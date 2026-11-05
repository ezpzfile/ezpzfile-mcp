// Drawing database: tables, blocks, layouts and a compact index of all objects.
// Entities are NOT kept decoded: a first pass reads only each object's common header (type, entity mode, owner);
// entity data is decoded on demand while drawing (Doc.entAt), which keeps memory close to the size of the file.
import { DwgError } from './bits.ts';
import type { Container } from './container.ts';
import { parseObjectMapArrays, parseClasses, ObjReader, readCMC } from './objects.ts';
import type { Color } from './objects.ts';
import { decodeEntity, decodeTable } from './entities.ts';
import { parseHeader } from './header.ts';
import type { HeaderVars } from './header.ts';

export interface EntBase {
  kind: string; handle: number; layer: number; ltype: number; color: Color; ltscale: number;
  invisible: boolean; lweight: number; entmode: number; owner: number;
  [k: string]: any;
}
export interface Layer { handle: number; name: string; color: Color; on: boolean; frozen: boolean; locked: boolean; ltype: number; lweight: number }
export interface LType { handle: number; name: string; dashes: number[]; patLen: number }
export interface Style { handle: number; name: string; font: string; bigfont: string; wfactor: number; fixedH: number }
export interface Block { handle: number; name: string; base: [number, number, number]; entities: number[] | null; layout: number; isXref: boolean; anonymous: boolean }
export interface Layout { handle: number; name: string; tab: number; block: number; paperW: number; paperH: number; paperUnits: number; plotRot: number;
  limMin: [number, number]; limMax: [number, number]; extMin: number[]; extMax: number[]; margins: number[]; realUnits: number; drawUnits: number }

// per object flags of the first pass
export const F_ENTITY = 1, F_GRAPHICS = 2, F_FAILED = 4;

export interface Doc {
  ver: number; verStr: string; hv: HeaderVars;
  layers: Map<number, Layer>; ltypes: Map<number, LType>; styles: Map<number, Style>;
  blocks: Map<number, Block>; layouts: Layout[];
  dbcolors: Map<number, number>;
  ms: number; ps: number;
  warnings: string[];
  failed: number; skippedDecode: Record<string, number>; objects: number; entities: number;
  typeCounts: Record<string, number>;
  decoder: TextDecoder;
  // compact object index (sorted by handle)
  handles: Float64Array; offs: Float64Array | Uint32Array;
  type: Uint16Array; mode: Uint8Array; flags: Uint8Array;
  children: Map<number, number[]>;    // owner handle -> object indices (entity mode 0), in handle order
  spaceList: [number[], number[]];    // R13-R2000: indices with entity mode 1 (paper) and 2 (model)
  reader: ObjReader;
  indexOf(handle: number): number;
  entAt(index: number): EntBase | null;
  ent(handle: number): EntBase | null;
  typeName(index: number): string;
  release(): void;
}

const CODEPAGES: Record<number, string> = {
  // DWG code page enumeration as observed in samples (29 = Cyrillic 1251, 30 = Western 1252); the rest
  // follow the same ANSI ordering and are a best guess.
  28: 'windows-1250', 29: 'windows-1251', 30: 'windows-1252', 31: 'windows-1253', 32: 'windows-1254',
  33: 'windows-1255', 34: 'windows-1256', 35: 'windows-1257', 36: 'windows-874', 37: 'shift_jis',
  38: 'gbk', 39: 'euc-kr', 40: 'big5', 43: 'windows-1258',
};

const SKIP = new Set(['SEQEND', 'ENDBLK', 'BLOCK']);

export function buildDoc(c: Container, onProgress?: (stage: string, ratio: number) => void): Doc {
  const warnings = [...c.warnings];
  let decoder: TextDecoder;
  try { decoder = new TextDecoder(CODEPAGES[c.codepage] || 'windows-1252'); }
  catch { decoder = new TextDecoder('windows-1252'); }
  if (!c.handles) throw new DwgError('corrupt', 'object map missing');
  const map = parseObjectMapArrays(c.handles);
  c.handles = null; // no longer needed
  if (map.n === 0) throw new DwgError('corrupt', 'object map is empty');
  const classes = parseClasses(c, decoder, warnings);
  const hv = parseHeader(c, decoder, warnings);
  c.header = null; c.classes = null;
  const R = new ObjReader(c.objects, c.ver, decoder, classes);
  const n = map.n;
  const handles = map.handles.length === n ? map.handles : map.handles.subarray(0, n);
  // offsets fit in 32 bits (negative / broken ones wrap to large values and fail the range check)
  const offs = Uint32Array.from(map.offs.subarray(0, n));
  const type = new Uint16Array(n), mode = new Uint8Array(n), flags = new Uint8Array(n);
  const children = new Map<number, number[]>();
  const spaceList: [number[], number[]] = [[], []];
  const typeCounts: Record<string, number> = {};
  const doc: Doc = {
    ver: c.ver, verStr: c.verStr, hv,
    layers: new Map(), ltypes: new Map(), styles: new Map(), blocks: new Map(), layouts: [],
    dbcolors: new Map(), ms: 0, ps: 0, warnings, failed: 0, skippedDecode: {}, objects: n, entities: 0,
    typeCounts, decoder, handles, offs, type, mode, flags, children, spaceList, reader: R,
    indexOf(h: number): number {
      let lo = 0, hi = n - 1;
      while (lo <= hi) { const m = (lo + hi) >> 1; const v = handles[m]; if (v === h) return m; if (v < h) lo = m + 1; else hi = m - 1; }
      return -1;
    },
    typeName(i: number): string { return R.typeName(type[i]).name; },
    entAt(i: number): EntBase | null {
      if (i < 0 || i >= n || !(flags[i] & F_ENTITY) || (flags[i] & F_FAILED)) return null;
      let tn = '';
      try {
        R.captureGraphics = (flags[i] & F_GRAPHICS) !== 0;
        const h = R.head(offs[i]);
        tn = h.typeName;
        if (SKIP.has(tn)) return null;
        const e = decodeEntity(h) as EntBase | null;
        if (e && h.graphics) e.graphics = h.graphics;
        return e;
      } catch {
        flags[i] |= F_FAILED;
        if (!tn) tn = R.typeName(type[i]).name;
        doc.skippedDecode[tn] = (doc.skippedDecode[tn] || 0) + 1;
        return null;
      } finally { R.captureGraphics = false; }
    },
    ent(h: number): EntBase | null { return doc.entAt(doc.indexOf(h)); },
    release() { c.objects = new Uint8Array(0); R.data = new Uint8Array(0); },
  };
  const TABLES = new Set(['LAYER', 'LTYPE', 'STYLE', 'BLOCK_HEADER', 'LAYOUT']);
  R.captureGraphics = false;
  for (let i = 0; i < n; i++) {
    if (onProgress && (i & 16383) === 0) onProgress('objects', i / n);
    const off = offs[i];
    if (off < 0 || off >= c.objects.length) { doc.failed++; flags[i] = F_FAILED; continue; }
    let h;
    try { h = R.head(off); } catch { doc.failed++; flags[i] = F_FAILED; continue; }
    const tn = h.typeName;
    type[i] = h.type;
    typeCounts[tn] = (typeCounts[tn] || 0) + 1;
    if (h.isEntity) {
      flags[i] = F_ENTITY | (h.hasGraphics ? F_GRAPHICS : 0);
      mode[i] = h.entmode;
      doc.entities++;
      if (h.entmode === 0) {
        if (h.owner) { let l = children.get(h.owner); if (!l) { l = []; children.set(h.owner, l); } l.push(i); }
      } else if (c.ver < 18 && (h.entmode === 1 || h.entmode === 2)) spaceList[h.entmode - 1].push(i);
      continue;
    }
    try {
      if (TABLES.has(tn)) {
        const o = decodeTable(h);
        if (tn === 'LAYER') doc.layers.set(h.handle, { handle: h.handle, name: o.name, color: o.color, on: o.on && o.color.index >= 0, frozen: o.frozen, locked: o.locked, ltype: o.ltype, lweight: o.lweight ?? 31 });
        else if (tn === 'LTYPE') doc.ltypes.set(h.handle, { handle: h.handle, name: o.name, dashes: o.dashes, patLen: o.patLen });
        else if (tn === 'STYLE') doc.styles.set(h.handle, { handle: h.handle, name: o.name, font: o.font, bigfont: o.bigfont, wfactor: o.wfactor, fixedH: o.fixedH });
        else if (tn === 'BLOCK_HEADER') doc.blocks.set(h.handle, { handle: h.handle, name: o.name, base: o.base, entities: o.entities, layout: o.layout || 0, isXref: !!o.isXref, anonymous: !!o.anonymous });
        else if (tn === 'LAYOUT') doc.layouts.push({ handle: h.handle, name: o.name, tab: o.tab, block: o.block, paperW: o.paperW, paperH: o.paperH, paperUnits: o.paperUnits, plotRot: o.plotRot, limMin: o.limMin, limMax: o.limMax, extMin: o.extMin, extMax: o.extMax, margins: o.margins, realUnits: o.realUnits, drawUnits: o.drawUnits });
      } else if (tn === 'DBCOLOR') {
        const col = readCMC(h);
        if (col.rgb !== null) doc.dbcolors.set(h.handle, col.rgb);
      }
    } catch {
      doc.skippedDecode[tn] = (doc.skippedDecode[tn] || 0) + 1;
    }
  }
  for (const b of doc.blocks.values()) {
    const nm = (b.name || '').toUpperCase();
    if (nm === '*MODEL_SPACE' && !doc.ms) doc.ms = b.handle;
    else if (nm === '*PAPER_SPACE' && !doc.ps) doc.ps = b.handle;
  }
  if (!doc.ms) warnings.push('model space block not found');
  return doc;
}
