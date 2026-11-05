// W2D (WHIP! 2D graphics stream inside classic DWF files) decoder.
// Clean-room implementation from the public "DWF format" description published by Autodesk and hosted by
// Paul Bourke (paulbourke.net/dataformats/whip/), plus analysis of sample streams. Opcodes not in that document
// stop decoding with a warning (partial result).

import { ACI_RGB, rgbHex } from './aci.ts';
import { ringsToPolygons } from './geom.ts';
import type { SheetItem } from './types.ts';

export interface W2dResult {
  items: SheetItem[];         // in W2D logical units (caller maps them to paper mm)
  warnings: string[];
  stats: Record<string, number>;
  layers: Map<number, string>;
  unknown: Map<string, number>;
  complete: boolean;
}

const WS = (b: number) => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d;

export function decodeW2d(d: Uint8Array, maxItems = 3_000_000): W2dResult {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const items: SheetItem[] = [];
  const warnings: string[] = [];
  const stats: Record<string, number> = {};
  const unknown = new Map<string, number>();
  const layers = new Map<number, string>();
  let p = 0;
  // header "(W2D V06.00)" or "(DWF V00.55)"
  if (d[0] === 0x28) { while (p < d.length && d[p] !== 0x29) p++; p++; }
  let cx = 0, cy = 0; // current point for relative coordinates
  let colorMap: Array<[number, number, number]> = ACI_RGB.map((c) => [c[0], c[1], c[2]] as [number, number, number]);
  let color = '#000000';
  let fill = false;
  let visible = true;
  let layer = '';
  let lineWeight = 0; // logical units
  let fontHeight = 0;
  let complete = true;
  const stat = (k: string) => { stats[k] = (stats[k] ?? 0) + 1; };
  const rel = (): [number, number] => { cx += dv.getInt32(p, true); cy += dv.getInt32(p + 4, true); p += 8; return [cx, cy]; };
  const rel16 = (): [number, number] => { cx += dv.getInt16(p, true); cy += dv.getInt16(p + 2, true); p += 4; return [cx, cy]; };
  const count = (): number => { let n = d[p++]; if (n === 0) { n = dv.getUint16(p, true) + 256; p += 2; } return n; };
  const out = (it: SheetItem) => {
    if (!visible) return;
    if (items.length >= maxItems) return;
    if (layer) it.layer = layer;
    items.push(it);
  };
  const lw = () => (lineWeight > 0 ? lineWeight : undefined);
  const polyline = (pts: number[]) => {
    if (fill && pts.length >= 6) out({ kind: 'fill', pts, color });
    else { const it: SheetItem = { kind: 'line', pts, color }; const w = lw(); if (w) (it as { wu?: number }).wu = w; out(it); }
  };
  const asciiInt = (): number => {
    while (p < d.length && WS(d[p])) p++;
    let s = '';
    while (p < d.length && ((d[p] >= 0x30 && d[p] <= 0x39) || d[p] === 0x2d || d[p] === 0x2b)) s += String.fromCharCode(d[p++]);
    if (d[p] === 0x2c) p++;
    return parseInt(s, 10);
  };
  const asciiPt = (): [number, number] => { const x = asciiInt(); const y = asciiInt(); return [x, y]; };

  try {
    while (p < d.length) {
      const b = d[p];
      if (WS(b)) { p++; continue; }
      if (b === 0x28) { // extended ASCII
        const start = p;
        p++;
        let name = '';
        while (p < d.length && !WS(d[p]) && d[p] !== 0x28 && d[p] !== 0x29) name += String.fromCharCode(d[p++]);
        const bodyStart = p;
        // find matching paren, honouring quotes and nested binary blocks
        let depth = 1;
        let q = p;
        while (q < d.length && depth > 0) {
          const c = d[q];
          if (c === 0x27) { q++; while (q < d.length && d[q] !== 0x27) { if (d[q] === 0x5c) q++; q++; } q++; continue; }
          if (c === 0x7b) { const len = dv.getUint32(q + 1, true); q += 5 + len; continue; }
          if (c === 0x28) depth++;
          else if (c === 0x29) depth--;
          q++;
        }
        const body = d.subarray(bodyStart, q - 1);
        stat('(' + name);
        if (name === 'EndOfDWF') break;
        handleExt(name, body);
        p = q;
        void start;
        continue;
      }
      if (b === 0x7b) { // extended binary
        const len = dv.getUint32(p + 1, true);
        const op = dv.getUint16(p + 5, true);
        stat('{' + op.toString(16));
        if (len === 0) { warnings.push('W2D extended binary block without length, stopped'); complete = false; break; }
        p = p + 5 + len;
        continue;
      }
      p++;
      switch (b) {
        case 0x6c: { // 'l' line 32-bit relative
          const a = rel(), c = rel();
          polylineStroke([a[0], a[1], c[0], c[1]]);
          stat('l'); break;
        }
        case 0x0c: { // Ctrl-L line 16-bit
          const a = rel16(), c = rel16();
          polylineStroke([a[0], a[1], c[0], c[1]]);
          stat('^L'); break;
        }
        case 0x8c: { // lines 16-bit, count
          const n = count();
          for (let i = 0; i < n; i++) { const a = rel16(), c = rel16(); polylineStroke([a[0], a[1], c[0], c[1]]); }
          stat('x8c'); break;
        }
        case 0x70: { // 'p' polyline 32-bit
          const n = count();
          const pts: number[] = [];
          for (let i = 0; i < n; i++) { const a = rel(); pts.push(a[0], a[1]); }
          polyline(pts); stat('p'); break;
        }
        case 0x10: { // Ctrl-P polyline 16-bit
          const n = count();
          const pts: number[] = [];
          for (let i = 0; i < n; i++) { const a = rel16(); pts.push(a[0], a[1]); }
          polyline(pts); stat('^P'); break;
        }
        case 0x74: case 0x14: { // 't' polytriangle 32-bit / Ctrl-T 16-bit (strip)
          const n = count();
          const pts: number[] = [];
          for (let i = 0; i < n; i++) { const a = b === 0x74 ? rel() : rel16(); pts.push(a[0], a[1]); }
          for (let i = 0; i + 2 < n; i++) out({ kind: 'fill', pts: [pts[i * 2], pts[i * 2 + 1], pts[i * 2 + 2], pts[i * 2 + 3], pts[i * 2 + 4], pts[i * 2 + 5]], color });
          stat(b === 0x74 ? 't' : '^T'); break;
        }
        case 0x72: { // 'r' circle 32-bit
          const c = rel();
          const r = dv.getUint32(p, true); p += 4;
          arcOut(c[0], c[1], r, 0, Math.PI * 2, true); stat('r'); break;
        }
        case 0x12: { // Ctrl-R circle 16-bit
          const c = rel16();
          const r = dv.getUint16(p, true); p += 2;
          arcOut(c[0], c[1], r, 0, Math.PI * 2, true); stat('^R'); break;
        }
        case 0x92: { // circular arc 32-bit: centre, radius, start, end (1/65536 turn)
          const c = rel();
          const r = dv.getUint32(p, true); p += 4;
          const a0 = dv.getUint16(p, true), a1 = dv.getUint16(p + 2, true); p += 4;
          arcOut(c[0], c[1], r, (a0 / 65536) * Math.PI * 2, (a1 / 65536) * Math.PI * 2, a0 === a1);
          stat('x92'); break;
        }
        case 0x65: { // 'e' ellipse 32-bit: centre, major, minor, start, end, tilt
          const c = rel();
          const ma = dv.getUint32(p, true), mi = dv.getUint32(p + 4, true); p += 8;
          const s0 = dv.getUint16(p, true), s1 = dv.getUint16(p + 2, true), tilt = dv.getUint16(p + 4, true); p += 6;
          ellipseOut(c[0], c[1], ma, mi, (s0 / 65536) * Math.PI * 2, (s1 / 65536) * Math.PI * 2, (tilt / 65536) * Math.PI * 2, s0 === s1);
          stat('e'); break;
        }
        case 0x62: { // 'b' polybezier 32-bit: count, start point, then count x 3 points
          const n = count();
          const s = rel();
          const pts: number[] = [s[0], s[1]];
          for (let i = 0; i < n; i++) {
            const c1 = rel(), c2 = rel(), e = rel();
            const x0 = pts[pts.length - 2], y0 = pts[pts.length - 1];
            for (let k = 1; k <= 8; k++) {
              const t = k / 8, u = 1 - t;
              pts.push(u * u * u * x0 + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * e[0], u * u * u * y0 + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * e[1]);
            }
          }
          polylineStroke(pts); stat('b'); break;
        }
        case 0x6b: case 0x0b: { // 'k' contour set 32-bit / Ctrl-K 16-bit
          const nc = count();
          const counts: number[] = [];
          for (let i = 0; i < nc; i++) counts.push(count());
          const rings: number[][] = [];
          for (const n of counts) {
            const r: number[] = [];
            for (let i = 0; i < n; i++) { const a = b === 0x6b ? rel() : rel16(); r.push(a[0], a[1]); }
            rings.push(r);
          }
          if (fill) for (const poly of ringsToPolygons(rings)) out({ kind: 'fill', pts: poly, color });
          else for (const r of rings) polylineStroke([...r, r[0], r[1]]);
          stat(b === 0x6b ? 'k' : '^K'); break;
        }
        case 0x63: { // 'c' colour index
          const i = d[p++];
          const c = colorMap[i] ?? [0, 0, 0];
          color = mapColor(c[0], c[1], c[2]);
          stat('c'); break;
        }
        case 0x03: { // Ctrl-C RGBA
          const r = d[p], g = d[p + 1], bb = d[p + 2];
          p += 4;
          color = mapColor(r, g, bb);
          stat('^C'); break;
        }
        case 0x46: fill = true; stat('F'); break;
        case 0x66: fill = false; stat('f'); break;
        case 0x56: visible = true; stat('V'); break;
        case 0x76: visible = false; stat('v'); break;
        case 0x4f: { cx = dv.getUint32(p, true); cy = dv.getUint32(p + 4, true); p += 8; stat('O'); break; }
        case 0x73: p += 4; stat('s'); break; // marker size 32
        case 0x53: asciiInt(); stat('S'); break;
        case 0x87: p += 2; stat('x87'); break; // marker glyph
        case 0x47: asciiInt(); stat('G'); break;
        case 0x6d: case 0x8d: { // polymarker 32 / 16
          const n = count();
          for (let i = 0; i < n; i++) { const a = b === 0x6d ? rel() : rel16(); out({ kind: 'line', pts: [a[0], a[1], a[0], a[1]], color }); }
          stat(b === 0x6d ? 'm' : 'x8d'); break;
        }
        case 0x43: { // 'C' ascii colour index
          const i = asciiInt();
          const c = colorMap[i] ?? [0, 0, 0];
          color = mapColor(c[0], c[1], c[2]);
          stat('C'); break;
        }
        case 0x4c: { // 'L' ascii line (absolute)
          const a = asciiPt(), c = asciiPt();
          cx = c[0]; cy = c[1];
          polylineStroke([a[0], a[1], c[0], c[1]]); stat('L'); break;
        }
        case 0x50: { // 'P' ascii polyline
          const n = asciiInt();
          const pts: number[] = [];
          for (let i = 0; i < n; i++) { const a = asciiPt(); pts.push(a[0], a[1]); }
          if (n) { cx = pts[pts.length - 2]; cy = pts[pts.length - 1]; }
          polyline(pts); stat('P'); break;
        }
        case 0x52: { // 'R' ascii circle: centre, radius
          const c = asciiPt();
          const r = asciiInt();
          cx = c[0]; cy = c[1];
          arcOut(c[0], c[1], r, 0, Math.PI * 2, true); stat('R'); break;
        }
        case 0x4d: { // 'M' ascii polymarker
          const n = asciiInt();
          for (let i = 0; i < n; i++) { const a = asciiPt(); out({ kind: 'line', pts: [a[0], a[1], a[0], a[1]], color }); }
          stat('M'); break;
        }
        case 0x18: { // Ctrl-X text (simple form): flags?, height, position, count, UTF-16 chars
          p += 4; // <Lf>
          const h = dv.getInt32(p, true); p += 4;
          const a = rel();
          const n = count();
          let s = '';
          for (let i = 0; i < n; i++) { s += String.fromCharCode(dv.getUint16(p, true)); p += 2; }
          if (s.trim()) out({ kind: 'text', x: a[0], y: a[1], text: s, size: Math.abs(h) || fontHeight || 1, color });
          stat('^X'); break;
        }
        default: {
          const k = '0x' + b.toString(16);
          unknown.set(k, (unknown.get(k) ?? 0) + 1);
          warnings.push(`W2D opcode ${k} at byte ${p - 1} is not in the public opcode list, stopped decoding this stream`);
          complete = false;
          p = d.length;
        }
      }
    }
  } catch (e) {
    warnings.push(`W2D stream ended unexpectedly at byte ${p} (${(e as Error).message})`);
    complete = false;
  }
  return { items, warnings, stats, layers, unknown, complete };

  function polylineStroke(pts: number[]) {
    const it: SheetItem = { kind: 'line', pts, color };
    const w = lw();
    if (w) (it as { wu?: number }).wu = w;
    out(it);
  }
  function arcOut(x: number, y: number, r: number, a0: number, a1: number, full: boolean) {
    if (fill && full) {
      const pts: number[] = [];
      for (let i = 0; i < 48; i++) { const a = (i / 48) * Math.PI * 2; pts.push(x + r * Math.cos(a), y + r * Math.sin(a)); }
      out({ kind: 'fill', pts, color });
      return;
    }
    const it: SheetItem = { kind: 'arc', cx: x, cy: y, r, a0: full ? 0 : a0, a1: full ? Math.PI * 2 : a1, color };
    const w = lw();
    if (w) (it as { wu?: number }).wu = w;
    out(it);
  }
  function ellipseOut(x: number, y: number, ma: number, mi: number, a0: number, a1: number, tilt: number, full: boolean) {
    if (ma === mi && !tilt) return arcOut(x, y, ma, a0, a1, full);
    let sweep = full ? Math.PI * 2 : a1 - a0;
    if (!Number.isFinite(sweep) || Math.abs(sweep) > 1e6) sweep = Math.PI * 2;
    while (sweep <= 0) sweep += Math.PI * 2;
    const n = 64;
    const pts: number[] = [];
    const ct = Math.cos(tilt), st = Math.sin(tilt);
    for (let i = 0; i <= n; i++) {
      const a = a0 + (sweep * i) / n;
      const ex = ma * Math.cos(a), ey = mi * Math.sin(a);
      pts.push(x + ex * ct - ey * st, y + ex * st + ey * ct);
    }
    if (fill && full) out({ kind: 'fill', pts, color }); else polylineStroke(pts);
  }
  function handleExt(name: string, body: Uint8Array) {
    const text = () => { let s = ''; for (let i = 0; i < body.length && i < 4096; i++) s += String.fromCharCode(body[i]); return s; };
    switch (name) {
      case 'Layer': {
        const m = text().match(/^\s*(\d+)\s*(?:'((?:[^'\\]|\\.)*)'|(\S[^)]*))?/);
        if (m) {
          const id = +m[1];
          const nm = (m[2] ?? m[3] ?? '').replace(/\\(.)/g, '$1').trim();
          if (nm) layers.set(id, nm);
          layer = layers.get(id) ?? `Layer ${id}`;
        }
        break;
      }
      case 'LineWeight': { const v = parseInt(text(), 10); if (Number.isFinite(v)) lineWeight = v; break; }
      case 'Color': {
        const m = text().match(/(\d+),(\d+),(\d+),(\d+)/);
        if (m) color = mapColor(+m[1], +m[2], +m[3]);
        break;
      }
      case 'ColorMap': {
        const nums = text().match(/\d+/g)?.map(Number) ?? [];
        const n = nums[0] ?? 0;
        const cm: Array<[number, number, number]> = [];
        for (let i = 0; i < n && 1 + i * 4 + 3 < nums.length + 1; i++) cm.push([nums[1 + i * 4], nums[2 + i * 4], nums[3 + i * 4]]);
        if (cm.length) colorMap = cm;
        break;
      }
      case 'Font': {
        const m = text().match(/\(Height\s+(-?\d+)\)/);
        if (m) fontHeight = Math.abs(+m[1]);
        break;
      }
      case 'Text': {
        // (Text x,y 'string' ...)
        const s = text();
        const m = s.match(/^\s*(-?\d+),(-?\d+)\s+'((?:[^'\\]|\\.)*)'/);
        if (m) out({ kind: 'text', x: +m[1], y: +m[2], text: m[3].replace(/\\(.)/g, '$1'), size: fontHeight || 1, color });
        break;
      }
      case 'Contour': case 'ContourSet': {
        const nums = text().match(/-?\d+/g)?.map(Number) ?? [];
        let i = 0;
        const nc = nums[i++] ?? 0;
        const counts: number[] = [];
        for (let k = 0; k < nc; k++) counts.push(nums[i++]);
        const rings: number[][] = [];
        for (const n of counts) { const r: number[] = []; for (let k = 0; k < n; k++) { r.push(nums[i++], nums[i++]); } rings.push(r); }
        if (fill) for (const poly of ringsToPolygons(rings)) out({ kind: 'fill', pts: poly, color });
        break;
      }
      default: break;
    }
  }
}

function mapColor(r: number, g: number, b: number): string {
  if (r === 255 && g === 255 && b === 255) return '#000000';
  return rgbHex(r, g, b);
}
