// ODB++ reader (own code). The ODB++ specification document is distributed by Siemens under confidentiality /
// customer-agreement terms, so it was NOT used (see NOTEBOOK.md). Everything here was learned by looking at the
// public IPC-2581 consortium test-case archives that also carry ODB++ exports (matrix/matrix, steps/<step>/layers/
// <layer>/features[.Z], components[.Z], profile, symbols/<name>/features, eda/data). Only what those samples show is
// read: line (L), pad (P), arc (A), surface (S/OB/OS/OC/OE/SE) records, round / square / rectangle (rounded and
// chamfered corners) / oval / diamond / octagon / donut / thermal symbols, user symbols, layer and feature
// polarity, the step profile, components and net names. Text records (T) are drawn as plain text.
import { differencePart } from './clip.ts';
import { fromFileName } from './classify.ts';
import { isCompressZ, latin1, uncompressZ, type InFile } from './container.ts';
import {
  type Part, type Ring, type Xf, arcPts, arcStroke, circleRing, convexHull, emptyBB, bbAddRing, obroundRing, partsBB,
  polygonRing, rectRing, roundRectRing, stadium, sweepConvex, xfPart,
} from './geom.ts';
import type { PcbDoc, PLayer, PObj } from './model.ts';
import { CadError, type PcbLayerKind, type PcbSide, type Progress } from './types.ts';

export function isOdbTree(files: InFile[]): boolean { return files.some((f) => /(^|\/)matrix\/matrix(\.z)?$/i.test(f.name.replace(/\\/g, '/'))); }

interface MatrixLayer { row: number; context: string; type: string; name: string; polarity: string; start?: string; end?: string }

function parseStructured(text: string): Array<{ kind: string; f: Record<string, string> }> {
  const out: Array<{ kind: string; f: Record<string, string> }> = [];
  let cur: { kind: string; f: Record<string, string> } | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l || l[0] === '#') continue;
    const m = /^(\w+)\s*\{$/.exec(l);
    if (m) { cur = { kind: m[1].toUpperCase(), f: {} }; out.push(cur); continue; }
    if (l === '}') { cur = null; continue; }
    const eq = l.indexOf('=');
    if (cur && eq > 0) cur.f[l.slice(0, eq).trim().toUpperCase()] = l.slice(eq + 1).trim();
  }
  return out;
}

export async function readOdb(files: InFile[], onProgress?: Progress): Promise<PcbDoc> {
  const norm = (p: string) => p.replace(/\\/g, '/');
  const mf = files.find((f) => /(^|\/)matrix\/matrix(\.z)?$/i.test(norm(f.name)))!;
  const root = norm(mf.name).replace(/matrix\/matrix(\.z)?$/i, '');
  const map = new Map<string, Uint8Array>();
  for (const f of files) { const p = norm(f.name); if (p.startsWith(root)) map.set(p.slice(root.length).toLowerCase(), f.bytes); }
  const get = (p: string): string | null => {
    const k = p.toLowerCase();
    let b = map.get(k);
    if (!b) { const z = map.get(k + '.z'); if (z) b = isCompressZ(z) ? uncompressZ(z) : z; }
    else if (isCompressZ(b)) b = uncompressZ(b);
    return b ? latin1(b) : null;
  };
  const matrixText = get('matrix/matrix');
  if (!matrixText) throw new CadError('corrupt', 'ODB++ matrix is missing');
  const blocks = parseStructured(matrixText);
  const steps = blocks.filter((b) => b.kind === 'STEP').map((b) => b.f.NAME?.toLowerCase()).filter(Boolean) as string[];
  const mlayers: MatrixLayer[] = blocks.filter((b) => b.kind === 'LAYER').map((b) => ({
    row: parseInt(b.f.ROW ?? '0', 10), context: (b.f.CONTEXT ?? '').toUpperCase(), type: (b.f.TYPE ?? '').toUpperCase(), name: b.f.NAME ?? '', polarity: (b.f.POLARITY ?? 'POSITIVE').toUpperCase(), start: b.f.START_NAME, end: b.f.END_NAME,
  })).sort((a, b) => a.row - b.row);
  // step: the one with the most feature files (a panel step usually holds only step-repeats)
  const stepNames = steps.length ? steps : [...new Set([...map.keys()].filter((k) => k.startsWith('steps/')).map((k) => k.split('/')[1]))];
  let step = stepNames[0];
  let bestN = -1;
  for (const s of stepNames) { const n = [...map.keys()].filter((k) => k.startsWith(`steps/${s}/layers/`) && /\/features(\.z)?$/.test(k)).length; if (n > bestN) { bestN = n; step = s; } }
  if (!step) throw new CadError('corrupt', 'ODB++ job without steps');
  const doc: PcbDoc = { layers: [], comps: [], nets: new Set(), warnings: [], source: 'ODB++', info: { step } };
  if (stepNames.length > 1) doc.warnings.push(`ODB++ job has ${stepNames.length} steps; showing "${step}" (panels / step-repeat are not expanded)`);
  const userSymbols = new Map<string, Part[] | null>();
  const warn = (m: string) => { if (!doc.warnings.includes(m)) doc.warnings.push(m); };
  const loadUserSymbol = (name: string): Part[] | null => {
    const k = name.toLowerCase();
    if (userSymbols.has(k)) return userSymbols.get(k)!;
    userSymbols.set(k, null); // recursion guard
    const t = get(`symbols/${k}/features`);
    if (!t) { userSymbols.set(k, null); return null; }
    const objs = parseFeatures(t, 'symbol ' + name, symShape, warn, null).objs;
    const parts: Part[] = [];
    for (const o of objs) {
      if (o.dark) { for (const p of o.parts) parts.push(p); continue; }
      for (let i = parts.length - 1; i >= 0; i--) for (const cp of o.parts) { const d = differencePart(parts[i], cp); if (d.length) parts[i] = d; else { parts.splice(i, 1); break; } }
    }
    userSymbols.set(k, parts);
    return parts;
  };
  const symShape = (name: string, unitMm: number): Part[] | null => {
    const std = standardSymbol(name, unitMm);
    if (std !== undefined) return std;
    const u = loadUserSymbol(name);
    if (u) return u;
    warn(`ODB++ symbol "${name}" is not known: drawn as a small circle`);
    return [[circleRing(0, 0, 0.1)]];
  };
  // copper order
  const board = mlayers.filter((l) => l.context === 'BOARD');
  const cuRows = board.filter((l) => /^(SIGNAL|POWER_GROUND|MIXED)$/.test(l.type)).map((l) => l.row);
  const firstCu = Math.min(...cuRows), lastCu = Math.max(...cuRows);
  let k = 0;
  for (const ml of mlayers) {
    k++;
    onProgress?.('odb layer', 0.1 + 0.5 * (k / mlayers.length));
    const lname = ml.name.toLowerCase();
    const base = `steps/${step}/layers/${lname}/`;
    const side: PcbSide = ml.row < firstCu ? 'top' : ml.row > lastCu ? 'bottom' : 'inner';
    let kind: PcbLayerKind = 'other';
    let label = ml.name;
    let order = 0;
    switch (ml.type) {
      case 'SIGNAL': case 'POWER_GROUND': case 'MIXED': {
        kind = 'copper';
        order = cuRows.indexOf(ml.row) + 1;
        const sd: PcbSide = ml.row === firstCu ? 'top' : ml.row === lastCu ? 'bottom' : 'inner';
        label = `${sd === 'top' ? 'Top copper' : sd === 'bottom' ? 'Bottom copper' : `Inner copper L${order}`} (${ml.name})`;
        break;
      }
      case 'SOLDER_MASK': kind = 'mask'; label = `${side === 'bottom' ? 'Bottom' : 'Top'} solder mask (${ml.name})`; break;
      case 'SILK_SCREEN': kind = 'silk'; label = `${side === 'bottom' ? 'Bottom' : 'Top'} silkscreen (${ml.name})`; break;
      case 'SOLDER_PASTE': kind = 'paste'; label = `${side === 'bottom' ? 'Bottom' : 'Top'} paste (${ml.name})`; break;
      case 'DRILL': kind = 'drill'; label = `Holes (${ml.name})`; break;
      case 'ROUT': kind = 'outline'; label = `Rout (${ml.name})`; break;
      case 'COMPONENT': kind = 'component'; label = `${/bot/i.test(ml.name) ? 'Bottom' : 'Top'} components`; break;
      case 'DOCUMENT': kind = 'drawing'; label = `Document ${ml.name}`; break;
      case 'DIELECTRIC': continue;
      default: kind = 'other';
    }
    if (ml.context !== 'BOARD' && kind !== 'drawing') kind = 'drawing';
    // components
    if (ml.type === 'COMPONENT') {
      const ct = get(base + 'components');
      if (ct) {
        let unit = 25.4;
        for (const line of ct.split(/\r?\n/)) {
          const l = line.trim();
          if (/^U\s+MM/i.test(l) || /^UNITS\s*=\s*MM/i.test(l)) unit = 1;
          else if (/^U\s+INCH/i.test(l) || /^UNITS\s*=\s*INCH/i.test(l)) unit = 25.4;
          const m = /^CMP\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)/.exec(l);
          if (m) doc.comps.push({ refdes: m[6], x: parseFloat(m[2]) * unit, y: parseFloat(m[3]) * unit, rot: parseFloat(m[4]) || 0, side: /bot/i.test(ml.name) ? 'bottom' : 'top', part: m[7].replace(/;.*$/, ''), pkg: m[1] });
        }
      }
    }
    const ft = get(base + 'features');
    if (!ft) continue;
    const r = parseFeatures(ft, ml.name, symShape, warn, kind === 'drill' ? 'hole' : null);
    const L: PLayer = { name: label, file: ml.name, format: 'odb', kind, side: kind === 'copper' ? (ml.row === firstCu ? 'top' : ml.row === lastCu ? 'bottom' : 'inner') : kind === 'drill' || kind === 'outline' ? 'both' : kind === 'drawing' ? null : side, order, fn: ml.type, objs: r.objs, warnings: r.warnings, stats: r.stats };
    if (ml.polarity === 'NEGATIVE') L.invert = true;
    if (kind === 'drill') { L.plated = !/np|non/i.test(ml.name); for (const o of L.objs) o.fn = L.plated ? 'PTH' : 'NPTH'; }
    if (kind === 'other') { const g = fromFileName(ml.name); if (g && !g.skip) { L.kind = g.kind; L.side = g.side; } }
    doc.layers.push(L);
  }
  // profile
  const pt = get(`steps/${step}/profile`);
  if (pt) {
    const r = parseFeatures(pt, 'profile', symShape, warn, null);
    const parts: Part[] = [];
    for (const o of r.objs) if (o.t === 'surface') for (const p of o.parts) parts.push(p);
    if (parts.length) doc.profile = parts;
  }
  // nets
  const eda = get(`steps/${step}/eda/data`);
  if (eda) for (const m of eda.matchAll(/^NET\s+(\S+)/gm)) doc.nets.add(m[1]);
  if (!doc.layers.length) throw new CadError('corrupt', 'ODB++ job has no layer features');
  return doc;
}

// ---------------------------------------------------------------- features
interface FeatRes { objs: PObj[]; warnings: string[]; stats: Record<string, number> }

function parseFeatures(text: string, name: string, symShape: (n: string, u: number) => Part[] | null, warn: (m: string) => void, drill: 'hole' | null): FeatRes {
  const objs: PObj[] = [];
  const stats: Record<string, number> = { lines: 0, pads: 0, arcs: 0, surfaces: 0, texts: 0, minDraw: 0 };
  let unit = 25.4; // coordinates: inch or mm
  const syms: Array<{ name: string; unitMm: number }> = [];
  const shapeCache = new Map<string, Part[] | null>();
  const symParts = (i: number): Part[] | null => {
    const s = syms[i];
    if (!s) return null;
    const key = s.name + '|' + s.unitMm;
    if (!shapeCache.has(key)) shapeCache.set(key, symShape(s.name, s.unitMm));
    return shapeCache.get(key)!;
  };
  /** symbol units: mils (inch files) or microns (mm files), unless the symbol line says I or M */
  const symUnit = (flag: string | undefined) => (flag === 'M' ? 0.001 : flag === 'I' ? 0.0254 : unit === 1 ? 0.001 : 0.0254);
  const lines = text.split(/\r?\n/);
  let surf: { dark: boolean; rings: Ring[]; cur: number[] | null } | null = null;
  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    if (!raw || raw[0] === '#') continue;
    const semi = raw.indexOf(';');
    const l = (semi >= 0 ? raw.slice(0, semi) : raw).trim();
    if (!l) continue;
    const t = l.split(/\s+/);
    const c = t[0];
    if (c === 'U' || c === 'UNITS' || c.startsWith('UNITS=')) { const v = (t[1] ?? c.split('=')[1] ?? '').toUpperCase(); unit = v.startsWith('MM') ? 1 : 25.4; continue; }
    if (c[0] === '$') { syms[parseInt(c.slice(1), 10)] = { name: t[1], unitMm: symUnit(t[2]) }; continue; }
    if (c[0] === '@' || c[0] === '&' || c === 'F' || c === 'ID') continue;
    const n = (i: number) => parseFloat(t[i]) * unit;
    if (c === 'L') {
      const x0 = n(1), y0 = n(2), x1 = n(3), y1 = n(4);
      const si = parseInt(t[5], 10);
      const dark = t[6] !== 'N';
      const s = syms[si];
      let parts: Part[] = [];
      let w = 0;
      const rd = s ? /^r([\d.]+)$/.exec(s.name) : null;
      if (rd) { w = parseFloat(rd[1]) * s!.unitMm; if (w > 0) parts = [[stadium(x0, y0, x1, y1, w / 2)]]; }
      else {
        const sp = symParts(si);
        if (sp && sp.length) {
          const pts: number[] = [];
          for (const p of sp) for (const r of p) for (let q = 0; q < r.length; q++) pts.push(r[q]);
          parts = [[sweepConvex(convexHull(pts), x0, y0, x1, y1)]];
          const sq = s ? /^s([\d.]+)$/.exec(s.name) : null;
          if (sq) w = parseFloat(sq[1]) * s!.unitMm;
        }
      }
      const o: PObj = { dark, parts, bb: emptyBB(), t: drill ? 'slot' : 'draw', path: Float64Array.of(x0, y0, x1, y1), w };
      if (parts.length) o.bb = partsBB(parts); else bbAddRing(o.bb, o.path!);
      objs.push(o);
      stats.lines++;
      if (w > 0 && (!stats.minDraw || w < stats.minDraw)) stats.minDraw = w;
      continue;
    }
    if (c === 'P') {
      const x = n(1), y = n(2);
      const si = parseInt(t[3], 10);
      const dark = t[4] !== 'N';
      const od = parseInt(t[6] ?? '0', 10);
      let rot = 0, mirror = false;
      if (od === 8 || od === 9) { rot = parseFloat(t[7] ?? '0') || 0; mirror = od === 9; }
      else { rot = (od % 4) * 90; mirror = od >= 4; }
      const sp = symParts(si);
      if (!sp) continue;
      // ODB++ rotation is clockwise (checked against the Gerber export of the same boards)
      const xf: Xf = { mx: mirror, my: false, rot: -rot, s: 1, tx: x, ty: y };
      const parts = sp.map((p) => xfPart(p, xf));
      const s = syms[si];
      const o: PObj = { dark, parts, bb: parts.length ? partsBB(parts) : [x, y, x, y], t: drill ? 'hole' : 'flash' };
      const rd = s ? /^r([\d.]+)$/.exec(s.name) : null;
      if (rd) o.w = parseFloat(rd[1]) * s!.unitMm;
      objs.push(o);
      stats.pads++;
      continue;
    }
    if (c === 'A') {
      const x0 = n(1), y0 = n(2), x1 = n(3), y1 = n(4), cx = n(5), cy = n(6);
      const si = parseInt(t[7], 10);
      const dark = t[8] !== 'N';
      const cw = (t[10] ?? 'N').toUpperCase() === 'Y';
      const r0 = Math.hypot(x0 - cx, y0 - cy), r1 = Math.hypot(x1 - cx, y1 - cy);
      const a0 = Math.atan2(y0 - cy, x0 - cx), a1 = Math.atan2(y1 - cy, x1 - cx);
      let sw = a1 - a0;
      const full = Math.hypot(x1 - x0, y1 - y0) < 1e-9;
      if (cw) { while (sw >= 0) sw -= Math.PI * 2; if (full) sw = -Math.PI * 2; } else { while (sw <= 0) sw += Math.PI * 2; if (full) sw = Math.PI * 2; }
      const s = syms[si];
      const rd = s ? (/^r([\d.]+)$/.exec(s.name) ?? /^s([\d.]+)$/.exec(s.name)) : null;
      const w = rd ? parseFloat(rd[1]) * s!.unitMm : 0;
      const path: number[] = [];
      arcPts(cx, cy, r0, r1, a0, sw, path, true);
      const parts = w > 0 ? [arcStroke(cx, cy, r0, r1, a0, sw, w / 2)] : [];
      const o: PObj = { dark, parts, bb: emptyBB(), t: drill ? 'slot' : 'arc', path: Float64Array.from(path), w };
      if (parts.length) o.bb = partsBB(parts); else bbAddRing(o.bb, o.path!);
      objs.push(o);
      stats.arcs++;
      continue;
    }
    if (c === 'S') { surf = { dark: t[1] !== 'N', rings: [], cur: null }; continue; }
    if (surf) {
      if (c === 'OB') { surf.cur = [n(1), n(2)]; continue; }
      if (c === 'OS') { surf.cur?.push(n(1), n(2)); continue; }
      if (c === 'OC' && surf.cur) {
        const xe = n(1), ye = n(2), cx = n(3), cy = n(4), cw = (t[5] ?? 'Y').toUpperCase() === 'Y';
        const xs = surf.cur[surf.cur.length - 2], ys = surf.cur[surf.cur.length - 1];
        const r0 = Math.hypot(xs - cx, ys - cy), r1 = Math.hypot(xe - cx, ye - cy);
        const a0 = Math.atan2(ys - cy, xs - cx), a1 = Math.atan2(ye - cy, xe - cx);
        let sw = a1 - a0;
        const full = Math.hypot(xe - xs, ye - ys) < 1e-9;
        if (cw) { while (sw >= 0) sw -= Math.PI * 2; if (full) sw = -Math.PI * 2; } else { while (sw <= 0) sw += Math.PI * 2; if (full) sw = Math.PI * 2; }
        arcPts(cx, cy, r0, r1, a0, sw, surf.cur, false);
        surf.cur[surf.cur.length - 2] = xe; surf.cur[surf.cur.length - 1] = ye;
        continue;
      }
      if (c === 'OE') {
        const p = surf.cur;
        if (p && p.length >= 6) {
          if (Math.abs(p[p.length - 2] - p[0]) < 1e-9 && Math.abs(p[p.length - 1] - p[1]) < 1e-9) p.length -= 2;
          if (p.length >= 6) surf.rings.push(Float64Array.from(p));
        }
        surf.cur = null;
        continue;
      }
      if (c === 'SE') {
        if (surf.rings.length) { const parts = [surf.rings]; objs.push({ dark: surf.dark, parts, bb: partsBB(parts), t: 'surface' }); stats.surfaces++; }
        surf = null;
        continue;
      }
    }
    if (c === 'T') { stats.texts++; warn(`${name}: ODB++ text records are not drawn`); continue; }
    if (c === 'B') { warn(`${name}: ODB++ barcodes are not drawn`); continue; }
  }
  return { objs, warnings: [], stats };
}

// ---------------------------------------------------------------- standard symbols (names seen in the samples)
function standardSymbol(name: string, u: number): Part[] | null | undefined {
  const s = name.toLowerCase();
  let m: RegExpExecArray | null;
  const v = (x: string) => parseFloat(x) * u;
  if ((m = /^r([\d.]+)$/.exec(s))) { const d = v(m[1]); return d > 0 ? [[circleRing(0, 0, d / 2)]] : []; }
  if ((m = /^s([\d.]+)$/.exec(s))) { const d = v(m[1]); return [[rectRing(0, 0, d, d)]]; }
  if ((m = /^rect([\d.]+)x([\d.]+)(?:x(r|c)([\d.]+)(?:x(\d+))?)?$/.exec(s))) {
    const w = v(m[1]), h = v(m[2]);
    if (!m[3]) return [[rectRing(0, 0, w, h)]];
    const corners = m[5] ? cornerMask(m[5]) : 15;
    return [[roundRectRing(0, 0, w, h, v(m[4]), m[3] === 'c', corners)]];
  }
  if ((m = /^oval([\d.]+)x([\d.]+)$/.exec(s))) return [[obroundRing(0, 0, v(m[1]), v(m[2]))]];
  if ((m = /^di([\d.]+)x([\d.]+)$/.exec(s))) { const w = v(m[1]) / 2, h = v(m[2]) / 2; return [[Float64Array.of(w, 0, 0, h, -w, 0, 0, -h)]]; }
  if ((m = /^oct([\d.]+)x([\d.]+)x([\d.]+)$/.exec(s))) return [[roundRectRing(0, 0, v(m[1]), v(m[2]), v(m[3]), true)]];
  if ((m = /^donut_r([\d.]+)x([\d.]+)$/.exec(s))) return [[circleRing(0, 0, v(m[1]) / 2), circleRing(0, 0, v(m[2]) / 2)]];
  if ((m = /^donut_s([\d.]+)x([\d.]+)$/.exec(s))) return [[rectRing(0, 0, v(m[1]), v(m[1])), rectRing(0, 0, v(m[2]), v(m[2]))]];
  if ((m = /^el([\d.]+)x([\d.]+)$/.exec(s))) { const r = circleRing(0, 0, 1); const w = v(m[1]) / 2, h = v(m[2]) / 2; for (let i = 0; i < r.length; i += 2) { r[i] *= w; r[i + 1] *= h; } return [[r]]; }
  if ((m = /^hex_[ls]([\d.]+)x([\d.]+)x([\d.]+)$/.exec(s))) return [[roundRectRing(0, 0, v(m[1]), v(m[2]), v(m[3]), true)]];
  if ((m = /^tri([\d.]+)x([\d.]+)$/.exec(s))) { const b = v(m[1]) / 2, h = v(m[2]) / 2; return [[Float64Array.of(-b, -h, b, -h, 0, h)]]; }
  // thermals: outer x inner x angle x spokes x gap (round "thr", square-gapped "ths"): approximated as ring pieces
  if ((m = /^(thr|ths)([\d.]+)x([\d.]+)x([\d.]+)x(\d+)x([\d.]+)$/.exec(s))) {
    const ro = v(m[2]) / 2, ri = v(m[3]) / 2, ang = parseFloat(m[4]), ns = Math.max(1, parseInt(m[5], 10)), gap = v(m[6]);
    const parts: Part[] = [];
    const step = (Math.PI * 2) / ns;
    for (let k = 0; k < ns; k++) {
      const c0 = (ang * Math.PI) / 180 + k * step;
      const ga = Math.asin(Math.min(1, gap / 2 / Math.max(ri, 1e-6)));
      const gao = Math.asin(Math.min(1, gap / 2 / ro));
      const a0 = c0 + gao, a1 = c0 + step - gao;
      if (a1 <= a0) continue;
      const pts: number[] = [];
      arcPts(0, 0, ro, ro, a0, a1 - a0, pts, true);
      const inner: number[] = [];
      const ia0 = c0 + ga, ia1 = c0 + step - ga;
      if (ia1 > ia0) arcPts(0, 0, ri, ri, ia0, ia1 - ia0, inner, true);
      for (let q = inner.length - 2; q >= 0; q -= 2) pts.push(inner[q], inner[q + 1]);
      parts.push([Float64Array.from(pts)]);
    }
    return parts;
  }
  if ((m = /^moire/.exec(s))) return [[circleRing(0, 0, 0.5)]];
  if (s === 'null' || /^null\d*/.test(s)) return [];
  if ((m = /^hole([\d.]+)/.exec(s))) return [[circleRing(0, 0, v(m[1]) / 2)]];
  if ((m = /^oval_h([\d.]+)x([\d.]+)$/.exec(s))) return [[polygonRing(0, 0, v(m[1]), 6, 0)]];
  return undefined;
}

/** corner list like "1234" -> bit mask (1 = upper right, counter-clockwise) */
function cornerMask(c: string): number {
  let m = 0;
  for (const ch of c) { const d = parseInt(ch, 10); if (d >= 1 && d <= 4) m |= 1 << (d - 1); }
  return m || 15;
}
