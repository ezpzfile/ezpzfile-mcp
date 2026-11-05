// DXF tokenizer and document model (ASCII and binary DXF).
// Clean-room implementation from the Autodesk DXF Reference (group code value types, "About Binary DXF Files",
// section/table/entity group code tables). No third-party parser code was used.

import { CadError } from './types.ts';

export interface Tokens {
  codes: Int32Array;
  vals: Array<string | number>;
  n: number;
}

export const BINARY_SENTINEL = 'AutoCAD Binary DXF\r\n\x1a\0';

// ------------------------------------------------------------------ sniffing

function isBinaryDxf(b: Uint8Array): boolean {
  if (b.length < 22) return false;
  for (let i = 0; i < 22; i++) if (b[i] !== BINARY_SENTINEL.charCodeAt(i)) return false;
  return true;
}

export function sniffDxf(bytes: Uint8Array): boolean {
  if (isBinaryDxf(bytes)) return true;
  // ASCII: optional BOM, then pairs; the first group should be 0 SECTION or 999 comment
  const n = Math.min(bytes.length, 4096);
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(bytes[i]);
  if (s.charCodeAt(0) === 0xef && s.charCodeAt(1) === 0xbb && s.charCodeAt(2) === 0xbf) s = s.slice(3);
  const lines = s.split(/\r\n|\n|\r/);
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  // skip 999 comments
  while (i + 1 < lines.length && lines[i].trim() === '999') i += 2;
  if (i + 1 >= lines.length) return false;
  if (lines[i].trim() !== '0') return false;
  const v = lines[i + 1].trim().toUpperCase();
  return v === 'SECTION';
}

// ------------------------------------------------------------------ encoding

function findAscii(b: Uint8Array, needle: string, limit: number): number {
  const n = needle.length;
  const end = Math.min(b.length - n, limit);
  const c0 = needle.charCodeAt(0);
  outer: for (let i = 0; i <= end; i++) {
    if (b[i] !== c0) continue;
    for (let k = 1; k < n; k++) if (b[i + k] !== needle.charCodeAt(k)) continue outer;
    return i;
  }
  return -1;
}

/** Reads the value of a header variable without tokenizing: works for ASCII and binary files */
function peekHeaderString(b: Uint8Array, name: string, binary: boolean): string | null {
  const at = findAscii(b, name, 1 << 20);
  if (at < 0) return null;
  let p = at + name.length;
  if (binary) {
    if (b[p] !== 0) return null;
    p++;
    // group code 1 or 3: one or two bytes
    if (b[p] === 1 || b[p] === 3) { p++; if (b[p] === 0) p++; } else return null;
    let s = '';
    while (p < b.length && b[p] !== 0 && s.length < 64) s += String.fromCharCode(b[p++]);
    return s;
  }
  // ASCII: newline, code line, value line
  const take = () => {
    while (p < b.length && (b[p] === 13 || b[p] === 10)) p++;
    let s = '';
    while (p < b.length && b[p] !== 13 && b[p] !== 10 && s.length < 80) s += String.fromCharCode(b[p++]);
    return s;
  };
  take(); // rest of name line (usually empty)
  const code = take().trim();
  if (code !== '1' && code !== '3') return null;
  return take().trim();
}

const CP_MAP: Record<string, string> = {
  ANSI_874: 'windows-874', ANSI_932: 'shift_jis', ANSI_936: 'gbk', ANSI_949: 'euc-kr', ANSI_950: 'big5',
  ANSI_1250: 'windows-1250', ANSI_1251: 'windows-1251', ANSI_1252: 'windows-1252', ANSI_1253: 'windows-1253',
  ANSI_1254: 'windows-1254', ANSI_1255: 'windows-1255', ANSI_1256: 'windows-1256', ANSI_1257: 'windows-1257',
  ANSI_1258: 'windows-1258', ANSI_1361: 'euc-kr', DOS932: 'shift_jis', DOS936: 'gbk', DOS949: 'euc-kr', DOS950: 'big5',
  DOS866: 'ibm866', 'MAC-ROMAN': 'macintosh', BIG5: 'big5', GB2312: 'gbk', KSC5601: 'euc-kr', JOHAB: 'euc-kr',
  ISO8859_1: 'iso-8859-1', ISO8859_2: 'iso-8859-2', ISO8859_3: 'iso-8859-3', ISO8859_4: 'iso-8859-4', ISO8859_5: 'iso-8859-5',
  ISO8859_6: 'iso-8859-6', ISO8859_7: 'iso-8859-7', ISO8859_8: 'iso-8859-8', ISO8859_9: 'iso-8859-9',
};

export function codepageLabel(cp: string | null): string {
  if (!cp) return 'windows-1252';
  const k = cp.trim().toUpperCase().replace(/-/g, (m) => m);
  return CP_MAP[k] ?? CP_MAP[k.replace('-', '_')] ?? 'windows-1252';
}

function makeDecoder(label: string): TextDecoder {
  try { return new TextDecoder(label); } catch { return new TextDecoder('windows-1252'); }
}

// ------------------------------------------------------------------ tokenizing

export interface TokenizeResult {
  tokens: Tokens;
  binary: boolean;
  acadver: string | null;
  codepage: string | null;
  encoding: string;
  warnings: string[];
}

export function tokenize(bytes: Uint8Array): TokenizeResult {
  const binary = isBinaryDxf(bytes);
  const warnings: string[] = [];
  const acadver = peekHeaderString(bytes, '$ACADVER', binary);
  const codepage = peekHeaderString(bytes, '$DWGCODEPAGE', binary);
  const verNum = acadver && /^AC(\d{4})$/.test(acadver) ? parseInt(acadver.slice(2), 10) : 0;
  let encoding = codepageLabel(codepage);
  if (verNum >= 1021) encoding = 'utf-8';
  if (binary) {
    const tokens = tokenizeBinary(bytes, makeDecoder(encoding), warnings);
    return { tokens, binary, acadver, codepage, encoding, warnings };
  }
  let text: string;
  let start = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) { start = 3; encoding = 'utf-8'; }
  const body = start ? bytes.subarray(start) : bytes;
  if (encoding === 'utf-8') {
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(body); }
    catch {
      encoding = codepageLabel(codepage);
      warnings.push(`file is not valid UTF-8, decoded as ${encoding}`);
      text = makeDecoder(encoding).decode(body);
    }
  } else {
    // files without a code page that are valid UTF-8 (common for third-party writers) are read as UTF-8
    if (!codepage) {
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(body); encoding = 'utf-8'; }
      catch {
        // no code page and not UTF-8: Japanese files (Jw_cad exports, R12) are usually Shift_JIS; accept it when
        // the bytes decode cleanly and give Japanese characters, else fall back to windows-1252
        let sj: string | null = null;
        try { sj = new TextDecoder('shift_jis', { fatal: true }).decode(body); } catch { sj = null; }
        if (sj && /[\u3040-\u30ff\u4e00-\u9fff]/.test(sj)) { text = sj; encoding = 'shift_jis'; warnings.push('no $DWGCODEPAGE: text decoded as Shift_JIS'); }
        else text = makeDecoder(encoding).decode(body);
      }
    } else text = makeDecoder(encoding).decode(body);
  }
  const tokens = tokenizeAscii(text, warnings);
  return { tokens, binary, acadver, codepage, encoding, warnings };
}

function tokenizeAscii(text: string, warnings: string[]): Tokens {
  // count lines first to size the arrays
  let lines = 0;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) lines++;
  const cap = (lines >> 1) + 2;
  const codes = new Int32Array(cap);
  const vals: Array<string | number> = new Array(cap);
  let n = 0;
  let pos = 0;
  const len = text.length;
  const nextLine = (): string | null => {
    if (pos >= len) return null;
    let e = text.indexOf('\n', pos);
    if (e === -1) e = len;
    let end = e;
    if (end > pos && text.charCodeAt(end - 1) === 13) end--;
    const s = text.slice(pos, end);
    pos = e + 1;
    return s;
  };
  for (;;) {
    let cl = nextLine();
    if (cl === null) break;
    // tolerate blank lines between pairs at the end
    if (cl.trim() === '') { if (pos >= len) break; cl = nextLine(); if (cl === null) break; }
    const code = parseInt(cl, 10);
    const vl = nextLine();
    if (vl === null) break;
    if (Number.isNaN(code)) {
      warnings.push(`bad group code line near byte ${pos}, stopped reading`);
      break;
    }
    if (n >= codes.length) break;
    codes[n] = code;
    vals[n] = vl;
    n++;
    if (code === 0 && vl === 'EOF') break;
  }
  return { codes, vals, n };
}

/** binary value kind for a group code: 's' string, 'd' double, 'h' int16, 'l' int32, 'q' int64, 'b' bool byte, 'x' binary chunk */
function binKind(c: number): 's' | 'd' | 'h' | 'l' | 'q' | 'b' | 'x' {
  if (c <= 9) return 's';
  if (c <= 59) return 'd';
  if (c <= 79) return 'h';
  if (c >= 90 && c <= 99) return 'l';
  if (c === 100 || c === 102 || c === 105) return 's';
  if (c >= 110 && c <= 149) return 'd';
  if (c >= 160 && c <= 169) return 'q';
  if (c >= 170 && c <= 179) return 'h';
  if (c >= 210 && c <= 239) return 'd';
  if (c >= 270 && c <= 289) return 'h';
  if (c >= 290 && c <= 299) return 'b';
  if (c >= 300 && c <= 309) return 's';
  if (c >= 310 && c <= 319) return 'x';
  if (c >= 320 && c <= 369) return 's';
  if (c >= 370 && c <= 389) return 'h';
  if (c >= 390 && c <= 399) return 's';
  if (c >= 400 && c <= 409) return 'h';
  if (c >= 410 && c <= 419) return 's';
  if (c >= 420 && c <= 429) return 'l';
  if (c >= 430 && c <= 439) return 's';
  if (c >= 440 && c <= 459) return 'l';
  if (c >= 460 && c <= 469) return 'd';
  if (c >= 470 && c <= 481) return 's';
  if (c === 999) return 's';
  if (c >= 1000 && c <= 1003) return 's';
  if (c === 1004) return 'x';
  if (c >= 1005 && c <= 1009) return 's';
  if (c >= 1010 && c <= 1059) return 'd';
  if (c >= 1060 && c <= 1070) return 'h';
  if (c === 1071) return 'l';
  return 's';
}

function tokenizeBinary(b: Uint8Array, dec: TextDecoder, warnings: string[]): Tokens {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let p = 22;
  // 2 byte group codes (R14 and later) start with 00 00 'S'; 1 byte codes (R13 and older) with 00 'S'
  const twoByte = b[p] === 0 && b[p + 1] === 0;
  const cap = Math.max(16, Math.floor(b.length / 6));
  let codes = new Int32Array(Math.min(cap, 1 << 20));
  let vals: Array<string | number> = [];
  let n = 0;
  const readStr = () => {
    let e = p;
    while (e < b.length && b[e] !== 0) e++;
    let ascii = true;
    for (let i = p; i < e; i++) if (b[i] > 127) { ascii = false; break; }
    let s: string;
    if (ascii) { s = ''; for (let i = p; i < e; i++) s += String.fromCharCode(b[i]); }
    else s = dec.decode(b.subarray(p, e));
    p = e + 1;
    return s;
  };
  try {
    while (p < b.length) {
      let code: number;
      if (twoByte) { code = dv.getUint16(p, true); p += 2; }
      else {
        code = b[p++];
        if (code === 255) { code = dv.getUint16(p, true); p += 2; }
      }
      let v: string | number;
      switch (binKind(code)) {
        case 's': v = readStr(); break;
        case 'd': v = dv.getFloat64(p, true); p += 8; break;
        case 'h': v = dv.getInt16(p, true); p += 2; break;
        case 'l': v = dv.getInt32(p, true); p += 4; break;
        case 'q': v = Number(dv.getBigInt64(p, true)); p += 8; break;
        case 'b': v = b[p]; p += 1; break;
        case 'x': {
          const l = b[p++];
          let s = '';
          for (let i = 0; i < l; i++) { const x = b[p + i]; s += (x < 16 ? '0' : '') + x.toString(16).toUpperCase(); }
          p += l;
          v = s;
          break;
        }
      }
      if (n >= codes.length) { const c2 = new Int32Array(codes.length * 2); c2.set(codes); codes = c2; }
      codes[n] = code;
      vals.push(v!);
      n++;
      if (code === 0 && v === 'EOF') break;
    }
  } catch {
    warnings.push(`binary DXF truncated at byte ${p}`);
  }
  return { codes, vals, n };
}

// ------------------------------------------------------------------ document model

export interface Ent {
  type: string;
  s: number; // first token index (the 0 group)
  e: number; // end (exclusive)
  kids?: Ent[];
}

export interface LayerDef { name: string; color: number; trueColor: number | null; off: boolean; frozen: boolean; ltype: string; lw: number; handle: string; plot: boolean }
export interface LtypeDef { name: string; dashes: number[]; total: number }
export interface StyleDef { name: string; font: string; bigfont: string; height: number; width: number; family: string | null }
export interface DimStyleDef { name: string; asz: number; scale: number; txt: number }
export interface BlockDef { name: string; base: [number, number, number]; flags: number; ents: Ent[]; handle: string; recordHandle: string; layer: string; xrefPath: string }
export interface LayoutDef { name: string; tab: number; blockRecord: string; limmin: [number, number]; limmax: [number, number]; extmin: [number, number]; extmax: [number, number]; paper: [number, number]; units: number; rotation: number; handle: string }
export interface MlineStyleDef { name: string; elements: Array<{ offset: number; color: number; ltype: string }> }

export interface DxfDoc {
  t: Tokens;
  header: Map<string, Array<[number, string | number]>>;
  layers: Map<string, LayerDef>;
  layerOrder: string[];
  ltypes: Map<string, LtypeDef>;
  styles: Map<string, StyleDef>;
  dimstyles: Map<string, DimStyleDef>;
  blocks: Map<string, BlockDef>;            // key: upper-case name
  blockRecords: Map<string, string>;         // handle -> block name
  entities: Ent[];
  layouts: LayoutDef[];
  mlineStyles: Map<string, MlineStyleDef>;   // handle -> style (also by upper-case name)
  imageDefs: Map<string, string>;            // handle -> file name
  objectsByHandle: Map<string, Ent>;
  warnings: string[];
}

export const num = (v: string | number | undefined): number => (typeof v === 'number' ? v : v === undefined ? NaN : parseFloat(v));
export const int = (v: string | number | undefined): number => (typeof v === 'number' ? Math.trunc(v) : v === undefined ? NaN : parseInt(v, 10));
export const str = (v: string | number | undefined): string => (v === undefined ? '' : typeof v === 'number' ? String(v) : v.trim());

/** Split a token range into entities at 0 groups, grouping POLYLINE/VERTEX/SEQEND and INSERT/ATTRIB/SEQEND */
export function splitEntities(t: Tokens, s: number, e: number, stopAt?: string): { ents: Ent[]; end: number } {
  const raw: Ent[] = [];
  let i = s;
  while (i < e && t.codes[i] !== 0) i++;
  let end = e;
  while (i < e) {
    const type = str(t.vals[i]).toUpperCase();
    if (stopAt && type === stopAt) { end = i; break; }
    let j = i + 1;
    while (j < e && t.codes[j] !== 0) j++;
    raw.push({ type, s: i, e: j });
    i = j;
  }
  const ents: Ent[] = [];
  for (let k = 0; k < raw.length; k++) {
    const r = raw[k];
    if (r.type === 'POLYLINE' || r.type === 'INSERT') {
      const kids: Ent[] = [];
      const kidType = r.type === 'POLYLINE' ? 'VERTEX' : 'ATTRIB';
      let m = k + 1;
      while (m < raw.length && (raw[m].type === kidType)) { kids.push(raw[m]); m++; }
      if (m < raw.length && raw[m].type === 'SEQEND' && (kids.length > 0 || r.type === 'POLYLINE' || hasAttribsFollow(t, r))) m++;
      if (kids.length) r.kids = kids;
      ents.push(r);
      k = m - 1;
    } else if (r.type === 'SEQEND' || r.type === 'VERTEX' || r.type === 'ATTRIB') {
      // stray: ignore
    } else ents.push(r);
  }
  return { ents, end };
}
function hasAttribsFollow(t: Tokens, r: Ent): boolean {
  for (let i = r.s + 1; i < r.e; i++) if (t.codes[i] === 66) return int(t.vals[i]) === 1;
  return false;
}

/** First value of a group code in an entity, skipping 102 {...} groups and extended data */
export function g(t: Tokens, ent: Ent, code: number): string | number | undefined {
  let inGroup = false;
  for (let i = ent.s + 1; i < ent.e; i++) {
    const c = t.codes[i];
    if (c === 102) { const v = str(t.vals[i]); inGroup = v.startsWith('{') ; continue; }
    if (inGroup) continue;
    if (c >= 1000) return undefined;
    if (c === code) return t.vals[i];
  }
  return undefined;
}

export function parseDoc(t: Tokens, onProgress?: (r: number) => void): DxfDoc {
  const doc: DxfDoc = {
    t, header: new Map(), layers: new Map(), layerOrder: [], ltypes: new Map(), styles: new Map(), dimstyles: new Map(),
    blocks: new Map(), blockRecords: new Map(), entities: [], layouts: [], mlineStyles: new Map(), imageDefs: new Map(),
    objectsByHandle: new Map(), warnings: [],
  };
  let sections = 0;
  let i = 0;
  const n = t.n;
  while (i < n) {
    if (t.codes[i] === 0 && str(t.vals[i]) === 'SECTION') {
      const nameIdx = i + 1;
      const name = nameIdx < n && t.codes[nameIdx] === 2 ? str(t.vals[nameIdx]).toUpperCase() : '';
      let j = nameIdx + 1;
      while (j < n && !(t.codes[j] === 0 && str(t.vals[j]) === 'ENDSEC')) {
        // a missing ENDSEC: stop at the next SECTION
        if (t.codes[j] === 0 && str(t.vals[j]) === 'SECTION') break;
        j++;
      }
      sections++;
      const s = nameIdx + 1, e = j;
      if (name === 'HEADER') parseHeader(doc, s, e);
      else if (name === 'TABLES') parseTables(doc, s, e);
      else if (name === 'BLOCKS') parseBlocks(doc, s, e);
      else if (name === 'ENTITIES') doc.entities.push(...splitEntities(t, s, e).ents);
      else if (name === 'OBJECTS') parseObjects(doc, s, e);
      onProgress?.(j / n);
      i = j + 1;
      continue;
    }
    if (t.codes[i] === 0 && str(t.vals[i]) === 'EOF') break;
    i++;
  }
  if (sections === 0) throw new CadError('corrupt', 'DXF: no SECTION found');
  if (!doc.layers.has('0')) {
    doc.layers.set('0', { name: '0', color: 7, trueColor: null, off: false, frozen: false, ltype: 'CONTINUOUS', lw: -3, handle: '', plot: true });
    doc.layerOrder.unshift('0');
  }
  return doc;
}

function parseHeader(doc: DxfDoc, s: number, e: number) {
  const t = doc.t;
  let cur: string | null = null;
  for (let i = s; i < e; i++) {
    if (t.codes[i] === 9) { cur = str(t.vals[i]).toUpperCase(); doc.header.set(cur, []); continue; }
    if (cur) doc.header.get(cur)!.push([t.codes[i], t.vals[i]]);
  }
}

export function hdrNum(doc: DxfDoc, name: string, code: number, def: number): number {
  const v = doc.header.get(name);
  if (!v) return def;
  for (const [c, x] of v) if (c === code) { const r = num(x); return Number.isFinite(r) ? r : def; }
  return def;
}
export function hdrStr(doc: DxfDoc, name: string): string | null {
  const v = doc.header.get(name);
  if (!v || !v.length) return null;
  return str(v[0][1]);
}

function parseTables(doc: DxfDoc, s: number, e: number) {
  const t = doc.t;
  let i = s;
  while (i < e) {
    if (t.codes[i] === 0 && str(t.vals[i]) === 'TABLE') {
      const tname = t.codes[i + 1] === 2 ? str(t.vals[i + 1]).toUpperCase() : '';
      let j = i + 1;
      while (j < e && !(t.codes[j] === 0 && str(t.vals[j]) === 'ENDTAB')) j++;
      // entries
      let k = i + 1;
      while (k < j && t.codes[k] !== 0) k++;
      while (k < j) {
        let m = k + 1;
        while (m < j && t.codes[m] !== 0) m++;
        const ent: Ent = { type: str(t.vals[k]).toUpperCase(), s: k, e: m };
        try { tableEntry(doc, tname, ent); } catch { /* skip broken entry */ }
        k = m;
      }
      i = j + 1;
      continue;
    }
    i++;
  }
}

function tableEntry(doc: DxfDoc, tname: string, ent: Ent) {
  const t = doc.t;
  if (tname === 'LAYER' && ent.type === 'LAYER') {
    const name = str(g(t, ent, 2));
    const color = int(g(t, ent, 62));
    const flags = int(g(t, ent, 70)) || 0;
    const tc = g(t, ent, 420);
    const lw = g(t, ent, 370);
    const plot = g(t, ent, 290);
    const l: LayerDef = {
      name, color: Number.isFinite(color) ? Math.abs(color) || 7 : 7, trueColor: tc !== undefined ? int(tc) : null,
      off: Number.isFinite(color) && color < 0, frozen: (flags & 1) !== 0, ltype: str(g(t, ent, 6)) || 'CONTINUOUS',
      lw: lw !== undefined ? int(lw) : -3, handle: str(g(t, ent, 5)), plot: plot === undefined ? true : int(plot) !== 0,
    };
    if (!doc.layers.has(name)) doc.layerOrder.push(name);
    doc.layers.set(name, l);
  } else if (tname === 'LTYPE' && ent.type === 'LTYPE') {
    const name = str(g(t, ent, 2)).toUpperCase();
    const dashes: number[] = [];
    let total = 0;
    for (let i = ent.s + 1; i < ent.e; i++) {
      if (t.codes[i] === 49) dashes.push(num(t.vals[i]));
      if (t.codes[i] === 40) total = num(t.vals[i]);
    }
    doc.ltypes.set(name, { name, dashes, total: total || dashes.reduce((a, b) => a + Math.abs(b), 0) });
  } else if (tname === 'STYLE' && ent.type === 'STYLE') {
    const name = str(g(t, ent, 2)).toUpperCase();
    let family: string | null = null;
    // xdata: 1001 ACAD, 1000 font family name
    for (let i = ent.s + 1; i < ent.e - 1; i++) {
      if (t.codes[i] === 1001 && str(t.vals[i]) === 'ACAD' && t.codes[i + 1] === 1000) { family = str(t.vals[i + 1]) || null; break; }
    }
    doc.styles.set(name, {
      name, font: str(g(t, ent, 3)), bigfont: str(g(t, ent, 4)), height: num(g(t, ent, 40)) || 0,
      width: num(g(t, ent, 41)) || 1, family,
    });
  } else if (tname === 'DIMSTYLE' && ent.type === 'DIMSTYLE') {
    const name = str(g(t, ent, 2)).toUpperCase();
    doc.dimstyles.set(name, { name, asz: num(g(t, ent, 41)), scale: num(g(t, ent, 40)), txt: num(g(t, ent, 140)) });
  } else if (tname === 'BLOCK_RECORD' && ent.type === 'BLOCK_RECORD') {
    const h = str(g(t, ent, 5)).toUpperCase();
    const name = str(g(t, ent, 2));
    if (h) doc.blockRecords.set(h, name);
  }
}

function parseBlocks(doc: DxfDoc, s: number, e: number) {
  const t = doc.t;
  let i = s;
  while (i < e) {
    if (t.codes[i] === 0 && str(t.vals[i]) === 'BLOCK') {
      let j = i + 1;
      while (j < e && t.codes[j] !== 0) j++;
      const head: Ent = { type: 'BLOCK', s: i, e: j };
      const name = str(g(t, head, 2)) || str(g(t, head, 3));
      const base: [number, number, number] = [num(g(t, head, 10)) || 0, num(g(t, head, 20)) || 0, num(g(t, head, 30)) || 0];
      const flags = int(g(t, head, 70)) || 0;
      // body until ENDBLK
      let k = j;
      while (k < e && !(t.codes[k] === 0 && str(t.vals[k]) === 'ENDBLK')) k++;
      const { ents } = splitEntities(t, j, k);
      let owner = '';
      for (let q = i + 1; q < j; q++) if (t.codes[q] === 330) { owner = str(t.vals[q]).toUpperCase(); break; }
      const def: BlockDef = {
        name, base, flags, ents, handle: str(g(t, head, 5)), recordHandle: owner, layer: str(g(t, head, 8)) || '0',
        xrefPath: str(g(t, head, 1)),
      };
      doc.blocks.set(name.toUpperCase(), def);
      // skip ENDBLK entity
      let m = k + 1;
      while (m < e && t.codes[m] !== 0) m++;
      i = m;
      continue;
    }
    i++;
  }
}

function parseObjects(doc: DxfDoc, s: number, e: number) {
  const t = doc.t;
  let i = s;
  while (i < e && t.codes[i] !== 0) i++;
  while (i < e) {
    let j = i + 1;
    while (j < e && t.codes[j] !== 0) j++;
    const type = str(t.vals[i]).toUpperCase();
    const ent: Ent = { type, s: i, e: j };
    const h = str(g(t, ent, 5)).toUpperCase();
    if (h) doc.objectsByHandle.set(h, ent);
    try {
      if (type === 'LAYOUT') parseLayout(doc, ent);
      else if (type === 'MLINESTYLE') {
        const name = str(g(t, ent, 2));
        const els: MlineStyleDef['elements'] = [];
        let cur: { offset: number; color: number; ltype: string } | null = null;
        let started = false;
        for (let q = ent.s + 1; q < ent.e; q++) {
          const c = t.codes[q];
          if (c === 71) started = true;
          if (!started) continue;
          if (c === 49) { cur = { offset: num(t.vals[q]), color: 256, ltype: 'BYLAYER' }; els.push(cur); }
          else if (c === 62 && cur) cur.color = int(t.vals[q]);
          else if (c === 6 && cur) cur.ltype = str(t.vals[q]);
        }
        const st = { name, elements: els };
        doc.mlineStyles.set(h, st);
        doc.mlineStyles.set(name.toUpperCase(), st);
      } else if (type === 'IMAGEDEF') {
        doc.imageDefs.set(h, str(g(t, ent, 1)));
      }
    } catch { /* ignore broken object */ }
    i = j;
  }
}

function parseLayout(doc: DxfDoc, ent: Ent) {
  const t = doc.t;
  // the AcDbLayout subclass follows AcDbPlotSettings; read plot settings and layout codes by subclass
  let sub = '';
  const L: LayoutDef = { name: '', tab: 0, blockRecord: '', limmin: [0, 0], limmax: [0, 0], extmin: [0, 0], extmax: [0, 0], paper: [0, 0], units: 1, rotation: 0, handle: str(g(t, ent, 5)) };
  let inGroup = false;
  for (let i = ent.s + 1; i < ent.e; i++) {
    const c = t.codes[i];
    const v = t.vals[i];
    if (c === 102) { inGroup = str(v).startsWith('{'); continue; }
    if (inGroup) continue;
    if (c === 100) { sub = str(v); continue; }
    if (sub === 'AcDbPlotSettings') {
      if (c === 44) L.paper[0] = num(v);
      else if (c === 45) L.paper[1] = num(v);
      else if (c === 72) L.units = int(v);
      else if (c === 73) L.rotation = int(v);
    } else if (sub === 'AcDbLayout') {
      if (c === 1) L.name = str(v);
      else if (c === 71) L.tab = int(v);
      else if (c === 10) L.limmin[0] = num(v);
      else if (c === 20) L.limmin[1] = num(v);
      else if (c === 11) L.limmax[0] = num(v);
      else if (c === 21) L.limmax[1] = num(v);
      else if (c === 14) L.extmin[0] = num(v);
      else if (c === 24) L.extmin[1] = num(v);
      else if (c === 15) L.extmax[0] = num(v);
      else if (c === 25) L.extmax[1] = num(v);
      else if (c === 330) L.blockRecord = str(v).toUpperCase();
    }
  }
  if (L.name) doc.layouts.push(L);
}
