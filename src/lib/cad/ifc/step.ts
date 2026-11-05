// ISO 10303-21 (STEP physical file) reader: streaming index + lazy argument parser.
// Clean-room implementation written from the ISO 10303-21 clear text encoding rules
// (sections: HEADER/DATA, entity instance "#id=NAME(args);", strings with '' escapes,
// control directives \X\ \X2\ \X4\ \S\ \P..\, enumerations .X., unset $, derived *).
//
// The index keeps every entity only as (id, type index, byte start, byte end) in typed arrays,
// so a 100+ MB file costs ~13 bytes per entity. Arguments are parsed on demand.

export class Ref { id: number; constructor(id: number) { this.id = id; } }
export class Enum { v: string; constructor(v: string) { this.v = v; } }
export class Typed { type: string; val: Arg; constructor(type: string, val: Arg) { this.type = type; this.val = val; } }
export type Arg = number | string | Ref | Enum | Typed | null | Arg[];

export function stepError(code: string, msg: string): Error {
  const e = new Error(msg) as Error & { code: string };
  e.code = code;
  return e;
}

const C_HASH = 35, C_EQ = 61, C_LP = 40, C_RP = 41, C_SEMI = 59, C_Q = 39, C_SLASH = 47, C_STAR = 42;
const C_COMMA = 44, C_DOLLAR = 36, C_DOT = 46, C_DQ = 34, C_MINUS = 45, C_PLUS = 43, C_BS = 92;

function isWs(c: number) { return c === 32 || c === 10 || c === 13 || c === 9 || c === 12; }
function isNameChar(c: number) { return (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95 || (c >= 97 && c <= 122); }

const latin1 = new TextDecoder('latin1');
const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Decode the body of a STEP string literal (between the quotes, '' still doubled). */
export function decodeStepString(b: Uint8Array, s: number, e: number): string {
  // fast path: plain ASCII without escapes
  let plain = true;
  for (let i = s; i < e; i++) { const c = b[i]; if (c === C_BS || c === C_Q || c >= 128) { plain = false; break; } }
  if (plain) return latin1.decode(b.subarray(s, e));
  let out = '';
  let raw: number[] = [];
  const flushRaw = () => {
    if (!raw.length) return;
    const u = Uint8Array.from(raw);
    try { out += utf8.decode(u); } catch { out += latin1.decode(u); }
    raw = [];
  };
  const hex = (i: number, n: number) => {
    let v = 0;
    for (let k = 0; k < n; k++) {
      const c = b[i + k];
      const d = c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1;
      if (d < 0) return -1;
      v = v * 16 + d;
    }
    return v;
  };
  let i = s;
  while (i < e) {
    const c = b[i];
    if (c === C_Q && b[i + 1] === C_Q) { raw.push(C_Q); i += 2; continue; }
    if (c === C_BS) {
      const d = b[i + 1];
      if (d === C_BS) { raw.push(C_BS); i += 2; continue; }
      if (d === 88 /* X */ && b[i + 2] === C_BS) { // \X\hh  (ISO 8859-1 code)
        const v = hex(i + 3, 2);
        if (v >= 0) { flushRaw(); out += String.fromCharCode(v); i += 5; continue; }
      }
      if (d === 88 && (b[i + 2] === 50 || b[i + 2] === 52) && b[i + 3] === C_BS) { // \X2\ or \X4\
        const w = b[i + 2] === 50 ? 4 : 8;
        flushRaw();
        let j = i + 4;
        while (j + w <= e && b[j] !== C_BS) {
          const v = hex(j, w);
          if (v < 0) break;
          out += w === 4 ? String.fromCharCode(v) : String.fromCodePoint(v);
          j += w;
        }
        // expect \X0\
        if (b[j] === C_BS && b[j + 1] === 88 && b[j + 2] === 48 && b[j + 3] === C_BS) j += 4;
        i = j;
        continue;
      }
      if (d === 83 /* S */ && b[i + 2] === C_BS) { // \S\c  -> c + 128
        flushRaw(); out += String.fromCharCode(b[i + 3] + 128); i += 4; continue;
      }
      if (d === 80 /* P */ && b[i + 3] === C_BS) { i += 4; continue; } // \PA\ code page switch: ignored
      if (d === 78 /* N */ && b[i + 2] === C_BS) { i += 3; continue; } // \N\ (ISO 10303-21 ed3 newline marker)
      if (d === 70 /* F */ && b[i + 2] === C_BS) { i += 3; continue; }
    }
    raw.push(c);
    i++;
  }
  flushRaw();
  return out;
}

export interface StepHeader {
  description: string[];
  fileName: string | null;
  timeStamp: string | null;
  author: string[];
  organization: string[];
  preprocessor: string | null;
  originatingSystem: string | null;
  authorization: string | null;
  schemas: string[];
}

/** Parser over a byte range that produces Arg values. */
class ArgParser {
  b: Uint8Array; i = 0; e = 0;
  constructor(b: Uint8Array) { this.b = b; }
  ws() {
    const b = this.b;
    for (;;) {
      while (this.i < this.e && isWs(b[this.i])) this.i++;
      if (b[this.i] === C_SLASH && b[this.i + 1] === C_STAR) {
        const j = indexOfSeq(b, this.i + 2, this.e, C_STAR, C_SLASH);
        this.i = j < 0 ? this.e : j + 2;
        continue;
      }
      return;
    }
  }
  /** parse "( a, b, ... )" starting at '(' ; returns array */
  list(): Arg[] {
    const b = this.b;
    const out: Arg[] = [];
    this.i++; // '('
    this.ws();
    if (b[this.i] === C_RP) { this.i++; return out; }
    for (;;) {
      out.push(this.value());
      this.ws();
      const c = b[this.i];
      if (c === C_COMMA) { this.i++; this.ws(); continue; }
      if (c === C_RP) { this.i++; return out; }
      // malformed: bail out to avoid infinite loops
      if (this.i >= this.e) return out;
      this.i++;
    }
  }
  value(): Arg {
    const b = this.b;
    this.ws();
    const c = b[this.i];
    if (c === C_HASH) {
      let j = this.i + 1, v = 0;
      while (j < this.e) { const d = b[j]; if (d < 48 || d > 57) break; v = v * 10 + (d - 48); j++; }
      this.i = j;
      return new Ref(v);
    }
    if (c === C_Q) {
      const s = this.i + 1;
      let j = s;
      for (;;) {
        while (j < this.e && b[j] !== C_Q) j++;
        if (b[j + 1] === C_Q) { j += 2; continue; }
        break;
      }
      this.i = j + 1;
      return decodeStepString(b, s, j);
    }
    if ((c >= 48 && c <= 57) || c === C_MINUS || c === C_PLUS || c === C_DOT && b[this.i + 1] >= 48 && b[this.i + 1] <= 57) return this.number();
    if (c === C_DOLLAR) { this.i++; return null; }
    if (c === C_STAR) { this.i++; return null; }
    if (c === C_LP) return this.list();
    if (c === C_DOT) {
      let j = this.i + 1;
      while (j < this.e && b[j] !== C_DOT) j++;
      const v = latin1.decode(b.subarray(this.i + 1, j));
      this.i = j + 1;
      return new Enum(v);
    }
    if (c === C_DQ) {
      let j = this.i + 1;
      while (j < this.e && b[j] !== C_DQ) j++;
      const v = latin1.decode(b.subarray(this.i + 1, j));
      this.i = j + 1;
      return v;
    }
    if (isNameChar(c)) {
      let j = this.i;
      while (j < this.e && isNameChar(b[j])) j++;
      const name = latin1.decode(b.subarray(this.i, j)).toUpperCase();
      this.i = j;
      this.ws();
      if (b[this.i] === C_LP) {
        const inner = this.list();
        return new Typed(name, inner.length === 1 ? inner[0] : inner);
      }
      return new Enum(name);
    }
    this.i++;
    return null;
  }
  number(): number {
    const b = this.b;
    let j = this.i, neg = false;
    if (b[j] === C_MINUS) { neg = true; j++; } else if (b[j] === C_PLUS) j++;
    let m = 0, exp = 0, digits = 0;
    while (j < this.e) { const d = b[j]; if (d < 48 || d > 57) break; if (digits < 17) { m = m * 10 + (d - 48); digits += m ? 1 : 0; } else exp++; j++; }
    if (b[j] === C_DOT) {
      j++;
      while (j < this.e) { const d = b[j]; if (d < 48 || d > 57) break; if (digits < 17) { m = m * 10 + (d - 48); digits += m ? 1 : 0; exp--; } j++; }
    }
    if (b[j] === 69 || b[j] === 101) { // E
      j++;
      let eneg = false, ev = 0;
      if (b[j] === C_MINUS) { eneg = true; j++; } else if (b[j] === C_PLUS) j++;
      while (j < this.e) { const d = b[j]; if (d < 48 || d > 57) break; ev = ev * 10 + (d - 48); j++; }
      exp += eneg ? -ev : ev;
    }
    this.i = j;
    let v = m;
    if (exp > 0) v = m * POW10[Math.min(exp, 308)];
    else if (exp < 0) v = exp >= -22 ? m / POW10[-exp] : m * Math.pow(10, exp);
    return neg ? -v : v;
  }
}
const POW10: number[] = [];
for (let k = 0; k <= 308; k++) POW10.push(Number('1e' + k));

function indexOfSeq(b: Uint8Array, from: number, to: number, c1: number, c2: number) {
  for (let i = from; i < to - 1; i++) if (b[i] === c1 && b[i + 1] === c2) return i;
  return -1;
}

/** Growable Uint32 array */
class U32 {
  a: Uint32Array; n = 0;
  constructor(cap = 1 << 16) { this.a = new Uint32Array(cap); }
  push(v: number) {
    if (this.n === this.a.length) { const t = new Uint32Array(this.a.length * 2); t.set(this.a); this.a = t; }
    this.a[this.n++] = v;
  }
  done() { return this.a.subarray(0, this.n); }
}
class U16 {
  a: Uint16Array; n = 0;
  constructor(cap = 1 << 16) { this.a = new Uint16Array(cap); }
  push(v: number) {
    if (this.n === this.a.length) { const t = new Uint16Array(this.a.length * 2); t.set(this.a); this.a = t; }
    this.a[this.n++] = v;
  }
  done() { return this.a.subarray(0, this.n); }
}

export class StepFile {
  bytes: Uint8Array;
  header: StepHeader;
  /** per entity (index k): id, type index, args start ('(' offset), end (';' offset) */
  ids: Uint32Array; types: Uint16Array; starts: Uint32Array; ends: Uint32Array;
  typeNames: string[] = [];
  private typeMap = new Map<string, number>();
  private direct: Int32Array | null = null;
  private sortedIds = true;
  private idMap: Map<number, number> | null = null;
  private parser: ArgParser;
  private cache = new Map<number, Arg[]>();
  maxCache = 400000;
  warnings: string[] = [];

  constructor(bytes: Uint8Array, onProgress?: (stage: string, ratio: number) => void) {
    this.bytes = bytes;
    this.parser = new ArgParser(bytes);
    const b = bytes;
    const n = b.length;
    if (n > 0xfffffff0) throw stepError('too-large', 'STEP file larger than 4 GB is not supported');
    let i = 0;
    // skip BOM / whitespace
    if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) i = 3;
    while (i < n && isWs(b[i])) i++;
    const magic = latin1.decode(b.subarray(i, Math.min(n, i + 13)));
    if (magic !== 'ISO-10303-21;') throw stepError('not-format', 'not an ISO 10303-21 (STEP) file');
    // header section
    const hdrStart = findToken(b, i, Math.min(n, i + (1 << 20)), 'HEADER;');
    const dataPos = findDataSection(b, i);
    if (dataPos < 0) throw stepError('corrupt', 'STEP file has no DATA section');
    this.header = this.parseHeader(hdrStart < 0 ? i : hdrStart + 7, dataPos);
    // data section scan
    const est = Math.max(1024, Math.floor((n - dataPos) / 60));
    const ids = new U32(est), starts = new U32(est), ends = new U32(est), types = new U16(est);
    let maxId = 0, prevId = -1;
    i = dataPos;
    let nextReport = i + (8 << 20);
    const nameBuf: number[] = [];
    let lastHash = -1, lastType = 0;
    const hashMap = new Map<number, number>();
    for (;;) {
      // skip whitespace and comments
      while (i < n) {
        const c = b[i];
        if (isWs(c)) { i++; continue; }
        if (c === C_SLASH && b[i + 1] === C_STAR) { const j = indexOfSeq(b, i + 2, n, C_STAR, C_SLASH); i = j < 0 ? n : j + 2; continue; }
        break;
      }
      if (i >= n) { this.warnings.push('STEP file ends without ENDSEC (truncated?)'); break; }
      if (b[i] !== C_HASH) {
        // ENDSEC; or a second DATA section (ed. 3 allows several)
        if (b[i] === 69 /* E */) {
          const nd = findDataSection(b, i);
          if (nd < 0) break;
          i = nd;
          continue;
        }
        // garbage: skip to next ';'
        while (i < n && b[i] !== C_SEMI) i++;
        i++;
        continue;
      }
      i++;
      let id = 0;
      while (i < n) { const d = b[i]; if (d < 48 || d > 57) break; id = id * 10 + (d - 48); i++; }
      while (i < n && isWs(b[i])) i++;
      if (b[i] !== C_EQ) { while (i < n && b[i] !== C_SEMI) i++; i++; continue; }
      i++;
      while (i < n && isWs(b[i])) i++;
      // type name
      let h = 0, len = 0;
      const ns = i;
      while (i < n && isNameChar(b[i])) { let c = b[i]; if (c >= 97) c -= 32; h = (h * 31 + c) | 0; len++; i++; }
      let t: number;
      if (len === 0) {
        t = this.internType(''); // complex entity instance "(A(..)B(..))"
      } else {
        h = (h * 31 + len) | 0;
        if (h === lastHash) t = lastType;
        else {
          const got = hashMap.get(h);
          if (got !== undefined && this.typeNames[got].length === len) t = got;
          else {
            nameBuf.length = 0;
            for (let k = ns; k < ns + len; k++) nameBuf.push(b[k] >= 97 ? b[k] - 32 : b[k]);
            const nm = String.fromCharCode(...nameBuf);
            t = this.internType(nm);
            if (got === undefined) hashMap.set(h, t);
          }
          lastHash = h; lastType = t;
        }
      }
      while (i < n && isWs(b[i])) i++;
      const s = i;
      // scan to the terminating ';' outside strings
      for (;;) {
        // tight inner loop
        while (i < n) { const c = b[i]; if (c === C_SEMI || c === C_Q) break; i++; }
        if (i >= n) break;
        if (b[i] === C_Q) {
          i++;
          while (i < n && b[i] !== C_Q) i++;
          i++;
          continue;
        }
        break;
      }
      ids.push(id); types.push(t); starts.push(s); ends.push(Math.min(i, n));
      if (id > maxId) maxId = id;
      if (id <= prevId) this.sortedIds = false;
      prevId = id;
      i++;
      if (i > nextReport) { onProgress?.('index', i / n); nextReport = i + (8 << 20); }
    }
    this.ids = ids.done(); this.types = types.done(); this.starts = starts.done(); this.ends = ends.done();
    const count = this.ids.length;
    if (maxId < count * 4 + 1000000) {
      this.direct = new Int32Array(maxId + 1).fill(-1);
      for (let k = 0; k < count; k++) this.direct[this.ids[k]] = k;
    } else if (!this.sortedIds) {
      this.idMap = new Map();
      for (let k = 0; k < count; k++) this.idMap.set(this.ids[k], k);
    }
  }

  private internType(name: string): number {
    let t = this.typeMap.get(name);
    if (t === undefined) { t = this.typeNames.length; this.typeNames.push(name); this.typeMap.set(name, t); }
    return t;
  }

  get count() { return this.ids.length; }

  /** entity index for an id, or -1 */
  index(id: number): number {
    if (this.direct) return id < this.direct.length ? this.direct[id] : -1;
    if (this.idMap) return this.idMap.get(id) ?? -1;
    let lo = 0, hi = this.ids.length - 1;
    while (lo <= hi) { const m = (lo + hi) >> 1; const v = this.ids[m]; if (v === id) return m; if (v < id) lo = m + 1; else hi = m - 1; }
    return -1;
  }

  typeOf(id: number): string {
    const k = this.index(id);
    return k < 0 ? '' : this.typeNames[this.types[k]];
  }
  typeIndexOf(name: string): number { return this.typeMap.get(name) ?? -1; }

  /** All entity ids of the given (upper case) type names */
  idsOfType(...names: string[]): number[] {
    const want = new Set<number>();
    for (const nm of names) { const t = this.typeMap.get(nm); if (t !== undefined) want.add(t); }
    const out: number[] = [];
    if (!want.size) return out;
    const T = this.types;
    if (want.size === 1) { const t = [...want][0]; for (let k = 0; k < T.length; k++) if (T[k] === t) out.push(this.ids[k]); }
    else for (let k = 0; k < T.length; k++) if (want.has(T[k])) out.push(this.ids[k]);
    return out;
  }

  /** Arguments of the entity (cached). Returns null for unknown ids. */
  args(id: number): Arg[] | null {
    const c = this.cache.get(id);
    if (c) return c;
    const k = this.index(id);
    if (k < 0) return null;
    const a = this.argsAt(k);
    if (this.cache.size >= this.maxCache) this.cache.clear();
    this.cache.set(id, a);
    return a;
  }
  /** Parse without caching */
  argsNoCache(id: number): Arg[] | null {
    const c = this.cache.get(id);
    if (c) return c;
    const k = this.index(id);
    return k < 0 ? null : this.argsAt(k);
  }
  argsAt(k: number): Arg[] {
    const p = this.parser;
    p.i = this.starts[k]; p.e = this.ends[k];
    if (this.bytes[p.i] !== C_LP) return [];
    if (this.typeNames[this.types[k]] === '') {
      // complex instance: (NAME1(args) NAME2(args) ...) -> list of Typed
      p.i++;
      const out: Arg[] = [];
      while (p.i < p.e) { p.ws(); if (this.bytes[p.i] === C_RP) break; const v = p.value(); if (v === null) break; out.push(v); }
      return out;
    }
    try { return p.list(); } catch { return []; }
  }
  clearCache() { this.cache.clear(); }

  /** Fast reader for IfcCartesianPoint((x,y[,z])) without caching. */
  point(id: number, out: number[]): boolean {
    const k = this.index(id);
    if (k < 0) return false;
    const p = this.parser;
    p.i = this.starts[k]; p.e = this.ends[k];
    const b = this.bytes;
    // expect ( ( x , y , z ) )
    p.ws(); if (b[p.i] !== C_LP) return false; p.i++;
    p.ws(); if (b[p.i] !== C_LP) return false; p.i++;
    out[0] = out[1] = out[2] = 0;
    for (let d = 0; d < 3; d++) {
      p.ws();
      const c = b[p.i];
      if (c === C_RP) break;
      out[d] = p.number();
      p.ws();
      if (b[p.i] === C_COMMA) p.i++;
    }
    return true;
  }

  private parseHeader(s: number, e: number): StepHeader {
    const p = this.parser;
    const h: StepHeader = { description: [], fileName: null, timeStamp: null, author: [], organization: [], preprocessor: null, originatingSystem: null, authorization: null, schemas: [] };
    const b = this.bytes;
    let i = s;
    while (i < e) {
      while (i < e && (isWs(b[i]) || b[i] === C_SEMI)) i++;
      const ns = i;
      while (i < e && isNameChar(b[i])) i++;
      const name = latin1.decode(b.subarray(ns, i)).toUpperCase();
      while (i < e && isWs(b[i])) i++;
      if (b[i] !== C_LP) { i++; continue; }
      p.i = i; p.e = e;
      let a: Arg[] = [];
      try { a = p.list(); } catch { /* ignore */ }
      i = p.i;
      const strs = (v: Arg) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') as string[] : typeof v === 'string' ? [v] : []);
      const str = (v: Arg) => (typeof v === 'string' && v.length ? v : null);
      if (name === 'FILE_DESCRIPTION') h.description = strs(a[0]);
      else if (name === 'FILE_NAME') {
        h.fileName = str(a[0]); h.timeStamp = str(a[1]); h.author = strs(a[2]).filter(Boolean); h.organization = strs(a[3]).filter(Boolean);
        h.preprocessor = str(a[4]); h.originatingSystem = str(a[5]); h.authorization = str(a[6]);
      } else if (name === 'FILE_SCHEMA') h.schemas = strs(a[0]);
    }
    return h;
  }
}

function findToken(b: Uint8Array, from: number, to: number, tok: string): number {
  const t0 = tok.charCodeAt(0);
  outer: for (let i = from; i < to - tok.length; i++) {
    if (b[i] !== t0) continue;
    for (let k = 1; k < tok.length; k++) if (b[i + k] !== tok.charCodeAt(k)) continue outer;
    return i;
  }
  return -1;
}

/** Find "DATA" followed by optional parameters and ';' outside of strings, returns offset after the ';' */
function findDataSection(b: Uint8Array, from: number): number {
  const n = b.length;
  let i = from;
  while (i < n - 4) {
    const c = b[i];
    if (c === C_Q) { i++; while (i < n && b[i] !== C_Q) i++; i++; continue; }
    if (c === 68 && b[i + 1] === 65 && b[i + 2] === 84 && b[i + 3] === 65 && (i === 0 || !isNameChar(b[i - 1]))) {
      let j = i + 4;
      while (j < n && isWs(b[j])) j++;
      if (b[j] === C_SEMI) return j + 1;
      if (b[j] === C_LP) { while (j < n && b[j] !== C_SEMI) j++; return j + 1; }
    }
    if (c === 69 && b[i + 1] === 78 && b[i + 2] === 68 && b[i + 3] === 45) { // END-ISO-10303-21
      return -1;
    }
    i++;
  }
  return -1;
}

// helpers for Arg access
export const isRef = (v: Arg): v is Ref => v instanceof Ref;
export const refId = (v: Arg): number => (v instanceof Ref ? v.id : 0);
export const num = (v: Arg, d = 0): number => {
  if (typeof v === 'number') return v;
  if (v instanceof Typed) return num(v.val, d);
  return d;
};
export const str = (v: Arg): string | null => {
  if (typeof v === 'string') return v;
  if (v instanceof Typed) return str(v.val);
  return null;
};
export const enumv = (v: Arg): string | null => (v instanceof Enum ? v.v : null);
export const list = (v: Arg): Arg[] => (Array.isArray(v) ? v : []);
export const refs = (v: Arg): number[] => {
  if (!Array.isArray(v)) return v instanceof Ref ? [v.id] : [];
  const o: number[] = [];
  for (const x of v) if (x instanceof Ref) o.push(x.id);
  return o;
};
