// Gerber layer format reader (RS-274X with X2/X3 attributes), own code written from the public
// Ucamco "Gerber Layer Format Specification" revision 2026.05 (see NOTEBOOK.md). Deprecated constructs from
// chapter 8 of that specification are read too (G74, G70/G71, G90/G91, G54/G55, FS trailing zeros and
// incremental notation, IP/MI/OF/SF/IR, rectangular holes, primitives 2/22/6, modal D01, %SRX1Y1I0J0*%).
// Standard Gerber (RS-274-D, apertures in a separate wheel file) gives a warning and placeholder apertures.
import { differencePart } from './clip.ts';
import {
  type BB, type Part, type Ring, type Xf, arcPts, arcStroke, circleRing, convexHull, emptyBB, bbAddRing, obroundRing,
  partsBB, polygonRing, rectRing, stadium, sweepConvex, xfPart, xfPoint, translateRing,
} from './geom.ts';
import type { PObj } from './model.ts';

export interface GerberResult {
  objs: PObj[];
  attrs: Record<string, string>; // file attributes (TF), name without the dot -> value
  units: 'mm' | 'inch' | '?';
  invert: boolean; // %IPNEG*%
  warnings: string[];
  stats: Record<string, number>;
  comps: Array<{ refdes: string; x: number; y: number; rot: number; fn?: string }>;
  nets: Set<string>;
}

interface Aperture {
  kind: 'C' | 'R' | 'O' | 'P' | 'M' | 'B';
  params: number[];
  parts: Part[]; // in mm, local coordinates (std and macro)
  block?: PObj[];
  fn?: string;
  diameter?: number; // C only (mm)
  cache?: Map<string, Part[]>;
}

interface Collector { objs: PObj[]; kind: 'root' | 'ab' | 'sr'; d?: number; sr?: { nx: number; ny: number; dx: number; dy: number } }

const TAU = Math.PI * 2;

/** sniff: Gerber is text with %FS / %MO / G04 / %AD / D0x* words */
export function sniffGerber(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192);
  let s = '';
  for (let i = 0; i < n; i++) {
    const c = bytes[i];
    if (c === 0) return false;
    s += String.fromCharCode(c);
  }
  if (/%FS[LTD]?[AI]?X\d\dY\d\d\*/.test(s)) return true;
  if (/%MO(MM|IN)\*%/.test(s)) return true;
  if (/%AD\s*D\d+[A-Za-z_$.]/.test(s)) return true;
  if (/^\s*G04[ \S]*\*\s*$/m.test(s) && /D0?[123]\*/.test(s)) return true;
  if (/^\s*G04 #@! TF\./m.test(s)) return true;
  // RS-274-D: only coordinates and D codes
  const lines = s.split(/\r?\n/).slice(0, 40).filter((l) => l.trim());
  if (lines.length >= 5 && lines.every((l) => /^(\s*[GDMXYIJ][-+\d]*)+\*\s*$/.test(l.trim())) && /D0?[123]\*/.test(s) && /X-?\d+Y-?\d+/.test(s)) return true;
  return false;
}

export function readGerber(text: string, name = ''): GerberResult {
  const warnings: string[] = [];
  const warned = new Set<string>();
  const warn = (k: string, msg?: string) => { if (!warned.has(k)) { warned.add(k); warnings.push(msg ?? k); } };
  const stats: Record<string, number> = { flashes: 0, draws: 0, arcs: 0, regions: 0, clear: 0, apertures: 0, minDraw: 0 };
  const attrs: Record<string, string> = {};
  const nets = new Set<string>();
  const comps: GerberResult['comps'] = [];
  const compSeen = new Set<string>();

  // ---- graphics state
  let unit = 0; // mm per file unit, 0 = not yet set
  let unitName: 'mm' | 'inch' | '?' = '?';
  let fsInt = 2, fsDec = 4, fsSet = false, trailing = false, incremental = false;
  let cx = 0, cy = 0; // current point, mm
  let cur: Aperture | null = null, curD = -1;
  let mode: 1 | 2 | 3 = 1; // G01 / G02 / G03
  let quadrant: 'multi' | 'single' | 'unset' = 'unset';
  let dark = true;
  let lm = { x: false, y: false }, lr = 0, ls = 1;
  let region = false;
  let contour: number[] = [];
  let contours: number[][] = [];
  let lastOp = 0;
  let invert = false;
  // deprecated image transforms (coordinates only)
  let ofA = 0, ofB = 0, sfA = 1, sfB = 1, miA = false, miB = false, ir = 0;
  const apertures = new Map<number, Aperture>();
  const macros = new Map<string, string[]>();
  const taDict = new Map<string, string>();
  const toDict = new Map<string, string>();
  const root: Collector = { objs: [], kind: 'root' };
  const stack: Collector[] = [root];
  const out = () => stack[stack.length - 1].objs;
  let ended = false;
  let rs274d = false;

  const ensureUnit = () => {
    if (!unit) { unit = 25.4; unitName = 'inch'; warn('no-mo', 'No unit (%MO) in the file; inch assumed'); }
  };
  const coord = (s: string): number => {
    ensureUnit();
    if (s.includes('.')) return parseFloat(s) * unit;
    let neg = false;
    if (s[0] === '-' || s[0] === '+') { neg = s[0] === '-'; s = s.slice(1); }
    let v: number;
    if (trailing) {
      const want = fsInt + fsDec;
      if (s.length < want) s = s + '0'.repeat(want - s.length);
      v = parseInt(s, 10) / 10 ** fsDec;
    } else v = parseInt(s, 10) / 10 ** fsDec;
    if (!Number.isFinite(v)) return NaN;
    return (neg ? -v : v) * unit;
  };
  const mapXY = (x: number, y: number): [number, number] => {
    // MI, SF, OF (coordinate data only); IR is applied to the whole image at the end
    if (miA) x = -x;
    if (miB) y = -y;
    return [x * sfA + ofA, y * sfB + ofB];
  };

  const objAttrs = (o: PObj, apFn?: string) => {
    const n = toDict.get('.N');
    if (n) { o.net = n; for (const nn of n.split(',')) if (nn) nets.add(nn); }
    const c = toDict.get('.C');
    if (c) o.comp = c;
    const f = apFn ?? taDict.get('.AperFunction');
    if (f) o.fn = f.split(',')[0];
  };

  // ---- aperture shapes
  const stdParts = (k: string, p: number[]): Part[] => {
    const u = unit || 25.4;
    const v = p.map((x) => x * u);
    const holeRing = (i: number): Ring[] => {
      if (v.length > i + 1 && v[i + 1] > 0) { warn('rect-hole', 'Rectangular aperture hole (deprecated) used'); return [rectRing(0, 0, v[i], v[i + 1])]; }
      if (v.length > i && v[i] > 0) return [circleRing(0, 0, v[i] / 2)];
      return [];
    };
    switch (k) {
      case 'C': return v[0] > 0 ? [[circleRing(0, 0, v[0] / 2), ...holeRing(1)]] : [];
      case 'R': return [[rectRing(0, 0, v[0] || 0, v[1] || 0), ...holeRing(2)]];
      case 'O': return [[obroundRing(0, 0, v[0] || 0, v[1] || 0), ...holeRing(2)]];
      case 'P': return [[polygonRing(0, 0, v[0] || 0, p[1] || 3, p[2] || 0), ...(v.length > 3 && v[3] > 0 ? [circleRing(0, 0, v[3] / 2)] : [])]];
    }
    return [];
  };

  const evalMacro = (name: string, params: number[]): Part[] => {
    const body = macros.get(name);
    if (!body) { warn('macro:' + name, `Aperture macro ${name} is not defined`); return []; }
    const vars = new Map<number, number>();
    params.forEach((v, i) => vars.set(i + 1, v));
    const u = unit || 25.4;
    const parts: Part[] = [];
    for (const raw of body) {
      const w = raw.replace(/\s+/g, '');
      if (!w) continue;
      if (/^0(\D|$)/.test(raw.trim()) && !/^0,/.test(w)) continue; // comment primitive '0 text'
      if (w[0] === '$') {
        const eq = w.indexOf('=');
        if (eq > 0) { const id = parseInt(w.slice(1, eq), 10); vars.set(id, evalExpr(w.slice(eq + 1), vars)); }
        continue;
      }
      const f = w.split(',').map((x) => evalExpr(x, vars));
      const code = Math.round(f[0]);
      const rotOf = (i: number) => (Number.isFinite(f[i]) ? f[i] : 0);
      const rot = (r: Ring, deg: number): Ring => (deg ? xfPart([r], { mx: false, my: false, rot: deg, s: 1, tx: 0, ty: 0 })[0] : r);
      let exposure = 1;
      let shape: Part | null = null;
      let pieces: Part[] | null = null;
      switch (code) {
        case 0: break;
        case 1: { exposure = f[1]; const d = f[2] * u; if (d > 0) shape = [rot(circleRing(f[3] * u, f[4] * u, d / 2), rotOf(5))]; break; }
        case 2: case 20: {
          exposure = f[1];
          const wd = f[2] * u, x0 = f[3] * u, y0 = f[4] * u, x1 = f[5] * u, y1 = f[6] * u;
          const L = Math.hypot(x1 - x0, y1 - y0);
          if (wd > 0 && L > 0) {
            const nx = (-(y1 - y0) / L) * wd / 2, ny = ((x1 - x0) / L) * wd / 2;
            shape = [rot(Float64Array.of(x0 + nx, y0 + ny, x0 - nx, y0 - ny, x1 - nx, y1 - ny, x1 + nx, y1 + ny), rotOf(7))];
          }
          if (code === 2) warn('prim2', 'Macro primitive 2 (deprecated) used');
          break;
        }
        case 21: { exposure = f[1]; const wd = f[2] * u, ht = f[3] * u; if (wd > 0 && ht > 0) shape = [rot(rectRing(f[4] * u, f[5] * u, wd, ht), rotOf(6))]; break; }
        case 22: { exposure = f[1]; const wd = f[2] * u, ht = f[3] * u; if (wd > 0 && ht > 0) shape = [rot(rectRing(f[4] * u + wd / 2, f[5] * u + ht / 2, wd, ht), rotOf(6))]; warn('prim22', 'Macro primitive 22 (deprecated) used'); break; }
        case 4: {
          exposure = f[1];
          const n = Math.round(f[2]);
          const pts: number[] = [];
          for (let k = 0; k <= n; k++) pts.push(f[3 + k * 2] * u, f[4 + k * 2] * u);
          if (pts.length >= 4 && pts[pts.length - 2] === pts[0] && pts[pts.length - 1] === pts[1]) pts.length -= 2;
          if (pts.length >= 6 && pts.every(Number.isFinite)) shape = [rot(Float64Array.from(pts), rotOf(5 + 2 * n))];
          break;
        }
        case 5: { exposure = f[1]; const d = f[5] * u; if (d > 0) shape = [rot(polygonRing(f[3] * u, f[4] * u, d, f[2], 0), rotOf(6))]; break; }
        case 7: {
          const x = f[1] * u, y = f[2] * u, od = f[3] * u, id = f[4] * u, gap = f[5] * u, deg = rotOf(6);
          pieces = thermal(x, y, od / 2, id / 2, gap).map((r) => [rot(r, deg)]);
          break;
        }
        case 6: {
          warn('moire', 'Macro primitive 6 moire (deprecated) used');
          const x = f[1] * u, y = f[2] * u, od = f[3] * u, th = f[4] * u, gap = f[5] * u, nr = Math.round(f[6]), ct = f[7] * u, cl = f[8] * u, deg = rotOf(9);
          pieces = [];
          let r = od / 2;
          for (let k = 0; k < nr && r > 0; k++) {
            const ri = r - th;
            pieces.push(ri > 0 ? [rot(circleRing(x, y, r), deg), rot(circleRing(x, y, ri), deg)] : [rot(circleRing(x, y, r), deg)]);
            r = ri - gap;
          }
          if (ct > 0 && cl > 0) { pieces.push([rot(rectRing(x, y, cl, ct), deg)]); pieces.push([rot(rectRing(x, y, ct, cl), deg)]); }
          break;
        }
        default: warn('prim' + code, `Unknown macro primitive ${code} in ${name}`);
      }
      if (pieces) { for (const p of pieces) parts.push(p); continue; }
      if (!shape) continue;
      if (exposure >= 0.5) parts.push(shape);
      else {
        // exposure off erases what the macro made so far
        for (let k = parts.length - 1; k >= 0; k--) {
          const pb = partsBB([parts[k]]), sb = partsBB([shape]);
          if (pb[0] > sb[2] || sb[0] > pb[2] || pb[1] > sb[3] || sb[1] > pb[3]) continue;
          const d = differencePart(parts[k], shape);
          if (d.length) parts[k] = d; else parts.splice(k, 1);
        }
      }
    }
    return parts;
  };

  const defineAperture = (word: string) => {
    // ADD<n><template>[,<params>]
    const m = /^ADD(\d+)([^,]*)(?:,(.*))?$/.exec(word.replace(/\s+/g, ''));
    if (!m) { warn('bad-ad', `Bad aperture definition: ${word.slice(0, 40)}`); return; }
    const d = parseInt(m[1], 10);
    const tmpl = m[2];
    const params = m[3] ? m[3].split('X').map((x) => parseFloat(x)) : [];
    let ap: Aperture;
    if (tmpl === 'C' || tmpl === 'R' || tmpl === 'O' || tmpl === 'P') {
      ap = { kind: tmpl, params, parts: stdParts(tmpl, params) };
      if (tmpl === 'C') ap.diameter = (params[0] || 0) * (unit || 25.4);
    } else {
      ap = { kind: 'M', params, parts: evalMacro(tmpl, params) };
    }
    const fn = taDict.get('.AperFunction');
    if (fn) ap.fn = fn.split(',')[0];
    apertures.set(d, ap);
    stats.apertures++;
  };

  const xfNow = (tx: number, ty: number): Xf => ({ mx: lm.x, my: lm.y, rot: lr, s: ls, tx, ty });
  const transformedParts = (ap: Aperture): Part[] => {
    if (!lm.x && !lm.y && !lr && ls === 1) return ap.parts;
    const key = `${lm.x}${lm.y}${lr}|${ls}`;
    if (!ap.cache) ap.cache = new Map();
    let p = ap.cache.get(key);
    if (!p) { p = ap.parts.map((pp) => xfPart(pp, xfNow(0, 0))); ap.cache.set(key, p); }
    return p;
  };

  const pushObj = (o: PObj) => {
    if (!o.dark) stats.clear++;
    out().push(o);
  };

  const flash = (x: number, y: number) => {
    if (!cur) { warn('no-ap', 'Flash without a current aperture'); return; }
    stats.flashes++;
    if (cur.kind === 'B') {
      const xf = xfNow(x, y);
      for (const b of cur.block!) {
        const o: PObj = { dark: dark ? b.dark : !b.dark, parts: b.parts.map((p) => xfPart(p, xf)), bb: emptyBB(), t: b.t, net: b.net, comp: b.comp, fn: b.fn, w: b.w !== undefined ? b.w * ls : undefined };
        o.bb = partsBB(o.parts);
        if (b.path) {
          const pp = new Float64Array(b.path.length);
          for (let i = 0; i < pp.length; i += 2) { const q = xfPoint(b.path[i], b.path[i + 1], xf); pp[i] = q[0]; pp[i + 1] = q[1]; }
          o.path = pp;
          if (!o.parts.length) { const bb = emptyBB(); bbAddRing(bb, pp); o.bb = bb; }
        }
        pushObj(o);
      }
      return;
    }
    const tp = transformedParts(cur);
    const parts = tp.map((p) => p.map((r) => translateRing(r, x, y)));
    const o: PObj = { dark, parts, bb: parts.length ? partsBB(parts) : [x, y, x, y], t: 'flash' };
    if (cur.kind === 'C') o.w = (cur.diameter ?? 0) * ls;
    objAttrs(o, cur.fn);
    pushObj(o);
    // X3 component layers: flashes with .C at the component reference point
    if (o.comp && o.fn === 'ComponentMain') {
      if (!compSeen.has(o.comp)) { compSeen.add(o.comp); comps.push({ refdes: o.comp, x, y, rot: parseFloat(toDict.get('.CRot') ?? '0') || 0, fn: o.fn }); }
    }
  };

  const stroke = (x0: number, y0: number, x1: number, y1: number, arc: { cxx: number; cyy: number; r0: number; r1: number; a0: number; sweep: number } | null) => {
    if (!cur) { warn('no-ap', 'Draw without a current aperture'); return; }
    if (cur.kind === 'B') { warn('block-draw', 'Draw with a block aperture (not allowed) skipped'); return; }
    const path: number[] = [];
    if (arc) arcPts(arc.cxx, arc.cyy, arc.r0, arc.r1, arc.a0, arc.sweep, path, true);
    else path.push(x0, y0, x1, y1);
    let parts: Part[] = [];
    let w = 0;
    if (cur.kind === 'C') {
      w = (cur.diameter ?? 0) * ls;
      if (w > 0) {
        if (arc) parts = [arcStroke(arc.cxx, arc.cyy, arc.r0, arc.r1, arc.a0, arc.sweep, w / 2)];
        else parts = [[stadium(x0, y0, x1, y1, w / 2)]];
        if (cur.params.length > 1) warn('draw-hole', 'Draw with a circle aperture that has a hole: hole ignored');
      }
    } else {
      // deprecated: rectangle (or other) apertures stroked; Minkowski sum of the convex outline
      if (cur.kind === 'R') warn('rect-draw', 'Draws with rectangular apertures (deprecated) are used');
      else warn('odd-draw', 'Draws with non-circular apertures (not allowed) are approximated');
      const tp = transformedParts(cur);
      const allPts: number[] = [];
      for (const p of tp) for (const r of p) for (let i = 0; i < r.length; i++) allPts.push(r[i]);
      if (allPts.length >= 6) {
        const hull = convexHull(allPts);
        for (let i = 0; i + 3 < path.length; i += 2) parts.push([sweepConvex(hull, path[i], path[i + 1], path[i + 2], path[i + 3])]);
        let mx = 0, my = 0;
        for (let i = 0; i < hull.length; i += 2) { mx = Math.max(mx, Math.abs(hull[i])); my = Math.max(my, Math.abs(hull[i + 1])); }
        w = 2 * Math.min(mx, my);
      }
    }
    const pp = Float64Array.from(path);
    const o: PObj = { dark, parts, bb: emptyBB(), t: arc ? 'arc' : 'draw', path: pp, w };
    if (parts.length) o.bb = partsBB(parts); else bbAddRing(o.bb, pp);
    objAttrs(o, cur.fn);
    if (arc) stats.arcs++; else stats.draws++;
    if (w > 0 && (!stats.minDraw || w < stats.minDraw)) stats.minDraw = w;
    pushObj(o);
  };

  /** circular segment from (x0,y0) to (x1,y1), offsets i,j (mm, signed in G75, unsigned in G74) */
  const arcGeom = (x0: number, y0: number, x1: number, y1: number, i: number, j: number, cw: boolean) => {
    const tryCenter = (ccx: number, ccy: number) => {
      const r0 = Math.hypot(x0 - ccx, y0 - ccy), r1 = Math.hypot(x1 - ccx, y1 - ccy);
      const a0 = Math.atan2(y0 - ccy, x0 - ccx), a1 = Math.atan2(y1 - ccy, x1 - ccx);
      let sw = a1 - a0;
      if (cw) { while (sw > 0) sw -= TAU; while (sw <= -TAU) sw += TAU; } else { while (sw < 0) sw += TAU; while (sw >= TAU) sw -= TAU; }
      return { cxx: ccx, cyy: ccy, r0, r1, a0, sweep: sw, dev: Math.abs(r0 - r1) };
    };
    const same = Math.hypot(x1 - x0, y1 - y0) < 1e-7;
    const multi = () => {
      const g = tryCenter(x0 + i, y0 + j);
      if (same) g.sweep = cw ? -TAU : TAU;
      else if (Math.abs(g.sweep) < 1e-12) g.sweep = cw ? -TAU : TAU;
      return g;
    };
    const single = () => {
      let best: ReturnType<typeof tryCenter> | null = null;
      for (const sx of [1, -1]) for (const sy of [1, -1]) {
        const g = tryCenter(x0 + sx * Math.abs(i), y0 + sy * Math.abs(j));
        if (Math.abs(g.sweep) > Math.PI / 2 + 1e-6) continue;
        if (!best || g.dev < best.dev) best = g;
      }
      if (!best) best = tryCenter(x0 + i, y0 + j);
      if (same) best.sweep = 0;
      return best;
    };
    if (quadrant === 'single') return single();
    const g = multi();
    if (quadrant === 'unset') {
      const tol = Math.max(0.01 * Math.max(g.r0, g.r1), 0.005);
      if (g.dev > tol && (i >= 0 && j >= 0)) {
        const s = single();
        if (s.dev < g.dev) { warn('g74-guess', 'Arcs without G74/G75: single quadrant mode assumed where it fits better'); return s; }
      }
      warn('no-g75', 'Arc without a preceding G75 (multi quadrant mode assumed)');
    }
    return g;
  };

  const closeContour = () => {
    if (contour.length >= 6) {
      const n = contour.length;
      if (Math.abs(contour[n - 2] - contour[0]) < 1e-9 && Math.abs(contour[n - 1] - contour[1]) < 1e-9) contour.length -= 2;
      if (contour.length >= 6) contours.push(contour);
    }
    contour = [];
  };

  const operate = (op: number, x: number, y: number, i: number, j: number, hasIJ: boolean) => {
    if (op === 2) {
      if (region) { closeContour(); contour = [x, y]; }
      cx = x; cy = y;
      return;
    }
    if (op === 3) {
      if (region) { warn('d03-region', 'D03 inside a region statement ignored'); cx = x; cy = y; return; }
      flash(x, y);
      cx = x; cy = y;
      return;
    }
    if (op === 1) {
      if (mode === 1) {
        if (region) { if (!contour.length) contour = [cx, cy]; contour.push(x, y); }
        else stroke(cx, cy, x, y, null);
      } else {
        if (!hasIJ) { i = 0; j = 0; }
        const g = arcGeom(cx, cy, x, y, i, j, mode === 2);
        if (region) {
          if (!contour.length) contour = [cx, cy];
          arcPts(g.cxx, g.cyy, g.r0, g.r1, g.a0, g.sweep, contour, false);
          // land exactly on the end point
          contour[contour.length - 2] = x; contour[contour.length - 1] = y;
        } else if (Math.abs(g.sweep) > 0) stroke(cx, cy, x, y, g);
        else stroke(cx, cy, x, y, null);
      }
      cx = x; cy = y;
    }
  };

  const finishRegion = () => {
    closeContour();
    if (contours.length) {
      const parts: Part[] = contours.map((c) => [Float64Array.from(c)]);
      const o: PObj = { dark, parts, bb: partsBB(parts), t: 'region' };
      objAttrs(o);
      stats.regions++;
      pushObj(o);
    }
    contours = [];
    contour = [];
    region = false;
  };

  const setAttr = (cmd: string, body: string) => {
    // body: .Name,value,...  (escapes \uXXXX)
    const unesc = body.replace(/\\u([0-9a-fA-F]{4})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
    const c = unesc.indexOf(',');
    const nm = c < 0 ? unesc : unesc.slice(0, c);
    const val = c < 0 ? '' : unesc.slice(c + 1);
    if (cmd === 'TF') attrs[nm.replace(/^\./, '')] = val;
    else if (cmd === 'TA') taDict.set(nm, val);
    else if (cmd === 'TO') toDict.set(nm, val);
    else if (cmd === 'TD') {
      if (!nm) { taDict.clear(); toDict.clear(); } else { taDict.delete(nm); toDict.delete(nm); }
    }
  };

  // ---- extended commands
  const extended = (block: string) => {
    // split into words on '*'; AM keeps its words together
    const words = block.split('*');
    let k = 0;
    while (k < words.length) {
      const w0 = words[k].replace(/^[\s\r\n]+/, '');
      if (!w0.trim()) { k++; continue; }
      const cmd = w0.slice(0, 2);
      if (cmd === 'AM') {
        const name = w0.slice(2).trim();
        macros.set(name, words.slice(k + 1).map((x) => x.trim()).filter((x) => x));
        return;
      }
      const w = w0.replace(/[\r\n]+/g, '');
      switch (cmd) {
        case 'FS': {
          const m = /^FS([LTD]?)([AI]?)(?:N\d+)?(?:G\d+)?X(\d)(\d)Y(\d)(\d)/.exec(w.replace(/\s+/g, ''));
          if (m) {
            trailing = m[1] === 'T';
            incremental = m[2] === 'I';
            fsInt = parseInt(m[3], 10); fsDec = parseInt(m[4], 10); fsSet = true;
            if (trailing) warn('fs-t', 'Trailing zero omission (deprecated) used');
            if (incremental) warn('fs-i', 'Incremental coordinates (deprecated) used');
            if (fsDec < 6) stats.lowRes = 1;
          } else warn('bad-fs', `Bad format specification: ${w.slice(0, 30)}`);
          break;
        }
        case 'MO': unit = /IN/.test(w) ? 25.4 : 1; unitName = unit === 1 ? 'mm' : 'inch'; break;
        case 'AD': defineAperture(w); break;
        case 'LP': dark = !/LPC/.test(w); break;
        case 'LM': { const v = w.slice(2).trim(); lm = { x: v === 'X' || v === 'XY', y: v === 'Y' || v === 'XY' }; break; }
        case 'LR': lr = parseFloat(w.slice(2)) || 0; break;
        case 'LS': ls = parseFloat(w.slice(2)) || 1; break;
        case 'TF': case 'TA': case 'TO': case 'TD': setAttr(cmd, w.slice(2)); break;
        case 'IP': invert = /NEG/.test(w); if (invert) warn('ipneg', 'Negative image polarity (%IPNEG, deprecated): image inverted'); break;
        case 'OF': { const a = /A([-+\d.]+)/.exec(w), b = /B([-+\d.]+)/.exec(w); ofA = a ? parseFloat(a[1]) * (unit || 25.4) : 0; ofB = b ? parseFloat(b[1]) * (unit || 25.4) : 0; if (ofA || ofB) warn('of', 'Image offset (%OF, deprecated) applied'); break; }
        case 'SF': { const a = /A([\d.]+)/.exec(w), b = /B([\d.]+)/.exec(w); sfA = a ? parseFloat(a[1]) : 1; sfB = b ? parseFloat(b[1]) : 1; if (sfA !== 1 || sfB !== 1) warn('sf', 'Scale factor (%SF, deprecated) applied'); break; }
        case 'MI': miA = /A1/.test(w); miB = /B1/.test(w); if (miA || miB) warn('mi', 'Image mirroring (%MI, deprecated) applied'); break;
        case 'IR': ir = parseInt(w.slice(2), 10) || 0; if (ir) warn('ir', `Image rotation ${ir} deg (%IR, deprecated) applied`); break;
        case 'AS': if (/AYBX/.test(w)) warn('as', 'Axis select AYBX (deprecated) ignored'); break;
        case 'IN': case 'LN': case 'IJ': case 'IC': case 'IO': case 'PF': case 'KO': break;
        case 'AB': {
          const m = /^ABD(\d+)/.exec(w.replace(/\s+/g, ''));
          if (m) stack.push({ objs: [], kind: 'ab', d: parseInt(m[1], 10) });
          else {
            const top = stack[stack.length - 1];
            if (top.kind === 'ab') {
              stack.pop();
              apertures.set(top.d!, { kind: 'B', params: [], parts: [], block: top.objs });
              stats.apertures++;
            } else warn('ab-close', 'Unmatched %AB*% ignored');
          }
          break;
        }
        case 'SR': {
          const m = /^SRX(\d+)Y(\d+)I([-+\d.]+)J([-+\d.]+)/.exec(w.replace(/\s+/g, ''));
          const closeSR = () => {
            const top = stack[stack.length - 1];
            if (top.kind !== 'sr') return;
            stack.pop();
            const { nx, ny, dx, dy } = top.sr!;
            const dst = stack[stack.length - 1].objs;
            for (let ix = 0; ix < nx; ix++) for (let iy = 0; iy < ny; iy++) {
              const ox = ix * dx, oy = iy * dy;
              for (const o of top.objs) {
                if (!ox && !oy) { dst.push(o); continue; }
                const parts = o.parts.map((p) => p.map((r) => translateRing(r, ox, oy)));
                const c: PObj = { ...o, parts, bb: [o.bb[0] + ox, o.bb[1] + oy, o.bb[2] + ox, o.bb[3] + oy] };
                if (o.path) c.path = translateRing(o.path, ox, oy);
                dst.push(c);
              }
            }
          };
          if (!m) { closeSR(); break; }
          const nx = parseInt(m[1], 10), ny = parseInt(m[2], 10);
          closeSR();
          if (nx === 1 && ny === 1) break; // %SRX1Y1I0J0*% closes or is a no-op
          const u = unit || 25.4;
          stack.push({ objs: [], kind: 'sr', sr: { nx, ny, dx: parseFloat(m[3]) * u, dy: parseFloat(m[4]) * u } });
          break;
        }
        default:
          if (w.trim()) warn('ext:' + cmd, `Unknown extended command %${cmd} ignored`);
      }
      k++;
    }
  };

  // ---- function codes
  const reNum = /[-+]?[\d.]+/y;
  const word = (w: string) => {
    if (!w) return;
    // comments
    if (/^G0*4(\D|$)/.test(w)) {
      const m = /#@!\s*(T[FAOD])\s*(.*)$/.exec(w);
      if (m) setAttr(m[1], m[2].trim());
      // Cadence Allegro writes the film mode in its identification record
      else if (/^G0*4\s+Mode:\s*Negative/i.test(w)) attrs.FilmMode = 'Negative';
      return;
    }
    let x: number | null = null, y: number | null = null, i: number | null = null, j: number | null = null;
    let d: number | null = null;
    let p = 0;
    const n = w.length;
    while (p < n) {
      const c = w.charCodeAt(p);
      if (c <= 32) { p++; continue; }
      const L = w[p]; p++;
      reNum.lastIndex = p;
      const m = reNum.exec(w);
      if (!m) { if (L !== '\n' && L !== '\r') warn('junk:' + L, `Unexpected '${L}' in "${w.slice(0, 30)}"`); continue; }
      p = reNum.lastIndex;
      const s = m[0];
      switch (L) {
        case 'G': {
          const g = parseInt(s, 10);
          if (g === 1) mode = 1; else if (g === 2) mode = 2; else if (g === 3) mode = 3;
          else if (g === 36) { region = true; contours = []; contour = []; }
          else if (g === 37) finishRegion();
          else if (g === 74) { quadrant = 'single'; warn('g74', 'Single quadrant arcs (G74, deprecated) used'); }
          else if (g === 75) quadrant = 'multi';
          else if (g === 70) { unit = 25.4; unitName = 'inch'; }
          else if (g === 71) { unit = 1; unitName = 'mm'; }
          else if (g === 90) incremental = false;
          else if (g === 91) { incremental = true; warn('fs-i', 'Incremental coordinates (deprecated) used'); }
          else if (g === 54 || g === 55 || g === 4) { /* no effect */ }
          else warn('g' + g, `G${g} ignored`);
          break;
        }
        case 'X': x = coord(s); break;
        case 'Y': y = coord(s); break;
        case 'I': i = coord(s); break;
        case 'J': j = coord(s); break;
        case 'D': d = parseInt(s, 10); break;
        case 'M': { const mm = parseInt(s, 10); if (mm === 2 || mm === 0 || mm === 30) ended = true; break; }
        case 'N': break; // sequence numbers (old files)
        default: warn('code:' + L, `Unknown code ${L} ignored`);
      }
    }
    const hasXY = x !== null || y !== null;
    if (d !== null && d >= 10) {
      const ap = apertures.get(d);
      if (!ap) {
        if (!fsSet && !apertures.size) {
          rs274d = true;
          const ph: Aperture = { kind: 'C', params: [0.1 / (unit || 25.4)], parts: [[circleRing(0, 0, 0.05)]], diameter: 0.1 };
          apertures.set(d, ph); cur = ph; curD = d;
        } else { warn('undef-ap:' + d, `Aperture D${d} is not defined`); cur = null; curD = d; }
      } else { cur = ap; curD = d; }
      if (!hasXY) return;
      d = lastOp || null;
    }
    if (!hasXY && d === null) return;
    if (d === null) {
      if (!hasXY) return;
      d = lastOp || 1;
      if (lastOp !== 1) warn('modal', 'Coordinates without an operation code');
    }
    if (d < 1 || d > 3) return;
    lastOp = d;
    let nx = cx, ny = cy;
    if (incremental) { nx = cx + (x ?? 0); ny = cy + (y ?? 0); }
    else {
      if (x !== null || y !== null) {
        const [mx, my] = mapXY(x ?? Number.NaN, y ?? Number.NaN);
        if (x !== null) nx = mx;
        if (y !== null) ny = my;
      }
    }
    if (!Number.isFinite(nx) || !Number.isFinite(ny)) { warn('bad-coord', 'Unreadable coordinates skipped'); return; }
    operate(d, nx, ny, i ?? 0, j ?? 0, i !== null || j !== null);
  };

  // ---- scan
  const s = text;
  const len = s.length;
  let pos = 0;
  let nextPct = s.indexOf('%');
  while (pos < len && !ended) {
    const c = s.charCodeAt(pos);
    if (c === 37 /* % */) {
      const e = s.indexOf('%', pos + 1);
      const block = s.slice(pos + 1, e < 0 ? len : e);
      pos = e < 0 ? len : e + 1;
      try { extended(block); } catch (err) { warn('ext-err', `Extended command failed: ${(err as Error).message}`); }
      continue;
    }
    if (c <= 32) { pos++; continue; }
    let e = s.indexOf('*', pos);
    if (e < 0) e = len;
    // a word never spans a '%' (the next '%' position is cached: searching it for every word is quadratic)
    if (nextPct >= 0 && nextPct < pos) nextPct = s.indexOf('%', pos);
    const pc = nextPct;
    if (pc >= 0 && pc < e) { const w = s.slice(pos, pc).trim(); if (w) word(w); pos = pc; continue; }
    const w = s.slice(pos, e).trim();
    pos = e + 1;
    try { word(w); } catch (err) { warn('word-err', `Command "${w.slice(0, 20)}" failed: ${(err as Error).message}`); }
  }
  if (region) { warn('open-region', 'Region statement not closed at the end of the file'); finishRegion(); }
  while (stack.length > 1) {
    const top = stack[stack.length - 1];
    if (top.kind === 'sr') extended('SR');
    else { stack.pop(); warn('open-ab', 'Block aperture not closed at the end of the file'); }
  }
  if (!ended) warn('no-m02', 'No M02 at the end: the file may be truncated');
  if (!fsSet && !rs274d) warn('no-fs', 'No format specification (%FS); 2.4 assumed');
  if (rs274d) warn('rs274d', `${name || 'File'} is Standard Gerber (RS-274-D): its apertures live in a separate wheel file that is not read; shapes are drawn with thin placeholder lines`);
  void curD;
  let objs = root.objs;
  if (ir) {
    const xf: Xf = { mx: false, my: false, rot: ir, s: 1, tx: 0, ty: 0 };
    objs = objs.map((o) => {
      const parts = o.parts.map((p) => xfPart(p, xf));
      const c: PObj = { ...o, parts, bb: partsBB(parts) };
      if (o.path) { const pp = new Float64Array(o.path.length); for (let k = 0; k < pp.length; k += 2) { const q = xfPoint(o.path[k], o.path[k + 1], xf); pp[k] = q[0]; pp[k + 1] = q[1]; } c.path = pp; }
      return c;
    });
  }
  return { objs, attrs, units: unitName, invert, warnings, stats, comps, nets };
}

/** thermal primitive: ring between ri and ro with four gaps of width gap on the axes, as four pieces */
function thermal(x: number, y: number, ro: number, ri: number, gap: number): Ring[] {
  const out: Ring[] = [];
  const g = gap / 2;
  if (ro <= g) return out;
  for (let q = 0; q < 4; q++) {
    const base = (q * Math.PI) / 2;
    // outer arc from angle where x = g to where y = g (in the rotated quadrant frame)
    const ao0 = Math.asin(Math.min(1, g / ro)), ao1 = Math.PI / 2 - ao0;
    const pts: number[] = [];
    if (ao1 <= ao0) continue;
    arcPts(0, 0, ro, ro, ao0, ao1 - ao0, pts, true);
    if (ri > g * Math.SQRT2) {
      const ai0 = Math.asin(g / ri), ai1 = Math.PI / 2 - ai0;
      const inner: number[] = [];
      arcPts(0, 0, ri, ri, ai0, ai1 - ai0, inner, true);
      for (let k = inner.length - 2; k >= 0; k -= 2) pts.push(inner[k], inner[k + 1]);
    } else pts.push(g, g);
    const c = Math.cos(base), s = Math.sin(base);
    const r = new Float64Array(pts.length);
    for (let k = 0; k < pts.length; k += 2) { r[k] = x + pts[k] * c - pts[k + 1] * s; r[k + 1] = y + pts[k] * s + pts[k + 1] * c; }
    out.push(r);
  }
  return out;
}

/** macro arithmetic: + - x / unary, brackets, $n variables */
export function evalExpr(src: string, vars: Map<number, number>): number {
  const s = src.replace(/\s+/g, '').replace(/X/g, 'x');
  let p = 0;
  const num = (): number => {
    const c = s[p];
    if (c === '(') { p++; const v = add(); if (s[p] === ')') p++; return v; }
    if (c === '-') { p++; return -num(); }
    if (c === '+') { p++; return num(); }
    if (c === '$') {
      p++;
      const st = p;
      while (p < s.length && s[p] >= '0' && s[p] <= '9') p++;
      return vars.get(parseInt(s.slice(st, p), 10)) ?? 0;
    }
    const st = p;
    while (p < s.length && /[\d.eE]/.test(s[p]) && !(s[p] === 'e' || s[p] === 'E')) p++;
    const v = parseFloat(s.slice(st, p));
    return Number.isFinite(v) ? v : 0;
  };
  const mul = (): number => {
    let v = num();
    while (p < s.length && (s[p] === 'x' || s[p] === '/')) { const o = s[p++]; const r = num(); v = o === 'x' ? v * r : r === 0 ? 0 : v / r; }
    return v;
  };
  const add = (): number => {
    let v = mul();
    while (p < s.length && (s[p] === '+' || s[p] === '-')) { const o = s[p++]; const r = mul(); v = o === '+' ? v + r : v - r; }
    return v;
  };
  if (!s) return 0;
  return add();
}

export type { BB };
