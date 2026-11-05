// Jw_cad JWW engine: .jww to RvtSheet2D (one paper sheet) with layer list.
// Clean-room implementation from the data format description published by the Jw_cad author
// (http://www.jwcad.net/jwdatafmt.txt, "Jw_cadのデータ形式", Version 7.02) and Microsoft's description of the MFC
// CArchive persistent object format (Technical Note TN002: object / class tags, CString and count encoding).
// No third-party JWW reader code was used.

import { arcSegs, itemsBounds, ringsToPolygons, saneItem } from './geom.ts';
import { CadError, type CadInfo, type CadResult, type LayerInfo, type Progress, type RvtSheet2D, type SheetItem } from './types.ts';

export interface JwwOptions { maxItems?: number }

const SIG = 'JwwData.';
/** pseudo layer for Jw_cad construction lines (補助線), hidden by default like in Jw_cad prints */
export const AUX_LAYER = '補助線 (construction lines)';
/** pseudo layer holding the paper outline from the 図面サイズ setting */
export const FRAME_LAYER = '用紙枠 (paper frame)';

export function sniffJww(b: Uint8Array): boolean {
  if (b.length < 12) return false;
  for (let i = 0; i < 8; i++) if (b[i] !== SIG.charCodeAt(i)) return false;
  return true;
}

// paper sizes by 図面サイズ number (mm, landscape)
const PAPER: Record<number, [number, number, string]> = {
  0: [1189, 841, 'A0'], 1: [841, 594, 'A1'], 2: [594, 420, 'A2'], 3: [420, 297, 'A3'], 4: [297, 210, 'A4'],
  8: [1682, 1189, '2A'], 9: [2378, 1682, '3A'], 10: [3364, 2378, '4A'], 11: [4756, 3364, '5A'],
  12: [10000, 7071, '10m'], 13: [50000, 35355, '50m'], 14: [100000, 70711, '100m'],
};

// default Jw_cad line colours 1..9 for a white sheet (used when the file's table is unusable)
const DEFAULT_COLORS = ['#ffffff', '#00a0c0', '#000000', '#00a000', '#b09000', '#c000c0', '#0000ff', '#008080', '#ff0000', '#808080'];

class Rd {
  b: Uint8Array; dv: DataView; p = 0;
  dec: TextDecoder;
  constructor(b: Uint8Array) {
    this.b = b;
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    this.dec = new TextDecoder('shift_jis'); // WHATWG shift_jis = Windows code page 932
  }
  need(n: number) { if (this.p + n > this.b.length) throw new RangeError(`unexpected end of data at byte ${this.p}`); }
  u8() { this.need(1); return this.b[this.p++]; }
  u16() { this.need(2); const v = this.dv.getUint16(this.p, true); this.p += 2; return v; }
  u32() { this.need(4); const v = this.dv.getUint32(this.p, true); this.p += 4; return v; }
  i32() { this.need(4); const v = this.dv.getInt32(this.p, true); this.p += 4; return v; }
  f64() { this.need(8); const v = this.dv.getFloat64(this.p, true); this.p += 8; return v; }
  /** MFC CString: BYTE length, 0xFF -> WORD, 0xFFFF -> DWORD; 0xFFFE marks a UTF-16 string */
  str(): string {
    let n = this.u8();
    let uni = false;
    if (n === 0xff) {
      n = this.u16();
      if (n === 0xfffe) {
        uni = true;
        n = this.u8();
        if (n === 0xff) { n = this.u16(); if (n === 0xffff) n = this.u32(); }
      } else if (n === 0xffff) n = this.u32();
    }
    if (uni) {
      this.need(n * 2);
      let s = '';
      for (let i = 0; i < n; i++) s += String.fromCharCode(this.dv.getUint16(this.p + i * 2, true));
      this.p += n * 2;
      return s;
    }
    this.need(n);
    const s = this.dec.decode(this.b.subarray(this.p, this.p + n));
    this.p += n;
    return s;
  }
  count(): number { const n = this.u16(); return n === 0xffff ? this.u32() : n; }
}

interface Header {
  version: number; memo: string; zumen: number;
  gState: number[]; gScale: number[]; lState: number[][];
  layerNames: string[][]; groupNames: string[];
  penColor: number[]; prtWidth: number[];
  sxfColor: number[]; sxfPrtWidth: number[]; sxfColorNames: string[];
  ltype: Array<{ pat: number; unit: number; pitch: number; prtPitch: number }>;
  sxfLtype: Array<{ name: string; seg: number; pitch: number[] }>;
  maxWid: number; dpi: number; solidColor: number;
}

function readHeader(r: Rd, warnings: string[]): Header {
  r.p = 8;
  const version = r.u32();
  const memo = r.str();
  const zumen = r.u32();
  r.u32(); // write group
  const gState: number[] = [], gScale: number[] = [], lState: number[][] = [];
  for (let g = 0; g < 16; g++) {
    gState.push(r.u32()); r.u32(); gScale.push(r.f64()); r.u32();
    const ls: number[] = [];
    for (let l = 0; l < 16; l++) { ls.push(r.u32()); r.u32(); }
    lState.push(ls);
  }
  for (let i = 0; i < 14; i++) r.u32();
  for (let i = 0; i < 5; i++) r.u32(); // dimension settings
  r.u32();
  const maxWid = r.i32();
  r.f64(); r.f64(); r.f64(); r.u32(); // printer origin, scale, rotation
  r.u32(); r.f64(); r.f64(); r.f64(); r.f64(); r.f64(); // grid
  const layerNames: string[][] = [];
  for (let g = 0; g < 16; g++) { const a: string[] = []; for (let l = 0; l < 16; l++) a.push(r.str()); layerNames.push(a); }
  const groupNames: string[] = [];
  for (let g = 0; g < 16; g++) groupNames.push(r.str());
  r.f64(); r.f64(); r.u32(); r.f64(); // shadow
  if (version >= 300) { r.f64(); r.f64(); } // sky map
  r.u32(); // 2.5D unit
  r.f64(); r.f64(); r.f64(); // view
  r.f64(); r.f64(); r.f64(); // range memory
  if (version >= 300) for (let n = 0; n < 8; n++) { r.f64(); r.f64(); r.f64(); r.u32(); }
  else for (let n = 0; n < 4; n++) { r.f64(); r.f64(); r.f64(); }
  if (version >= 300) { r.f64(); r.f64(); r.f64(); r.u32(); r.f64(); r.f64(); r.f64(); r.u32(); }
  for (let n = 0; n < 10; n++) r.f64();
  r.f64();
  const penColor: number[] = [];
  for (let n = 0; n <= 9; n++) { penColor.push(r.u32()); r.u32(); }
  const prtWidth: number[] = [];
  for (let n = 0; n <= 9; n++) { r.u32(); prtWidth.push(r.u32()); r.f64(); }
  const ltype: Header['ltype'] = [];
  for (let n = 0; n < 2; n++) ltype.push({ pat: 0, unit: 0, pitch: 0, prtPitch: 0 });
  for (let n = 2; n <= 9; n++) ltype.push({ pat: r.u32(), unit: r.u32(), pitch: r.u32(), prtPitch: r.u32() });
  for (let n = 11; n <= 15; n++) { r.u32(); r.u32(); r.u32(); r.u32(); r.u32(); }
  const ltype2: Header['ltype'] = [];
  for (let n = 16; n <= 19; n++) ltype2.push({ pat: r.u32(), unit: r.u32(), pitch: r.u32(), prtPitch: r.u32() });
  r.u32(); r.u32(); r.u32(); r.u32(); r.u32(); r.u32(); r.u32(); r.u32(); r.u32(); r.u32();
  const prtDisp = r.u32();
  const dpi = version >= 600 ? (Math.floor(prtDisp / 10) % 10 === 1 ? 300 : 600) : 300;
  if (version >= 223) { r.u32(); r.u32(); r.u32(); r.u32(); r.u32(); r.f64(); r.f64(); r.f64(); r.f64(); r.f64(); }
  if (version >= 225) { r.f64(); r.f64(); r.f64(); r.f64(); }
  let solidColor = 0x808080;
  if (version >= 230) { r.u32(); solidColor = r.u32(); }
  const sxfColor: number[] = [], sxfPrtWidth: number[] = [], sxfColorNames: string[] = [];
  const sxfLtype: Header['sxfLtype'] = [];
  if (version >= 420) {
    for (let n = 0; n <= 256; n++) { sxfColor.push(r.u32()); r.u32(); }
    for (let n = 0; n <= 256; n++) { sxfColorNames.push(r.str()); r.u32(); sxfPrtWidth.push(r.u32()); r.f64(); }
    for (let n = 0; n <= 32; n++) { r.u32(); r.u32(); r.u32(); r.u32(); }
    for (let n = 0; n <= 32; n++) {
      const name = r.str(); const seg = r.u32(); const pitch: number[] = [];
      for (let j = 1; j <= 10; j++) pitch.push(r.f64());
      sxfLtype.push({ name, seg, pitch });
    }
  }
  for (let i = 1; i <= 10; i++) { r.f64(); r.f64(); r.f64(); r.u32(); }
  r.f64(); r.f64(); r.f64(); r.u32(); r.u32();
  r.f64(); r.f64();
  r.u32();
  for (let i = 0; i < 6; i++) r.f64();
  void ltype2; void warnings;
  return { version, memo, zumen, gState, gScale, lState, layerNames, groupNames, penColor, prtWidth, sxfColor, sxfPrtWidth, sxfColorNames, ltype: [...ltype, ...ltype2], sxfLtype, maxWid, dpi, solidColor };
}

/** documented header ends right before the entity list: count WORD then a new class tag 0xFFFF, schema, "CData..." */
function looksLikeListStart(b: Uint8Array, p: number): boolean {
  if (p + 12 > b.length) return false;
  const tag = b[p + 2] | (b[p + 3] << 8);
  if (tag !== 0xffff) {
    const cnt = b[p] | (b[p + 1] << 8);
    return cnt === 0 && p + 4 <= b.length; // empty drawing: count 0 then block list count
  }
  const ln = b[p + 6] | (b[p + 7] << 8);
  if (ln < 6 || ln > 32) return false;
  return String.fromCharCode(b[p + 8], b[p + 9], b[p + 10], b[p + 11], b[p + 12]) === 'CData';
}
function findListStart(b: Uint8Array, from: number): number {
  for (let p = from; p + 13 < b.length; p++) {
    if (b[p + 2] === 0xff && b[p + 3] === 0xff && b[p + 8] === 0x43 && b[p + 9] === 0x44 && b[p + 10] === 0x61 && b[p + 11] === 0x74 && b[p + 12] === 0x61 && looksLikeListStart(b, p)) return p;
  }
  return -1;
}

// ------------------------------------------------------------------ data objects

interface Base { group: number; style: number; color: number; width: number; layer: number; glayer: number; flag: number }
type Obj =
  | (Base & { t: 'sen'; x0: number; y0: number; x1: number; y1: number })
  | (Base & { t: 'enko'; cx: number; cy: number; r: number; a0: number; da: number; tilt: number; flat: number; full: boolean })
  | (Base & { t: 'ten'; x: number; y: number; kari: boolean; code: number; ang: number; mag: number })
  | (Base & { t: 'moji'; x0: number; y0: number; x1: number; y1: number; shu: number; sx: number; sy: number; gap: number; ang: number; font: string; s: string })
  | (Base & { t: 'solid'; p: number[]; rgb: number | null })
  | (Base & { t: 'sunpou'; sen: Obj; moji: Obj; extra: Obj[] })
  | (Base & { t: 'block'; x: number; y: number; sx: number; sy: number; rot: number; num: number })
  | (Base & { t: 'list'; num: number; name: string; items: Obj[] });

class ObjReader {
  r: Rd;
  ver: number;
  map: Array<{ cls: string } | { obj: Obj | null }> = [{ obj: null }];
  timeSize = 0; // CTime: 4 or 8 bytes, detected on the first block definition
  counts: Record<string, number> = {};
  constructor(r: Rd, ver: number) { this.r = r; this.ver = ver; }

  base(): Base {
    const r = this.r;
    const group = r.u32(), style = r.u8(), color = r.u16();
    const width = this.ver >= 351 ? r.u16() : 0;
    const layer = r.u16(), glayer = r.u16(), flag = r.u16();
    return { group, style, color, width, layer: layer & 15, glayer: glayer & 15, flag };
  }
  sen(): Obj { const b = this.base(), r = this.r; return { ...b, t: 'sen', x0: r.f64(), y0: r.f64(), x1: r.f64(), y1: r.f64() }; }
  ten(): Obj {
    const b = this.base(), r = this.r;
    const x = r.f64(), y = r.f64(), kari = r.u32() !== 0;
    let code = 0, ang = 0, mag = 1;
    if (b.style === 100) { code = r.u32(); ang = r.f64(); mag = r.f64(); }
    return { ...b, t: 'ten', x, y, kari, code, ang, mag };
  }
  moji(): Obj {
    const b = this.base(), r = this.r;
    const x0 = r.f64(), y0 = r.f64(), x1 = r.f64(), y1 = r.f64();
    const shu = r.u32();
    const sx = r.f64(), sy = r.f64(), gap = r.f64(), ang = r.f64();
    const font = r.str(), s = r.str();
    return { ...b, t: 'moji', x0, y0, x1, y1, shu, sx, sy, gap, ang, font, s };
  }

  readObject(depth: number): Obj | null {
    const r = this.r;
    let tag = r.u16();
    let cls: string;
    if (tag === 0) return null;
    if (tag === 0x7fff) {
      const big = r.u32();
      if (big & 0x80000000) {
        const e = this.map[big & 0x7fffffff];
        if (!e || !('cls' in e)) throw new CadError('corrupt', 'bad class reference');
        cls = e.cls;
      } else {
        const e = this.map[big];
        return e && 'obj' in e ? e.obj : null;
      }
    } else if (tag === 0xffff) {
      r.u16(); // schema (file version)
      const ln = r.u16();
      r.need(ln);
      cls = '';
      for (let i = 0; i < ln; i++) cls += String.fromCharCode(r.b[r.p + i]);
      r.p += ln;
      this.map.push({ cls });
    } else if (tag & 0x8000) {
      const e = this.map[tag & 0x7fff];
      if (!e || !('cls' in e)) throw new CadError('corrupt', `bad class tag ${tag.toString(16)} at byte ${r.p - 2}`);
      cls = e.cls;
    } else {
      const e = this.map[tag];
      return e && 'obj' in e ? e.obj : null;
    }
    const slot = this.map.length;
    this.map.push({ obj: null });
    this.counts[cls] = (this.counts[cls] ?? 0) + 1;
    let o: Obj;
    switch (cls) {
      case 'CDataSen': o = this.sen(); break;
      case 'CDataEnko': {
        const b = this.base();
        o = { ...b, t: 'enko', cx: r.f64(), cy: r.f64(), r: r.f64(), a0: r.f64(), da: r.f64(), tilt: r.f64(), flat: r.f64(), full: r.u32() !== 0 };
        break;
      }
      case 'CDataTen': o = this.ten(); break;
      case 'CDataMoji': o = this.moji(); break;
      case 'CDataSolid': {
        const b = this.base();
        const p = [r.f64(), r.f64(), r.f64(), r.f64(), r.f64(), r.f64(), r.f64(), r.f64()];
        const rgb = b.color === 10 ? r.u32() : null;
        o = { ...b, t: 'solid', p, rgb };
        break;
      }
      case 'CDataSunpou': {
        const b = this.base();
        const sen = this.sen(), moji = this.moji();
        const extra: Obj[] = [];
        if (this.ver >= 420) {
          r.u16();
          extra.push(this.sen(), this.sen(), this.ten(), this.ten(), this.ten(), this.ten());
        }
        o = { ...b, t: 'sunpou', sen, moji, extra };
        break;
      }
      case 'CDataBlock': {
        const b = this.base();
        o = { ...b, t: 'block', x: r.f64(), y: r.f64(), sx: r.f64(), sy: r.f64(), rot: r.f64(), num: r.u32() };
        break;
      }
      case 'CDataList': {
        if (depth > 64) throw new CadError('corrupt', 'block definitions nested too deep');
        const b = this.base();
        const num = r.u32();
        r.u32(); // referenced flag
        this.readTime();
        const name = r.str();
        const n = r.count();
        const items: Obj[] = [];
        for (let i = 0; i < n; i++) { const c = this.readObject(depth + 1); if (c) items.push(c); }
        o = { ...b, t: 'list', num, name, items };
        break;
      }
      default:
        throw new CadError('unsupported-version', `unknown JWW data class ${cls} at byte ${r.p}`);
    }
    this.map[slot] = { obj: o };
    return o;
  }

  /** CTime is 4 bytes (32 bit time_t) or 8 bytes (64 bit) depending on the compiler of the writing version:
   *  pick the size after which a CString name, an object count and a valid object tag follow */
  readTime() {
    const r = this.r;
    if (!this.timeSize) {
      const ok = (sz: number): boolean => {
        const b = r.b;
        let q = r.p + sz;
        if (q >= b.length) return false;
        const n = b[q];
        if (n === 0xff) return false;
        q += 1 + n;
        if (q + 2 > b.length) return false;
        const cnt = b[q] | (b[q + 1] << 8);
        if (cnt === 0) return true;
        if (q + 4 > b.length) return false;
        const tag = b[q + 2] | (b[q + 3] << 8);
        return tag === 0xffff || tag === 0x7fff || ((tag & 0x8000) !== 0 && (tag & 0x7fff) < this.map.length);
      };
      this.timeSize = ok(8) ? 8 : ok(4) ? 4 : 4;
    }
    r.need(this.timeSize);
    r.p += this.timeSize;
  }
}

// ------------------------------------------------------------------ drawing

type M = [number, number, number, number, number, number]; // x' = a x + c y + e, y' = b x + d y + f
const mul = (p: M, c: M): M => [p[0] * c[0] + p[2] * c[1], p[1] * c[0] + p[3] * c[1], p[0] * c[2] + p[2] * c[3], p[1] * c[2] + p[3] * c[3], p[0] * c[4] + p[2] * c[5] + p[4], p[1] * c[4] + p[3] * c[5] + p[5]];
const ap = (m: M, x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

function colorRef(v: number): [number, number, number] { return [v & 255, (v >> 8) & 255, (v >> 16) & 255]; }
const hex2 = (n: number) => (n < 16 ? '0' : '') + n.toString(16);
/** COLORREF to a colour that reads on white paper: very light colours are darkened, white becomes black */
function paperColor(v: number): string {
  let [r, g, b] = colorRef(v);
  if (r > 240 && g > 240 && b > 240) return '#000000';
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  if (lum > 0.6) { const k = 0.6 / lum; r = Math.round(r * k); g = Math.round(g * k); b = Math.round(b * k); }
  return '#' + hex2(r) + hex2(g) + hex2(b);
}

interface Ctx { m: M; tscale: number; rot: number; depth: number; stack: number[] }

class Drawer {
  h: Header;
  items: SheetItem[] = [];
  warnings = new Set<string>();
  blocks = new Map<number, Obj & { t: 'list' }>();
  W: number; H: number;
  maxItems: number;
  layerItems = new Map<string, number>();
  colors: string[] = [];
  widths: number[] = [];
  sxfColors: string[] = [];
  sxfWidths: number[] = [];
  unit: number; // mm per printer width unit

  constructor(h: Header, maxItems: number) {
    this.h = h;
    const pp = PAPER[h.zumen] ?? PAPER[3];
    this.W = pp[0]; this.H = pp[1];
    this.maxItems = maxItems;
    this.unit = h.maxWid <= -101 ? 0.01 : 25.4 / h.dpi;
    // file colours for 1..9 if they look like a real table, else defaults
    const usable = h.penColor.length === 10 && new Set(h.penColor.slice(1)).size > 3;
    for (let n = 0; n <= 9; n++) this.colors.push(usable ? paperColor(h.penColor[n]) : DEFAULT_COLORS[n]);
    for (let n = 0; n <= 9; n++) this.widths.push(this.w(h.prtWidth[n] ?? 1));
    for (let n = 0; n < h.sxfColor.length; n++) { this.sxfColors.push(paperColor(h.sxfColor[n])); this.sxfWidths.push(this.w(h.sxfPrtWidth[n] ?? 1)); }
  }
  w(v: number): number { const x = v * this.unit; return +(Math.max(0.05, Math.min(5, x || 0.13))).toFixed(3); }

  layerName(g: number, l: number): string {
    const gn = this.h.groupNames[g]?.trim(), ln = this.h.layerNames[g]?.[l]?.trim();
    const key = `${g.toString(16).toUpperCase()}-${l.toString(16).toUpperCase()}`;
    const label = [gn, ln].filter(Boolean).join(' / ');
    return label ? `${key} ${label}` : key;
  }
  color(o: Base): string {
    const c = o.color;
    if (c >= 1 && c <= 9) return this.colors[c];
    if (c >= 100 && c - 100 < this.sxfColors.length) return this.sxfColors[c - 100];
    return '#000000';
  }
  width(o: Base): number {
    const c = o.color;
    if (c >= 1 && c <= 9) return this.widths[c];
    if (c >= 100 && c - 100 < this.sxfWidths.length) return this.sxfWidths[c - 100];
    return 0.13;
  }
  dash(style: number, scale: number): number[] | undefined {
    if (style <= 1) return undefined;
    const h = this.h;
    if (style >= 30 && style - 30 < h.sxfLtype.length) {
      const t = h.sxfLtype[style - 30];
      const seq = t.pitch.slice(0, Math.max(0, Math.min(10, t.seg * 2 || 0))).filter((v) => v > 0);
      return seq.length >= 2 ? seq.map((v) => +(v * scale).toPrecision(4)) : undefined;
    }
    let lt: Header['ltype'][number] | undefined;
    if (style >= 2 && style <= 9) lt = h.ltype[style];
    else if (style >= 16 && style <= 19) lt = h.ltype[10 + (style - 16)];
    if (!lt || !lt.pat || !(lt.unit > 0)) return undefined;
    const bits: number[] = [];
    const unit = Math.min(32, lt.unit);
    for (let i = 0; i < unit; i++) bits.push((lt.pat >>> (31 - i)) & 1);
    // rotate so the pattern starts at the beginning of a dash
    let k = bits.findIndex((b, i) => b === 1 && bits[(i + unit - 1) % unit] === 0);
    if (k < 0) return undefined;
    const runs: number[] = [];
    let cur = 1, len = 0;
    for (let i = 0; i < unit; i++) {
      const b = bits[(k + i) % unit];
      if (b === cur) len++;
      else { runs.push(len); cur = b; len = 1; }
    }
    runs.push(len);
    if (runs.length % 2) runs.push(0);
    const bit = (lt.prtPitch || 10) * (25.4 / this.h.dpi) * scale;
    return runs.map((v) => +(v * bit).toPrecision(4));
  }

  push(it: SheetItem, layer: string) {
    if (this.items.length >= this.maxItems) { this.warnings.add(`drawing cut at ${this.maxItems} items`); return; }
    if (!saneItem(it)) { this.warnings.add('figures with invalid coordinates skipped'); return; }
    it.layer = layer;
    this.items.push(it);
    this.layerItems.set(layer, (this.layerItems.get(layer) ?? 0) + 1);
  }

  /** coordinates are stored in paper millimetres with the origin at the paper centre (verified on samples: lines
   *  next to dimension texts measure value / layer group scale); the group scale only converts to real size */
  groupMatrix(_g: number): M {
    return [1, 0, 0, 1, this.W / 2, this.H / 2];
  }

  draw(o: Obj, ctx: Ctx, layer: string) {
    switch (o.t) {
      case 'sen': {
        const a = ap(ctx.m, o.x0, o.y0), b = ap(ctx.m, o.x1, o.y1);
        const it: SheetItem = { kind: 'line', pts: [a[0], a[1], b[0], b[1]], color: this.color(o), w: this.width(o) };
        const d = this.dash(o.style, 1);
        if (d) it.dash = d;
        this.push(it, layer);
        break;
      }
      case 'enko': this.arc(o, ctx, layer); break;
      case 'ten': {
        if (o.kari) break; // construction points are not plotted
        const [x, y] = ap(ctx.m, o.x, o.y);
        if (o.code) {
          // point marker / arrow code: drawn as a short arrow along the display angle (approximation)
          const L = 2.5 * (o.mag || 1);
          const a = o.ang + ctx.rot;
          const tx = x + Math.cos(a) * L, ty = y + Math.sin(a) * L;
          const nx = -Math.sin(a) * L / 6, ny = Math.cos(a) * L / 6;
          this.push({ kind: 'fill', pts: [x, y, tx + nx, ty + ny, tx - nx, ty - ny], color: this.color(o) }, layer);
          this.warnings.add('point marker codes drawn as simple arrows');
        } else this.push({ kind: 'line', pts: [x, y, x, y], color: this.color(o), w: Math.max(0.3, this.width(o) * 2) }, layer);
        break;
      }
      case 'moji': this.text(o, ctx, layer); break;
      case 'solid': this.solid(o, ctx, layer); break;
      case 'sunpou': {
        this.draw({ ...o.sen, layer: o.layer, glayer: o.glayer }, ctx, layer);
        this.draw({ ...o.moji, layer: o.layer, glayer: o.glayer }, ctx, layer);
        for (const e of o.extra) {
          if (e.t === 'sen' && e.x0 === e.x1 && e.y0 === e.y1) continue;
          if (e.t === 'ten' && !e.code) continue; // plain reference points of the dimension
          this.draw(e, ctx, layer);
        }
        break;
      }
      case 'block': {
        const def = this.blocks.get(o.num);
        if (!def) { this.warnings.add(`block definition ${o.num} missing`); break; }
        if (ctx.stack.includes(o.num) || ctx.depth > 32) { this.warnings.add('recursive block reference skipped'); break; }
        const c = Math.cos(o.rot), s = Math.sin(o.rot);
        const local: M = [c * o.sx, s * o.sx, -s * o.sy, c * o.sy, o.x, o.y];
        const child: Ctx = { m: mul(ctx.m, local), tscale: ctx.tscale * Math.abs(o.sy || 1), rot: ctx.rot + o.rot, depth: ctx.depth + 1, stack: [...ctx.stack, o.num] };
        for (const e of def.items) this.draw(e, child, layer);
        break;
      }
      case 'list': break;
    }
  }

  arc(o: Obj & { t: 'enko' }, ctx: Ctx, layer: string) {
    const m = ctx.m;
    const color = this.color(o), w = this.width(o);
    const dash = this.dash(o.style, 1);
    const full = o.full || Math.abs(o.da) >= Math.PI * 2 - 1e-9;
    const flat = o.flat > 0 ? o.flat : 1;
    // similarity check of the 2D linear part
    const sx = Math.hypot(m[0], m[1]), sy = Math.hypot(m[2], m[3]);
    const ortho = Math.abs(m[0] * m[2] + m[1] * m[3]) < 1e-9 * sx * sy;
    const det = m[0] * m[3] - m[1] * m[2];
    if (Math.abs(flat - 1) < 1e-9 && ortho && Math.abs(sx - sy) < 1e-9 * sx && !dash && det > 0) {
      const [cx, cy] = ap(m, o.cx, o.cy);
      const rot = Math.atan2(m[1], m[0]);
      const a0 = full ? 0 : o.a0 + o.tilt + rot;
      const a1 = full ? Math.PI * 2 : a0 + o.da;
      this.push({ kind: 'arc', cx, cy, r: o.r * sx, a0, a1, color, w }, layer);
      return;
    }
    const sweep = full ? Math.PI * 2 : o.da;
    const n = arcSegs(sweep, o.r * Math.max(sx, sy), 0.05);
    const ct = Math.cos(o.tilt), st = Math.sin(o.tilt);
    const pts: number[] = [];
    for (let i = 0; i <= n; i++) {
      const t = (full ? 0 : o.a0) + (sweep * i) / n;
      const ex = o.r * Math.cos(t), ey = o.r * flat * Math.sin(t);
      const [x, y] = ap(m, o.cx + ex * ct - ey * st, o.cy + ex * st + ey * ct);
      pts.push(x, y);
    }
    const it: SheetItem = { kind: 'line', pts, color, w };
    if (dash) it.dash = dash;
    this.push(it, layer);
  }

  text(o: Obj & { t: 'moji' }, ctx: Ctx, layer: string) {
    let s = o.s;
    if (!s) return;
    // Jw_cad keeps some settings as zero-length texts at (0, -1000), e.g. "Printer_Orientation = 0": not drawing content
    if (o.x0 === 0 && o.y0 === -1000 && o.x1 === 0 && o.y1 === -1000) return;
    if (s.startsWith('^@BM')) { this.warnings.add('embedded images (^@BM) are not drawn'); return; }
    // Jw_cad special text codes (super / subscript and similar markers) are removed
    s = s.replace(/\^[udcowbm]/g, '').replace(/\s+$/, '');
    if (!s.trim()) return;
    const [x, y] = ap(ctx.m, o.x0, o.y0);
    const size = (o.sy > 0 ? o.sy : 2.5) * ctx.tscale;
    const rot = (o.ang * Math.PI) / 180 + ctx.rot;
    const it: SheetItem = { kind: 'text', x, y, text: s, size: +size.toPrecision(5), color: this.color(o) };
    if (Math.abs(rot) > 1e-9) it.rot = rot;
    if (o.font) it.font = o.font;
    this.push(it, layer);
  }

  solid(o: Obj & { t: 'solid' }, ctx: Ctx, layer: string) {
    const color = o.color === 10 && o.rgb != null ? '#' + colorRef(o.rgb).map(hex2).join('') : this.color(o);
    const p = o.p;
    if (o.style >= 101) {
      // circle solids (see 円のソリッド): centre, radius, flatness, tilt, start, sweep, kind / inner radius
      const cx = p[0], cy = p[1], r = p[2], flat = p[3] || 1, tilt = p[4], a0 = p[5], da = p[6], kind = p[7];
      const ring = (rr: number, start: number, sweep: number) => {
        const n = Math.max(24, arcSegs(sweep, rr, 0.02));
        const out: number[] = [];
        const ct = Math.cos(tilt), st = Math.sin(tilt);
        for (let i = 0; i <= n; i++) {
          const t = start + (sweep * i) / n;
          const ex = rr * Math.cos(t), ey = rr * flat * Math.sin(t);
          const [x, y] = ap(ctx.m, cx + ex * ct - ey * st, cy + ex * st + ey * ct);
          out.push(x, y);
        }
        return out;
      };
      let rings: number[][];
      if (o.style === 101 && kind === 100) rings = [ring(r, 0, Math.PI * 2)];
      else if (o.style === 101 && kind === 0) { const [x, y] = ap(ctx.m, cx, cy); rings = [[x, y, ...ring(r, a0, da)]]; }
      else if (o.style === 101) rings = [ring(r, a0, da)];
      else if (o.style === 105 || o.style === 106) {
        const full = Math.abs(da) >= Math.PI * 2 - 1e-9 || da === 0;
        const outer = ring(r, full ? 0 : a0, full ? Math.PI * 2 : da);
        const innerR = kind;
        if (full) rings = [outer, ring(innerR, 0, Math.PI * 2)];
        else { const inner = ring(innerR, a0, da); const rev: number[] = []; for (let i = inner.length - 2; i >= 0; i -= 2) rev.push(inner[i], inner[i + 1]); rings = [[...outer, ...rev]]; }
      } else if (o.style === 111) {
        const pts = ring(r, kind === 100 ? 0 : a0, kind === 100 ? Math.PI * 2 : da);
        this.push({ kind: 'line', pts, color, w: this.width(o) }, layer);
        return;
      } else { this.warnings.add(`circle solid type ${o.style} drawn as a disc`); rings = [ring(r, 0, Math.PI * 2)]; }
      for (const poly of ringsToPolygons(rings)) this.push({ kind: 'fill', pts: poly, color }, layer);
      return;
    }
    // order: 1st (start), 2nd, 3rd, 4th (end)
    const pts: number[] = [];
    for (const [x, y] of [[p[0], p[1]], [p[4], p[5]], [p[6], p[7]], [p[2], p[3]]]) { const q = ap(ctx.m, x, y); pts.push(q[0], q[1]); }
    this.push({ kind: 'fill', pts, color }, layer);
  }
}

export async function readJww(bytes: Uint8Array, onProgress?: Progress, options: JwwOptions = {}): Promise<CadResult> {
  const t0 = Date.now();
  if (!sniffJww(bytes)) throw new CadError('not-format', 'not a JWW file (no "JwwData." signature)');
  if (bytes.length > 512 * 1024 * 1024) throw new CadError('too-large', 'JWW larger than 512 MB');
  const warnings: string[] = [];
  const r = new Rd(bytes);
  onProgress?.('header', 0);
  let h: Header;
  try { h = readHeader(r, warnings); }
  catch (e) { if (e instanceof CadError) throw e; throw new CadError('corrupt', `JWW header truncated: ${(e as Error).message}`); }
  if (h.version < 200 || h.version > 2000) throw new CadError('unsupported-version', `JWW data version ${h.version} is outside the known range`);
  // check the documented header length against the data; newer versions may add header fields
  if (!looksLikeListStart(bytes, r.p)) {
    const q = findListStart(bytes, r.p);
    if (q < 0) throw new CadError(h.version > 702 ? 'unsupported-version' : 'corrupt', `JWW ${h.version}: figure data list not found after the header`);
    warnings.push(`header of version ${h.version} is ${q - r.p} bytes longer than the documented Ver.7.02 layout; extra settings skipped`);
    r.p = q;
  }
  const or = new ObjReader(r, h.version);
  const ents: Obj[] = [];
  const blockDefs: Array<Obj & { t: 'list' }> = [];
  let complete = true;
  try {
    const n = r.count();
    for (let i = 0; i < n; i++) {
      const o = or.readObject(0);
      if (o) ents.push(o);
      if ((i & 4095) === 0) onProgress?.('figures', 0.1 + 0.6 * (i / n));
    }
    const nb = r.count();
    for (let i = 0; i < nb; i++) { const o = or.readObject(0); if (o && o.t === 'list') blockDefs.push(o); }
    if (h.version >= 700 && r.p + 4 <= bytes.length) {
      const ni = r.u32();
      if (ni > 0) warnings.push(`${ni} embedded image file(s) not drawn`);
    }
  } catch (e) {
    if (e instanceof CadError && e.code === 'unsupported-version' && ents.length === 0) throw e;
    complete = false;
    warnings.push(`figure data ended early: ${(e as Error).message} (${ents.length} figures read)`);
  }
  if (ents.length === 0 && !complete) throw new CadError('corrupt', 'JWW: no figure data could be read');

  const dr = new Drawer(h, options.maxItems ?? 3_000_000);
  for (const b of blockDefs) {
    dr.blocks.set(b.num, b);
    // nested definitions also register by number
    const walk = (l: Obj & { t: 'list' }) => { for (const it of l.items) if (it.t === 'list') { dr.blocks.set(it.num, it); walk(it); } };
    walk(b);
  }
  let k = 0;
  for (const o of ents) {
    // 補助線 (construction lines, line type 9 / colour 9) are shown on screen but never printed: own hidden layer
    const aux = (o.t === 'sen' || o.t === 'enko') && (o.style === 9 || o.color === 9);
    const layer = aux ? AUX_LAYER : dr.layerName(o.glayer, o.layer);
    dr.draw(o, { m: dr.groupMatrix(o.glayer), tscale: 1, rot: 0, depth: 0, stack: [] }, layer);
    if ((++k & 4095) === 0) onProgress?.('drawing', 0.7 + 0.25 * (k / ents.length));
  }
  // paper frame: drawn on its own layer; the sheet covers the paper and everything drawn outside it
  const pp = PAPER[h.zumen];
  if (!pp) warnings.push(`unknown paper size code ${h.zumen}, A3 assumed`);
  dr.push({ kind: 'line', pts: [0, 0, dr.W, 0, dr.W, dr.H, 0, dr.H, 0, 0], color: '#9aa3b5', w: 0.25 }, FRAME_LAYER);
  let W = dr.W, H = dr.H;
  const bb = itemsBounds(dr.items);
  let ox = 0, oy = 0;
  if (bb && (bb[0] < -0.5 || bb[1] < -0.5 || bb[2] > W + 0.5 || bb[3] > H + 0.5)) {
    const pad = 5;
    const x0 = Math.min(0, bb[0] - pad), y0 = Math.min(0, bb[1] - pad);
    ox = -x0; oy = -y0;
    W = Math.max(W, bb[2] + pad) - x0; H = Math.max(H, bb[3] + pad) - y0;
    for (const it of dr.items) shift(it, ox, oy);
    warnings.push('drawing extends beyond the paper; the sheet covers the paper (frame layer) and the outside content');
  }
  const layers: LayerInfo[] = [];
  for (let g = 0; g < 16; g++) for (let l = 0; l < 16; l++) {
    const name = dr.layerName(g, l);
    const n = dr.layerItems.get(name) ?? 0;
    const named = !!(h.layerNames[g]?.[l]?.trim());
    if (!n && !named) continue;
    layers.push({ name, color: '#000000', visible: h.gState[g] !== 0 && h.lState[g][l] !== 0, items: n, scale: h.gScale[g] > 0 ? h.gScale[g] : 1 });
  }
  layers.push({ name: FRAME_LAYER, color: '#9aa3b5', visible: true, items: 1 });
  if (dr.layerItems.get(AUX_LAYER)) layers.push({ name: AUX_LAYER, color: '#808080', visible: false, items: dr.layerItems.get(AUX_LAYER) });
  const allWarn = [...warnings, ...dr.warnings];
  const sheet: RvtSheet2D = {
    id: 0, number: '', name: h.memo.trim().split(/\r?\n/)[0] || `Jw_cad ${pp?.[2] ?? ''}`.trim(), size: { w: W, h: H }, items: dr.items, viewports: [],
    completeness: complete && !dr.warnings.size ? 'full' : 'partial', warnings: allWarn, origin: [-dr.W / 2 - ox, -dr.H / 2 - oy],
  };
  const info: CadInfo = {
    format: 'JWW', version: `${h.version} (Jw_cad ${(h.version / 100).toFixed(2)})`, paper: pp ? `${pp[2]} ${pp[0]} x ${pp[1]} mm` : `code ${h.zumen}`,
    memo: h.memo.trim(), figures: ents.length, blocks: dr.blocks.size, items: dr.items.length, layers: layers.length,
    scales: [...new Set(h.gScale.map((s) => `1:${+s.toPrecision(6)}`))].join(', '), ms: Date.now() - t0,
  };
  if (or.timeSize) info.ctimeBytes = or.timeSize;
  for (const [kk, v] of Object.entries(or.counts)) info['count.' + kk] = v;
  onProgress?.('done', 1);
  return { kind: '2d', sheets: [sheet], layers, info };
}

function shift(it: SheetItem, dx: number, dy: number) {
  switch (it.kind) {
    case 'line': case 'fill': for (let i = 0; i + 1 < it.pts.length; i += 2) { it.pts[i] += dx; it.pts[i + 1] += dy; } break;
    case 'arc': it.cx += dx; it.cy += dy; break;
    case 'text': case 'image': it.x += dx; it.y += dy; break;
  }
}
