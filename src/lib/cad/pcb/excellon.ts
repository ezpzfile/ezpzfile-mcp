// Excellon / XNC drill and rout reader, own code. Base: the public Ucamco "XNC Format Specification" rev 2021.11
// (a strict subset of IPC-NC-349). The wider dialect (zero omission LZ/TZ, FILE_FORMAT / FMAT / 000.000 digit
// hints, G85 slots, R repeats, M71/M72, ICI and G91 incremental, I/J arcs, header-less files with tool changes on
// M00) was learned from the sample files listed in NOTEBOOK.md.
import { arcPts, circleRing, emptyBB, bbAddRing, partsBB, stadium } from './geom.ts';
import type { PObj } from './model.ts';

export interface DrillResult {
  objs: PObj[];
  attrs: Record<string, string>;
  units: 'mm' | 'inch';
  /** coordinate format was guessed (no header): coordinates may need a scale fix against the copper layers */
  guessed: boolean;
  plated: 'plated' | 'nonplated' | 'mixed' | '?';
  warnings: string[];
  stats: Record<string, number>;
}

export function sniffExcellon(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 4096);
  let s = '';
  for (let i = 0; i < n; i++) { const c = bytes[i]; if (c === 0) return false; s += String.fromCharCode(c); }
  if (/^\s*(;[^\n]*\n\s*)*M48\s*$/m.test(s) && /^\s*M48/m.test(s)) return true;
  if (/^\s*M48\s*$/m.test(s) && /(METRIC|INCH|T\d+C[\d.])/.test(s)) return true;
  // header-less: '%' line, then G90/G05/T codes and X..Y.. hits
  if (/^%\s*$/m.test(s) && /^(G90|G05|T\d+)\s*$/m.test(s) && /^X-?\d+Y-?\d+\s*$/m.test(s) && !/%FS|%MO|%AD/.test(s)) return true;
  if (/^;\s*(LEADER|HEADER|FILE)\s*:/m.test(s) && /^X-?\d+Y-?\d+\s*$/m.test(s)) return true;
  return false;
}

export function readExcellon(text: string): DrillResult {
  const warnings: string[] = [];
  const warned = new Set<string>();
  const warn = (k: string, m?: string) => { if (!warned.has(k)) { warned.add(k); warnings.push(m ?? k); } };
  const attrs: Record<string, string> = {};
  const objs: PObj[] = [];
  const stats: Record<string, number> = { holes: 0, slots: 0, routs: 0, tools: 0 };

  let unit = 0; // mm per unit
  let intD = -1, decD = -1;
  let zeros: 'LZ' | 'TZ' | '' = '';
  let incremental = false;
  let inHeader = false, sawHeader = false;
  const tools = new Map<number, { d: number; plated?: boolean; fn?: string }>();
  let pendingFn: string | undefined;
  const commentSizes: Array<{ d: number; plated?: boolean }> = [];
  let fritzingNpthBelow = -1;
  let tool = -1;
  let cx = 0, cy = 0;
  let routMode = false, down = false;
  let rmode: 0 | 1 | 2 | 3 = 1;
  let filePlated: boolean | undefined;
  let m00Index = 0;
  let headerless = false;
  let ended = false;

  const digits = () => {
    const inch = unit === 25.4;
    return { i: intD >= 0 ? intD : inch ? 2 : 3, d: decD >= 0 ? decD : inch ? 4 : 3 };
  };
  const num = (s: string): number => {
    if (!unit) { unit = 25.4; warn('no-unit', 'Drill file without a unit: inch assumed'); }
    if (s.includes('.')) return parseFloat(s) * unit;
    let neg = false;
    if (s[0] === '-' || s[0] === '+') { neg = s[0] === '-'; s = s.slice(1); }
    const { i, d } = digits();
    let v: number;
    if (zeros === 'LZ') {
      // leading zeros present, trailing ones left out: pad on the right
      const want = i + d;
      const t = s.length < want ? s + '0'.repeat(want - s.length) : s;
      v = parseInt(t, 10) / 10 ** (t.length - i);
    } else v = parseInt(s, 10) / 10 ** d;
    return (neg ? -v : v) * unit;
  };
  const toolD = (): number => {
    const t = tools.get(tool);
    if (t) return t.d;
    warn('undef-tool:' + tool, `Tool T${tool} has no size; 0.5 mm assumed`);
    return 0.5;
  };
  const platedOf = (): boolean | undefined => {
    const t = tools.get(tool);
    if (t?.plated !== undefined) return t.plated;
    if (fritzingNpthBelow > 0) return tool >= fritzingNpthBelow;
    return filePlated;
  };
  const fnOf = () => tools.get(tool)?.fn;
  const hole = (x: number, y: number) => {
    const d = toolD();
    const parts = [[circleRing(x, y, d / 2)]];
    const pl = platedOf();
    objs.push({ dark: true, parts, bb: [x - d / 2, y - d / 2, x + d / 2, y + d / 2], t: 'hole', w: d, fn: fnOf() ?? (pl === undefined ? undefined : pl ? 'PTH' : 'NPTH') });
    stats.holes++;
  };
  const slot = (path: number[], kind: 'slot' | 'rout') => {
    const d = toolD();
    const parts = [];
    for (let k = 0; k + 3 < path.length; k += 2) parts.push([stadium(path[k], path[k + 1], path[k + 2], path[k + 3], d / 2)]);
    const pp = Float64Array.from(path);
    const pl = platedOf();
    const o: PObj = { dark: true, parts, bb: emptyBB(), t: 'slot', w: d, path: pp, fn: fnOf() ?? (pl === undefined ? undefined : pl ? 'PTH' : 'NPTH') };
    o.bb = parts.length ? partsBB(parts) : (bbAddRing(o.bb, pp), o.bb);
    objs.push(o);
    if (kind === 'slot') stats.slots++; else stats.routs++;
  };

  const parseXY = (s: string) => {
    const mx = /X([-+]?[\d.]+)/.exec(s), my = /Y([-+]?[\d.]+)/.exec(s);
    let x = cx, y = cy;
    if (incremental) { if (mx) x = cx + num(mx[1]); if (my) y = cy + num(my[1]); }
    else { if (mx) x = num(mx[1]); if (my) y = num(my[1]); }
    return { x, y, has: !!(mx || my) };
  };

  const lines = text.split(/\r\n|\r|\n/);
  for (let li = 0; li < lines.length && !ended; li++) {
    let L = lines[li].trim();
    if (!L) continue;
    if (L[0] === ';' || L[0] === '(') {
      const c = L.replace(/^[;(]\s*/, '');
      let m: RegExpExecArray | null;
      if ((m = /#@!\s*(T[FAO])\.?\s*(\S.*)$/.exec(c))) {
        const body = m[2].replace(/\)\s*$/, '');
        const k = body.indexOf(',');
        const nm = (k < 0 ? body : body.slice(0, k)).replace(/^\./, '');
        const val = k < 0 ? '' : body.slice(k + 1);
        if (m[1] === 'TF') {
          attrs[nm] = val;
          if (nm === 'FileFunction') { if (/^NonPlated/i.test(val)) filePlated = false; else if (/^Plated/i.test(val)) filePlated = true; }
        } else if (m[1] === 'TA' && nm === 'AperFunction') pendingFn = val;
      } else if ((m = /FILE_FORMAT\s*=\s*(\d+)\s*:\s*(\d+)/i.exec(c))) { intD = +m[1]; decD = +m[2]; }
      else if ((m = /^TYPE\s*=\s*(NON[_-]?PLATED|PLATED)/i.exec(c))) filePlated = !/NON/i.test(m[1]);
      else if ((m = /Holesize\s+(\d+)\.?\s*=\s*([\d.]+).*?\b(NON_PLATED|PLATED|OPTIONAL)?\b.*?\b(MILS|MM|INCH|MICRONS)\b/i.exec(c))) {
        const v = parseFloat(m[2]);
        const u = /MILS/i.test(m[4]) ? 0.0254 : /INCH/i.test(m[4]) ? 25.4 : /MICRON/i.test(m[4]) ? 0.001 : 1;
        const pl = m[3] ? !/NON/i.test(m[3]) : undefined;
        commentSizes[parseInt(m[1], 10)] = { d: v * u, plated: pl };
        if (!unit && !sawHeader) unit = u === 1 ? 1 : u === 0.0254 || u === 25.4 ? 25.4 : 0;
        const t = /^T(\d+)\s/.exec(c);
        if (t) commentSizes[parseInt(t[1], 10)] = { d: v * u, plated: pl };
      } else if ((m = /NON-PLATED HOLES START AT T(\d+)/i.exec(c))) { /* fritzing */ }
      else if ((m = /THROUGH \(PLATED\) HOLES START AT T(\d+)/i.exec(c))) fritzingNpthBelow = parseInt(m[1], 10);
      else if ((m = /FORMAT=\{[-\d]*:[-\d]*\/\s*(absolute|incremental)\s*\/\s*(inch|metric|mm)/i.exec(c))) { if (/incremental/i.test(m[1])) incremental = true; }
      continue;
    }
    L = L.toUpperCase();
    // strip inline comments
    const sc = L.indexOf(';');
    if (sc > 0) L = L.slice(0, sc).trim();
    if (L === 'M48') { inHeader = true; sawHeader = true; continue; }
    if (L === '%' || L === 'M95') { inHeader = false; if (!sawHeader) headerless = true; continue; }
    let m: RegExpExecArray | null;
    if ((m = /^(METRIC|INCH)\b(.*)$/.exec(L))) {
      unit = m[1] === 'METRIC' ? 1 : 25.4;
      const rest = m[2];
      if (/LZ/.test(rest)) zeros = 'LZ'; else if (/TZ/.test(rest)) zeros = 'TZ';
      const f = /(0+)\.(0+)/.exec(rest);
      if (f) { intD = f[1].length; decD = f[2].length; }
      continue;
    }
    if (L === 'M71') { unit = 1; continue; }
    if (L === 'M72') { unit = 25.4; continue; }
    if ((m = /^FMAT,(\d)/.exec(L))) { if (m[1] === '1') warn('fmat1', 'FMAT,1 (old Excellon format 1) commands may be misread'); continue; }
    if (/^(VER|DETECT|ATC|OSTOP|BLKD|SBK|SG|TCST|RUNTIME|AFS|CCW|CP|DN|DTMDIST|FSB|HBCK|HPCK|NCSL|OM48|OSTOP|PCKPARAM|PF|PPR|PVS|RC|RCP|RD|RH|RO|RS|RTP|TR|VER|WD|Z\+|ZA|ZC|ZD|ZS)\b/.test(L) && !/^T\d/.test(L)) continue;
    if ((m = /^ICI,?(ON|OFF)/.exec(L))) { incremental = m[1] === 'ON'; continue; }
    // tool definition / selection
    if ((m = /^T(\d+)(.*)$/.exec(L))) {
      const t = parseInt(m[1], 10);
      const rest = m[2];
      const c = /C([\d.]+)/.exec(rest);
      if (c) {
        let d = parseFloat(c[1]);
        if (!unit) { unit = d > 0.5 && d < 30 ? 1 : 25.4; }
        if (!c[1].includes('.')) { const { i } = digits(); void i; d = parseFloat(c[1]) / 10 ** digits().d; }
        const entry = { d: d * unit, plated: undefined as boolean | undefined, fn: pendingFn ? pendingFn.split(',').find((x) => /PTH|Drill|Rout|Via|Component|Mechanical|Castellated|Press|Backdrill/i.test(x)) ?? pendingFn.split(',')[0] : undefined };
        if (pendingFn) { if (/^NonPlated/i.test(pendingFn)) entry.plated = false; else if (/^Plated/i.test(pendingFn)) entry.plated = true; }
        tools.set(t, entry);
        stats.tools++;
        if (inHeader) continue;
      }
      tool = t;
      if (t > 0 && !tools.has(t) && commentSizes[t]) tools.set(t, { d: commentSizes[t].d, plated: commentSizes[t].plated });
      // coordinates on the same line (rare)
      if (!/[XY]/.test(rest)) continue;
      L = rest.replace(/^[^XYG]*/, '');
    }
    if (inHeader) continue;
    if (L === 'M30' || L === 'M02') { ended = true; continue; }
    if (L === 'M00') {
      // header-less files (Cadence Allegro "TOOL-SELECT NO"): every M00 is a manual tool change, in the hole size order
      m00Index++;
      if (commentSizes.length && !tools.has(m00Index + 1) && commentSizes[m00Index + 1]) { tools.set(m00Index + 1, { d: commentSizes[m00Index + 1].d, plated: commentSizes[m00Index + 1].plated }); }
      if (commentSizes[m00Index + 1]) tool = m00Index + 1;
      continue;
    }
    if (L === 'G90') { incremental = false; continue; }
    if (L === 'G91') { incremental = true; continue; }
    if (L === 'G05' || L === 'G81') { routMode = false; down = false; continue; }
    if (L === 'M15') { down = true; continue; }
    if (L === 'M16' || L === 'M17') { down = false; continue; }
    if (/^(M\d+|G9[34]|G4[0-9]|G8[02-9]|G06)$/.test(L)) continue;
    // repeat: R<n>X<dx>Y<dy>
    if ((m = /^R(\d+)(.*)$/.exec(L))) {
      const n = parseInt(m[1], 10);
      const dx = /X([-+]?[\d.]+)/.exec(m[2]), dy = /Y([-+]?[\d.]+)/.exec(m[2]);
      const ddx = dx ? num(dx[1]) : 0, ddy = dy ? num(dy[1]) : 0;
      for (let k = 0; k < n && k < 100000; k++) { cx += ddx; cy += ddy; hole(cx, cy); }
      continue;
    }
    // slot: X..Y..G85X..Y..
    const g85 = L.indexOf('G85');
    if (g85 > 0) {
      const a = parseXY(L.slice(0, g85));
      cx = a.x; cy = a.y;
      const b = parseXY(L.slice(g85 + 3));
      slot([a.x, a.y, b.x, b.y], 'slot');
      cx = b.x; cy = b.y;
      continue;
    }
    if (tool < 0 && commentSizes.length && /[XY]/.test(L)) { tool = 1; if (!tools.has(1) && commentSizes[1]) tools.set(1, { d: commentSizes[1].d, plated: commentSizes[1].plated }); }
    const gm = /^G0?([0-3])(?!\d)(.*)$/.exec(L);
    if (gm) {
      const g = parseInt(gm[1], 10) as 0 | 1 | 2 | 3;
      const rest = gm[2];
      if (g === 0) { routMode = true; down = false; const p = parseXY(rest); cx = p.x; cy = p.y; rmode = 1; continue; }
      routMode = true;
      rmode = g;
      routTo(rest);
      continue;
    }
    if (/^[XY]/.test(L)) {
      if (routMode && down) { routTo(L); continue; }
      const p = parseXY(L);
      cx = p.x; cy = p.y;
      if (!routMode) hole(p.x, p.y);
      continue;
    }
    warn('unk:' + L.slice(0, 6), `Unknown drill command ${L.slice(0, 20)} ignored`);
  }

  function routTo(rest: string) {
    const p = parseXY(rest);
    if (!down) { cx = p.x; cy = p.y; return; }
    if (rmode === 1 || rmode === 0) slot([cx, cy, p.x, p.y], 'rout');
    else {
      const cw = rmode === 2;
      const a = /A([-+]?[\d.]+)/.exec(rest), ii = /I([-+]?[\d.]+)/.exec(rest), jj = /J([-+]?[\d.]+)/.exec(rest);
      let ccx: number, ccy: number;
      if (ii || jj) { ccx = cx + (ii ? num(ii[1]) : 0); ccy = cy + (jj ? num(jj[1]) : 0); }
      else if (a) {
        const r = Math.abs(num(a[1]));
        const mx = (cx + p.x) / 2, my = (cy + p.y) / 2;
        const dx = p.x - cx, dy = p.y - cy;
        const h = Math.hypot(dx, dy) / 2;
        const dist = Math.sqrt(Math.max(0, r * r - h * h));
        const nx = -dy / (2 * h || 1), ny = dx / (2 * h || 1);
        const sgn = cw ? -1 : 1;
        ccx = mx + nx * dist * sgn; ccy = my + ny * dist * sgn;
      } else { slot([cx, cy, p.x, p.y], 'rout'); cx = p.x; cy = p.y; return; }
      const r0 = Math.hypot(cx - ccx, cy - ccy), r1 = Math.hypot(p.x - ccx, p.y - ccy);
      const a0 = Math.atan2(cy - ccy, cx - ccx), a1 = Math.atan2(p.y - ccy, p.x - ccx);
      let sw = a1 - a0;
      if (cw) { while (sw >= 0) sw -= Math.PI * 2; } else { while (sw <= 0) sw += Math.PI * 2; }
      const pts: number[] = [];
      arcPts(ccx, ccy, r0, r1, a0, sw, pts, true);
      slot(pts, 'rout');
    }
    cx = p.x; cy = p.y;
  }

  const guessed = !sawHeader && (intD < 0 || headerless) && !/^[XY][-+\d]*\.\d/m.test(text);
  if (!sawHeader) warn('no-m48', 'Drill file without an M48 header: format guessed');
  let plated: DrillResult['plated'] = '?';
  let np = 0, pp = 0;
  for (const o of objs) { if (o.fn === 'NPTH' || /NonPlated/i.test(o.fn ?? '')) np++; else if (o.fn) pp++; }
  if (filePlated === true) plated = 'plated'; else if (filePlated === false) plated = 'nonplated';
  else if (np && pp) plated = 'mixed'; else if (np) plated = 'nonplated'; else if (pp) plated = 'plated';
  return { objs, attrs, units: unit === 1 ? 'mm' : 'inch', guessed, plated, warnings, stats };
}
