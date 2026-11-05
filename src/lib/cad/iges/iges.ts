// IGES 5.3 reader (Initial Graphics Exchange Specification, US PRO / NIST public document):
// 80-column fixed ASCII form, sections S (start), G (global), D (directory entries), P (parameter
// data), T (terminate). Surfaces, trimmed surfaces and B-rep solids are tessellated with the face
// code of our own STEP engine (tess.ts, surf.ts). Clean-room implementation, see NOTEBOOK.md.
//
// Output: RvtGeometry (metres, Z up as stored). Entry points: sniffIges(bytes), readIges(bytes, onProgress, options)

import * as G from './geom.ts';
import type { M } from './geom.ts';
import * as S from './surf.ts';
import type { Surface, BCurve } from './surf.ts';
import { numericSurface, spline114, ruled118 } from './isurf.ts';
import { FaceTess, nmesh } from './tess.ts';
import type { NMesh, UVP } from './tess.ts';
import { F32, U32, emitWithNormals } from './mesh.ts';
import type { BucketAcc } from './mesh.ts';
import type { RvtGeometry, GeomBucket, GeomElement, BBox3 } from './rvt-types.ts';

export type IgesErrorCode = 'unsupported-version' | 'corrupt' | 'encrypted' | 'too-large' | 'not-format';
export function igesError(code: IgesErrorCode, message: string): Error & { code: IgesErrorCode } {
  const e = new Error(message) as Error & { code: IgesErrorCode };
  e.name = 'IgesError';
  e.code = code;
  return e;
}

export interface IgesReadOptions {
  edges?: boolean;          // boundary curves and wireframe as line segments (default true)
  lod?: 'fast' | 'full';    // tessellation density (default full)
  maxTriangles?: number;    // default 20M
  hidden?: boolean;         // also draw entities with blank status 01 (default false)
  /** test hook: receives per-face triangles (model units, before placement) for automated checks */
  _faceLog?: unknown[];
}
export interface IgesReadResult { kind: '3d'; geometry: RvtGeometry; info: Record<string, string | number> }

const TWO_PI = Math.PI * 2;
const sc3 = (a: number[], k: number) => [a[0] * k, a[1] * k, a[2] * k];
const MAX_BYTES = 512 * 1024 * 1024;
const latin1 = new TextDecoder('latin1');

// ------------------------------------------------------------------ sniff
function firstLines(bytes: Uint8Array, n: number): string[] {
  const head = latin1.decode(bytes.subarray(0, Math.min(bytes.length, 82 * (n + 1))));
  let lines = head.split(/\r\n|\n|\r/);
  if (lines.length < 2 && head.length >= 160) { lines = []; for (let i = 0; i + 80 <= head.length; i += 80) lines.push(head.slice(i, i + 80)); }
  return lines.slice(0, n);
}
function lineOk(l: string | undefined, letters: string): boolean {
  if (!l || l.length < 73 || l.length > 82) return false;
  if (!letters.includes(l[72])) return false;
  const seq = l.slice(73, 80);
  return /^ *\d+ *$/.test(seq) || (l.length === 73);
}
/** fixed-format IGES: column 73 holds the section letter (S/G, or C for the compressed form), columns 74-80 the sequence number */
export function sniffIges(bytes: Uint8Array): boolean {
  if (!bytes || bytes.length < 80) return false;
  const L = firstLines(bytes, 4);
  if (lineOk(L[0], 'C')) return true; // compressed ASCII form (reported as unsupported)
  if (!lineOk(L[0], 'SG')) return false;
  if (L.length > 1 && L[1] !== '' && !lineOk(L[1], 'SGD')) return false;
  return parseInt(L[0].slice(73, 80), 10) === 1 || L[0][72] === 'S';
}

// ------------------------------------------------------------------ parameter tokens
type Val = number | string | null;
function tokenize(s: string, pd: string, rd: string, start = 0, limit = Infinity): { vals: Val[]; end: number } {
  const out: Val[] = [];
  const n = s.length;
  let i = start;
  while (i < n && out.length < limit) {
    while (i < n && (s[i] === ' ' || s[i] === '\n')) i++;
    if (i >= n) break;
    // Hollerith string nHxxxx
    let j = i;
    while (j < n && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) j++;
    if (j > i && j < n && (s[j] === 'H' || s[j] === 'h')) {
      const len = parseInt(s.slice(i, j), 10);
      const str = s.slice(j + 1, j + 1 + len);
      out.push(str);
      i = j + 1 + len;
      while (i < n && s[i] !== pd && s[i] !== rd) i++;
    } else {
      j = i;
      while (j < n && s[j] !== pd && s[j] !== rd) j++;
      const raw = s.slice(i, j).trim();
      if (!raw) out.push(null);
      else {
        const v = Number(raw.replace(/[dD]/, 'E'));
        out.push(isNaN(v) ? raw : v);
      }
      i = j;
    }
    if (i >= n) break;
    if (s[i] === rd) { i++; return { vals: out, end: i }; }
    i++; // parameter delimiter
    if (i >= n || s[i] === rd) { out.push(null); if (i < n) i++; return { vals: out, end: i }; }
  }
  return { vals: out, end: i };
}
const num = (a: Val[] | null, i: number, d = 0): number => { const v = a ? a[i] : null; return typeof v === 'number' && isFinite(v) ? v : d; };
const strv = (a: Val[] | null, i: number): string => { const v = a ? a[i] : null; return typeof v === 'string' ? v : ''; };

// ------------------------------------------------------------------ colours and styles
interface Style { r: number; g: number; b: number; a: number; key: string }
function mkStyle(r: number, g: number, b: number, a = 1): Style {
  const q = (x: number) => Math.round(Math.max(0, Math.min(1, x)) * 1000) / 1000;
  r = q(r); g = q(g); b = q(b); a = q(a);
  return { r, g, b, a, key: `${r},${g},${b},${a}` };
}
const DEFAULT_STYLE = mkStyle(0.74, 0.76, 0.8);
// directory entry colour numbers 1..8 (IGES 5.3 section 2.2.4.4.13)
const COLOR_NO: Record<number, [number, number, number]> = {
  1: [0.1, 0.1, 0.1], 2: [1, 0, 0], 3: [0, 1, 0], 4: [0, 0, 1], 5: [1, 1, 0], 6: [1, 0, 1], 7: [0, 1, 1], 8: [1, 1, 1],
};
const UNIT_FLAG: Record<number, [number, string]> = {
  1: [0.0254, 'INCH'], 2: [0.001, 'MM'], 4: [0.3048, 'FT'], 5: [1609.344, 'MI'], 6: [1, 'M'], 7: [1000, 'KM'],
  8: [0.0000254, 'MIL'], 9: [1e-6, 'UM'], 10: [0.01, 'CM'], 11: [0.0254e-6, 'UIN'],
};
const UNIT_NAME: Record<string, number> = { IN: 0.0254, INCH: 0.0254, MM: 0.001, FT: 0.3048, MI: 1609.344, M: 1, KM: 1000, MIL: 0.0000254, UM: 1e-6, MICRON: 1e-6, CM: 0.01, UIN: 0.0254e-6 };
const VERSION_FLAG: Record<number, string> = { 1: '1.0', 2: 'ANSI Y14.26M-1981', 3: '2.0', 4: '3.0', 5: 'ANSI Y14.26M-1987', 6: '4.0', 7: 'ASME/ANSI Y14.26M-1989', 8: '5.0', 9: '5.1', 10: '5.2', 11: '5.3' };
const TYPE_NAME: Record<number, string> = {
  100: 'circular arc', 102: 'composite curve', 104: 'conic arc', 106: 'copious data', 108: 'plane', 110: 'line', 112: 'parametric spline curve',
  114: 'parametric spline surface', 116: 'point', 118: 'ruled surface', 120: 'surface of revolution', 122: 'tabulated cylinder', 123: 'direction',
  124: 'transformation matrix', 126: 'rational B-spline curve', 128: 'rational B-spline surface', 130: 'offset curve', 140: 'offset surface',
  141: 'boundary', 142: 'curve on a parametric surface', 143: 'bounded surface', 144: 'trimmed surface', 186: 'manifold solid B-rep',
  190: 'plane surface', 192: 'cylindrical surface', 194: 'conical surface', 196: 'spherical surface', 198: 'toroidal surface',
  308: 'subfigure definition', 314: 'colour definition', 402: 'associativity', 406: 'property', 408: 'singular subfigure instance',
  502: 'vertex list', 504: 'edge list', 508: 'loop', 510: 'face', 514: 'shell',
  // recognised, not drawn
  202: 'angular dimension', 206: 'diameter dimension', 210: 'general label', 212: 'general note', 214: 'leader', 216: 'linear dimension',
  218: 'ordinate dimension', 220: 'point dimension', 222: 'radius dimension', 228: 'general symbol', 230: 'sectioned area', 404: 'drawing', 410: 'view',
  150: 'block', 152: 'right angular wedge', 154: 'right circular cylinder', 156: 'right circular cone frustum', 158: 'sphere', 160: 'torus',
  162: 'solid of revolution', 164: 'solid of linear extrusion', 168: 'ellipsoid', 180: 'boolean tree', 184: 'solid assembly', 430: 'solid instance',
};
const CURVES = new Set([100, 102, 104, 106, 110, 112, 126, 130]);
const SURFACES = new Set([108, 114, 118, 120, 122, 128, 140, 190, 192, 194, 196, 198]);
const NOT_GEOMETRY = new Set([116, 123, 124, 142, 141, 308, 314, 402, 406, 404, 410, 502, 504, 508, 510, 514, 0]);

// ------------------------------------------------------------------ the file
const CACHED = new Set([116, 123, 124, 142, 141, 308, 314, 402, 406, 408, 502, 504, 508, 514]);
class IgesFile {
  text: string;
  pd = ','; rd = ';';
  global: Val[] = [];
  start = '';
  n = 0;                        // entity count
  type!: Int32Array; pptr!: Int32Array; level!: Int32Array; xf!: Int32Array; colour!: Int32Array; pcount!: Int32Array; form!: Int32Array;
  blank!: Uint8Array; subord!: Uint8Array; use!: Uint8Array;
  label: string[] = []; subscript!: Int32Array;
  pOff!: Int32Array;            // P line start offsets (by P sequence - 1)
  pCount = 0;
  warnings: string[] = [];
  cache = new Map<number, Val[] | null>();
  constructor(bytes: Uint8Array, onProgress?: (stage: string, r: number) => void) {
    const text = latin1.decode(bytes);
    this.text = text;
    // line starts
    const starts: number[] = [];
    const ends: number[] = [];
    let p = 0;
    const N = text.length;
    let hasNl = false;
    for (let i = 0; i < Math.min(N, 200); i++) if (text.charCodeAt(i) === 10 || text.charCodeAt(i) === 13) { hasNl = true; break; }
    if (!hasNl) {
      for (let i = 0; i + 73 <= N; i += 80) { starts.push(i); ends.push(Math.min(N, i + 80)); }
    } else {
      // line break style from the first break: LF / CRLF, or CR only (old Mac files)
      const fl = text.indexOf('\n'), fc = text.indexOf('\r');
      const crOnly = fc >= 0 && (fl < 0 || (fc < fl && text.charCodeAt(fc + 1) !== 10));
      const br = crOnly ? '\r' : '\n';
      while (p < N) {
        let e = text.indexOf(br, p);
        if (e < 0) e = N;
        let ee = e;
        if (!crOnly && ee > p && text.charCodeAt(ee - 1) === 13) ee--;
        starts.push(p); ends.push(ee);
        p = e + 1;
      }
    }
    onProgress?.('index', 0.3);
    const firstReal = starts.findIndex((s, k) => ends[k] - s >= 73);
    if (firstReal < 0) throw igesError('not-format', 'no 80-column IGES records');
    const c0 = text[starts[firstReal] + 72];
    if (c0 === 'C') throw igesError('unsupported-version', 'compressed ASCII IGES is not supported (save as fixed 80-column ASCII IGES)');
    if (c0 !== 'S' && c0 !== 'G') throw igesError('not-format', 'not an IGES file (no start or global section)');
    let gText = '';
    const dLines: number[] = [];
    const pOff: number[] = [];
    let bad = 0, tSeen = false;
    for (let k = 0; k < starts.length; k++) {
      const s = starts[k], len = ends[k] - s;
      if (len < 73) { if (len > 0 && text.slice(s, ends[k]).trim()) bad++; continue; }
      const sec = text[s + 72];
      if (sec === 'S') this.start += text.slice(s, s + 72).trimEnd() + ' ';
      else if (sec === 'G') gText += text.slice(s, s + 72);
      else if (sec === 'D') dLines.push(s);
      else if (sec === 'P') pOff.push(s);
      else if (sec === 'T') tSeen = true;
      else bad++;
    }
    if (bad > 10 && bad > starts.length * 0.01) this.warnings.push(`${bad} records with an unknown section letter skipped`);
    if (!tSeen) this.warnings.push('terminate section missing (truncated file?)');
    if (!dLines.length) throw igesError(gText ? 'corrupt' : 'not-format', 'IGES file without directory entries');
    // global section: delimiters first
    let i = 0;
    const g = gText;
    while (i < g.length && g[i] === ' ') i++;
    if (g.startsWith('1H', i)) { this.pd = g[i + 2]; i += 3; } else this.pd = ',';
    while (i < g.length && g[i] === ' ') i++;
    if (g[i] === this.pd) i++;
    while (i < g.length && g[i] === ' ') i++;
    if (g.startsWith('1H', i)) { this.rd = g[i + 3 - 1]; i += 3; while (i < g.length && g[i] === ' ') i++; if (g[i] === this.pd) i++; }
    else if (g[i] === this.pd) i++;
    else if (g[i] === ';') { this.rd = ';'; }
    if (this.pd === this.rd || !this.pd || !this.rd) throw igesError('corrupt', 'invalid global section delimiters');
    this.global = [this.pd, this.rd, ...tokenize(g, this.pd, this.rd, i).vals];
    // directory entries
    const n = Math.floor(dLines.length / 2);
    if (dLines.length % 2) this.warnings.push('odd number of directory entry lines (truncated file?)');
    this.n = n;
    this.type = new Int32Array(n); this.pptr = new Int32Array(n); this.level = new Int32Array(n); this.xf = new Int32Array(n);
    this.colour = new Int32Array(n); this.pcount = new Int32Array(n); this.form = new Int32Array(n); this.subscript = new Int32Array(n);
    this.blank = new Uint8Array(n); this.subord = new Uint8Array(n); this.use = new Uint8Array(n);
    const fld = (s: number, k: number) => { const v = parseInt(text.slice(s + 8 * k, s + 8 * k + 8).trim() || '0', 10); return isFinite(v) ? v : 0; };
    for (let e = 0; e < n; e++) {
      const a = dLines[2 * e], b = dLines[2 * e + 1];
      this.type[e] = fld(a, 0); this.pptr[e] = fld(a, 1); this.level[e] = fld(a, 4); this.xf[e] = fld(a, 6);
      const st = text.slice(a + 64, a + 72).replace(/ /g, '0');
      this.blank[e] = +st.slice(0, 2) || 0; this.subord[e] = +st.slice(2, 4) || 0; this.use[e] = +st.slice(4, 6) || 0;
      this.colour[e] = fld(b, 2); this.pcount[e] = fld(b, 3); this.form[e] = fld(b, 4);
      this.label[e] = text.slice(b + 56, b + 64).trim();
      this.subscript[e] = fld(b, 8);
      if (fld(b, 0) !== this.type[e] && e < 3) throw igesError('corrupt', 'directory entry lines out of step');
    }
    this.pOff = Int32Array.from(pOff);
    this.pCount = pOff.length;
    onProgress?.('index', 1);
  }
  /** DE pointer (sequence number, odd) to entity index, or -1 */
  ent(ptr: number): number {
    ptr = Math.abs(ptr);
    if (!(ptr >= 1) || !(ptr % 2 === 1)) return -1;
    const e = (ptr - 1) / 2;
    return e < this.n ? e : -1;
  }
  /** parameters after the entity type number (cached) */
  P(e: number): Val[] | null {
    if (e < 0 || e >= this.n) return null;
    const c = this.cache.get(e);
    if (c !== undefined) return c;
    let res: Val[] | null = null;
    const first = this.pptr[e] - 1;
    if (first >= 0 && first < this.pCount) {
      let cnt = this.pcount[e];
      if (!(cnt > 0)) cnt = 1;
      cnt = Math.min(cnt, this.pCount - first);
      let s = '';
      for (let k = 0; k < cnt; k++) { const o = this.pOff[first + k]; s += this.text.slice(o, o + 64); }
      const t = tokenize(s, this.pd, this.rd);
      const v = t.vals;
      if (v.length && typeof v[0] === 'number' && v[0] === this.type[e]) res = v.slice(1);
      else if (v.length) res = v.slice(1); // type number mismatch: keep what is there
    }
    // keep only small entities that many others point at; curves and surfaces have their own caches
    if (CACHED.has(this.type[e])) this.cache.set(e, res);
    return res;
  }
  /** release cached parameters of big entities once they are consumed */
  drop(e: number) { this.cache.delete(e); }
}

// number of defined parameters of an entity (to find the trailing associativity / property pointers)
function defLen(t: number, form: number, a: Val[]): number {
  const n = (i: number) => Math.max(0, Math.floor(num(a, i)));
  switch (t) {
    case 100: return 7;
    case 102: return 1 + n(0);
    case 104: return 11;
    case 106: { const ip = n(0), k = n(1); return 2 + (ip === 1 ? 1 + 2 * k : ip === 2 ? 3 * k : 6 * k); }
    case 108: return 9;
    case 110: return 6;
    case 112: return 4 + n(3) + 1 + 12 * n(3) + 12;
    case 116: return 4;
    case 118: return 4;
    case 120: return 4;
    case 122: return 4;
    case 126: { const K = n(0), Md = n(1); return 6 + (K + Md + 2) + (K + 1) + 3 * (K + 1) + 2 + 3; }
    case 128: { const K1 = n(0), K2 = n(1), M1 = n(2), M2 = n(3); return 9 + (K1 + M1 + 2) + (K2 + M2 + 2) + 4 * (K1 + 1) * (K2 + 1) + 4; }
    case 140: return 5;
    case 142: return 5;
    case 143: return 3 + n(2);
    case 144: return 4 + n(2);
    case 186: return 3 + 2 * n(2);
    case 308: return 3 + n(2);
    case 402: return form === 1 || form === 7 || form === 14 || form === 15 ? 1 + n(0) : -1;
    case 408: return 5;
    case 514: return 1 + 2 * n(0);
    case 510: return 3 + n(1);
  }
  return -1;
}

/** s: surface in IGES parameters (used with parameter space curves); s3: optional closed-form surface with its own
 *  (periodic) parameters, used when loops come from model space curves */
interface SurfInfo { s: Surface; s3?: Surface; dom: number[] | null; uvB: boolean; key: string }
interface TrimLoop { c3: number[][] | null; uv: number[][] | null; domain?: boolean }
interface Acc { meshes: Map<string, { st: Style; m: NMesh }>; edges: number[]; keys: number[]; faces: number; tris: number; box: number[] }
const newAcc = (): Acc => ({ meshes: new Map(), edges: [], keys: [], faces: 0, tris: 0, box: [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity] });

// ------------------------------------------------------------------ reader
class IgesReader extends FaceTess {
  f: IgesFile;
  opts: Required<Omit<IgesReadOptions, '_faceLog'>>;
  xfCache = new Map<number, M | null>();
  curveCache = new Map<number, number[][] | null>();
  surfCache = new Map<number, SurfInfo | null>();
  styleCache = new Map<number, Style | null>();
  faceFallback = 0;
  facesTotal = 0;
  facesUV = 0;
  uvRejected = 0;
  solids = 0;
  wireCurves = 0;
  unsupported = new Map<number, number>();
  reoriented = 0;   // composite curves whose members were stored end to end in reverse (CATIA V5 writes these)
  faceLog: { solid: number; fid: number; kind: string; same: boolean; tri: number[]; nrm: number[]; loops: { outer: boolean; pts: number[][] }[] }[] | null = null;
  curSolid = 0;
  triangles = 0;
  maxTriangles: number;
  constructor(f: IgesFile, opts: Required<Omit<IgesReadOptions, '_faceLog'>>) {
    super();
    this.f = f;
    this.opts = opts;
    this.opt = { lod: opts.lod };
    this.maxTriangles = opts.maxTriangles;
  }
  unsup(t: number) { this.unsupported.set(t, (this.unsupported.get(t) || 0) + 1); }
  A(e: number) { return this.f.P(e); }
  /** transformation matrix of entity e's directory entry (chained 124s), or null */
  own(e: number, depth = 0): M | null {
    const p = this.f.xf[e];
    if (!p) return null;
    return this.matrix(this.f.ent(p), depth);
  }
  matrix(e: number, depth = 0): M | null {
    if (e < 0) return null;
    if (this.xfCache.has(e)) return this.xfCache.get(e)!;
    let m: M | null = null;
    if (this.f.type[e] === 124 && depth < 20) {
      const a = this.A(e);
      if (a) {
        m = new Float64Array(12);
        for (let k = 0; k < 12; k++) m[k] = num(a, k, k === 0 || k === 5 || k === 10 ? 1 : 0);
        if (!(Math.abs(G.det3(m)) > 1e-300)) { this.warn('singular transformation matrix ignored'); m = null; }
        const parent = this.f.xf[e] ? this.matrix(this.f.ent(this.f.xf[e]), depth + 1) : null;
        if (m && parent) m = G.mul(parent, m);
      }
    } else if (this.f.type[e] !== 124) this.warn('transformation pointer to a non-124 entity ignored');
    this.xfCache.set(e, m);
    return m;
  }
  style(e: number): Style | null {
    if (this.styleCache.has(e)) return this.styleCache.get(e)!;
    const c = this.f.colour[e];
    let st: Style | null = null;
    if (c < 0) {
      const ce = this.f.ent(-c);
      if (ce >= 0 && this.f.type[ce] === 314) {
        const a = this.A(ce);
        st = mkStyle(num(a, 0) / 100, num(a, 1) / 100, num(a, 2) / 100);
      }
    } else if (COLOR_NO[c]) { const [r, g, b] = COLOR_NO[c]; st = mkStyle(r, g, b); }
    this.styleCache.set(e, st);
    return st;
  }
  /** name from a 406 form 15 name property (trailing property pointers), else the directory entry label */
  name(e: number): string {
    const a = this.A(e);
    if (a) {
      const L = defLen(this.f.type[e], this.f.form[e], a);
      if (L >= 0 && L < a.length) {
        const na = Math.max(0, Math.floor(num(a, L)));
        const nbAt = L + 1 + na;
        const nb = Math.max(0, Math.floor(num(a, nbAt)));
        for (let k = 0; k < nb && k < 64; k++) {
          const pe = this.f.ent(num(a, nbAt + 1 + k));
          if (pe >= 0 && this.f.type[pe] === 406 && this.f.form[pe] === 15) { const s = strv(this.A(pe), 1).trim(); if (s) return s; }
        }
      }
    }
    const lb = this.f.label[e];
    if (lb) return this.f.subscript[e] ? `${lb} ${this.f.subscript[e]}` : lb;
    return '';
  }

  // ---------------------------------------------------------------- curves
  /** polyline of a curve entity in the coordinates of its parent (own transform applied) */
  curve(e: number, depth = 0): number[][] | null {
    if (e < 0) return null;
    if (this.curveCache.has(e)) return this.curveCache.get(e)!;
    let pts: number[][] | null = null;
    try { pts = depth > 40 ? null : this.curveRaw(e, depth); }
    catch (err) { if ((err as { code?: string }).code) throw err; this.warn(`curve ${this.f.type[e]} could not be read`); pts = null; }
    if (pts && pts.length) {
      for (const p of pts) if (!(isFinite(p[0]) && isFinite(p[1]) && isFinite(p[2]))) { pts = null; this.warn('curve with invalid coordinates skipped'); break; }
    }
    if (pts && pts.length) {
      const m = this.own(e);
      if (m) pts = pts.map((p) => { const o = [0, 0, 0]; G.applyM(m, p, o); return o; });
    } else pts = null;
    this.curveCache.set(e, pts);
    return pts;
  }
  sampleB(c: BCurve, t0: number, t1: number): number[][] {
    const span = Math.abs(t1 - t0), [r0, r1] = S.bcurveRange(c);
    const frac = span / (r1 - r0 || 1);
    if (c.p === 1 && frac > 0.999999 && !c.W) return c.P.map((q) => [q[0], q[1], q[2] || 0]);
    let n = c.p === 1 ? Math.max(1, Math.round((c.P.length - 1) * frac)) : Math.ceil(Math.max(4, (c.P.length + 2) * 3) * frac);
    if (this.opt.lod === 'fast') n = Math.ceil(n / 2);
    n = Math.max(c.p === 1 ? 1 : 2, Math.min(400, n));
    const out: number[][] = [];
    for (let i = 0; i <= n; i++) { const q = [0, 0, 0]; S.bcurveEval(c, t0 + ((t1 - t0) * i) / n, q); out.push(q); }
    return out;
  }
  curveRaw(e: number, depth: number): number[][] | null {
    const t = this.f.type[e], a = this.A(e);
    if (!a) return null;
    switch (t) {
      case 110: return [[num(a, 0), num(a, 1), num(a, 2)], [num(a, 3), num(a, 4), num(a, 5)]];
      case 100: {
        const zt = num(a, 0), cx = num(a, 1), cy = num(a, 2), sx = num(a, 3), sy = num(a, 4), ex = num(a, 5), ey = num(a, 6);
        const r = Math.hypot(sx - cx, sy - cy);
        if (!(r > 0)) return null;
        const a0 = Math.atan2(sy - cy, sx - cx), a1 = Math.atan2(ey - cy, ex - cx);
        let sw = a1 - a0;
        if (Math.hypot(ex - sx, ey - sy) <= r * 1e-9) sw = TWO_PI;
        else { while (sw <= 0) sw += TWO_PI; while (sw > TWO_PI) sw -= TWO_PI; }
        const n = Math.max(this.segs(r, sw), Math.ceil(sw / (Math.PI / 2)), 2);
        const out: number[][] = [];
        for (let i = 0; i <= n; i++) { const ang = a0 + (sw * i) / n; out.push([cx + r * Math.cos(ang), cy + r * Math.sin(ang), zt]); }
        if (sw < TWO_PI) out[n] = [ex, ey, zt];
        return out;
      }
      case 102: {
        const k = Math.max(0, Math.min(a.length - 1, Math.floor(num(a, 0))));
        const out: number[][] = [];
        const parts: number[][][] = [];
        for (let i = 0; i < k; i++) {
          const c = this.f.ent(num(a, 1 + i));
          if (c < 0) continue;
          if (this.f.type[c] === 116) continue;
          const p = this.curve(c, depth + 1);
          if (!p) { this.warn('composite curve member not readable'); continue; }
          parts.push(p);
        }
        // members must run end to start; some writers store members reversed: orient each one to connect.
        // Closed members (full circles) keep their direction: their ends tell nothing.
        const d2 = (p: number[], q: number[]) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
        let ext = 0;
        for (const p of parts) for (const q of [p[0], p[p.length - 1]]) ext = Math.max(ext, Math.abs(q[0]), Math.abs(q[1]), Math.abs(q[2]));
        const eps2 = (ext * 1e-7 + 1e-12) ** 2;
        const closed = (p: number[][]) => d2(p[0], p[p.length - 1]) <= eps2;
        let flipped = 0;
        for (let i = 0; i < parts.length; i++) {
          let p = parts[i];
          if (!closed(p)) {
            if (i === 0 && parts.length > 1) {
              const nx = parts[1], e0 = p[p.length - 1], s0 = p[0];
              const de = Math.min(d2(e0, nx[0]), d2(e0, nx[nx.length - 1])), ds = Math.min(d2(s0, nx[0]), d2(s0, nx[nx.length - 1]));
              if (de > eps2 && ds < de * 0.25) { p = p.slice().reverse(); flipped++; }
            } else if (i > 0) {
              const l = out[out.length - 1];
              const ds = d2(l, p[0]), de = d2(l, p[p.length - 1]);
              if (ds > eps2 && de < ds * 0.25) { p = p.slice().reverse(); flipped++; }
            }
          }
          for (let j = 0; j < p.length; j++) {
            const q = p[j];
            if (out.length) { const l = out[out.length - 1]; if (Math.abs(l[0] - q[0]) + Math.abs(l[1] - q[1]) + Math.abs(l[2] - q[2]) <= this.tol) continue; }
            out.push(q);
          }
        }
        if (flipped) this.reoriented++;
        return out.length >= 2 ? out : null;
      }
      case 104: return this.conic(a, this.f.form[e]);
      case 106: {
        const ip = Math.floor(num(a, 0)), k = Math.max(0, Math.floor(num(a, 1)));
        const out: number[][] = [];
        if (ip === 1) { const zt = num(a, 2); for (let i = 0; i < k && 4 + 2 * i < a.length + 1; i++) out.push([num(a, 3 + 2 * i), num(a, 4 + 2 * i), zt]); }
        else if (ip === 2 || ip === 3) { const st = ip === 2 ? 3 : 6; for (let i = 0; i < k && 2 + st * i + 2 < a.length; i++) out.push([num(a, 2 + st * i), num(a, 3 + st * i), num(a, 4 + st * i)]); }
        if (this.f.form[e] === 63 && out.length > 2) out.push(out[0]);
        return out.length >= 2 ? out : null;
      }
      case 112: {
        const ndim = Math.floor(num(a, 2)), n = Math.max(0, Math.floor(num(a, 3)));
        if (n < 1 || 4 + n + 1 + 12 * n > a.length) return null;
        const T = Array.from({ length: n + 1 }, (_, i) => num(a, 4 + i));
        const c0 = 4 + n + 1;
        const out: number[][] = [];
        const per = this.opt.lod === 'fast' ? 4 : 8;
        for (let i = 0; i < n; i++) {
          const b = c0 + 12 * i;
          const L = T[i + 1] - T[i];
          const cubic = num(a, b + 3) || num(a, b + 7) || num(a, b + 11) || num(a, b + 2) || num(a, b + 6) || num(a, b + 10);
          const steps = cubic ? per : 1;
          for (let k = i === 0 ? 0 : 1; k <= steps; k++) {
            const s = (L * k) / steps;
            const ev = (o: number) => num(a, b + o) + s * (num(a, b + o + 1) + s * (num(a, b + o + 2) + s * num(a, b + o + 3)));
            out.push([ev(0), ev(4), ndim === 2 ? num(a, b + 8) : ev(8)]);
          }
        }
        return out.length >= 2 ? out : null;
      }
      case 126: {
        const c = this.bcurve(a);
        if (!c) return null;
        let v0 = num(a, 6 + (c.P.length + c.p + 1) + c.P.length + 3 * c.P.length), v1 = num(a, 7 + (c.P.length + c.p + 1) + c.P.length + 3 * c.P.length);
        const [r0, r1] = S.bcurveRange(c);
        if (!(v1 > v0)) { v0 = r0; v1 = r1; }
        v0 = Math.max(r0, v0); v1 = Math.min(r1, v1);
        if (!(v1 > v0)) { v0 = r0; v1 = r1; }
        return this.sampleB(c, v0, v1);
      }
      case 142: {
        const cc = this.f.ent(num(a, 3));
        if (cc >= 0) return this.curve(cc, depth + 1);
        return null;
      }
      case 116: return null;
      case 130: this.warn('offset curve (130) not supported'); return null;
    }
    this.warn(`curve type ${t} not supported`);
    return null;
  }
  bcurve(a: Val[]): BCurve | null {
    const K = Math.floor(num(a, 0)), Md = Math.floor(num(a, 1));
    if (!(K >= 1 && Md >= 1 && Md <= 30)) { this.warn('rational B-spline curve with invalid degree or count'); return null; }
    const nk = K + Md + 2, k0 = 6, w0 = k0 + nk, p0 = w0 + K + 1, end = p0 + 3 * (K + 1);
    if (end > a.length + 1 || K > 1e6) { this.warn('rational B-spline curve with missing data'); return null; }
    const U: number[] = []; for (let i = 0; i < nk; i++) U.push(num(a, k0 + i));
    for (let i = 1; i < nk; i++) if (U[i] < U[i - 1]) { this.warn('rational B-spline curve with decreasing knots'); return null; }
    const P: number[][] = []; for (let i = 0; i <= K; i++) P.push([num(a, p0 + 3 * i), num(a, p0 + 3 * i + 1), num(a, p0 + 3 * i + 2)]);
    let W: number[] | null = null;
    if (num(a, 4) !== 1) {
      W = []; for (let i = 0; i <= K; i++) W.push(num(a, w0 + i, 1));
      if (W.some((w) => !(w > 0))) { this.warn('non-positive B-spline weights replaced by 1'); W = null; }
      else if (W.every((w) => Math.abs(w - W![0]) < 1e-12)) W = null;
    }
    if (!(U[Md] < U[K + 1])) return null;
    return { p: Md, P, U, W, closed: false };
  }
  /** conic arc (104) in its definition plane: ellipse, hyperbola or parabola, start to end counterclockwise */
  conic(a: Val[], form: number): number[][] | null {
    const A = num(a, 0), B = num(a, 1), C = num(a, 2), D = num(a, 3), E = num(a, 4), F = num(a, 5), zt = num(a, 6);
    const x1 = num(a, 7), y1 = num(a, 8), x2 = num(a, 9), y2 = num(a, 10);
    const th = 0.5 * Math.atan2(B, A - C), c = Math.cos(th), s = Math.sin(th);
    const l1 = A * c * c + B * c * s + C * s * s, l2 = A * s * s - B * c * s + C * c * c;
    const scale = Math.max(Math.abs(A), Math.abs(B), Math.abs(C)) || 1;
    const toW = (X: number, Y: number, cx: number, cy: number) => [cx + c * X - s * Y, cy + s * X + c * Y, zt];
    const toL = (x: number, y: number, cx: number, cy: number) => [c * (x - cx) + s * (y - cy), -s * (x - cx) + c * (y - cy)];
    const closed = Math.hypot(x2 - x1, y2 - y1) < 1e-12 * (1 + Math.abs(x1) + Math.abs(y1));
    const disc = B * B - 4 * A * C;
    const out: number[][] = [];
    if ((form === 3) || Math.abs(disc) < 1e-9 * scale * scale) {
      // parabola: one quadratic term vanishes in the rotated frame
      const Dp = D * c + E * s, Ep = -D * s + E * c;
      const sw = Math.abs(l1) >= Math.abs(l2);
      const [X1, Y1] = toL(x1, y1, 0, 0), [X2, Y2] = toL(x2, y2, 0, 0);
      const n = 32;
      for (let i = 0; i <= n; i++) {
        if (sw) { const X = X1 + ((X2 - X1) * i) / n; const Y = Math.abs(Ep) > 1e-300 ? -(l1 * X * X + Dp * X + F) / Ep : Y1; out.push(toW(X, Y, 0, 0)); }
        else { const Y = Y1 + ((Y2 - Y1) * i) / n; const X = Math.abs(Dp) > 1e-300 ? -(l2 * Y * Y + Ep * Y + F) / Dp : X1; out.push(toW(X, Y, 0, 0)); }
      }
      return out;
    }
    // centre
    const det = 4 * A * C - B * B;
    const cx = (B * E - 2 * C * D) / det, cy = (B * D - 2 * A * E) / det;
    const Fc = A * cx * cx + B * cx * cy + C * cy * cy + D * cx + E * cy + F;
    const [X1, Y1] = toL(x1, y1, cx, cy), [X2, Y2] = toL(x2, y2, cx, cy);
    if (disc < 0) {
      const ra = Math.sqrt(Math.abs(-Fc / l1)), rb = Math.sqrt(Math.abs(-Fc / l2));
      if (!(ra > 0 && rb > 0)) return null;
      const p0 = Math.atan2(Y1 / rb, X1 / ra);
      let sw = closed ? TWO_PI : Math.atan2(Y2 / rb, X2 / ra) - p0;
      if (!closed) while (sw <= 0) sw += TWO_PI;
      const n = Math.max(this.segs(Math.max(ra, rb), sw), 8);
      for (let i = 0; i <= n; i++) { const t = p0 + (sw * i) / n; out.push(toW(ra * Math.cos(t), rb * Math.sin(t), cx, cy)); }
      if (!closed) out[n] = [x2, y2, zt];
      return out;
    }
    // hyperbola: l1 X^2 + l2 Y^2 = -Fc with opposite signs
    const ax = -Fc / l1 > 0;
    const ra = Math.sqrt(Math.abs(Fc / l1)), rb = Math.sqrt(Math.abs(Fc / l2));
    if (!(ra > 0 && rb > 0)) return null;
    const n = 32;
    if (ax) {
      const sg = X1 >= 0 ? 1 : -1, t0 = Math.asinh(Y1 / rb), t1 = Math.asinh(Y2 / rb);
      for (let i = 0; i <= n; i++) { const t = t0 + ((t1 - t0) * i) / n; out.push(toW(sg * ra * Math.cosh(t), rb * Math.sinh(t), cx, cy)); }
    } else {
      const sg = Y1 >= 0 ? 1 : -1, t0 = Math.asinh(X1 / ra), t1 = Math.asinh(X2 / ra);
      for (let i = 0; i <= n; i++) { const t = t0 + ((t1 - t0) * i) / n; out.push(toW(ra * Math.sinh(t), sg * rb * Math.cosh(t), cx, cy)); }
    }
    return out;
  }
  point(e: number): number[] | null {
    if (e < 0 || this.f.type[e] !== 116) return null;
    const a = this.A(e);
    const p = [num(a, 0), num(a, 1), num(a, 2)];
    const m = this.own(e);
    if (m) { const o = [0, 0, 0]; G.applyM(m, p, o); return o; }
    return p;
  }
  direction(e: number): number[] | null {
    if (e < 0 || this.f.type[e] !== 123) return null;
    const a = this.A(e);
    let d = [num(a, 0), num(a, 1), num(a, 2)];
    const m = this.own(e);
    if (m) d = [m[0] * d[0] + m[1] * d[1] + m[2] * d[2], m[4] * d[0] + m[5] * d[1] + m[6] * d[2], m[8] * d[0] + m[9] * d[1] + m[10] * d[2]];
    const l = Math.hypot(d[0], d[1], d[2]);
    return l > 0 ? [d[0] / l, d[1] / l, d[2] / l] : null;
  }
  frame(o: number[], z: number[], x: number[] | null): M {
    let xx = x && Math.abs(G.dot3(x, z)) < 0.999 ? x : Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    xx = G.norm3(G.sub3(xx, sc3(z, G.dot3(xx, z))));
    const y = G.cross3(z, xx);
    return G.fromAxes(o, xx, y, z);
  }

  // ---------------------------------------------------------------- surfaces
  /** surface in its parent's coordinates (own transform applied), with its natural parameter domain */
  surface(e: number, depth = 0): SurfInfo | null {
    if (e < 0) return null;
    if (this.surfCache.has(e)) return this.surfCache.get(e)!;
    let r: SurfInfo | null = null;
    try { r = depth > 20 ? null : this.surfaceRaw(e, depth); }
    catch (err) { if ((err as { code?: string }).code) throw err; this.warn(`surface ${this.f.type[e]} could not be read`); r = null; }
    if (r) {
      const m = this.own(e);
      if (m) r = { ...r, s: xformSurface(r.s, m), s3: r.s3 ? xformSurface(r.s3, m) : undefined };
    }
    this.surfCache.set(e, r);
    return r;
  }
  surfaceRaw(e: number, depth: number): SurfInfo | null {
    const t = this.f.type[e], a = this.A(e);
    if (!a) return null;
    const key = String(t);
    switch (t) {
      case 128: {
        const K1 = Math.floor(num(a, 0)), K2 = Math.floor(num(a, 1)), M1 = Math.floor(num(a, 2)), M2 = Math.floor(num(a, 3));
        if (!(K1 >= 1 && K2 >= 1 && M1 >= 1 && M2 >= 1 && M1 <= 30 && M2 <= 30 && K1 * K2 < 4e6)) { this.warn('rational B-spline surface with invalid degree or count'); return null; }
        const n1 = K1 + M1 + 2, n2 = K2 + M2 + 2, cnt = (K1 + 1) * (K2 + 1);
        const s0 = 9, t0 = s0 + n1, w0 = t0 + n2, p0 = w0 + cnt, d0 = p0 + 3 * cnt;
        if (d0 > a.length) { this.warn('rational B-spline surface with missing data'); return null; }
        const U: number[] = [], V: number[] = [];
        for (let i = 0; i < n1; i++) U.push(num(a, s0 + i));
        for (let i = 0; i < n2; i++) V.push(num(a, t0 + i));
        for (let i = 1; i < n1; i++) if (U[i] < U[i - 1]) { this.warn('B-spline surface with decreasing knots'); return null; }
        for (let i = 1; i < n2; i++) if (V[i] < V[i - 1]) { this.warn('B-spline surface with decreasing knots'); return null; }
        const P: number[][][] = [];
        let W: number[][] | null = num(a, 6) === 1 ? null : [];
        let allSame = true;
        const w00 = num(a, w0, 1);
        for (let i = 0; i <= K1; i++) {
          const row: number[][] = [], wr: number[] = [];
          for (let j = 0; j <= K2; j++) {
            const k = i + (K1 + 1) * j;
            row.push([num(a, p0 + 3 * k), num(a, p0 + 3 * k + 1), num(a, p0 + 3 * k + 2)]);
            if (W) { const w = num(a, w0 + k, 1); wr.push(w); if (Math.abs(w - w00) > 1e-12) allSame = false; if (!(w > 0)) { W = null; this.warn('non-positive B-spline weights replaced by 1'); } }
          }
          P.push(row);
          if (W) W.push(wr);
        }
        if (W && allSame) W = null;
        if (!(U[M1] < U[K1 + 1] && V[M2] < V[K2 + 1])) { this.warn('B-spline surface with an empty knot range'); return null; }
        let u0 = num(a, d0, U[M1]), u1 = num(a, d0 + 1, U[K1 + 1]), v0 = num(a, d0 + 2, V[M2]), v1 = num(a, d0 + 3, V[K2 + 1]);
        u0 = Math.max(u0, U[M1]); u1 = Math.min(u1, U[K1 + 1]); v0 = Math.max(v0, V[M2]); v1 = Math.min(v1, V[K2 + 1]);
        if (!(u1 > u0)) { u0 = U[M1]; u1 = U[K1 + 1]; }
        if (!(v1 > v0)) { v0 = V[M2]; v1 = V[K2 + 1]; }
        const s = S.bsplineSurface({ pu: M1, pv: M2, P, U, V, W }, false, false);
        this.f.drop(e);
        return { s, dom: [u0, u1, v0, v1], uvB: true, key };
      }
      case 114: {
        const Mu = Math.floor(num(a, 2)), Nv = Math.floor(num(a, 3));
        if (!(Mu >= 1 && Nv >= 1 && Mu * Nv < 1e6)) { this.warn('parametric spline surface with invalid segment counts'); return null; }
        const TU: number[] = [], TV: number[] = [];
        for (let i = 0; i <= Mu; i++) TU.push(num(a, 4 + i));
        for (let j = 0; j <= Nv; j++) TV.push(num(a, 5 + Mu + j));
        const c0 = 6 + Mu + Nv;
        const avail = Math.floor((a.length - c0) / 48);
        // patches stored row by row (u outer); files may include the extra (M+1, N+1) patches
        const stride = avail >= (Mu + 1) * (Nv + 1) ? Nv + 1 : Nv;
        if (avail < Mu * Nv) { this.warn('parametric spline surface with missing coefficients'); return null; }
        const coef: number[][][] = [];
        for (let i = 0; i < Mu; i++) {
          const row: number[][] = [];
          for (let j = 0; j < Nv; j++) { const b = c0 + 48 * (i * stride + j); const c: number[] = []; for (let k = 0; k < 48; k++) c.push(num(a, b + k)); row.push(c); }
          coef.push(row);
        }
        this.f.drop(e);
        return { s: spline114(TU, TV, coef), dom: [TU[0], TU[Mu], TV[0], TV[Nv]], uvB: true, key };
      }
      case 118: {
        const e1 = this.f.ent(num(a, 0)), e2 = this.f.ent(num(a, 1));
        const c1 = this.curveOrPoint(e1, depth), c2 = this.curveOrPoint(e2, depth);
        if (!c1 || !c2) return null;
        const rev = num(a, 2) === 1;
        const C2 = rev ? c2.slice().reverse() : c2;
        const s3 = ruled118(c1, C2, this.f.form[e] === 0);
        // form 1: equal relative parameter values on both curves (IGES 5.3 section 4.16)
        const g1 = this.f.form[e] === 1 ? this.curveEval(e1, depth) : null, g2 = this.f.form[e] === 1 ? this.curveEval(e2, depth) : null;
        if (g1 && g2) {
          const A = [0, 0, 0], B = [0, 0, 0];
          const ev = (u: number, v: number, out: number[]) => {
            g1.ev(g1.t0 + (g1.t1 - g1.t0) * u, A);
            const w = rev ? 1 - u : u;
            g2.ev(g2.t0 + (g2.t1 - g2.t0) * w, B);
            for (let k = 0; k < 3; k++) out[k] = A[k] + (B[k] - A[k]) * v;
          };
          return { s: numericSurface('ruled', ev, 0, 1, 0, 1, Math.max(c1.length, c2.length) * 2, 8, true), s3, dom: [0, 1, 0, 1], uvB: true, key };
        }
        return { s: s3, dom: [0, 1, 0, 1], uvB: false, key };
      }
      case 120: {
        const ax = this.curve(this.f.ent(num(a, 0)), depth + 1), ge = this.f.ent(num(a, 1)), gen = this.curve(ge, depth + 1);
        if (!ax || ax.length < 2 || !gen || gen.length < 2) return null;
        const o = ax[0], d = G.norm3(G.sub3(ax[ax.length - 1], ax[0]));
        let rmax = 0;
        for (const p of gen) { const w = G.sub3(p, o); const h = G.dot3(w, d); rmax = Math.max(rmax, G.len3(G.sub3(w, sc3(d, h)))); }
        const sa = num(a, 2), ta0 = num(a, 3, TWO_PI), ta = ta0 > sa ? ta0 : sa + TWO_PI;
        const s3 = S.revolutionSurface(gen, o, d, this.segsFull(rmax));
        // IGES parametrisation (5.3 section 4.18): first parameter along the generatrix, second the rotation angle
        const g = this.curveEval(ge, depth);
        if (g) {
          const p = [0, 0, 0];
          const ev = (t: number, th: number, out: number[]) => {
            g.ev(t, p);
            const w = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
            const h = w[0] * d[0] + w[1] * d[1] + w[2] * d[2];
            const r = [w[0] - h * d[0], w[1] - h * d[1], w[2] - h * d[2]];
            const q = [d[1] * r[2] - d[2] * r[1], d[2] * r[0] - d[0] * r[2], d[0] * r[1] - d[1] * r[0]];
            const c = Math.cos(th), sn = Math.sin(th);
            for (let k = 0; k < 3; k++) out[k] = o[k] + d[k] * h + r[k] * c + q[k] * sn;
          };
          const s = numericSurface('revolution', ev, g.t0, g.t1, sa, ta, Math.max(16, gen.length * 2), Math.max(16, Math.ceil(((ta - sa) / TWO_PI) * 64)));
          return { s, s3, dom: [g.t0, g.t1, sa, ta], uvB: true, key };
        }
        return { s: s3, dom: [sa, ta, 0, gen.length - 1], uvB: false, key };
      }
      case 122: {
        const de = this.f.ent(num(a, 0)), dir = this.curve(de, depth + 1);
        if (!dir || dir.length < 2) return null;
        const L = [num(a, 1), num(a, 2), num(a, 3)];
        const v = G.sub3(L, dir[0]), len = G.len3(v);
        if (!(len > 0)) return null;
        const s3 = S.extrusionSurface(dir, sc3(v, 1 / len));
        // IGES parametrisation (5.3 section 4.19): u in [0,1] along the directrix, v in [0,1] along the generatrix
        const g = this.curveEval(de, depth);
        if (g) {
          const ev = (u: number, w: number, out: number[]) => { g.ev(g.t0 + (g.t1 - g.t0) * u, out); out[0] += v[0] * w; out[1] += v[1] * w; out[2] += v[2] * w; };
          return { s: numericSurface('tabulated', ev, 0, 1, 0, 1, dir.length * 2, 4, true), s3, dom: [0, 1, 0, 1], uvB: true, key };
        }
        return { s: s3, dom: [0, dir.length - 1, 0, len], uvB: false, key };
      }
      case 140: {
        const b = this.surface(this.f.ent(num(a, 4)), depth + 1);
        if (!b) return null;
        return { s: S.offsetSurface(b.s, num(a, 3)), s3: b.s3 ? S.offsetSurface(b.s3, num(a, 3)) : undefined, dom: b.dom, uvB: b.uvB, key: '140:' + b.key };
      }
      case 108: {
        const n = [num(a, 0), num(a, 1), num(a, 2)], l = G.len3(n);
        if (!(l > 0)) return null;
        const z = sc3(n, 1 / l);
        return { s: S.planeSurface(this.frame(sc3(z, num(a, 3) / l), z, null)), dom: null, uvB: false, key };
      }
      case 190: {
        const o = this.point(this.f.ent(num(a, 0))), z = this.direction(this.f.ent(num(a, 1)));
        if (!o || !z) return null;
        return { s: S.planeSurface(this.frame(o, z, this.f.form[e] === 1 ? this.direction(this.f.ent(num(a, 2))) : null)), dom: null, uvB: false, key };
      }
      case 192: case 194: case 198: {
        const o = this.point(this.f.ent(num(a, 0))), z = this.direction(this.f.ent(num(a, 1)));
        if (!o || !z) return null;
        const refAt = t === 192 ? 3 : 4;
        const m = this.frame(o, z, this.f.form[e] === 1 ? this.direction(this.f.ent(num(a, refAt))) : null);
        if (t === 192) { const r = num(a, 2); return r > 0 ? { s: S.cylinderSurface(m, r, this.segsFull(r)), dom: null, uvB: false, key } : null; }
        if (t === 194) { const r = num(a, 2), sa = (num(a, 3) * Math.PI) / 180; return { s: S.coneSurface(m, r, sa, this.segsFull(Math.max(r, 1e-9))), dom: null, uvB: false, key }; }
        const R = num(a, 2), r = num(a, 3);
        return R > 0 && r > 0 ? { s: S.torusSurface(m, R, r, this.segsFull(R + r), this.segsFull(r)), dom: null, uvB: false, key } : null;
      }
      case 196: {
        const o = this.point(this.f.ent(num(a, 0))), r = num(a, 1);
        if (!o || !(r > 0)) return null;
        const z = this.f.form[e] === 1 ? this.direction(this.f.ent(num(a, 2))) : null;
        const x = this.f.form[e] === 1 ? this.direction(this.f.ent(num(a, 3))) : null;
        return { s: S.sphereSurface(this.frame(o, z || [0, 0, 1], x), r, this.segsFull(r)), dom: null, uvB: false, key };
      }
    }
    this.warn(`surface type ${t} (${TYPE_NAME[t] || 'unknown'}) not supported`);
    return null;
  }
  /** curve with its IGES parametrisation (own transform applied): 110, 100, 126, 112, 102 */
  curveEval(e: number, depth = 0): { t0: number; t1: number; ev: (t: number, out: number[]) => void } | null {
    if (e < 0 || depth > 40) return null;
    const t = this.f.type[e], a = this.A(e);
    if (!a) return null;
    let r: { t0: number; t1: number; ev: (t: number, out: number[]) => void } | null = null;
    if (t === 110) {
      const p = [num(a, 0), num(a, 1), num(a, 2)], q = [num(a, 3), num(a, 4), num(a, 5)];
      r = { t0: 0, t1: 1, ev: (x, o) => { for (let k = 0; k < 3; k++) o[k] = p[k] + (q[k] - p[k]) * x; } };
    } else if (t === 100) {
      const zt = num(a, 0), cx = num(a, 1), cy = num(a, 2), sx = num(a, 3), sy = num(a, 4), ex = num(a, 5), ey = num(a, 6);
      const rr = Math.hypot(sx - cx, sy - cy);
      if (!(rr > 0)) return null;
      const a0 = Math.atan2(sy - cy, sx - cx);
      let sw = Math.atan2(ey - cy, ex - cx) - a0;
      if (Math.hypot(ex - sx, ey - sy) <= rr * 1e-9) sw = TWO_PI; else { while (sw <= 0) sw += TWO_PI; while (sw > TWO_PI) sw -= TWO_PI; }
      r = { t0: a0, t1: a0 + sw, ev: (x, o) => { o[0] = cx + rr * Math.cos(x); o[1] = cy + rr * Math.sin(x); o[2] = zt; } };
    } else if (t === 126) {
      const c = this.bcurve(a);
      if (!c) return null;
      const K = c.P.length - 1, at = 6 + (K + c.p + 2) + (K + 1) + 3 * (K + 1);
      const [r0, r1] = S.bcurveRange(c);
      let v0 = num(a, at, r0), v1 = num(a, at + 1, r1);
      if (!(v1 > v0)) { v0 = r0; v1 = r1; }
      r = { t0: v0, t1: v1, ev: (x, o) => S.bcurveEval(c, Math.max(r0, Math.min(r1, x)), o) };
    } else if (t === 112) {
      const ndim = Math.floor(num(a, 2)), n = Math.max(0, Math.floor(num(a, 3)));
      if (n < 1 || 4 + n + 1 + 12 * n > a.length) return null;
      const T = Array.from({ length: n + 1 }, (_, i) => num(a, 4 + i));
      const c0 = 4 + n + 1;
      r = { t0: T[0], t1: T[n], ev: (x, o) => {
        let i = 0; while (i < n - 1 && x >= T[i + 1]) i++;
        const b = c0 + 12 * i, sx = x - T[i];
        const f = (k: number) => num(a, b + k) + sx * (num(a, b + k + 1) + sx * (num(a, b + k + 2) + sx * num(a, b + k + 3)));
        o[0] = f(0); o[1] = f(4); o[2] = ndim === 2 ? num(a, b + 8) : f(8);
      } };
    } else if (t === 102) {
      const k = Math.max(0, Math.min(a.length - 1, Math.floor(num(a, 0))));
      const parts: { t0: number; t1: number; ev: (t: number, out: number[]) => void }[] = [];
      for (let i = 0; i < k; i++) { const m = this.f.ent(num(a, 1 + i)); if (m >= 0 && this.f.type[m] === 116) continue; const c = this.curveEval(m, depth + 1); if (!c) return null; parts.push(c); }
      if (!parts.length) return null;
      // concatenated parametrisation: each member continues where the previous one ended
      const starts: number[] = [];
      let acc = parts[0].t0;
      for (const c of parts) { starts.push(acc); acc += c.t1 - c.t0; }
      r = { t0: parts[0].t0, t1: acc, ev: (x, o) => {
        let i = 0; while (i < parts.length - 1 && x >= starts[i + 1]) i++;
        const c = parts[i]; c.ev(c.t0 + (x - starts[i]), o);
      } };
    }
    if (!r) return null;
    const m = this.own(e);
    if (m) { const base = r.ev, q = [0, 0, 0]; r = { t0: r.t0, t1: r.t1, ev: (x, o) => { base(x, q); G.applyM(m, q, o); } }; }
    return r;
  }
  curveOrPoint(e: number, depth: number): number[][] | null {
    if (e < 0) return null;
    if (this.f.type[e] === 116) { const p = this.point(e); return p ? [p, p] : null; }
    return this.curve(e, depth + 1);
  }

  // ---------------------------------------------------------------- faces
  /** curve on a parametric surface (142): model space polyline and parameter space polyline */
  onSurface(e: number): TrimLoop {
    const a = this.A(e);
    if (!a || this.f.type[e] !== 142) {
      // some writers point straight at a model space curve
      const c = this.curve(e);
      return { c3: c, uv: null };
    }
    const be = this.f.ent(num(a, 2)), ce = this.f.ent(num(a, 3));
    let c3 = ce >= 0 ? this.curve(ce) : null;
    let uv = be >= 0 ? this.curve(be) : null;
    const m = this.own(e);
    if (m && c3) c3 = c3.map((p) => { const o = [0, 0, 0]; G.applyM(m, p, o); return o; });
    if (uv && uv.length < 2) uv = null;
    return { c3, uv };
  }
  /** boundary (141): model space and parameter space curves joined with their senses */
  boundary(e: number): TrimLoop {
    const a = this.A(e);
    if (!a || this.f.type[e] !== 141) return { c3: null, uv: null };
    const type = num(a, 0), n = Math.max(0, Math.floor(num(a, 3)));
    let c3: number[][] | null = [], uv: number[][] | null = type === 1 ? [] : null;
    let k = 4;
    for (let i = 0; i < n && k < a.length; i++) {
      const ce = this.f.ent(num(a, k)), sense = num(a, k + 1, 1), K = Math.max(0, Math.floor(num(a, k + 2)));
      let p = this.curve(ce);
      if (p) { if (sense === 2) p = p.slice().reverse(); for (const q of p) c3!.push(q); } else c3 = null as unknown as number[][];
      const part: number[][] = [];
      for (let j = 0; j < K; j++) { const pe = this.curve(this.f.ent(num(a, k + 3 + j))); if (pe) for (const q of pe) part.push(q); else if (uv) uv = null; }
      if (uv) { const pp = sense === 2 ? part.reverse() : part; for (const q of pp) uv.push(q); }
      k += 3 + K;
      if (!c3) break;
    }
    return { c3: c3 && c3.length >= 2 ? c3 : null, uv: uv && uv.length >= 2 ? uv : null };
  }
  /** loops given as UV (parameter curves) when they agree with the model space curves */
  validUV(si: SurfInfo, L: TrimLoop): boolean {
    if (!L.uv) return false;
    if (!L.c3) return true;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of L.c3) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); z0 = Math.min(z0, p[2]); z1 = Math.max(z1, p[2]); }
    const lim = Math.max(Math.hypot(x1 - x0, y1 - y0, z1 - z0) * 0.02, this.tol * 100);
    const q = [0, 0, 0];
    const n = L.uv.length, step = Math.max(1, Math.floor(n / 12)) * 2 - 1;
    const C = L.c3;
    for (let h = 0; h < 2 * n; h += step) {
      // parameter points and the midpoints of parameter segments (their images must follow the model curve too)
      const i = h >> 1;
      if (h & 1) { const j = (i + 1) % n; si.s.eval((L.uv[i][0] + L.uv[j][0]) / 2, (L.uv[i][1] + L.uv[j][1]) / 2, q); }
      else si.s.eval(L.uv[i][0], L.uv[i][1], q);
      let best = Infinity;
      for (let k = 0; k < C.length - 1; k++) {
        const a = C[k], b = C[k + 1];
        const ab = G.sub3(b, a), ap = G.sub3(q, a);
        const l2 = G.dot3(ab, ab);
        let t = l2 > 0 ? G.dot3(ap, ab) / l2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
        const d = Math.hypot(ap[0] - ab[0] * t, ap[1] - ab[1] * t, ap[2] - ab[2] * t);
        if (d < best) best = d;
        if (best <= lim) break;
      }
      if (C.length === 1) best = G.len3(G.sub3(q, C[0]));
      if (!(best <= lim)) return false;
    }
    return true;
  }
  domainLoop3(si: SurfInfo): number[][] {
    const [u0, u1, v0, v1] = si.dom!;
    const nu = Math.max(4, Math.min(200, si.s.stepsU(u1 - u0) * 2)), nv = Math.max(4, Math.min(200, si.s.ruledV ? 4 : si.s.stepsV(v1 - v0) * 2));
    const out: number[][] = [];
    const ev = (u: number, v: number) => { const q = [0, 0, 0]; si.s.eval(u, v, q); out.push(q); };
    for (let i = 0; i < nu; i++) ev(u0 + ((u1 - u0) * i) / nu, v0);
    for (let i = 0; i < nv; i++) ev(u1, v0 + ((v1 - v0) * i) / nv);
    for (let i = 0; i < nu; i++) ev(u1 - ((u1 - u0) * i) / nu, v1);
    for (let i = 0; i < nv; i++) ev(u0, v1 - ((v1 - v0) * i) / nv);
    return out;
  }
  /** iso-curves of the domain boundary as edge polylines (untrimmed surfaces) */
  domainEdges(si: SurfInfo, edges: number[]) {
    const L = this.domainLoop3(si);
    for (let i = 0; i < L.length; i++) { const a = L[i], b = L[(i + 1) % L.length]; edges.push(a[0], a[1], a[2], b[0], b[1], b[2]); }
  }
  /**
   * tessellate one face: surface + outer loop (or the natural domain) + holes, into a local mesh.
   * Parameter space loops are used directly when the surface parametrisation is ours (B-splines, 114)
   * and they agree with the model space curves; otherwise model space loops are mapped by the inverse.
   */
  face(si: SurfInfo, outer: TrimLoop | null, holes: TrimLoop[], m: NMesh, edges: number[] | null, keys: number[], same: boolean, fid: number) {
    this.facesTotal++;
    this.curFace = fid;
    const s = si.s;
    const loops = [outer || { c3: null, uv: null, domain: true }, ...holes];
    if (loops[0].domain && !si.dom) { this.warn('trimmed surface on an unbounded surface without outer boundary skipped'); return; }
    const i0 = m.idx.length;
    // edges and adjacency keys
    const edgeLoops: number[][][] = [];
    for (const L of loops) {
      if (L.domain) continue;
      let p = L.c3;
      if (!p && L.uv && si.uvB) p = this.uvTo3(si, L.uv);
      if (p) edgeLoops.push(p);
    }
    if (edges && this.opts.edges) {
      if (loops[0].domain) this.domainEdges(si, edges);
      for (const p of edgeLoops) for (let i = 0; i < p.length - 1; i++) edges.push(p[i][0], p[i][1], p[i][2], p[i + 1][0], p[i + 1][1], p[i + 1][2]);
    }
    // adjacency keys for grouping loose surfaces into bodies: boundary points (adjacent faces sample a shared edge alike)
    for (const p of edgeLoops) { const st = Math.max(1, Math.floor(p.length / 64)); for (let i = 0; i < p.length; i += st) keys.push(p[i][0], p[i][1], p[i][2]); }
    if (loops[0].domain) { const [u0, u1, v0, v1] = si.dom!; const q = [0, 0, 0]; for (const [u, v] of [[u0, v0], [u1, v0], [u1, v1], [u0, v1], [(u0 + u1) / 2, v0], [(u0 + u1) / 2, v1], [u0, (v0 + v1) / 2], [u1, (v0 + v1) / 2]]) { s.eval(u, v, q); keys.push(q[0], q[1], q[2]); } }
    let logLoops: { outer: boolean; pts: number[][] }[] = [];
    // parameter space route
    const uvRoute = loops.every((L) => (L.domain ? true : si.uvB && this.validUV(si, L)));
    if (!uvRoute && si.uvB && loops.some((L) => L.uv && L.c3)) this.uvRejected++;
    if (uvRoute && s.kind !== 'plane') {
      const uvl: UVP[][] = loops.map((L) => {
        if (L.domain) { const [u0, u1, v0, v1] = si.dom!; return [{ u: u0, v: v0, p: null }, { u: u1, v: v0, p: null }, { u: u1, v: v1, p: null }, { u: u0, v: v1, p: null }]; }
        const out: UVP[] = [];
        for (const q of L.uv!) { const l = out[out.length - 1]; if (l && Math.abs(l.u - q[0]) + Math.abs(l.v - q[1]) < 1e-14 * (1 + Math.abs(q[0]) + Math.abs(q[1]))) continue; out.push({ u: q[0], v: q[1], p: null }); }
        while (out.length > 1 && Math.abs(out[0].u - out[out.length - 1].u) + Math.abs(out[0].v - out[out.length - 1].v) < 1e-14 * (1 + Math.abs(out[0].u) + Math.abs(out[0].v))) out.pop();
        return out;
      });
      const dl = uvl.map((l) => this.densify(s, l));
      this.uvFace(s, dl, m, same);
      this.facesUV++;
      // logged reference loops: the model space curve when it is sampled at least as finely as the parameter loop
      if (this.faceLog) logLoops = loops.map((L, k) => ({ outer: k === 0, pts: L.c3 && L.c3.length >= dl[k].length ? L.c3 : dl[k].map((q) => { const o = [0, 0, 0]; s.eval(q.u, q.v, o); return o; }) }));
    } else {
      const l3: { pts: number[][]; outer: boolean }[] = [];
      for (let k = 0; k < loops.length; k++) {
        const L = loops[k];
        let p: number[][] | null = L.domain ? this.domainLoop3(si) : L.c3;
        if (!p && L.uv && si.uvB) p = this.uvTo3(si, L.uv);
        if (!p) { this.warn('trimming loop without a usable model space curve skipped'); if (k === 0) return; continue; }
        const clean: number[][] = [];
        for (const q of p) if (!clean.length || G.len3(G.sub3(clean[clean.length - 1], q)) > this.tol) clean.push(q);
        while (clean.length > 1 && G.len3(G.sub3(clean[0], clean[clean.length - 1])) <= this.tol) clean.pop();
        if (clean.length >= 2) l3.push({ pts: clean, outer: k === 0 });
      }
      if (!l3.length) return;
      const s3 = si.s3 || s;
      if (s3.kind === 'plane') this.planarFace(l3, m, s3, same);
      else if (!this.curvedFace(s3, l3, m, same)) { this.faceFallback++; this.planarFace(l3, m, null, same); }
      logLoops = l3;
    }
    if (this.faceLog) {
      const pos: number[] = [], nrm: number[] = [];
      for (let k = i0; k < m.idx.length; k++) { const v = m.idx[k]; pos.push(m.pos[3 * v], m.pos[3 * v + 1], m.pos[3 * v + 2]); nrm.push(m.nrm[3 * v], m.nrm[3 * v + 1], m.nrm[3 * v + 2]); }
      this.faceLog.push({ solid: this.curSolid, fid, kind: s.kind, same, tri: pos, nrm, loops: logLoops });
    }
  }
  /** subdivide straight parameter segments of a loop until their image in space is close to its chord */
  densify(s: Surface, L: UVP[]): UVP[] {
    const n = L.length;
    if (n < 2) return L;
    const P = L.map((q) => { const o = [0, 0, 0]; s.eval(q.u, q.v, o); return o; });
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of P) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); z0 = Math.min(z0, p[2]); z1 = Math.max(z1, p[2]); }
    const dev = Math.max(Math.hypot(x1 - x0, y1 - y0, z1 - z0) * (this.opt.lod === 'fast' ? 6e-3 : 3e-3), this.tol * 10);
    const out: UVP[] = [];
    let budget = 20000;
    const pm = [0, 0, 0];
    const sub = (a: UVP, pa: number[], b: UVP, pb: number[], d: number) => {
      if (d >= 10 || budget <= 0) return;
      const m: UVP = { u: (a.u + b.u) / 2, v: (a.v + b.v) / 2, p: null };
      s.eval(m.u, m.v, pm);
      const e = Math.hypot(pm[0] - (pa[0] + pb[0]) / 2, pm[1] - (pa[1] + pb[1]) / 2, pm[2] - (pa[2] + pb[2]) / 2);
      // also look at the quarter points (an S-shaped image has a straight-looking midpoint)
      if (e <= dev && d > 0) return;
      const q = pm.slice();
      if (e <= dev) {
        const t = [0, 0, 0];
        s.eval(a.u + (b.u - a.u) * 0.25, a.v + (b.v - a.v) * 0.25, t);
        const e2 = Math.hypot(t[0] - (pa[0] * 0.75 + pb[0] * 0.25), t[1] - (pa[1] * 0.75 + pb[1] * 0.25), t[2] - (pa[2] * 0.75 + pb[2] * 0.25));
        if (e2 <= dev) return;
      }
      budget--;
      sub(a, pa, m, q, d + 1);
      out.push(m);
      sub(m, q, b, pb, d + 1);
    };
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      out.push(L[i]);
      sub(L[i], P[i], L[j], P[j], 0);
    }
    return out;
  }
  uvTo3(si: SurfInfo, uv: number[][]): number[][] {
    const out: number[][] = [];
    for (let i = 0; i < uv.length; i++) {
      const a = uv[i];
      if (i > 0) {
        // straight parameter segments are curved in space: subdivide
        const b = uv[i - 1];
        const k = 8;
        for (let j = 1; j < k; j++) { const q = [0, 0, 0]; si.s.eval(b[0] + ((a[0] - b[0]) * j) / k, b[1] + ((a[1] - b[1]) * j) / k, q); out.push(q); }
      }
      const q = [0, 0, 0]; si.s.eval(a[0], a[1], q); out.push(q);
    }
    return out;
  }

  // ---------------------------------------------------------------- B-rep (186 .. 514)
  edgeCache = new Map<string, number[][] | null>();
  vertex(e: number, k: number): number[] | null {
    if (e < 0 || this.f.type[e] !== 502) return null;
    const a = this.A(e);
    const n = num(a, 0);
    if (!(k >= 1 && k <= n)) return null;
    return [num(a, 1 + 3 * (k - 1)), num(a, 2 + 3 * (k - 1)), num(a, 3 + 3 * (k - 1))];
  }
  brepEdge(le: number, k: number): number[][] | null {
    const key = `${le}:${k}`;
    if (this.edgeCache.has(key)) return this.edgeCache.get(key)!;
    let res: number[][] | null = null;
    const a = this.A(le);
    if (a && this.f.type[le] === 504 && k >= 1 && k <= num(a, 0)) {
      const b = 1 + 5 * (k - 1);
      const c = this.curve(this.f.ent(num(a, b)));
      const sv = this.vertex(this.f.ent(num(a, b + 1)), num(a, b + 2)), tv = this.vertex(this.f.ent(num(a, b + 3)), num(a, b + 4));
      res = c && sv && tv ? trimPolyline(c, sv, tv, this.tol * 1000) : c;
    }
    this.edgeCache.set(key, res);
    return res;
  }
  solid(e: number, m: NMesh, edges: number[], keys: number[], seen: Set<string>) {
    const a = this.A(e);
    if (!a) return;
    this.solids++;
    this.curSolid = e;
    const shells: [number, boolean][] = [[this.f.ent(num(a, 0)), num(a, 1, 1) !== 0]];
    const nv = Math.max(0, Math.floor(num(a, 2)));
    for (let i = 0; i < nv; i++) shells.push([this.f.ent(num(a, 3 + 2 * i)), num(a, 4 + 2 * i, 1) !== 0]);
    for (const [sh, sof] of shells) {
      const sa = this.A(sh);
      if (!sa || this.f.type[sh] !== 514) { this.warn('B-rep shell missing'); continue; }
      const nf = Math.max(0, Math.floor(num(sa, 0)));
      for (let i = 0; i < nf; i++) {
        const fe = this.f.ent(num(sa, 1 + 2 * i));
        const of = num(sa, 2 + 2 * i, 1) !== 0;
        this.brepFace(fe, of === sof, m, edges, keys, seen);
        if (this.triangles + m.idx.length / 3 > this.maxTriangles) return;
      }
    }
  }
  brepFace(fe: number, same: boolean, m: NMesh, edges: number[], keys: number[], seen: Set<string>) {
    const a = this.A(fe);
    if (!a || this.f.type[fe] !== 510) { this.warn('B-rep face missing'); return; }
    const si = this.surface(this.f.ent(num(a, 0)));
    if (!si) return;
    const nl = Math.max(0, Math.floor(num(a, 1)));
    const outerFlag = num(a, 2, 1) === 1;
    const loops: TrimLoop[] = [];
    for (let i = 0; i < nl; i++) {
      const le = this.f.ent(num(a, 3 + i));
      const la = this.A(le);
      if (!la || this.f.type[le] !== 508) continue;
      const ne = Math.max(0, Math.floor(num(la, 0)));
      const pts: number[][] = [];
      let k = 1;
      for (let j = 0; j < ne && k < la.length; j++) {
        const type = num(la, k), ed = this.f.ent(num(la, k + 1)), ndx = num(la, k + 2), of = num(la, k + 3, 1) !== 0, K = Math.max(0, Math.floor(num(la, k + 4)));
        k += 5 + 2 * K;
        if (type === 1) continue; // vertex
        let p = this.brepEdge(ed, ndx);
        if (!p) { this.warn('B-rep edge without curve'); continue; }
        const key = `${ed}:${ndx}`;
        if (this.opts.edges && !seen.has(key)) { seen.add(key); for (let q = 0; q < p.length - 1; q++) edges.push(p[q][0], p[q][1], p[q][2], p[q + 1][0], p[q + 1][1], p[q + 1][2]); }
        if (!of) p = p.slice().reverse();
        for (let q = 0; q < p.length - 1; q++) pts.push(p[q]);
        if (ne === 1) pts.push(p[p.length - 1]);
      }
      if (pts.length >= 2) loops.push({ c3: pts, uv: null });
    }
    if (!loops.length && !si.dom) return;
    if (outerFlag && loops.length) this.face(si, loops[0], loops.slice(1), m, null, keys, same, fe);
    else this.face(si, null, loops, m, null, keys, same, fe);
  }
}

/** sub-polyline of P between the points nearest to a and b (B-rep edge between its vertices) */
function trimPolyline(P: number[][], a: number[], b: number[], tol: number): number[][] {
  const d = (p: number[], q: number[]) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
  const n = P.length;
  if (d(P[0], a) <= tol && d(P[n - 1], b) <= tol) return P;
  if (d(P[0], b) <= tol && d(P[n - 1], a) <= tol) return P;
  const near = (p: number[]) => {
    let best = 0, bd = Infinity;
    for (let i = 0; i < n - 1; i++) {
      const s = G.sub3(P[i + 1], P[i]), w = G.sub3(p, P[i]);
      const l2 = G.dot3(s, s);
      let t = l2 > 0 ? G.dot3(w, s) / l2 : 0; t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dd = Math.hypot(w[0] - s[0] * t, w[1] - s[1] * t, w[2] - s[2] * t);
      if (dd < bd) { bd = dd; best = i + t; }
    }
    return best;
  };
  const at = (x: number) => { const i = Math.min(n - 2, Math.floor(x)), t = x - i; return [P[i][0] + (P[i + 1][0] - P[i][0]) * t, P[i][1] + (P[i + 1][1] - P[i][1]) * t, P[i][2] + (P[i + 1][2] - P[i][2]) * t]; };
  let sa = near(a), sb = near(b);
  const closed = d(P[0], P[n - 1]) <= tol;
  const out: number[][] = [a];
  if (closed && Math.abs(sa - sb) < 1e-9) {
    // full closed curve starting at a
    for (let i = Math.ceil(sa); i < n - 1; i++) out.push(P[i]);
    for (let i = 0; i <= Math.floor(sa); i++) out.push(P[i]);
    out.push(a);
    return out;
  }
  if (sa <= sb) { for (let i = Math.floor(sa) + 1; i <= Math.ceil(sb) - 1; i++) out.push(P[i]); }
  else if (closed) { for (let i = Math.floor(sa) + 1; i < n - 1; i++) out.push(P[i]); for (let i = 0; i <= Math.ceil(sb) - 1; i++) out.push(P[i]); }
  else { for (let i = Math.ceil(sa) - 1; i >= Math.floor(sb) + 1; i--) out.push(P[i]); }
  void at;
  out.push(b);
  return out;
}

function xformSurface(s: Surface, m: M): Surface {
  if (G.isIdent(m)) return s;
  const im = G.inv(m);
  const q = [0, 0, 0], t = [0, 0, 0];
  return {
    ...s,
    eval(u, v, out) { s.eval(u, v, t); G.applyM(m, t, out); },
    inv(p, h) { const r = [0, 0, 0]; G.applyM(im, p, r); return s.inv(r, h); },
    singular(p) { G.applyM(im, p, q); return s.singular(q.slice()); },
    poleV: s.poleV ? (p: number[]) => { const r = [0, 0, 0]; G.applyM(im, p, r); return s.poleV!(r); } : undefined,
  };
}

/** append local mesh (model units) into acc after the world matrix */
function addMesh(acc: Acc, st: Style, local: NMesh, world: M) {
  if (!local.idx.length) return;
  let e = acc.meshes.get(st.key);
  if (!e) acc.meshes.set(st.key, (e = { st, m: nmesh() }));
  const dst = e.m;
  const base = dst.pos.length / 3;
  const w = world;
  const im = G.inv(w);
  for (let i = 0; i < local.pos.length; i += 3) {
    const x = local.pos[i], y = local.pos[i + 1], z = local.pos[i + 2];
    const X = w[0] * x + w[1] * y + w[2] * z + w[3], Y = w[4] * x + w[5] * y + w[6] * z + w[7], Z = w[8] * x + w[9] * y + w[10] * z + w[11];
    dst.pos.push(X, Y, Z);
    if (X < acc.box[0]) acc.box[0] = X; if (Y < acc.box[1]) acc.box[1] = Y; if (Z < acc.box[2]) acc.box[2] = Z;
    if (X > acc.box[3]) acc.box[3] = X; if (Y > acc.box[4]) acc.box[4] = Y; if (Z > acc.box[5]) acc.box[5] = Z;
    const nx = local.nrm[i], ny = local.nrm[i + 1], nz = local.nrm[i + 2];
    // normals: inverse transpose
    let a = im[0] * nx + im[4] * ny + im[8] * nz, b = im[1] * nx + im[5] * ny + im[9] * nz, c = im[2] * nx + im[6] * ny + im[10] * nz;
    const l = Math.hypot(a, b, c) || 1;
    a /= l; b /= l; c /= l;
    dst.nrm.push(a, b, c);
  }
  const flip = G.det3(w) < 0;
  for (let k = 0; k < local.idx.length; k += 3) {
    if (flip) dst.idx.push(base + local.idx[k], base + local.idx[k + 2], base + local.idx[k + 1]);
    else dst.idx.push(base + local.idx[k], base + local.idx[k + 1], base + local.idx[k + 2]);
  }
  acc.tris += local.idx.length / 3;
}
function addLines(acc: Acc, local: number[], world: M) {
  const w = world;
  for (let i = 0; i < local.length; i += 3) {
    const x = local[i], y = local[i + 1], z = local[i + 2];
    const X = w[0] * x + w[1] * y + w[2] * z + w[3], Y = w[4] * x + w[5] * y + w[6] * z + w[7], Z = w[8] * x + w[9] * y + w[10] * z + w[11];
    acc.edges.push(X, Y, Z);
    if (X < acc.box[0]) acc.box[0] = X; if (Y < acc.box[1]) acc.box[1] = Y; if (Z < acc.box[2]) acc.box[2] = Z;
    if (X > acc.box[3]) acc.box[3] = X; if (Y > acc.box[4]) acc.box[4] = Y; if (Z > acc.box[5]) acc.box[5] = Z;
  }
}
function addKeys(acc: Acc, local: number[], world: M) {
  const w = world;
  for (let i = 0; i < local.length; i += 3) {
    const x = local[i], y = local[i + 1], z = local[i + 2];
    acc.keys.push(w[0] * x + w[1] * y + w[2] * z + w[3], w[4] * x + w[5] * y + w[6] * z + w[7], w[8] * x + w[9] * y + w[10] * z + w[11]);
  }
}

// ------------------------------------------------------------------ main
interface Item { e: number; kind: 'surface' | 'solid' | 'group' | 'subfigure' | 'curve'; acc: Acc; name: string; level: number }

export async function readIges(
  bytes: Uint8Array,
  onProgress?: (stage: string, ratio: number) => void,
  options: IgesReadOptions = {},
): Promise<IgesReadResult> {
  try { return await readInner(bytes, onProgress, options); }
  catch (e) {
    if ((e as { code?: string }).code) throw e;
    // out of memory and other unexpected failures surface as a typed error
    throw igesError('corrupt', 'IGES read failed: ' + ((e as Error)?.message || String(e)));
  }
}

async function readInner(
  bytes: Uint8Array,
  onProgress: ((stage: string, ratio: number) => void) | undefined,
  options: IgesReadOptions,
): Promise<IgesReadResult> {
  const t0 = performance.now();
  const opts = { edges: options.edges ?? true, lod: options.lod ?? 'full', maxTriangles: options.maxTriangles ?? 20_000_000, hidden: options.hidden ?? false } as Required<Omit<IgesReadOptions, '_faceLog'>>;
  if (!bytes || bytes.length < 80) throw igesError('not-format', 'file too small for IGES');
  if (bytes.length > MAX_BYTES) throw igesError('too-large', `IGES file larger than ${MAX_BYTES >> 20} MB`);
  // binary IGES (first byte 'B' and binary records) is not supported
  if (bytes[0] === 0x42) {
    let bin = 0;
    for (let i = 0; i < Math.min(bytes.length, 4096); i++) { const c = bytes[i]; if (c < 9 || (c > 13 && c < 32) || c > 126) bin++; }
    if (bin > 40) throw igesError('unsupported-version', 'binary IGES is not supported (save as fixed 80-column ASCII IGES)');
  }
  if (!sniffIges(bytes)) {
    const L = firstLines(bytes, 1)[0] || '';
    throw igesError('not-format', L.length >= 73 ? 'not an IGES file (column 73 section letter missing)' : 'not an IGES file');
  }
  onProgress?.('index', 0);
  const f = new IgesFile(bytes, onProgress);
  const warnings: string[] = [...f.warnings];
  const gl = f.global;
  // global section fields (1-based numbering of IGES 5.3 section 2.2.4.3)
  const gs = (k: number) => (typeof gl[k - 1] === 'string' ? (gl[k - 1] as string).trim() : '');
  const gn = (k: number, d: number) => (typeof gl[k - 1] === 'number' ? (gl[k - 1] as number) : d);
  const unitFlag = gn(14, 1), unitName = gs(15).toUpperCase().replace(/^\d+H/, '');
  let unit = UNIT_FLAG[unitFlag]?.[0];
  let unitLabel = UNIT_FLAG[unitFlag]?.[1] || unitName;
  if (unitFlag === 3 || !unit) {
    const nm = unitName.replace(/[^A-Z]/g, '');
    if (UNIT_NAME[nm]) { unit = UNIT_NAME[nm]; unitLabel = nm; }
    else { unit = 0.001; unitLabel = unitName || 'unknown'; warnings.push(`unknown unit "${unitName || unitFlag}": millimetres assumed`); }
  }
  let modelScale = gn(13, 1);
  if (!(modelScale > 0)) modelScale = 1;
  const toMetre = unit / modelScale;
  if (modelScale !== 1) warnings.push(`model space scale ${modelScale} applied`);
  const R = new IgesReader(f, opts);
  if (options._faceLog) R.faceLog = options._faceLog as NonNullable<IgesReader['faceLog']>;
  R.lenScale = toMetre;
  R.tol = 1e-7 / toMetre;
  const root = new Float64Array([toMetre, 0, 0, 0, 0, toMetre, 0, 0, 0, 0, toMetre, 0]);

  // level names (406 form 3)
  const levelName = new Map<number, string>();
  for (let e = 0; e < f.n; e++) if (f.type[e] === 406 && f.form[e] === 3) {
    const a = f.P(e);
    const nm = strv(a, 2);
    if (nm) levelName.set(Math.floor(num(a, 1)), nm);
  }
  const levelOf = (e: number) => {
    const l = f.level[e];
    if (l >= 0) return l;
    const le = f.ent(-l);
    if (le >= 0 && f.type[le] === 406) return Math.floor(num(f.P(le), 1));
    return 0;
  };
  // membership: entities claimed by groups and subfigure definitions are not drawn on their own
  const claimed = new Uint8Array(f.n);
  const groupForms = new Set([1, 7, 14, 15]);
  const members = (e: number): number[] => {
    const a = f.P(e);
    if (!a) return [];
    const t = f.type[e];
    if (t === 402) { const n = Math.max(0, Math.min(a.length, Math.floor(num(a, 0)))); const out: number[] = []; for (let i = 0; i < n; i++) { const m = f.ent(num(a, 1 + i)); if (m >= 0 && m !== e) out.push(m); } return out; }
    if (t === 308) { const n = Math.max(0, Math.min(a.length, Math.floor(num(a, 2)))); const out: number[] = []; for (let i = 0; i < n; i++) { const m = f.ent(num(a, 3 + i)); if (m >= 0 && m !== e) out.push(m); } return out; }
    return [];
  };
  for (let e = 0; e < f.n; e++) {
    const t = f.type[e];
    if ((t === 402 && groupForms.has(f.form[e])) || t === 308) for (const m of members(e)) claimed[m] = 1;
  }
  onProgress?.('geometry', 0);
  const visible = (e: number) => opts.hidden || f.blank[e] !== 1;
  const drawable = (t: number) => SURFACES.has(t) || CURVES.has(t) || t === 143 || t === 144 || t === 186 || t === 408 || t === 402;
  let lastYield = performance.now();
  let capped = false;
  const tick = async (k: number) => {
    if (performance.now() - lastYield > 200) { onProgress?.('geometry', Math.min(1, k / f.n)); lastYield = performance.now(); await new Promise((r) => setTimeout(r, 0)); }
  };
  /** draw entity e into acc with placement world; inherited colour st */
  const draw = (e: number, world: M, st: Style | null, acc: Acc, depth: number, seenB: Set<string>) => {
    if (depth > 30 || e < 0) return;
    if (R.triangles + acc.tris > R.maxTriangles) { capped = true; return; }
    const t = f.type[e];
    const own = R.own(e);
    const myStyle = R.style(e) || st;
    switch (t) {
      case 144: case 143: {
        const W = own ? G.mul(world, own) : world;
        const a = f.P(e);
        if (!a) return;
        const m = nmesh(), edges: number[] = [], keys: number[] = [];
        if (t === 144) {
          const se = f.ent(num(a, 0));
          const si = R.surface(se);
          if (!si) return;
          const n1 = num(a, 1), n2 = Math.max(0, Math.floor(num(a, 2)));
          const outer = n1 === 0 ? null : R.onSurface(f.ent(num(a, 3)));
          const holes: TrimLoop[] = [];
          for (let i = 0; i < n2 && 4 + i < a.length; i++) holes.push(R.onSurface(f.ent(num(a, 4 + i))));
          R.face(si, outer && (outer.c3 || outer.uv) ? outer : null, holes.filter((h) => h.c3 || h.uv), m, edges, keys, true, e);
          addMesh(acc, R.style(e) || R.style(se) || myStyle || DEFAULT_STYLE, m, W);
        } else {
          const si = R.surface(f.ent(num(a, 1)));
          if (!si) return;
          const n = Math.max(0, Math.floor(num(a, 2)));
          const B: TrimLoop[] = [];
          for (let i = 0; i < n && 3 + i < a.length; i++) { const b = R.boundary(f.ent(num(a, 3 + i))); if (b.c3 || b.uv) B.push(b); }
          R.face(si, B[0] || null, B.slice(1), m, edges, keys, true, e);
          addMesh(acc, R.style(e) || myStyle || DEFAULT_STYLE, m, W);
        }
        addLines(acc, edges, W); addKeys(acc, keys, W);
        acc.faces++;
        return;
      }
      case 186: {
        const W = own ? G.mul(world, own) : world;
        const m = nmesh(), edges: number[] = [], keys: number[] = [];
        R.solid(e, m, edges, keys, seenB);
        addMesh(acc, myStyle || DEFAULT_STYLE, m, W);
        addLines(acc, edges, W); addKeys(acc, keys, W);
        acc.faces++;
        return;
      }
      case 408: {
        const a = f.P(e);
        const def = f.ent(num(a, 0));
        if (def < 0 || f.type[def] !== 308) { R.warn('subfigure instance without definition'); return; }
        const sc = num(a, 4, 1) || 1;
        const T = new Float64Array([sc, 0, 0, num(a, 1), 0, sc, 0, num(a, 2), 0, 0, sc, num(a, 3)]);
        let W = own ? G.mul(world, own) : world;
        W = G.mul(W, T);
        const dOwn = R.own(def);
        if (dOwn) W = G.mul(W, dOwn);
        for (const m of members(def)) if (visible(m)) draw(m, W, myStyle, acc, depth + 1, seenB);
        return;
      }
      case 402: {
        if (!groupForms.has(f.form[e])) return;
        for (const m of members(e)) if (visible(m)) draw(m, world, myStyle, acc, depth + 1, seenB);
        return;
      }
      case 108: {
        // bounded plane: its bounding curve
        if (f.form[e] === 0) { R.warn('unbounded plane (108 form 0) not drawn'); return; }
        const a = f.P(e);
        const si = R.surface(e);
        const bc = R.curve(f.ent(num(a, 4)));
        if (!si || !bc) return;
        const W = world; // own transform already in the surface and curve
        const m = nmesh(), edges: number[] = [], keys: number[] = [];
        const ownM = R.own(e);
        const c3 = ownM ? bc.map((p) => { const o = [0, 0, 0]; G.applyM(ownM, p, o); return o; }) : bc;
        R.face(si, { c3, uv: null }, [], m, edges, keys, true, e);
        addMesh(acc, myStyle || DEFAULT_STYLE, m, W);
        addLines(acc, edges, W); addKeys(acc, keys, W);
        acc.faces++;
        return;
      }
    }
    if (SURFACES.has(t)) {
      const si = R.surface(e);
      if (!si) return;
      if (!si.dom) { R.warn(`untrimmed ${TYPE_NAME[t]} (${t}) has no bounds and is not drawn`); return; }
      const m = nmesh(), edges: number[] = [], keys: number[] = [];
      R.face(si, null, [], m, edges, keys, true, e);
      addMesh(acc, myStyle || DEFAULT_STYLE, m, world);
      addLines(acc, edges, world); addKeys(acc, keys, world);
      acc.faces++;
      return;
    }
    if (CURVES.has(t)) {
      if (!opts.edges) return;
      const p = R.curve(e);
      if (!p) return;
      const seg: number[] = [];
      for (let i = 0; i < p.length - 1; i++) seg.push(p[i][0], p[i][1], p[i][2], p[i + 1][0], p[i + 1][1], p[i + 1][2]);
      addLines(acc, seg, world);
      R.wireCurves++;
      return;
    }
    if (!NOT_GEOMETRY.has(t) && t !== 116) R.unsup(t);
  };

  // top-level items
  const items: Item[] = [];
  for (let e = 0; e < f.n; e++) {
    await tick(e);
    if (R.triangles > opts.maxTriangles) { capped = true; break; }
    const t = f.type[e];
    if (!drawable(t)) { if (!NOT_GEOMETRY.has(t) && !(t >= 200 && t < 240) && t !== 116 && t !== 410 && t !== 404 && t !== 320 && t !== 0) R.unsup(t); continue; }
    if (claimed[e] || f.subord[e] === 1 || f.subord[e] === 3) continue;
    const use = f.use[e];
    if (use === 1 || use === 2 || use === 5) continue;
    if (!visible(e)) continue;
    if (t === 402 && !groupForms.has(f.form[e])) continue;
    if (t === 142) continue;
    const kind: Item['kind'] = t === 186 ? 'solid' : t === 408 ? 'subfigure' : t === 402 ? 'group' : CURVES.has(t) ? 'curve' : 'surface';
    // a group that only holds groups: one item per member group
    let parts: { de: number; st: Style | null; name: string }[] = [{ de: e, st: null, name: R.name(e) }];
    if (t === 402) {
      const mem = members(e).filter((m) => visible(m));
      if (mem.length > 1 && mem.every((m) => f.type[m] === 402 && groupForms.has(f.form[m]))) {
        const gname = R.name(e);
        parts = mem.map((m, k) => ({ de: m, st: R.style(e), name: R.name(m) || (gname ? `${gname} ${k + 1}` : '') }));
      }
    }
    for (const pt of parts) {
      const acc = newAcc();
      try { draw(pt.de, root, pt.st, acc, 0, new Set()); }
      catch (err) { if ((err as { code?: string }).code) throw err; R.warn(`entity ${t} could not be drawn`); continue; }
      R.triangles += acc.tris;
      if (!acc.tris && !acc.edges.length) continue;
      items.push({ e: pt.de, kind, acc, name: pt.name, level: levelOf(pt.de) });
    }
  }
  onProgress?.('geometry', 1);

  // ---- elements: groups (split when they only hold groups), solids, subfigure instances; loose surfaces
  // joined into bodies when they share boundary points; loose curves per level
  interface El { name: string; kind: string; accs: Acc[]; level: number }
  const els: El[] = [];
  const gbox = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  for (const it of items) for (let k = 0; k < 3; k++) { gbox[k] = Math.min(gbox[k], it.acc.box[k]); gbox[k + 3] = Math.max(gbox[k + 3], it.acc.box[k + 3]); }
  const diag = isFinite(gbox[0]) ? Math.hypot(gbox[3] - gbox[0], gbox[4] - gbox[1], gbox[5] - gbox[2]) : 1;
  let gi = 0, si = 0, fi = 0;
  const loose: Item[] = [];
  const curves = new Map<number, Acc[]>();
  for (const it of items) {
    if (it.kind === 'surface') { loose.push(it); continue; }
    if (it.kind === 'curve') { let l = curves.get(it.level); if (!l) curves.set(it.level, (l = [])); l.push(it.acc); continue; }
    if (it.kind === 'group') { els.push({ name: it.name || `Group ${++gi}`, kind: 'Groups', accs: [it.acc], level: it.level }); continue; }
    if (it.kind === 'solid') { els.push({ name: it.name || `Solid ${++si}`, kind: 'Solids', accs: [it.acc], level: it.level }); continue; }
    const def = f.ent(num(f.P(it.e), 0));
    els.push({ name: it.name || (def >= 0 ? strv(f.P(def), 1).trim() : '') || `Subfigure ${++fi}`, kind: 'Subfigures', accs: [it.acc], level: it.level });
  }
  // loose surfaces: union-find over shared boundary points
  if (loose.length) {
    const q = Math.max(diag * 1e-5, R.tol * 10 * toMetre);
    const parent = loose.map((_, i) => i);
    const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    const map = new Map<string, number>();
    loose.forEach((it, i) => {
      const K = it.acc.keys;
      for (let k = 0; k < K.length; k += 3) {
        const key = `${Math.round(K[k] / q)},${Math.round(K[k + 1] / q)},${Math.round(K[k + 2] / q)}`;
        const j = map.get(key);
        if (j === undefined) map.set(key, i);
        else { const a = find(i), b = find(j); if (a !== b) parent[a] = b; }
      }
    });
    const comps = new Map<number, Item[]>();
    loose.forEach((it, i) => { const r = find(i); let l = comps.get(r); if (!l) comps.set(r, (l = [])); l.push(it); });
    let bi = 0;
    const list = [...comps.values()];
    for (const c of list) {
      const named = c.find((x) => x.name);
      const single = c.length === 1;
      const nm = single && c[0].name ? c[0].name : list.length === 1 ? 'Surfaces' : named && c.filter((x) => x.name === named.name).length === c.length ? named.name : `Surface body ${++bi}`;
      els.push({ name: nm, kind: 'Surfaces', accs: c.map((x) => x.acc), level: c[0].level });
    }
  }
  for (const [lv, accs] of curves) els.push({ name: curves.size > 1 ? `Curves (level ${levelName.get(lv) || lv})` : 'Curves', kind: 'Curves', accs, level: lv });

  // ---- output
  let offset = [0, 0, 0];
  if (isFinite(gbox[0]) && Math.max(...gbox.map(Math.abs)) > 1e4) offset = [0, 1, 2].map((k) => Math.round((gbox[k] + gbox[k + 3]) / 2000) * 1000);
  const buckets = new Map<string, BucketAcc>();
  const edgeCats = new Map<string, F32>();
  const elements: GeomElement[] = [];
  const outBox = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  let triangles = 0, id = 0;
  const useNameCats = els.length <= 24;
  for (const el of els) {
    const eid = ++id;
    const cat = useNameCats ? el.name : el.kind;
    const ebox = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (const acc of el.accs) {
      for (const { st, m } of acc.meshes.values()) {
        const key = `${cat}|${st.key}`;
        let b = buckets.get(key);
        if (!b) { b = { categoryName: cat, color: [st.r, st.g, st.b], opacity: st.a, pos: new F32(), nrm: new F32(), idx: new U32(), edges: new F32(), ranges: [] }; buckets.set(key, b); }
        const P = new Float64Array(m.pos.length);
        for (let i = 0; i < P.length; i += 3) { P[i] = m.pos[i] - offset[0]; P[i + 1] = m.pos[i + 1] - offset[1]; P[i + 2] = m.pos[i + 2] - offset[2]; }
        triangles += emitWithNormals(b, eid, P, Float64Array.from(m.nrm), m.idx, ebox);
      }
      if (acc.edges.length) {
        let E = edgeCats.get(cat);
        if (!E) edgeCats.set(cat, (E = new F32()));
        E.reserve(acc.edges.length);
        for (let i = 0; i < acc.edges.length; i += 3) {
          const x = acc.edges[i] - offset[0], y = acc.edges[i + 1] - offset[1], z = acc.edges[i + 2] - offset[2];
          E.a[E.n++] = x; E.a[E.n++] = y; E.a[E.n++] = z;
          if (x < ebox[0]) ebox[0] = x; if (y < ebox[1]) ebox[1] = y; if (z < ebox[2]) ebox[2] = z;
          if (x > ebox[3]) ebox[3] = x; if (y > ebox[4]) ebox[4] = y; if (z > ebox[5]) ebox[5] = z;
        }
      }
    }
    if (!isFinite(ebox[0])) continue;
    for (let k = 0; k < 3; k++) { outBox[k] = Math.min(outBox[k], ebox[k]); outBox[k + 3] = Math.max(outBox[k + 3], ebox[k + 3]); }
    const lv = el.level;
    elements.push({
      id: eid, category: null, categoryName: cat, className: `IGES ${el.kind.toLowerCase().replace(/s$/, '')}`, name: el.name,
      typeName: el.kind, familyName: null, levelId: lv || null, levelName: lv ? levelName.get(lv) || `Level ${lv}` : null,
      bbox: { min: [ebox[0], ebox[1], ebox[2]], max: [ebox[3], ebox[4], ebox[5]] },
    });
  }
  const outBuckets: GeomBucket[] = [];
  for (const b of buckets.values()) {
    if (!b.idx.n) continue;
    const gb: GeomBucket = { category: null, categoryName: b.categoryName, color: b.color, positions: b.pos.done(), normals: b.nrm.done(), indices: b.idx.done(), ranges: b.ranges };
    if (b.opacity < 1) gb.opacity = b.opacity;
    outBuckets.push(gb);
  }
  const outEdges = [...edgeCats].map(([cat, E]) => ({ category: null, categoryName: cat, positions: E.done() }));
  if (offset[0] || offset[1] || offset[2]) warnings.push(`coordinates shifted by -(${offset.join(', ')}) m to keep float precision (info.originOffset)`);
  if (!triangles && R.wireCurves) warnings.push(`wireframe only: ${R.wireCurves} curves drawn as lines, no surfaces in the file`);
  if (R.faceFallback) R.warn(`${R.faceFallback} curved faces could not be mapped to their surface parameters and were triangulated from their boundary only`);
  if (capped) warnings.push(`triangle limit ${opts.maxTriangles} reached: remaining entities skipped`);
  for (const [t, n] of R.unsupported) warnings.push(`${n} entities of type ${t}${TYPE_NAME[t] ? ` (${TYPE_NAME[t]})` : ''} not drawn`);
  for (const [m, n] of R.warnCounts) warnings.push(n > 1 ? `${m} (x${n})` : m);
  if (!elements.length) warnings.push('no displayable 3D geometry found');
  const ms = Math.round(performance.now() - t0);
  const bbox: BBox3 = isFinite(outBox[0]) ? { min: [outBox[0], outBox[1], outBox[2]], max: [outBox[3], outBox[4], outBox[5]] } : { min: [0, 0, 0], max: [0, 0, 0] };
  const geometry: RvtGeometry = {
    units: 'm', up: 'z', bbox, buckets: outBuckets, edges: opts.edges ? outEdges : undefined, elements,
    stats: { elements: elements.length, triangles, skippedFaces: R.faceFallback, ms }, warnings,
  };
  const counts: Record<number, number> = {};
  for (let e = 0; e < f.n; e++) counts[f.type[e]] = (counts[f.type[e]] || 0) + 1;
  const info: Record<string, string | number> = {
    format: 'IGES', version: VERSION_FLAG[gn(23, 0)] || String(gn(23, 0) || 'unknown'), entities: f.n,
    lengthUnit: unitLabel, lengthScaleToMetre: toMetre, faces: R.facesTotal, facesFromParameterCurves: R.facesUV,
    facesFromBoundaryOnly: R.faceFallback, compositeCurvesReoriented: R.reoriented, solids: R.solids, wireframeCurves: R.wireCurves, instances: elements.length, ms,
    entityTypes: Object.entries(counts).sort((a, b) => +a[0] - +b[0]).map(([t, n]) => `${t}:${n}`).join(' '),
  };
  if (gs(5)) info.originatingSystem = gs(5);
  if (gs(6)) info.preprocessor = gs(6);
  if (gs(3)) info.productId = gs(3);
  if (gs(4)) info.fileName = gs(4);
  if (gs(18)) info.timeStamp = gs(18);
  if (gs(21)) info.author = gs(21);
  if (gs(22)) info.organization = gs(22);
  if (f.start.trim()) info.description = f.start.trim().slice(0, 300);
  if (offset[0] || offset[1] || offset[2]) info.originOffset = offset.join(',');
  return { kind: '3d', geometry, info };
}

/** test hooks (not part of the API) */
export const _internals = { IgesFile, IgesReader };
