// Pre-R13 DWG (AutoCAD 1.4 / 2.10 / 2.6 / R9 / R10 / R11 / R12): the old linear file format.
// The ODS covers R13 and later only, so this layout comes from byte analysis of sample files (NOTEBOOK.md):
//   0x00  version id (6 bytes)
//   0x14  entity section start, 0x18 entity section end, 0x1c block section start, 0x20 block section size
//   0x2c  table directory: BLOCK, LAYER, STYLE, LTYPE, VIEW as { entry size u16, count u16, flags u16, start u32 }
//   0x5e  header variables (fixed offsets)
// Entities are stored one after the other: type u8 (0x80 = erased), flags u8, length u16, layer index u16,
// optional-field mask u16, then the common optional fields selected by the flags and the type's own data.
// R11/R12 (AC1009) add a CRC after every entity and table entry, handles, extended data and paper space.
import { DwgError } from './bits.ts';
import type { ObjReader, Color } from './objects.ts';
import type { Doc, EntBase, Layer, LType, Style, Block, Layout } from './doc.ts';
import { F_ENTITY } from './doc.ts';
import type { HeaderVars } from './header.ts';

// version id -> format generation (number used in the code below)
export const OLD_VERSIONS: Record<string, number> = {
  'AC1.2': 1, 'AC1.40': 1, 'AC1.50': 1, 'AC2.10': 2, AC1001: 2, AC1002: 2, AC1003: 3, AC1004: 4, AC1005: 4, AC1006: 6, AC1007: 6, AC1008: 6, AC1009: 9,
};
export const OLD_NAMES: Record<string, string> = {
  'AC1.2': 'AutoCAD 1.2', 'AC1.40': 'AutoCAD 1.4', 'AC1.50': 'AutoCAD 2.0', 'AC2.10': 'AutoCAD 2.10', AC1001: 'AutoCAD 2.2', AC1002: 'AutoCAD 2.5', AC1003: 'AutoCAD 2.6', AC1004: 'R9',
  AC1005: 'R9', AC1006: 'R10', AC1007: 'R11 beta', AC1008: 'R11 beta', AC1009: 'R11/R12',
};

const KIND: Record<number, string> = {
  1: 'LINE', 2: 'POINT', 3: 'CIRCLE', 4: 'SHAPE', 7: 'TEXT', 8: 'ARC', 9: 'TRACE', 11: 'SOLID', 12: 'BLOCK',
  13: 'ENDBLK', 14: 'INSERT', 15: 'ATTDEF', 16: 'ATTRIB', 17: 'SEQEND', 18: 'POLYLINE', 19: 'POLYLINE', 20: 'VERTEX',
  21: '3DLINE', 22: '3DFACE', 23: 'DIMENSION', 24: 'VIEWPORT', 5: 'REPEAT', 6: 'ENDREP',
};

const BYLAYER: Color = { index: 256, rgb: null };

export interface OldStats { entities: number; mismatched: Record<string, number>; examples: string[] }

class Cur {
  o: number; b: Uint8Array; dv: DataView; end: number;
  constructor(b: Uint8Array, dv: DataView, o: number, end: number) { this.b = b; this.dv = dv; this.o = o; this.end = end; }
  need(n: number) { if (this.o + n > this.end) throw new Error('entity data overrun'); }
  u8(): number { this.need(1); return this.b[this.o++]; }
  u16(): number { this.need(2); const v = this.dv.getUint16(this.o, true); this.o += 2; return v; }
  i16(): number { this.need(2); const v = this.dv.getInt16(this.o, true); this.o += 2; return v; }
  u32(): number { this.need(4); const v = this.dv.getUint32(this.o, true); this.o += 4; return v; }
  d(): number { this.need(8); const v = this.dv.getFloat64(this.o, true); this.o += 8; return v; }
  p2(): [number, number] { return [this.d(), this.d()]; }
  skip(n: number) { this.need(n); this.o += n; }
}

function cstr(b: Uint8Array, o: number, n: number, dec: TextDecoder): string {
  let e = o;
  const lim = Math.min(b.length, o + n);
  while (e < lim && b[e] !== 0) e++;
  return dec.decode(b.subarray(o, e));
}

interface MView { target: number[]; dir: number[]; twist: number; viewHeight: number; viewCenter: [number, number] }

// R11/R12 extended entity data: an application index, then groups of (code byte, value). Only the MVIEW data
// of paper space viewports is used; it follows the public DXF description of the viewport's extended data.
function parseMView(b: Uint8Array, dv: DataView, o: number, end: number, dec: TextDecoder): MView | null {
  const c = new Cur(b, dv, o, end);
  try {
    c.u16(); // application index
    let isMView = false;
    const pts: number[][] = [], reals: number[] = [];
    while (c.o < c.end) {
      const code = c.u8();
      if (code === 0) { c.u8(); const n = c.u8(); c.need(n); const s = dec.decode(b.subarray(c.o, c.o + n)); c.o += n; if (s === 'MVIEW') isMView = true; }
      else if (code === 2) c.u8();
      else if (code === 3) c.skip(2);
      else if (code === 4) c.skip(c.u8());
      else if (code === 5) c.skip(8);
      else if (code >= 10 && code <= 13) pts.push([c.d(), c.d(), c.d()]);
      else if (code >= 40 && code <= 42) reals.push(c.d());
      else if (code === 70) c.i16();
      else if (code === 71) c.u32();
      else break;
      if (pts.length >= 2 && reals.length >= 4) break;
    }
    if (!isMView || pts.length < 2 || reals.length < 4) return null;
    return { target: pts[0], dir: pts[1], twist: reals[0], viewHeight: reals[1], viewCenter: [reals[2], reals[3]] };
  } catch { return null; }
}

export function buildOldDoc(bytes: Uint8Array, vs: string, onProgress?: (stage: string, ratio: number) => void, stats?: OldStats): Doc {
  const ver = OLD_VERSIONS[vs];
  if (!ver) throw new DwgError('unsupported-version', 'DWG version ' + vs + ' is not supported');
  const b = bytes, dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.length < 0x100) throw new DwgError('corrupt', 'file too short');
  const decoder = new TextDecoder('windows-1252');
  const warnings: string[] = [];
  const u16 = (o: number) => dv.getUint16(o, true), u32 = (o: number) => dv.getUint32(o, true);
  const f64 = (o: number) => dv.getFloat64(o, true);
  const crc = ver >= 9 ? 2 : 0;           // R11+: CRC after every entity and table entry
  const entStart = u32(0x14), entEnd = u32(0x18), blkStart = u32(0x1c), blkSize = u32(0x20) & 0x3fffffff;
  const inFile = (o: number) => o >= 0 && o <= b.length;
  if (!inFile(entStart) || !inFile(entEnd) || entEnd < entStart || !inFile(blkStart)) throw new DwgError('corrupt', 'section addresses out of range');

  // ---------------- header variables (fixed offsets, see NOTEBOOK.md)
  const fin = (v: number, def: number) => (Number.isFinite(v) && Math.abs(v) < 1e15 ? v : def);
  const hv: HeaderVars = {
    ltscale: 1, pdmode: 0, pdsize: 0, textsize: 2.5, lunits: 2, aunits: 0, insunits: 0, measurement: null,
    extMin: null, extMax: null, pextMin: null, pextMax: null, limMin: null, limMax: null, plimMin: null, plimMax: null,
    tilemode: 1, psltscale: 1, ok: true, stage: 'old', dimscale: 1, dimasz: 0.18, dimtxt: 0.18,
  };
  if (ver >= 6) {
    hv.extMin = [fin(f64(0x78), 0), fin(f64(0x80), 0), fin(f64(0x88), 0)];
    hv.extMax = [fin(f64(0x90), 0), fin(f64(0x98), 0), fin(f64(0xa0), 0)];
  }
  if (ver >= 2) {
    hv.limMin = [fin(f64(0xa8), 0), fin(f64(0xb0), 0)];
    hv.limMax = [fin(f64(0xb8), 0), fin(f64(0xc0), 0)];
    const lts = f64(0x132);
    if (lts > 1e-9 && lts < 1e9) hv.ltscale = lts;
    const ts = f64(0x13a);
    if (ts > 1e-9 && ts < 1e9) hv.textsize = ts;
  } else { hv.limMin = [0, 0]; hv.limMax = [0, 0]; }

  // ---------------- tables
  interface TDir { size: number; count: number; start: number }
  const dir = (o: number): TDir => ({ size: u16(o), count: u16(o + 2), start: u32(o + 6) });
  const tBlock = dir(0x2c), tLayer = dir(0x36), tStyle = dir(0x40), tLtype = dir(0x4a);
  const pad = ver >= 9 ? 2 : 0;           // R11+: a 2 byte field after the name of every table entry
  const entries = (t: TDir, minSize: number, f: (o: number, i: number) => void) => {
    if (!t.count) return;
    if (t.size < minSize || t.count > 100000 || !inFile(t.start + t.size * t.count)) { warnings.push('a symbol table could not be read'); return; }
    for (let i = 0; i < t.count; i++) f(t.start + i * t.size, i);
  };
  const layers = new Map<number, Layer>(), ltypes = new Map<number, LType>(), styles = new Map<number, Style>();
  const blocks = new Map<number, Block>();
  // table record handles: index + base, so that all handles are distinct
  const LT0 = 1, LA0 = 100001, ST0 = 200001, BL0 = 300001;
  entries(tLtype, 1 + 32 + pad + 48 + 2 + 8 + 96, (o, i) => {
    const name = cstr(b, o + 1, 32, decoder);
    const q = o + 33 + pad + 48;
    const n = Math.min(12, b[q + 1]);
    const dashes: number[] = [];
    for (let k = 0; k < n; k++) dashes.push(f64(q + 10 + k * 8));
    ltypes.set(LT0 + i, { handle: LT0 + i, name, dashes, patLen: f64(q + 2) });
  });
  const ltHandle = (v: number) => (v < tLtype.count ? LT0 + v : 0);
  entries(tLayer, 1 + 32 + pad + 4, (o, i) => {
    const flag = b[o];
    const name = cstr(b, o + 1, 32, decoder);
    const col = dv.getInt16(o + 33 + pad, true), lt = dv.getInt16(o + 35 + pad, true);
    layers.set(LA0 + i, {
      handle: LA0 + i, name, color: { index: col, rgb: null }, on: col >= 0, frozen: (flag & 1) !== 0, locked: (flag & 4) !== 0,
      ltype: lt >= 0 ? ltHandle(lt) : 0, lweight: 31,
    });
  });
  if (!layers.size) layers.set(LA0, { handle: LA0, name: '0', color: { index: 7, rgb: null }, on: true, frozen: false, locked: false, ltype: 0, lweight: 31 });
  entries(tStyle, 1 + 32 + pad + 33 + 64, (o, i) => {
    const q = o + 33 + pad;
    const font = cstr(b, q + 33, 64, decoder);
    const bigfont = tStyle.size >= 1 + 32 + pad + 33 + 128 ? cstr(b, q + 97, 64, decoder) : '';
    styles.set(ST0 + i, { handle: ST0 + i, name: cstr(b, o + 1, 32, decoder), font, bigfont, wfactor: f64(q + 8), fixedH: f64(q) });
  });
  const blockAddr = new Map<number, number>(); // BLOCK entity address -> block handle
  entries(tBlock, 1 + 32 + pad + 4, (o, i) => {
    const name = cstr(b, o + 1, 32, decoder);
    const raw = u32(o + 33 + pad);
    const h = BL0 + i;
    blocks.set(h, { handle: h, name, base: [0, 0, 0], entities: [], layout: 0, isXref: false, anonymous: name.startsWith('*') });
    blockAddr.set(blkStart + (raw & 0x3fffffff), h);
    if (!(raw & 0x40000000)) blockAddr.set(raw, h);
  });

  // ---------------- entities
  const ents: EntBase[] = [];
  const children = new Map<number, number[]>();
  const typeCounts: Record<string, number> = {};
  const skippedDecode: Record<string, number> = {};
  let failed = 0;
  const MS = 900001, PS = 900002, RP0 = 1000001;
  const msList: number[] = [], psList: number[] = [];
  let viewportsSeen = 0;

  const layerOf = (i: number) => (layers.has(LA0 + i) ? LA0 + i : LA0);
  const styleOf = (i: number) => (styles.has(ST0 + i) ? ST0 + i : (styles.size ? ST0 : 0));

  // one entity at o (n bytes); returns the decoded entity, or null for erased / unknown ones
  const readEnt = (o: number, n: number): EntBase | null => {
    const t = b[o], fl = b[o + 1];
    const code = t & 0x7f;
    const kindRaw = KIND[code];
    if (t & 0x80) return null; // erased
    const end = o + n - crc;
    const c = new Cur(b, dv, o + 4, end);
    const layer = c.u16();
    const opts = c.u16();
    let mview: MView | null = null;
    let paper = false;
    let extra = 0;
    if (ver >= 9 && (fl & 0x40)) {
      extra = c.u8();
      if (extra & 2) {
        const sz = c.u16();
        if (code === 24) mview = parseMView(b, dv, c.o, Math.min(end, c.o + sz), decoder);
        c.skip(sz);
      }
    }
    let color: Color = BYLAYER;
    if (fl & 1) { const v = c.u8(); color = { index: v === 0 ? 0 : v, rgb: null }; }
    let ltype = 0;
    if (fl & 2) {
      const v = ver >= 9 ? c.u16() : c.u8();
      const bylayer = ver >= 9 ? 0x7fff : 0xfe, byblock = ver >= 9 ? 0x7ffe : 0xff;
      ltype = v === byblock ? -1 : v === bylayer ? 0 : ltHandle(v);
    }
    // flag 4: for LINE / POINT / 3DFACE (R10+) the points are 2D; for all other types an elevation follows
    const flat = code === 1 || code === 2 || code === 22 || code === 21;
    const is2d = flat ? (ver < 6 || (fl & 4) !== 0) : true;
    let elev = 0, thick = 0;
    if ((fl & 4) && !(flat && ver >= 6)) elev = c.d();
    if (fl & 8) thick = c.d();
    if (ver >= 9 && (fl & 0x20)) c.skip(c.u8()); // handle
    if (extra & 4) { paper = c.u16() !== 0; }
    if (!kindRaw) { skippedDecode['type ' + code] = (skippedDecode['type ' + code] || 0) + 1; return null; }
    const e: EntBase = {
      kind: kindRaw, handle: 0, layer: layerOf(layer), ltype, color, ltscale: 1, invisible: false, lweight: 29, entmode: paper ? 1 : 2, owner: 0,
    };
    (e as any)._paper = paper;
    const ext = [0, 0, 1];
    const pt = (): number[] => (is2d ? [c.d(), c.d(), elev] : [c.d(), c.d(), c.d()]);
    const str = (): string => { const len = c.u16(); c.need(len); const s = decoder.decode(b.subarray(c.o, c.o + len)); c.o += len; return s; };
    switch (code) {
      case 1: e.p0 = pt(); e.p1 = pt(); e.thick = thick; e.ext = ext; break;
      case 21: { // 3DLINE; before R10 each z is optional (mask bits 0 and 1)
        e.kind = 'LINE';
        if (ver < 6) {
          const a = c.p2(); const za = (opts & 1) ? c.d() : elev;
          const q = c.p2(); const zb = (opts & 2) ? c.d() : elev;
          e.p0 = [a[0], a[1], za]; e.p1 = [q[0], q[1], zb];
        } else { e.p0 = pt(); e.p1 = pt(); }
        e.thick = thick; e.ext = ext;
        break;
      }
      case 2: e.p = pt(); e.thick = thick; e.ext = ext; break;
      case 3: e.c = [c.d(), c.d(), elev]; e.r = c.d(); e.thick = thick; e.ext = ext; break;
      case 8: e.c = [c.d(), c.d(), elev]; e.r = c.d(); e.a0 = c.d(); e.a1 = c.d(); e.thick = thick; e.ext = ext; break;
      case 9: case 11: e.pts = [c.p2(), c.p2(), c.p2(), c.p2()]; e.elev = elev; e.ext = ext; break;
      case 5: break; // REPEAT (AutoCAD 2.x): the entities up to ENDREP are repeated in a grid
      case 6: e.rows = c.u16(); e.cols = c.u16(); e.rowSp = c.d(); e.colSp = c.d(); break;
      case 22: e.pts = [pt(), pt(), pt(), pt()]; e.invis = 0; if (opts & 1) e.invis = c.u8(); break;
      case 4: { // SHAPE: shape fonts are not available
        c.p2(); c.d(); c.u8();
        if (opts & 1) c.d();
        if (opts & 2) c.u8();
        break;
      }
      case 7: case 15: case 16: {
        e.ins = c.p2(); e.height = c.d(); e.elev = elev; e.ext = ext; e.thick = thick;
        e.text = str();
        if (code === 15) { e.prompt = str(); e.tag = str(); e.flags = c.u8(); }
        else if (code === 16) { e.tag = str(); e.flags = c.u8(); }
        e.rot = 0; e.wfactor = 1; e.oblique = 0; e.style = styleOf(0); e.gen = 0; e.halign = 0; e.valign = 0; e.align = null;
        // optional fields: TEXT bit 0 = rotation; attributes have a field length first and shift by one bit
        let m = opts;
        if (code !== 7) { if (m & 1) c.u8(); m >>= 1; }
        if (m & 1) e.rot = c.d();
        if (m & 2) e.wfactor = c.d();
        if (m & 4) e.oblique = c.d();
        if (m & 8) e.style = styleOf(c.u8());
        if (m & 0x10) e.gen = c.u8();
        if (m & 0x20) e.halign = c.u8();
        if (m & 0x40) e.align = c.p2();
        if (m & 0x80) e.ext = [c.d(), c.d(), c.d()];
        if (m & 0x100) e.valign = c.u8();
        if (code === 15) e.kind = 'ATTDEF';
        else if (code === 16) e.kind = 'ATTRIB';
        break;
      }
      case 12: { e.base = c.p2(); if (opts & 2) c.u16(); if (opts & 4) e.name = str(); break; }
      case 13: break;
      case 17: c.u32(); break; // address of the owning entity
      case 14: {
        e.block = BL0 + c.u16();
        const p = c.p2();
        e.ins = [p[0], p[1], elev];
        e.scale = [1, 1, 1]; e.rot = 0; e.ext = ext; e.attribs = []; e.hasAttribs = (fl & 0x80) !== 0;
        if (opts & 1) e.scale[0] = c.d();
        if (opts & 2) e.scale[1] = c.d();
        if (opts & 4) e.rot = c.d();
        if (opts & 8) e.scale[2] = c.d();
        if (opts & 0x10) e.cols = c.u16();
        if (opts & 0x20) e.rows = c.u16();
        if (opts & 0x40) e.colSp = c.d();
        if (opts & 0x80) e.rowSp = c.d();
        if ((e.cols || 1) > 1 || (e.rows || 1) > 1) e.kind = 'MINSERT';
        else e.kind = 'INSERT';
        break;
      }
      case 18: case 19: {
        e.flags = 0; e.sw = 0; e.ew = 0; e.elev = elev; e.ext = ext; e.thick = thick;
        if (opts & 1) e.flags = c.u8();
        if (opts & 2) e.sw = c.d();
        if (opts & 4) e.ew = c.d();
        if (opts & 8) e.m = c.u16();
        if (opts & 0x10) e.n = c.u16();
        e.kind = (e.flags & 64) ? 'POLYLINE_PFACE' : (e.flags & 16) ? 'POLYLINE_MESH' : (e.flags & 8) ? 'POLYLINE_3D' : 'POLYLINE_2D';
        break;
      }
      case 20: {
        const p = c.p2();
        e.p = [p[0], p[1], elev]; e.sw = 0; e.ew = 0; e.bulge = 0; e.flags = 0;
        if (opts & 1) e.sw = c.d();
        if (opts & 2) e.ew = c.d();
        if (opts & 4) e.bulge = c.d();
        if (opts & 8) e.flags = c.u8();
        if (opts & 0x10) e.tdir = c.d();
        e.kind = 'VERTEX_2D';
        break;
      }
      case 23: {
        // block, defpoint (3D), text midpoint, then the optional fields; the block is drawn shifted by point 12
        e.kind = 'DIMENSION_LINEAR';
        e.block = BL0 + c.u16();
        const p3 = (): number[] => (ver >= 6 ? [c.d(), c.d(), c.d()] : [c.d(), c.d(), 0]); // 2D before R10
        e.p10 = p3(); e.textMid = c.p2();
        if (opts & 1) e.p12 = c.p2();
        if (opts & 2) e.dimType = c.u8();
        if (opts & 4) e.userText = str();
        if (opts & 8) e.p13 = p3();
        if (opts & 0x10) e.p14 = p3();
        if (opts & 0x20) e.p15 = p3();
        if (opts & 0x40) e.p16 = p3();
        if (opts & 0x80) e.leaderLen = c.d();
        if (opts & 0x100) e.dimRot = c.d();
        if (opts & 0x7e00) { c.o = end; break; } // not seen in samples
        if (opts & 0x8000) c.u16(); // dimension style index
        if (e.p12) e.blockOffset = e.p12;
        break;
      }
      case 24: {
        e.c = [c.d(), c.d(), c.d()]; e.w = c.d(); e.hgt = c.d(); e.vpId = c.u16();
        viewportsSeen++;
        if (mview && e.vpId !== 1) {
          e.target = mview.target; e.dir = mview.dir; e.twist = mview.twist; e.viewHeight = mview.viewHeight; e.viewCenter = mview.viewCenter;
        } else { e.w = 0; e.hgt = 0; } // viewport 1 is paper space itself
        e.frozen = [];
        break;
      }
    }
    // extrusion direction (R11 mask bit 0) of the simple geometric types
    if (ver >= 9 && (opts & 1) && (code === 1 || code === 2 || code === 3 || code === 8 || code === 9 || code === 11)) e.ext = [c.d(), c.d(), c.d()];
    if (stats) {
      stats.entities++;
      if (c.o !== end) {
        const k = e.kind + ' f=' + fl.toString(16) + ' o=' + opts.toString(16) + ' d=' + (end - c.o);
        stats.mismatched[k] = (stats.mismatched[k] || 0) + 1;
        if (stats.examples.length < 20) stats.examples.push(k + ' @' + o.toString(16));
      }
    }
    return e;
  };

  // walk a section; owner bookkeeping: POLYLINE -> VERTEX ... SEQEND, INSERT (with attributes) -> ATTRIB ... SEQEND
  const walk = (start: number, end: number, onTop: (idx: number, e: EntBase) => void, onBlock?: (o: number, e: EntBase | null) => void) => {
    let o = start;
    let owner = 0;
    let repeat: number[] | null = null;
    let guard = 0;
    while (o + 4 <= end) {
      if ((guard++ & 4095) === 0) onProgress?.('objects', (o - start) / Math.max(1, end - start));
      const t = b[o], n = u16(o + 2);
      if (n < 8 || o + n > end) {
        // a broken length ends the section (the rest cannot be located)
        warnings.push('entity data damaged at offset ' + o + '; the rest of the section was skipped');
        failed++;
        break;
      }
      const code = t & 0x7f;
      let e: EntBase | null = null;
      try { e = readEnt(o, n); }
      catch { failed++; const k = KIND[code] || ('type ' + code); skippedDecode[k] = (skippedDecode[k] || 0) + 1; }
      if (onBlock && (code === 12 || code === 13) && !(t & 0x80)) onBlock(o, e);
      if (e) {
        typeCounts[e.kind] = (typeCounts[e.kind] || 0) + 1;
        const idx = ents.length;
        e.handle = idx + 1;
        ents.push(e);
        const k = e.kind;
        if (k === 'VERTEX_2D' || k === 'ATTRIB') {
          if (owner) {
            children.get(owner)!.push(idx);
            if (k === 'VERTEX_2D') {
              const pk = ents[owner - 1].kind;
              e.kind = pk === 'POLYLINE_3D' ? 'VERTEX_3D' : pk === 'POLYLINE_MESH' ? 'VERTEX_MESH' : pk === 'POLYLINE_PFACE' ? ((e.flags & 128) && !(e.flags & 64) ? 'VERTEX_PFACE_FACE_OLD' : 'VERTEX_PFACE') : 'VERTEX_2D';
            }
          } else if (k === 'ATTRIB') { e.kind = 'TEXT'; onTop(idx, e); }
        } else if (k === 'SEQEND') { owner = 0; }
        else {
          owner = 0;
          if (k.startsWith('POLYLINE') || ((k === 'INSERT' || k === 'MINSERT') && e.hasAttribs)) { owner = e.handle; children.set(owner, []); }
          if (k === 'REPEAT') { repeat = []; e.kind = 'BLOCK'; }
          else if (k === 'ENDREP') {
            // REPEAT ... ENDREP becomes an anonymous block drawn by a MINSERT
            const bh = RP0 + idx;
            blocks.set(bh, { handle: bh, name: '*REPEAT' + idx, base: [0, 0, 0], entities: (repeat || []).map((i) => i + 1), layout: 0, isXref: false, anonymous: true });
            repeat = null;
            Object.assign(e, { kind: 'MINSERT', block: bh, ins: [0, 0, 0], scale: [1, 1, 1], rot: 0, ext: [0, 0, 1], attribs: [], hasAttribs: false });
            onTop(idx, e);
          } else if (k !== 'BLOCK' && k !== 'ENDBLK') { if (repeat) repeat.push(idx); else onTop(idx, e); }
        }
      }
      o += n;
    }
  };

  // AutoCAD 1.x: entities without lengths or flags, blocks inline in the entity list, layers are numbers
  const walkR1 = (start: number, end: number) => {
    const c = new Cur(b, dv, start, end);
    const str = (): string => { const len = c.u16(); c.need(len); const s = decoder.decode(b.subarray(c.o, c.o + len)); c.o += len; return s; };
    const byName = new Map<string, number>();
    const inserts: EntBase[] = [];
    let curB: Block | null = null, repeat: number[] | null = null, nb = 0;
    while (c.o < end) {
      const t = c.i16(), code = Math.abs(t), lay = c.i16();
      let lh = LA0 + 1000 + lay;
      if (!layers.has(lh)) layers.set(lh, { handle: lh, name: String(lay), color: { index: 7, rgb: null }, on: true, frozen: false, locked: false, ltype: 0, lweight: 31 });
      const e: EntBase = { kind: KIND[code] || '', handle: 0, layer: lh, ltype: 0, color: BYLAYER, ltscale: 1, invisible: false, lweight: 29, entmode: 2, owner: 0 };
      const ext = [0, 0, 1];
      switch (code) {
        case 1: e.p0 = [c.d(), c.d(), 0]; e.p1 = [c.d(), c.d(), 0]; e.ext = ext; break;
        case 2: e.p = [c.d(), c.d(), 0]; e.ext = ext; break;
        case 3: e.c = [c.d(), c.d(), 0]; e.r = c.d(); e.ext = ext; break;
        case 8: e.c = [c.d(), c.d(), 0]; e.r = c.d(); e.a0 = c.d(); e.a1 = c.d(); e.ext = ext; break;
        case 4: c.skip(32); c.u16(); break;
        case 7: e.ins = c.p2(); e.height = c.d(); e.rot = c.d(); e.text = str(); e.ext = ext; e.elev = 0; e.wfactor = 1; e.style = 0; e.halign = 0; e.valign = 0; e.align = null; break;
        case 9: case 11: e.pts = [c.p2(), c.p2(), c.p2(), c.p2()]; e.elev = 0; e.ext = ext; break;
        case 10: str(); e.kind = 'LOAD'; break; // shape file load
        case 12: e.name = str(); e.base = c.p2(); break;
        case 13: break;
        case 14: e.blockName = str(); e.ins = [c.d(), c.d(), 0]; e.scale = [c.d(), c.d(), 1]; e.rot = c.d(); e.ext = ext; e.attribs = []; e.hasAttribs = false; inserts.push(e); break;
        case 5: break;
        case 6: e.rows = c.u16(); e.cols = c.u16(); e.rowSp = c.d(); e.colSp = c.d(); break;
        default: throw new DwgError('unsupported-version', 'AutoCAD 1.x entity type ' + code + ' is not known');
      }
      if (t < 0 || !e.kind) continue; // erased
      typeCounts[e.kind] = (typeCounts[e.kind] || 0) + 1;
      const idx = ents.length;
      e.handle = idx + 1;
      ents.push(e);
      if (code === 12) {
        const h = BL0 + 50000 + nb++;
        curB = { handle: h, name: e.name, base: [e.base[0], e.base[1], 0], entities: [], layout: 0, isXref: false, anonymous: false };
        blocks.set(h, curB); byName.set(e.name.toUpperCase(), h);
        continue;
      }
      if (code === 13) { curB = null; continue; }
      if (code === 5) { repeat = []; e.kind = 'BLOCK'; continue; }
      if (code === 10) { e.kind = 'BLOCK'; continue; }
      if (code === 6) {
        const bh = RP0 + idx;
        blocks.set(bh, { handle: bh, name: '*REPEAT' + idx, base: [0, 0, 0], entities: (repeat || []).map((i) => i + 1), layout: 0, isXref: false, anonymous: true });
        repeat = null;
        Object.assign(e, { kind: 'MINSERT', block: bh, ins: [0, 0, 0], scale: [1, 1, 1], rot: 0, ext: [0, 0, 1], attribs: [], hasAttribs: false });
      }
      if (repeat) repeat.push(idx);
      else if (curB) curB.entities!.push(idx + 1);
      else msList.push(idx + 1);
    }
    if (c.o !== end) throw new DwgError('corrupt', 'entity list does not end at the recorded end');
    for (const e of inserts) e.block = byName.get(String(e.blockName).toUpperCase()) || 0;
  };
  if (ver === 1) {
    const end = u32(0x24);
    if (end < 0x202 || end > b.length) throw new DwgError('corrupt', 'entity list end out of range');
    // sample finding: the entity list of AutoCAD 1.4 files starts right after a fixed size header
    walkR1(0x202, end);
  } else walk(entStart, entEnd, (idx, e) => { (e._paper ? psList : msList).push(idx + 1); });
  // block section: BLOCK ... ENDBLK groups, matched to the block table by address
  let cur: Block | null = null;
  if (blkSize > 0 && blkStart < b.length) {
    walk(blkStart, Math.min(b.length, blkStart + blkSize), (idx, e) => {
      if (e.kind === 'ENDBLK') return;
      if (cur) cur.entities!.push(idx + 1);
    }, (o, e) => {
      if (b[o] === 13) { cur = null; return; }
      const h = blockAddr.get(o);
      cur = h ? blocks.get(h)! : null;
      if (cur && e && e.base) cur.base = [e.base[0], e.base[1], 0];
    });
  }
  // compact index in the shape the renderer expects (ATTRIBs and VERTEXes are reached through `children`)
  const n = ents.length;
  const handles = new Float64Array(n), offs = new Uint32Array(n), type = new Uint16Array(n), mode = new Uint8Array(n), flags = new Uint8Array(n);
  for (let i = 0; i < n; i++) { handles[i] = i + 1; flags[i] = F_ENTITY; mode[i] = ents[i].entmode; }
  blocks.set(MS, { handle: MS, name: '*Model_Space', base: [0, 0, 0], entities: msList, layout: 0, isXref: false, anonymous: false });
  if (psList.length) blocks.set(PS, { handle: PS, name: '*Paper_Space', base: [0, 0, 0], entities: psList, layout: 0, isXref: false, anonymous: false });
  if (viewportsSeen && !psList.length) warnings.push('paper space viewports without paper space entities');
  hv.plimMin = hv.limMin; hv.plimMax = hv.limMax;
  // paper space: one layout with the header limits. Old files carry no units; limits of a standard inch sheet
  // (ANSI / ARCH sizes) mean the paper is in inches
  const layouts: Layout[] = [];
  if (psList.length) {
    const lw = (hv.limMax![0] - hv.limMin![0]), lh = (hv.limMax![1] - hv.limMin![1]);
    const SHEETS = [[8.5, 11], [11, 17], [17, 22], [22, 34], [34, 44], [9, 12], [12, 18], [18, 24], [24, 36], [36, 48], [30, 42]];
    const a = Math.min(lw, lh), c2 = Math.max(lw, lh);
    const inch = SHEETS.some(([x, y]) => Math.abs(a - x) < 0.02 * x && Math.abs(c2 - y) < 0.02 * y);
    layouts.push({
      handle: PS, name: 'Paper space', tab: 1, block: PS, paperW: inch ? lw * 25.4 : 0, paperH: inch ? lh * 25.4 : 0, paperUnits: inch ? 0 : 1,
      plotRot: 0, limMin: hv.limMin!, limMax: hv.limMax!, extMin: [0, 0, 0], extMax: [0, 0, 0], margins: [0, 0, 0, 0], realUnits: 1, drawUnits: 1,
    });
  }
  const SKIP = new Set(['SEQEND', 'ENDBLK', 'BLOCK']);
  let entCount = 0;
  for (const e of ents) if (!SKIP.has(e.kind)) entCount++;
  const doc: Doc = {
    ver: 12, verStr: vs, hv, layers, ltypes, styles, blocks, layouts, dbcolors: new Map(), ms: MS, ps: psList.length ? PS : 0,
    warnings, failed, skippedDecode, objects: n, entities: entCount, typeCounts, decoder,
    handles, offs, type, mode, flags, children, spaceList: [[], []], reader: null as unknown as ObjReader,
    indexOf(h: number) { return h >= 1 && h <= n ? h - 1 : -1; },
    entAt(i: number) { if (i < 0 || i >= n) return null; const e = ents[i]; return SKIP.has(e.kind) ? null : e; },
    ent(h: number) { return doc.entAt(h - 1); },
    typeName(i: number) { return i >= 0 && i < n ? ents[i].kind : ''; },
    release() { /* nothing large to free */ },
  };
  return doc;
}
