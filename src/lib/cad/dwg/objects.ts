// Object map, classes and common object / entity headers (ODS chapters 10, 20, 23).
import { BitReader, DwgError } from './bits.ts';
import type { Container } from './container.ts';

export interface DwgClass { num: number; app: string; cpp: string; dxf: string; isEntity: boolean }

// Object map: handle -> byte offset (R13-15 absolute file offset, R2004+ offset in AcDbObjects)
export function parseObjectMap(map: Uint8Array): Map<number, number> {
  const a = parseObjectMapArrays(map);
  const out = new Map<number, number>();
  for (let i = 0; i < a.n; i++) out.set(a.handles[i], a.offs[i]);
  return out;
}

// handle -> offset pairs as arrays, sorted by handle
export function parseObjectMapArrays(map: Uint8Array): { handles: Float64Array; offs: Float64Array; n: number } {
  // count the entries first (every modular char ends with a byte without the 0x80 bit; two per entry)
  let ends = 0;
  for (let p0 = 0; p0 + 2 <= map.length;) {
    const size = (map[p0] << 8) | map[p0 + 1];
    if (size <= 2) break;
    const end = Math.min(map.length, p0 + size);
    for (let q = p0 + 2; q < end; q++) if (!(map[q] & 0x80)) ends++;
    p0 = end + 2;
  }
  let cap = Math.max(16, ends >> 1);
  let H = new Float64Array(cap), O = new Float64Array(cap);
  let cnt = 0, sorted = true;
  let p = 0;
  const n = map.length;
  while (p + 2 <= n) {
    const size = (map[p] << 8) | map[p + 1];
    if (size <= 2) break;
    const end = Math.min(n, p + size);
    let q = p + 2;
    // sample finding: handle and location deltas restart from 0 in every map section
    let lastH = 0, lastLoc = 0;
    while (q < end) {
      // handle delta: unsigned modular char
      let v = 0, mul = 1, b = 0;
      do { b = map[q++]; v += (b & 0x7f) * mul; mul *= 128; } while ((b & 0x80) && q < end);
      // location delta: signed modular char (0x40 in the last byte = negative)
      let w = 0; mul = 1;
      for (;;) {
        b = map[q++];
        if (b & 0x80) { w += (b & 0x7f) * mul; mul *= 128; if (q >= end) break; continue; }
        w += (b & 0x3f) * mul;
        if (b & 0x40) w = -w;
        break;
      }
      lastH += v; lastLoc += w;
      if (cnt >= cap) { cap *= 2; const h2 = new Float64Array(cap), o2 = new Float64Array(cap); h2.set(H); o2.set(O); H = h2; O = o2; }
      if (cnt && lastH <= H[cnt - 1]) sorted = false;
      H[cnt] = lastH; O[cnt] = lastLoc; cnt++;
    }
    p = end + 2; // skip CRC
  }
  if (!sorted) {
    // sort by handle; for duplicate handles the later entry wins
    const idx = Array.from({ length: cnt }, (_, i) => i).sort((a, b) => H[a] - H[b] || a - b);
    const h2 = new Float64Array(cnt), o2 = new Float64Array(cnt);
    let m = 0;
    for (const i of idx) { if (m && h2[m - 1] === H[i]) { o2[m - 1] = O[i]; continue; } h2[m] = H[i]; o2[m] = O[i]; m++; }
    return { handles: h2, offs: o2, n: m };
  }
  return { handles: H, offs: O, n: cnt };
}

// String stream locator for R2007+ objects: returns start bit, or -1 when no string stream
export function stringStreamStart(r: BitReader, endBit: number): number {
  let p = endBit - 1;
  if (p < 0) return -1;
  r.bit = p;
  if (!r.B()) return -1;
  p -= 16; r.bit = p;
  let sz = r.RS();
  if (sz & 0x8000) {
    p -= 16; r.bit = p;
    const hi = r.RS();
    sz = (sz & 0x7fff) | (hi << 15);
  }
  p -= sz;
  return p;
}

export function parseClasses(c: Container, decoder: TextDecoder, warnings: string[]): Map<number, DwgClass> {
  const out = new Map<number, DwgClass>();
  const d = c.classes;
  if (!d || d.length < 20) return out;
  const ver = c.ver;
  const r = new BitReader(d, 0, d.length * 8, ver, decoder);
  r.bit = 16 * 8;
  const size = r.RL();
  let hasHi = false;
  if (ver >= 32 || (ver >= 24 && c.maint > 3)) { r.RL(); hasHi = true; }
  let endBit = (20 + (hasHi ? 4 : 0) + size) * 8;
  let str: BitReader = r;
  if (ver >= 21) {
    const bits = r.RL();
    const dataStart = r.bit;
    endBit = 20 * 8 + (hasHi ? 32 : 0) + bits;  // bit size counted from after the size field(s)
    const sr = r.clone(0);
    const ss = stringStreamStart(sr, endBit);
    if (ss >= 0) { sr.bit = ss; str = sr; }
    r.bit = dataStart;
    void dataStart;
  }
  if (endBit > d.length * 8) endBit = d.length * 8;
  try {
    let maxNum = 5000;
    if (ver >= 18) { maxNum = r.BS(); r.RC(); r.RC(); r.B(); }
    const TV = () => (ver >= 21 ? str.TU() : r.T());
    while (r.bit + 32 < endBit) {
      const num = r.BS();
      r.BS(); // proxy flags / version
      const app = TV(), cpp = TV(), dxf = TV();
      r.B();
      const item = r.BS();
      if (ver >= 18) { r.BL(); r.BS(); r.BS(); r.BL(); r.BL(); }
      out.set(num, { num, app, cpp, dxf: dxf.toUpperCase(), isEntity: item === 0x1f2 });
      if (num < 500 || num > 5000 || num >= maxNum) break;
    }
  } catch (e) {
    warnings.push('classes: ' + (e as Error).message);
  }
  return out;
}

export interface ObjHead {
  handle: number;
  type: number;
  typeName: string;
  isEntity: boolean;
  dat: BitReader;        // positioned at object specific data
  str: BitReader;        // string stream (== dat before R2007)
  hdl: BitReader;        // handle stream
  ver: number;
  // entity common
  entmode: number;
  owner: number;
  layer: number;
  ltype: number;         // 0 = bylayer, -1 = byblock, -2 = continuous, else handle
  color: Color;
  ltscale: number;
  invisible: boolean;
  lweight: number;
  numReactors: number;
  xdicMissing: boolean;
  nolinks: boolean;
  ltFlags: number; psFlags: number; matFlags: number;
  vs: [number, number, number];
  colorBook: boolean;
  handleStart: number;
  strStart: number;
  graphics?: Uint8Array;
  hasGraphics?: boolean;
}

export interface Color { index: number; rgb: number | null; transp?: number; book?: number } // index 256 bylayer, 0 byblock

export const FIXED_TYPES: Record<number, string> = {
  1: 'TEXT', 2: 'ATTRIB', 3: 'ATTDEF', 4: 'BLOCK', 5: 'ENDBLK', 6: 'SEQEND', 7: 'INSERT', 8: 'MINSERT',
  10: 'VERTEX_2D', 11: 'VERTEX_3D', 12: 'VERTEX_MESH', 13: 'VERTEX_PFACE', 14: 'VERTEX_PFACE_FACE',
  15: 'POLYLINE_2D', 16: 'POLYLINE_3D', 17: 'ARC', 18: 'CIRCLE', 19: 'LINE',
  20: 'DIMENSION_ORDINATE', 21: 'DIMENSION_LINEAR', 22: 'DIMENSION_ALIGNED', 23: 'DIMENSION_ANG3PT',
  24: 'DIMENSION_ANG2LN', 25: 'DIMENSION_RADIUS', 26: 'DIMENSION_DIAMETER', 27: 'POINT', 28: '3DFACE',
  29: 'POLYLINE_PFACE', 30: 'POLYLINE_MESH', 31: 'SOLID', 32: 'TRACE', 33: 'SHAPE', 34: 'VIEWPORT',
  35: 'ELLIPSE', 36: 'SPLINE', 37: 'REGION', 38: '3DSOLID', 39: 'BODY', 40: 'RAY', 41: 'XLINE',
  42: 'DICTIONARY', 43: 'OLEFRAME', 44: 'MTEXT', 45: 'LEADER', 46: 'TOLERANCE', 47: 'MLINE',
  48: 'BLOCK_CONTROL', 49: 'BLOCK_HEADER', 50: 'LAYER_CONTROL', 51: 'LAYER', 52: 'STYLE_CONTROL', 53: 'STYLE',
  56: 'LTYPE_CONTROL', 57: 'LTYPE', 60: 'VIEW_CONTROL', 61: 'VIEW', 62: 'UCS_CONTROL', 63: 'UCS',
  64: 'VPORT_CONTROL', 65: 'VPORT', 66: 'APPID_CONTROL', 67: 'APPID', 68: 'DIMSTYLE_CONTROL', 69: 'DIMSTYLE',
  70: 'VP_ENT_HDR_CONTROL', 71: 'VP_ENT_HDR', 72: 'GROUP', 73: 'MLINESTYLE', 74: 'OLE2FRAME', 75: 'DUMMY',
  76: 'LONG_TRANSACTION', 77: 'LWPOLYLINE', 78: 'HATCH', 79: 'XRECORD', 80: 'ACDBPLACEHOLDER',
  81: 'VBA_PROJECT', 82: 'LAYOUT', 0x1f2: 'ACAD_PROXY_ENTITY', 0x1f3: 'ACAD_PROXY_OBJECT',
};
const ENTITY_FIXED = new Set([1, 2, 3, 4, 5, 6, 7, 8, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28,
  29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 44, 45, 46, 47, 74, 77, 78, 0x1f2]);

export class ObjReader {
  data: Uint8Array;
  ver: number;
  decoder: TextDecoder;
  classes: Map<number, DwgClass>;
  rd: BitReader; hd: BitReader; sd: BitReader;
  captureGraphics = true;
  constructor(data: Uint8Array, ver: number, decoder: TextDecoder, classes: Map<number, DwgClass>) {
    this.data = data; this.ver = ver; this.decoder = decoder; this.classes = classes;
    // readers are reused for every object (decoding is synchronous and nothing keeps them)
    this.rd = new BitReader(data, 0, data.length * 8, ver, decoder);
    this.hd = new BitReader(data, 0, data.length * 8, ver, decoder);
    this.sd = new BitReader(data, 0, data.length * 8, ver, decoder);
  }
  typeName(t: number): { name: string; entity: boolean } {
    const f = FIXED_TYPES[t];
    if (f) return { name: f, entity: ENTITY_FIXED.has(t) };
    const c = this.classes.get(t);
    if (c) {
      let n = c.dxf;
      if (n === 'LWPLINE') n = 'LWPOLYLINE';
      return { name: n, entity: c.isEntity };
    }
    return { name: 'UNKNOWN_' + t, entity: false };
  }
  // read only the type of the object at byte offset
  peekType(off: number): number {
    const r = new BitReader(this.data, off * 8, this.data.length * 8, this.ver, this.decoder);
    r.MS();
    if (this.ver >= 24) r.MCu();
    return r.OT();
  }
  head(off: number): ObjHead {
    const ver = this.ver;
    const r = this.rd;
    r.bit = off * 8; r.end = this.data.length * 8;
    const size = r.MS();
    let hsize = 0;
    // sample finding: in R2010+ the MS size counts the bytes after the handle stream size MC
    if (ver >= 24) hsize = r.MCu();
    const afterMS = r.bit;
    const objEnd = afterMS + size * 8;
    if (objEnd > this.data.length * 8 + 16) throw new DwgError('corrupt', 'object extends past section');
    r.end = Math.min(objEnd, this.data.length * 8);
    const type = r.OT();
    const tn = this.typeName(type);
    let handleStart = 0;
    if (ver >= 24) handleStart = objEnd - hsize;
    else if (ver >= 15) handleStart = afterMS + r.RL();
    const handle = r.H().value;
    // EED
    for (let guard = 0; guard < 10000; guard++) {
      const n = r.BS();
      if (n <= 0) break;
      r.H();
      r.skipBits(n * 8);
    }
    const h: ObjHead = {
      handle, type, typeName: tn.name, isEntity: tn.entity, dat: r, str: r, hdl: r, ver,
      entmode: 2, owner: 0, layer: 0, ltype: 0, color: { index: 256, rgb: null }, ltscale: 1, invisible: false,
      lweight: -1, numReactors: 0, xdicMissing: true, nolinks: true, ltFlags: 0, psFlags: 0, matFlags: 0,
      vs: [0, 0, 0], colorBook: false, handleStart: 0, strStart: -1,
    };
    let isbylayerlt = true;
    if (tn.entity) {
      if (r.B()) { // graphics (proxy entity graphics, ODS chapter 29)
        const gs = ver >= 24 ? r.BLL() : r.RL();
        const useful = gs > 0 && gs < 64 * 1024 * 1024 && (tn.name === 'ACAD_PROXY_ENTITY' || !FIXED_TYPES[type]);
        h.hasGraphics = useful;
        if (useful && this.captureGraphics) h.graphics = r.bytes(gs).slice();
        else r.skipBits(gs * 8);
      }
      if (ver <= 14) handleStart = afterMS + r.RL();
      h.entmode = r.BB();
      h.numReactors = r.BL();
      if (ver >= 18) h.xdicMissing = !!r.B(); else h.xdicMissing = false;
      if (ver >= 27) r.B();
      if (ver <= 14) isbylayerlt = !!r.B();
      if (ver <= 15) h.nolinks = !!r.B(); else h.nolinks = true;
      h.color = readENC(r, ver, h);
      h.ltscale = r.BD();
      if (ver >= 15) { h.ltFlags = r.BB(); h.psFlags = r.BB(); }
      if (ver >= 21) { h.matFlags = r.BB(); r.RC(); }
      if (ver >= 24) { h.vs = [r.B(), r.B(), r.B()]; }
      h.invisible = (r.BS() & 1) === 1;
      if (ver >= 15) h.lweight = r.RC();
    } else {
      if (ver <= 14) handleStart = afterMS + r.RL();
      h.numReactors = r.BL();
      if (ver >= 18) h.xdicMissing = !!r.B(); else h.xdicMissing = false;
      if (ver >= 27) r.B();
    }
    // streams
    if (!(handleStart >= afterMS && handleStart <= objEnd)) throw new DwgError('corrupt', 'bad object bit size');
    if (h.numReactors < 0 || h.numReactors > 100000) throw new DwgError('corrupt', 'bad reactor count');
    h.handleStart = handleStart;
    const hdl = this.hd;
    hdl.bit = handleStart; hdl.end = r.end;
    h.hdl = hdl;
    if (ver >= 21) {
      const sr = this.sd;
      sr.bit = 0; sr.end = handleStart;
      const ss = stringStreamStart(sr, handleStart);
      h.strStart = ss;
      if (ss >= 0) { sr.bit = ss; h.str = sr; }
      else { sr.bit = handleStart; h.str = sr; }  // reading from it will fail cleanly (no strings)
      r.end = handleStart;
    }
    // common handles
    if (tn.entity) {
      if (h.entmode === 0) h.owner = hdl.HR(handle);
      for (let i = 0; i < h.numReactors; i++) hdl.H();
      if (!h.xdicMissing) hdl.H();
      if (ver <= 14) {
        h.layer = hdl.HR(handle);
        if (!isbylayerlt) h.ltype = hdl.HR(handle);
      }
      if (ver <= 15 && !h.nolinks) { hdl.H(); hdl.H(); }
      if (h.colorBook) h.color.book = hdl.HR(handle);
      if (ver >= 15) {
        h.layer = hdl.HR(handle);
        if (h.ltFlags === 3) h.ltype = hdl.HR(handle);
        else if (h.ltFlags === 1) h.ltype = -1;
        else if (h.ltFlags === 2) h.ltype = -2;
        if (ver >= 21 && h.matFlags === 3) hdl.H();
        if (h.psFlags === 3) hdl.H();
        if (ver >= 24) { if (h.vs[0]) hdl.H(); if (h.vs[1]) hdl.H(); if (h.vs[2]) hdl.H(); }
      }
    } else {
      h.owner = hdl.HR(handle);
      for (let i = 0; i < h.numReactors; i++) hdl.H();
      if (!h.xdicMissing) hdl.H();
    }
    return h;
  }
}

// TV helper bound to an object head
export function TV(h: ObjHead): string { return h.ver >= 21 ? h.str.TU() : h.dat.T(); }

export function readENC(r: BitReader, ver: number, h?: ObjHead): Color {
  if (ver < 18) return { index: r.BS(), rgb: null };
  const v = r.BS();
  const flags = v & 0xff00;
  const c: Color = { index: v & 0xff, rgb: null };
  if (v === 256 || (flags === 0 && v > 256)) { c.index = v === 256 ? 256 : v & 0x1ff; }
  // sample finding: with 0x4000 (DBCOLOR reference) no RGB value follows in the data stream
  if ((flags & 0x8000) && !(flags & 0x4000)) {
    const rgb = r.BL() >>> 0;
    const kind = rgb >>> 24;
    if (kind === 0xc0) c.index = 256;            // by layer
    else if (kind === 0xc1) c.index = 0;         // by block
    else if (kind === 0xc3) c.index = rgb & 0xff; // ACI stored in rgb
    else c.rgb = rgb & 0xffffff;
    if (kind === 0xc2) c.rgb = rgb & 0xffffff;
  }
  if (flags & 0x4000) { if (h) h.colorBook = true; c.index = v & 0xff; }
  if (flags & 0x2000) { c.transp = r.BL(); }
  return c;
}

// CMC colour (tables, R2004+ with rgb and optional names)
export function readCMC(h: ObjHead): Color {
  const r = h.dat;
  if (h.ver < 18) return { index: r.BS(), rgb: null };
  const idx = r.BS();
  const rgb = r.BL() >>> 0;
  const flags = r.RC();
  if (flags & 1) TV(h);
  if (flags & 2) TV(h);
  const kind = rgb >>> 24;
  if (kind === 0xc2) return { index: idx, rgb: rgb & 0xffffff };
  if (kind === 0xc3) return { index: rgb & 0xff, rgb: null };
  if (kind === 0xc0) return { index: 256, rgb: null };
  if (kind === 0xc1) return { index: 0, rgb: null };
  return { index: idx, rgb: null };
}
