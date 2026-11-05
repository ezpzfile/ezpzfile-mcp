// STEP (ISO 10303-21) reader for AP203, AP214 (AUTOMOTIVE_DESIGN) and AP242 product data:
// B-rep solids with faces trimmed in surface parameter space, AP242 tessellated geometry,
// assemblies (NAUO + context dependent shape representations, mapped items), colours, units.
// Output: RvtGeometry (metres, Z up as stored). Clean-room implementation, see NOTEBOOK.md.
//
// Entry points: sniffStep(bytes), readStep(bytes, onProgress, options)

import { StepFile, Ref, Typed, stepError, num, str, enumv, list, refs } from './step.ts';
import type { Arg } from './step.ts';
import * as G from './geom.ts';
import type { M, Mesh } from './geom.ts';
import * as S from './surf.ts';
import type { Surface, BCurve } from './surf.ts';
import { F32, U32, emitMesh, emitWithNormals } from './mesh.ts';
import type { BucketAcc } from './mesh.ts';
import { isZip, zipEntries, zipRead } from './zip.ts';
import type { RvtGeometry, GeomBucket, GeomElement, BBox3 } from './rvt-types.ts';

export interface StepReadOptions {
  edges?: boolean;          // B-rep edges as line segments (default true)
  lod?: 'fast' | 'full';    // tessellation density (default full)
  maxTriangles?: number;    // default 20M
  hidden?: boolean;         // also draw items marked invisible (default false)
  /** test hook: receives per-face triangles (model units) for automated checks */
  _faceLog?: unknown[];
}
export interface StepTreeNode { id: number; parent: number | null; name: string; product: string; depth: number; hasGeometry: boolean }
/** RvtGeometry plus the optional assembly tree (see README.md) */
export interface StepGeometry extends RvtGeometry { tree?: StepTreeNode[] }
export interface StepReadResult { kind: '3d'; geometry: StepGeometry; info: Record<string, string | number> }

const latin1 = new TextDecoder('latin1');
const DEBUG = !!(globalThis as any).process?.env?.STEP_DEBUG;
const TWO_PI = Math.PI * 2;

// ------------------------------------------------------------------ sniffing
function headerSchema(bytes: Uint8Array): string | null {
  let i = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3;
  const head = latin1.decode(bytes.subarray(i, Math.min(bytes.length, i + 65536)));
  if (!/^\s*ISO-10303-21\s*;/.test(head)) return null;
  const m = /FILE_SCHEMA\s*\(\s*\(\s*'([^']*)'/i.exec(head);
  return m ? m[1].trim().toUpperCase() : '';
}
function isGzip(b: Uint8Array) { return b.length > 18 && b[0] === 0x1f && b[1] === 0x8b && b[2] === 8; }
/** gzip header file name (FNAME), if present */
function gzipName(b: Uint8Array): string | null {
  if (!(b[3] & 8)) return null;
  let p = 10;
  if (b[3] & 4) p += 2 + (b[10] | (b[11] << 8));
  let e = p;
  while (e < b.length && b[e]) e++;
  return latin1.decode(b.subarray(p, e));
}
const STEP_EXT = /\.(stp|step|p21)$/i;

/** STEP part/assembly file (any non-IFC schema), gzip with a .stp/.step name, or a zip holding one. */
export function sniffStep(bytes: Uint8Array): boolean {
  if (isGzip(bytes)) { const n = gzipName(bytes); return !!n && STEP_EXT.test(n); }
  if (isZip(bytes)) { try { return zipEntries(bytes).some((e) => STEP_EXT.test(e.name)); } catch { return false; } }
  const s = headerSchema(bytes);
  return s !== null && !/^IFC/.test(s);
}

/**
 * Like sniffStep, but also looks inside gzip data without a stored file name and inside zip entries
 * (decompresses only the beginning). Use when the extension is unknown.
 */
export async function sniffStepAsync(bytes: Uint8Array): Promise<boolean> {
  if (sniffStep(bytes)) return true;
  try {
    if (isGzip(bytes)) {
      const ds = new DecompressionStream('gzip');
      const w = ds.writable.getWriter();
      w.write(bytes.subarray(0, Math.min(bytes.length, 1 << 16)) as unknown as BufferSource).catch(() => {});
      w.close().catch(() => {});
      const r = ds.readable.getReader();
      let head = new Uint8Array(0);
      try {
        while (head.length < 4096) { const { value, done } = await r.read(); if (done) break; const t = new Uint8Array(head.length + value.length); t.set(head); t.set(value, head.length); head = t; }
      } catch { /* truncated input is expected */ }
      r.cancel().catch(() => {});
      const s = headerSchema(head);
      return s !== null && !/^IFC/.test(s);
    }
  } catch { /* ignore */ }
  return false;
}

async function gunzip(b: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('gzip');
  const w = ds.writable.getWriter();
  w.write(b as unknown as BufferSource).catch(() => {});
  w.close().catch(() => {});
  const r = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try { for (;;) { const { value, done } = await r.read(); if (done) break; chunks.push(value); total += value.length; } }
  catch (e) { if (!total) throw stepError('corrupt', 'gzip: ' + (e as Error).message); }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// ------------------------------------------------------------------ styles
interface Style { r: number; g: number; b: number; a: number; key: string }
function mkStyle(r: number, g: number, b: number, a: number): Style {
  const q = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 1000) / 1000;
  r = q(r); g = q(g); b = q(b); a = q(a);
  return { r, g, b, a, key: `${r},${g},${b},${a}` };
}
const DEFAULT_STYLE = mkStyle(0.74, 0.76, 0.8, 1);
const PREDEF: Record<string, [number, number, number]> = {
  black: [0, 0, 0], red: [1, 0, 0], green: [0, 1, 0], blue: [0, 0, 1], yellow: [1, 1, 0], magenta: [1, 0, 1], cyan: [0, 1, 1], white: [1, 1, 1],
};
const PREFIX: Record<string, number> = { EXA: 1e18, PETA: 1e15, TERA: 1e12, GIGA: 1e9, MEGA: 1e6, KILO: 1e3, HECTO: 1e2, DECA: 10, DECI: 0.1, CENTI: 0.01, MILLI: 1e-3, MICRO: 1e-6, NANO: 1e-9, PICO: 1e-12 };

/** geometry of a representation or item, in metres, local coordinates */
interface Part { pos: number[]; idx: number[]; nrm: number[] | null; st: Style | null; featureEdges: boolean }
interface NMesh { pos: number[]; idx: number[]; nrm: number[] }
const nmesh = (): NMesh => ({ pos: [], idx: [], nrm: [] });
/** inverse transpose of the 3x3 part (for normals) */
function normalM(m: M): M { const i = G.inv(m); const r = new Float64Array(12); r[0] = i[0]; r[1] = i[4]; r[2] = i[8]; r[4] = i[1]; r[5] = i[5]; r[6] = i[9]; r[8] = i[2]; r[9] = i[6]; r[10] = i[10]; return r; }
function xformNormals(m: M, N: number[] | Float64Array, out: number[] | Float64Array) {
  for (let i = 0; i < N.length; i += 3) {
    const x = N[i], y = N[i + 1], z = N[i + 2];
    let a = m[0] * x + m[1] * y + m[2] * z, b = m[4] * x + m[5] * y + m[6] * z, c = m[8] * x + m[9] * y + m[10] * z;
    const l = Math.hypot(a, b, c) || 1; a /= l; b /= l; c /= l;
    out[i] = a; out[i + 1] = b; out[i + 2] = c;
  }
}
interface Geo { parts: Part[]; edges: number[]; faces: number; solids: number; bodies?: { name: string; geo: Geo }[] }
const emptyGeo = (): Geo => ({ parts: [], edges: [], faces: 0, solids: 0 });
function transformGeo(g: Geo, m: M): Geo {
  const flip = G.det3(m) < 0;
  const parts = g.parts.map((p) => {
    const pos = p.pos.slice();
    G.transformPos(m, pos);
    let idx = p.idx;
    if (flip) { idx = idx.slice(); for (let i = 0; i < idx.length; i += 3) { const x = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = x; } }
    let nrm: number[] | null = null;
    if (p.nrm) { nrm = p.nrm.slice(); xformNormals(normalM(m), p.nrm, nrm); }
    return { pos, idx, nrm, st: p.st, featureEdges: p.featureEdges };
  });
  const edges = g.edges.slice();
  G.transformPos(m, edges);
  return { parts, edges, faces: g.faces, solids: g.solids };
}
function scaleM(m: M, s: number): M { const r = new Float64Array(m); r[3] *= s; r[7] *= s; r[11] *= s; return r; }

interface UVP { u: number; v: number; p: number[] | null }

// ------------------------------------------------------------------ reader
class StepReader {
  f: StepFile;
  opt: Required<StepReadOptions>;
  warnCounts = new Map<string, number>();
  lenScale = 1;   // model length unit of the main context (for tessellation density only)
  angScale = 1;
  tol = 1e-6;     // model units
  ctxUnits = new Map<number, { len: number; ang: number; lenName: string }>();
  edgeCache = new Map<number, number[][]>();
  surfCache = new Map<number, Surface | null>();
  bcurveCache = new Map<number, BCurve | null>();
  itemStyle = new Map<number, Style>();
  invisible = new Set<number>();
  repGeoCache = new Map<number, Geo>();
  faceFallback = 0;
  facesTotal = 0;
  childRepsOfOtherPd: Set<number> = new Set();
  curAngScale = 1;

  constructor(f: StepFile, opt: Required<StepReadOptions>) { this.f = f; this.opt = opt; }
  warn(m: string) { this.warnCounts.set(m, (this.warnCounts.get(m) || 0) + 1); }
  A(id: number): Arg[] { return this.f.args(id) || []; }
  T(id: number): string { return this.f.typeKey(id); }
  rid(v: Arg): number { return v instanceof Ref ? v.id : 0; }
  /** attributes of a partial of a complex instance, or of the simple instance when the type matches */
  part(id: number, name: string): Arg[] | null {
    const m = this.f.cx(id);
    if (m) return m.get(name) || null;
    return this.f.typeOf(id) === name ? this.A(id) : null;
  }

  P(v: Arg): number[] {
    const out = [0, 0, 0];
    if (v instanceof Ref) {
      const t = this.f.typeOf(v.id);
      if (t === 'CARTESIAN_POINT') this.f.point(v.id, out);
      else if (t === 'VERTEX_POINT') return this.P(this.A(v.id)[1]);
      else this.warn(`point type ${t || '(complex)'} not supported`);
    }
    return out;
  }
  D(v: Arg, def: number[] | null = null): number[] | null {
    if (!(v instanceof Ref)) return def;
    const t = this.f.typeOf(v.id);
    if (t === 'VECTOR') return this.D(this.A(v.id)[1], def);
    if (t !== 'DIRECTION') return def;
    const out = [0, 0, 0];
    this.f.point(v.id, out);
    const l = Math.hypot(out[0], out[1], out[2]);
    return l > 1e-300 ? [out[0] / l, out[1] / l, out[2] / l] : def;
  }
  frame(o: number[], z: number[], x: number[]): M {
    z = G.norm3(z);
    let xx = G.sub3(x, z.map((q) => q * G.dot3(x, z)));
    if (G.len3(xx) < 1e-9) { const alt = Math.abs(z[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]; xx = G.sub3(alt, z.map((q) => q * G.dot3(alt, z))); }
    xx = G.norm3(xx);
    return G.fromAxes(o, xx, G.cross3(z, xx), z);
  }
  axis(v: Arg): M {
    if (!(v instanceof Ref)) return G.ident();
    const t = this.f.typeOf(v.id), a = this.A(v.id);
    if (t === 'AXIS2_PLACEMENT_3D') return this.frame(this.P(a[1]), this.D(a[2], [0, 0, 1])!, this.D(a[3], [1, 0, 0])!);
    if (t === 'AXIS2_PLACEMENT_2D') { const x = this.D(a[2], [1, 0, 0])!; return this.frame(this.P(a[1]), [0, 0, 1], [x[0], x[1], 0]); }
    if (t === 'AXIS1_PLACEMENT') return this.frame(this.P(a[1]), this.D(a[2], [0, 0, 1])!, [1, 0, 0]);
    if (t.startsWith('CARTESIAN_TRANSFORMATION_OPERATOR')) return this.cto(v.id);
    this.warn(`placement ${t || '(complex)'} not supported`);
    return G.ident();
  }
  /** CARTESIAN_TRANSFORMATION_OPERATOR_3D: (name, [description,] axis1, axis2, local_origin, scale, axis3) */
  cto(id: number): M {
    const a = this.A(id);
    const o = a.length >= 7 ? 2 : 1;
    const ax1 = this.D(a[o]), ax2 = this.D(a[o + 1]);
    const org = this.P(a[o + 2]);
    const sc = a[o + 3] != null ? num(a[o + 3], 1) : 1;
    const z = this.D(a[o + 4], [0, 0, 1])!;
    let x = ax1 || (Math.abs(Math.abs(z[0]) - 1) < 1e-9 ? [0, 1, 0] : [1, 0, 0]);
    x = G.norm3(G.sub3(x, z.map((q) => q * G.dot3(x, z))));
    let y = ax2 || G.cross3(z, x);
    y = G.sub3(y, z.map((q) => q * G.dot3(y, z)));
    y = G.sub3(y, x.map((q) => q * G.dot3(y, x)));
    y = G.len3(y) < 1e-9 ? G.cross3(z, x) : G.norm3(y);
    return G.fromAxes(org, x.map((q) => q * sc), y.map((q) => q * sc), z.map((q) => q * sc));
  }

  // ------------------------------------------------------------------ units
  unitInfo(id: number, depth = 0): { kind: string; scale: number; name: string } | null {
    if (!id || depth > 6) return null;
    const m = this.f.cx(id);
    const has = (n: string) => (m ? m.has(n) : this.f.typeOf(id) === n);
    let kind = has('LENGTH_UNIT') ? 'len' : has('PLANE_ANGLE_UNIT') ? 'ang' : '';
    const si = this.part(id, 'SI_UNIT');
    if (si) {
      const off = m ? 0 : 1; // simple SI_UNIT has dimensions first
      const pre = enumv(si[off]), nm = enumv(si[off + 1]) || '';
      if (!kind) kind = nm === 'METRE' ? 'len' : nm === 'RADIAN' ? 'ang' : '';
      return { kind, scale: pre ? PREFIX[pre] ?? 1 : 1, name: ((pre || '') + nm).toLowerCase() };
    }
    const cb = this.part(id, 'CONVERSION_BASED_UNIT');
    if (cb) {
      const mw = this.rid(cb[1]);
      let mwa = this.part(mw, 'MEASURE_WITH_UNIT');
      if (!mwa) mwa = this.A(mw);
      const val = num(mwa[0], 1);
      const base = this.unitInfo(this.rid(mwa[1]), depth + 1);
      return { kind, scale: val * (base ? base.scale : 1), name: (str(cb[0]) || '').toLowerCase() };
    }
    return null;
  }
  units(ctx: number): { len: number; ang: number; lenName: string } {
    const c = this.ctxUnits.get(ctx);
    if (c) return c;
    const r = { len: this.lenScale, ang: this.angScale, lenName: '' };
    const g = this.part(ctx, 'GLOBAL_UNIT_ASSIGNED_CONTEXT');
    if (g) for (const u of refs(g[0])) {
      const ui = this.unitInfo(u);
      if (!ui) continue;
      if (ui.kind === 'len') { r.len = ui.scale; r.lenName = ui.name; }
      if (ui.kind === 'ang') r.ang = ui.scale;
    }
    this.ctxUnits.set(ctx, r);
    return r;
  }
  repArgs(rep: number): Arg[] { return this.part(rep, 'REPRESENTATION') || this.A(rep); }
  repUnits(rep: number) { const a = this.repArgs(rep); return this.units(this.rid(a[2])); }

  // ------------------------------------------------------------------ styles
  colour(v: Arg): [number, number, number] | null {
    if (!(v instanceof Ref)) return null;
    const t = this.f.typeOf(v.id), a = this.A(v.id);
    if (t === 'COLOUR_RGB') return [num(a[1]), num(a[2]), num(a[3])];
    if (t === 'DRAUGHTING_PRE_DEFINED_COLOUR') return PREDEF[(str(a[0]) || '').toLowerCase()] || null;
    return null;
  }
  /** surface colour + transparency found under a list of presentation styles */
  styleFrom(styles: Arg, depth = 0): Style | null {
    let col: [number, number, number] | null = null, tr = 0, curveCol: [number, number, number] | null = null;
    const walk = (id: number, d: number, surf: boolean) => {
      if (d > 12 || !id) return;
      const t = this.f.typeOf(id), a = this.A(id);
      switch (t) {
        case 'PRESENTATION_STYLE_ASSIGNMENT': case 'PRESENTATION_STYLE_BY_CONTEXT': for (const s of refs(a[0])) walk(s, d + 1, surf); break;
        case 'SURFACE_STYLE_USAGE': walk(this.rid(a[1]), d + 1, true); break;
        case 'SURFACE_SIDE_STYLE': for (const s of refs(a[1])) walk(s, d + 1, true); break;
        case 'SURFACE_STYLE_FILL_AREA': walk(this.rid(a[0]), d + 1, true); break;
        case 'FILL_AREA_STYLE': for (const s of refs(a[1])) walk(s, d + 1, surf); break;
        case 'FILL_AREA_STYLE_COLOUR': { const c = this.colour(a[1]); if (c && surf && !col) col = c; break; }
        case 'SURFACE_STYLE_RENDERING': case 'SURFACE_STYLE_RENDERING_WITH_PROPERTIES': {
          const c = this.colour(a[1]); if (c && !col) col = c;
          for (const p of refs(a[2])) { if (this.f.typeOf(p) === 'SURFACE_STYLE_TRANSPARENT') tr = num(this.A(p)[0]); }
          break;
        }
        case 'CURVE_STYLE': { const c = this.colour(a[3]); if (c && !curveCol) curveCol = c; break; }
      }
    };
    for (const s of refs(styles)) walk(s, depth, false);
    const c = col || null;
    return c ? mkStyle(c[0], c[1], c[2], 1 - Math.max(0, Math.min(1, tr))) : null;
  }
  readStyles() {
    for (const tn of ['STYLED_ITEM', 'OVER_RIDING_STYLED_ITEM']) for (const id of this.f.idsOfType(tn)) {
      const a = this.f.argsNoCache(id) || [];
      const item = this.rid(a[2]);
      if (!item) continue;
      const st = this.styleFrom(a[1]);
      if (st && (tn === 'OVER_RIDING_STYLED_ITEM' || !this.itemStyle.has(item))) this.itemStyle.set(item, st);
    }
    for (const id of this.f.idsOfType('INVISIBILITY')) {
      for (const it of refs(this.A(id)[0])) {
        const t = this.f.typeOf(it);
        if (t === 'STYLED_ITEM' || t === 'OVER_RIDING_STYLED_ITEM') { const x = this.rid(this.A(it)[2]); if (x) this.invisible.add(x); }
        else if (t === 'PRESENTATION_LAYER_ASSIGNMENT') for (const x of refs(this.A(it)[2])) this.invisible.add(x);
        else this.invisible.add(it);
      }
    }
  }

  // ------------------------------------------------------------------ curves
  segs(rModel: number, sweep: number): number {
    const rm = Math.abs(rModel) * this.lenScale;
    let base = rm < 0.002 ? 12 : rm < 0.01 ? 16 : rm < 0.05 ? 28 : rm < 0.2 ? 40 : rm < 1 ? 56 : 72;
    if (this.opt.lod === 'fast') base = Math.max(6, base >> 1);
    return Math.max(1, Math.ceil((base * Math.abs(sweep)) / TWO_PI - 1e-9));
  }
  segsFull(rModel: number) { return this.segs(rModel, TWO_PI); }
  bcurve(id: number): BCurve | null {
    if (this.bcurveCache.has(id)) return this.bcurveCache.get(id)!;
    let res: BCurve | null = null;
    const m = this.f.cx(id);
    let deg = 0, cps: number[] = [], closed = false, mults: number[] = [], knots: number[] = [], w: number[] | null = null, kind = '';
    if (m) {
      const b = m.get('B_SPLINE_CURVE');
      if (b) { deg = num(b[0]); cps = refs(b[1]); closed = enumv(b[3]) === 'T'; }
      const k = m.get('B_SPLINE_CURVE_WITH_KNOTS');
      if (k) { mults = list(k[0]).map((x) => num(x)); knots = list(k[1]).map((x) => num(x)); kind = 'knots'; }
      else if (m.has('BEZIER_CURVE')) kind = 'bezier';
      else if (m.has('UNIFORM_CURVE')) kind = 'uniform';
      else if (m.has('QUASI_UNIFORM_CURVE')) kind = 'quasi';
      const r = m.get('RATIONAL_B_SPLINE_CURVE');
      if (r) w = list(r[0]).map((x) => num(x, 1));
    } else {
      const t = this.f.typeOf(id), a = this.A(id);
      deg = num(a[1]); cps = refs(a[2]); closed = enumv(a[4]) === 'T';
      if (t === 'B_SPLINE_CURVE_WITH_KNOTS') { mults = list(a[6]).map((x) => num(x)); knots = list(a[7]).map((x) => num(x)); kind = 'knots'; }
      else if (t === 'BEZIER_CURVE') kind = 'bezier'; else if (t === 'UNIFORM_CURVE') kind = 'uniform'; else if (t === 'QUASI_UNIFORM_CURVE') kind = 'quasi';
    }
    const P = cps.map((c) => this.P(new Ref(c)));
    const n = P.length;
    let U: number[] = [];
    if (kind === 'knots') knots.forEach((k, i) => { for (let j = 0; j < (mults[i] || 1); j++) U.push(k); });
    else if (kind === 'bezier' || kind === 'quasi') {
      for (let i = 0; i <= deg; i++) U.push(0);
      const inner = n - deg - 1;
      for (let i = 1; i <= inner; i++) U.push(i);
      for (let i = 0; i <= deg; i++) U.push(inner + 1);
    } else if (kind === 'uniform') for (let i = 0; i < n + deg + 1; i++) U.push(i - deg);
    if (n >= 2 && deg >= 1 && U.length === n + deg + 1) res = { p: deg, P, U, W: w && w.length === n ? w : null, closed };
    else this.warn('B-spline curve with inconsistent knots');
    this.bcurveCache.set(id, res);
    return res;
  }
  sampleB(c: BCurve, t0: number, t1: number): number[][] {
    const span = Math.abs(t1 - t0), [r0, r1] = S.bcurveRange(c);
    const frac = span / (r1 - r0 || 1);
    let n = c.p === 1 ? Math.max(1, Math.round((c.P.length - 1) * frac)) : Math.ceil(Math.max(4, (c.P.length + 2) * 3) * frac);
    if (this.opt.lod === 'fast') n = Math.ceil(n / 2);
    n = Math.max(c.p === 1 ? 1 : 2, Math.min(400, n));
    const out: number[][] = [];
    for (let i = 0; i <= n; i++) { const q = [0, 0, 0]; S.bcurveEval(c, t0 + ((t1 - t0) * i) / n, q); out.push(q); }
    return out;
  }
  conic(id: number): { m: M; rx: number; ry: number } | null {
    const t = this.f.typeOf(id), a = this.A(id);
    if (t === 'CIRCLE') return { m: this.axis(a[1]), rx: num(a[2]), ry: num(a[2]) };
    if (t === 'ELLIPSE') return { m: this.axis(a[1]), rx: num(a[2]), ry: num(a[3]) };
    return null;
  }
  conicAng(c: { m: M; rx: number; ry: number }, p: number[]): number {
    const q = [0, 0, 0];
    G.applyM(G.inv(c.m), p, q);
    return Math.atan2(q[1] / (c.ry || 1), q[0] / (c.rx || 1));
  }
  conicPts(c: { m: M; rx: number; ry: number }, a0: number, sweep: number): number[][] {
    const n = this.segs(Math.max(c.rx, c.ry), sweep);
    const out: number[][] = [];
    for (let i = 0; i <= n; i++) { const t = a0 + (sweep * i) / n; const p = [0, 0, 0]; G.applyM(c.m, [c.rx * Math.cos(t), c.ry * Math.sin(t), 0], p); out.push(p); }
    return out;
  }
  /** sampled curve from point s to point e (curve direction given by sense) */
  curveBetween(cid: number, s: number[], e: number[], sense: boolean, depth = 0): number[][] {
    if (depth > 8) return [s, e];
    const t = this.T(cid);
    const a = this.A(cid);
    const closed = G.len3(G.sub3(s, e)) < this.tol;
    if (t === 'LINE') return [s, e];
    if (t === 'CIRCLE' || t === 'ELLIPSE') {
      const c = this.conic(cid)!;
      const a0 = this.conicAng(c, s);
      let sweep: number;
      if (closed) sweep = sense ? TWO_PI : -TWO_PI;
      else {
        const a1 = this.conicAng(c, e);
        if (sense) { sweep = a1 - a0; while (sweep <= 1e-12) sweep += TWO_PI; while (sweep > TWO_PI) sweep -= TWO_PI; }
        else { sweep = a1 - a0; while (sweep >= -1e-12) sweep -= TWO_PI; while (sweep < -TWO_PI) sweep += TWO_PI; }
      }
      const pts = this.conicPts(c, a0, sweep);
      pts[0] = s; pts[pts.length - 1] = e;
      return pts;
    }
    if (t === 'SURFACE_CURVE' || t === 'SEAM_CURVE' || t === 'INTERSECTION_CURVE' || t === 'BOUNDED_SURFACE_CURVE') return this.curveBetween(this.rid(a[1]), s, e, sense, depth + 1);
    if (t === 'TRIMMED_CURVE') return this.curveBetween(this.rid(a[1]), s, e, sense === (enumv(a[4]) !== 'F'), depth + 1);
    if (t === 'POLYLINE') {
      const P = refs(a[1]).map((p) => this.P(new Ref(p)));
      const near = (q: number[]) => { let bi = 0, bd = Infinity; P.forEach((p, i) => { const d = G.len3(G.sub3(p, q)); if (d < bd) { bd = d; bi = i; } }); return bi; };
      const i0 = near(s), i1 = closed ? (i0 === 0 ? P.length - 1 : i0) : near(e);
      const seg = i0 <= i1 ? P.slice(i0, i1 + 1) : P.slice(i1, i0 + 1).reverse();
      if (seg.length < 2) return [s, e];
      seg[0] = s; seg[seg.length - 1] = e;
      return seg;
    }
    if (t.includes('B_SPLINE_CURVE') || t === 'BEZIER_CURVE' || t === 'QUASI_UNIFORM_CURVE' || t === 'UNIFORM_CURVE') {
      const c = this.bcurve(cid);
      if (!c) return [s, e];
      const [r0, r1] = S.bcurveRange(c);
      let t0 = S.bcurveProject(c, s), t1 = S.bcurveProject(c, e);
      const curveClosed = G.len3(G.sub3((() => { const q = [0, 0, 0]; S.bcurveEval(c, r0, q); return q; })(), (() => { const q = [0, 0, 0]; S.bcurveEval(c, r1, q); return q; })())) < this.tol * 10;
      let pts: number[][];
      if (closed) {
        // full loop starting at s
        if (Math.abs(t0 - r0) < Math.abs(t0 - r1)) { pts = this.sampleB(c, r0, r1); } else pts = this.sampleB(c, r1, r0);
        if (!sense) pts.reverse();
        if (Math.abs(t0 - r0) > (r1 - r0) * 1e-6 && Math.abs(t0 - r1) > (r1 - r0) * 1e-6) {
          const a1 = this.sampleB(c, t0, r1), a2 = this.sampleB(c, r0, t0);
          pts = [...a1, ...a2.slice(1)];
          if (!sense) pts.reverse();
        }
      } else if (curveClosed && ((sense && t1 < t0) || (!sense && t1 > t0))) {
        pts = sense ? [...this.sampleB(c, t0, r1), ...this.sampleB(c, r0, t1).slice(1)] : [...this.sampleB(c, t0, r0), ...this.sampleB(c, r1, t1).slice(1)];
      } else pts = this.sampleB(c, t0, t1);
      void t0; void t1;
      pts[0] = s; pts[pts.length - 1] = e;
      return pts;
    }
    if (t === 'PCURVE') { this.warn('PCURVE edge geometry drawn as straight segments'); return [s, e]; }
    if (t === 'COMPOSITE_CURVE') { this.warn('composite edge curve approximated by its end points'); return [s, e]; }
    this.warn(`edge curve ${t || '(complex)'} not supported (straight segment used)`);
    return [s, e];
  }
  edgePts(ec: number): number[][] {
    const c = this.edgeCache.get(ec);
    if (c) return c;
    const a = this.A(ec);
    const s = this.P(a[1]), e = this.P(a[2]);
    let pts: number[][];
    try { pts = this.f.typeOf(ec) === 'EDGE_CURVE' ? this.curveBetween(this.rid(a[3]), s, e, enumv(a[4]) !== 'F') : [s, e]; }
    catch (err) { this.warn(`edge sampling failed: ${(err as Error).message}`); pts = [s, e]; }
    this.edgeCache.set(ec, pts);
    return pts;
  }
  /** full polyline of a profile curve (for revolution / extrusion surfaces) */
  curveFull(cid: number, depth = 0): number[][] | null {
    if (depth > 8 || !cid) return null;
    const t = this.T(cid), a = this.A(cid);
    if (t === 'LINE') { const p = this.P(a[1]); const d = this.D(a[2], [1, 0, 0])!; const L = 1e5; return [[p[0] - d[0] * L, p[1] - d[1] * L, p[2] - d[2] * L], [p[0] + d[0] * L, p[1] + d[1] * L, p[2] + d[2] * L]]; }
    if (t === 'CIRCLE' || t === 'ELLIPSE') return this.conicPts(this.conic(cid)!, 0, TWO_PI);
    if (t === 'POLYLINE') return refs(a[1]).map((p) => this.P(new Ref(p)));
    if (t === 'TRIMMED_CURVE') {
      const basis = this.rid(a[1]);
      const tr = (v: Arg) => { for (const x of list(v)) { if (x instanceof Ref) return { pt: this.P(x), par: null as number | null }; if (x instanceof Typed) return { pt: null, par: num(x.val) }; if (typeof x === 'number') return { pt: null, par: x }; } return { pt: null, par: null }; };
      const t1 = tr(a[2]), t2 = tr(a[3]);
      const bt = this.T(basis);
      if ((bt === 'CIRCLE' || bt === 'ELLIPSE')) {
        const c = this.conic(basis)!;
        const a1 = t1.pt ? this.conicAng(c, t1.pt) : (t1.par || 0) * this.curAngScale;
        let a2 = t2.pt ? this.conicAng(c, t2.pt) : (t2.par || 0) * this.curAngScale;
        const sense = enumv(a[4]) !== 'F';
        if (sense) { while (a2 <= a1) a2 += TWO_PI; } else { while (a2 >= a1) a2 -= TWO_PI; }
        return this.conicPts(c, a1, a2 - a1);
      }
      if (bt === 'LINE' && t1.par != null && t2.par != null) {
        const la = this.A(basis); const p = this.P(la[1]); const va = this.A(this.rid(la[2])); const d = this.D(va[1], [1, 0, 0])!; const mg = num(va[2], 1);
        return [t1.par, t2.par].map((q) => [p[0] + d[0] * mg * q, p[1] + d[1] * mg * q, p[2] + d[2] * mg * q]);
      }
      if (t1.pt && t2.pt) return this.curveBetween(basis, t1.pt, t2.pt, enumv(a[4]) !== 'F', depth + 1);
      return this.curveFull(basis, depth + 1);
    }
    if (t.includes('B_SPLINE_CURVE') || t === 'BEZIER_CURVE') { const c = this.bcurve(cid); if (!c) return null; const [r0, r1] = S.bcurveRange(c); return this.sampleB(c, r0, r1); }
    if (t === 'SURFACE_CURVE' || t === 'SEAM_CURVE') return this.curveFull(this.rid(a[1]), depth + 1);
    this.warn(`profile curve ${t || '(complex)'} not supported`);
    return null;
  }

  // ------------------------------------------------------------------ surfaces
  surface(id: number): Surface | null {
    if (this.surfCache.has(id)) return this.surfCache.get(id)!;
    let s: Surface | null = null;
    try { s = this.makeSurface(id); } catch (e) { this.warn(`surface failed: ${(e as Error).message}`); }
    this.surfCache.set(id, s);
    return s;
  }
  makeSurface(id: number, depth = 0): Surface | null {
    if (depth > 5) return null;
    const t = this.T(id), a = this.A(id);
    switch (t) {
      case 'PLANE': return S.planeSurface(this.axis(a[1]));
      case 'CYLINDRICAL_SURFACE': { const r = num(a[2]); return S.cylinderSurface(this.axis(a[1]), r, this.segsFull(r)); }
      case 'CONICAL_SURFACE': { const r = num(a[2]); return S.coneSurface(this.axis(a[1]), r, num(a[3]) * this.curAngScale, this.segsFull(Math.max(r, 1e-3 / this.lenScale))); }
      case 'SPHERICAL_SURFACE': { const r = num(a[2]); return S.sphereSurface(this.axis(a[1]), r, this.segsFull(r)); }
      case 'TOROIDAL_SURFACE': case 'DEGENERATE_TOROIDAL_SURFACE': {
        const R = num(a[2]), r = num(a[3]);
        return S.torusSurface(this.axis(a[1]), R, r, this.segsFull(R + Math.abs(r)), this.segsFull(Math.abs(r)));
      }
      case 'SURFACE_OF_REVOLUTION': {
        const prof = this.curveFull(this.rid(a[1]));
        if (!prof || prof.length < 2) return null;
        const ax = this.A(this.rid(a[2]));
        let rmax = 0;
        const o = this.P(ax[1]), d = this.D(ax[2], [0, 0, 1])!;
        for (const p of prof) { const w = G.sub3(p, o); const s2 = G.dot3(w, d); rmax = Math.max(rmax, G.len3(G.sub3(w, d.map((q) => q * s2)))); }
        return S.revolutionSurface(prof, o, d, this.segsFull(rmax));
      }
      case 'SURFACE_OF_LINEAR_EXTRUSION': {
        const prof = this.curveFull(this.rid(a[1]));
        if (!prof || prof.length < 2) return null;
        const d = this.D(a[2], [0, 0, 1])!;
        return S.extrusionSurface(prof, d);
      }
      case 'OFFSET_SURFACE': { const b = this.makeSurface(this.rid(a[1]), depth + 1); return b ? S.offsetSurface(b, num(a[2])) : null; }
      case 'RECTANGULAR_TRIMMED_SURFACE': case 'CURVE_BOUNDED_SURFACE': return this.makeSurface(this.rid(a[1]), depth + 1);
    }
    if (t.includes('B_SPLINE_SURFACE') || t === 'BEZIER_SURFACE') return this.bsurface(id);
    this.warn(`surface ${t || '(complex)'} not supported`);
    return null;
  }
  bsurface(id: number): Surface | null {
    const m = this.f.cx(id);
    let pu = 0, pv = 0, cps: Arg[] = [], uc = false, vc = false, um: number[] = [], vm: number[] = [], uk: number[] = [], vk: number[] = [], W: number[][] | null = null;
    let kind = 'knots';
    if (m) {
      const b = m.get('B_SPLINE_SURFACE');
      if (!b) return null;
      pu = num(b[0]); pv = num(b[1]); cps = list(b[2]); uc = enumv(b[4]) === 'T'; vc = enumv(b[5]) === 'T';
      const k = m.get('B_SPLINE_SURFACE_WITH_KNOTS');
      if (k) { um = list(k[0]).map((x) => num(x)); vm = list(k[1]).map((x) => num(x)); uk = list(k[2]).map((x) => num(x)); vk = list(k[3]).map((x) => num(x)); }
      else kind = m.has('BEZIER_SURFACE') ? 'bezier' : m.has('UNIFORM_SURFACE') ? 'uniform' : 'quasi';
      const r = m.get('RATIONAL_B_SPLINE_SURFACE');
      if (r) W = list(r[0]).map((row) => list(row).map((x) => num(x, 1)));
    } else {
      const t = this.f.typeOf(id), a = this.A(id);
      pu = num(a[1]); pv = num(a[2]); cps = list(a[3]); uc = enumv(a[5]) === 'T'; vc = enumv(a[6]) === 'T';
      if (t === 'B_SPLINE_SURFACE_WITH_KNOTS') { um = list(a[8]).map((x) => num(x)); vm = list(a[9]).map((x) => num(x)); uk = list(a[10]).map((x) => num(x)); vk = list(a[11]).map((x) => num(x)); }
      else kind = t === 'BEZIER_SURFACE' ? 'bezier' : t === 'UNIFORM_SURFACE' ? 'uniform' : 'quasi';
    }
    const P = cps.map((row) => refs(row).map((c) => this.P(new Ref(c))));
    const nu = P.length, nv = P[0]?.length || 0;
    const expand = (mults: number[], ks: number[], n: number, p: number) => {
      const U: number[] = [];
      if (kind === 'knots') { ks.forEach((k, i) => { for (let j = 0; j < (mults[i] || 1); j++) U.push(k); }); return U; }
      if (kind === 'uniform') { for (let i = 0; i < n + p + 1; i++) U.push(i - p); return U; }
      for (let i = 0; i <= p; i++) U.push(0);
      const inner = n - p - 1;
      for (let i = 1; i <= inner; i++) U.push(i);
      for (let i = 0; i <= p; i++) U.push(inner + 1);
      return U;
    };
    const U = expand(um, uk, nu, pu), V = expand(vm, vk, nv, pv);
    if (nu < 2 || nv < 2 || U.length !== nu + pu + 1 || V.length !== nv + pv + 1) { this.warn('B-spline surface with inconsistent knots'); return null; }
    return S.bsplineSurface({ pu, pv, P, U, V, W: W && W.length === nu ? W : null }, uc, vc);
  }

  // ------------------------------------------------------------------ faces
  /** tessellate one face into mesh m (model units); pushes B-rep edge segments into edges */
  face(fid: number, m: NMesh, edges: number[], edgeSeen: Set<number>) {
    const t = this.f.typeOf(fid), a = this.A(fid);
    this.facesTotal++;
    this.curFace = fid;
    let surfId = 0, same = true;
    if (t === 'ADVANCED_FACE' || t === 'FACE_SURFACE') { surfId = this.rid(a[2]); same = enumv(a[3]) !== 'F'; }
    else if (t !== 'FACE') { this.warn(`face type ${t || '(complex)'} not supported`); return; }
    const loops: { pts: number[][]; outer: boolean; vertexLoop: boolean }[] = [];
    const use = new Map<number, number>();
    for (const b of refs(a[1])) {
      const ba = this.A(b);
      const lid = this.rid(ba[1]);
      const lt = this.f.typeOf(lid), la = this.A(lid);
      let pts: number[][] = [];
      let vertexLoop = false;
      if (lt === 'EDGE_LOOP') {
        for (const oe of refs(la[1])) {
          const oa = this.A(oe);
          let ec = this.rid(oa[3]), ori = enumv(oa[4]) !== 'F';
          if (this.f.typeOf(oe) === 'EDGE_CURVE') { ec = oe; ori = true; }
          use.set(ec, (use.get(ec) || 0) + 1);
          let ep = this.edgePts(ec);
          if (!ori) ep = ep.slice().reverse();
          for (let i = 0; i < ep.length - 1; i++) pts.push(ep[i]);
        }
      } else if (lt === 'POLY_LOOP') pts = refs(la[1]).map((p) => this.P(new Ref(p)));
      else if (lt === 'VERTEX_LOOP') { pts = [this.P(la[1])]; vertexLoop = true; }
      else { this.warn(lt ? `loop ${lt} not supported` : 'reference to a missing loop (truncated or broken file)'); continue; }
      if (enumv(ba[2]) === 'F') pts.reverse();
      // drop consecutive duplicates
      const clean: number[][] = [];
      for (const p of pts) if (!clean.length || G.len3(G.sub3(clean[clean.length - 1], p)) > this.tol) clean.push(p);
      while (clean.length > 1 && G.len3(G.sub3(clean[0], clean[clean.length - 1])) <= this.tol) clean.pop();
      loops.push({ pts: clean, outer: this.f.typeOf(b) === 'FACE_OUTER_BOUND', vertexLoop });
    }
    // edges (seams, used twice in this face, are not drawn)
    if (this.opt.edges) for (const [ec, n] of use) {
      if (n > 1 || edgeSeen.has(ec)) continue;
      const g = this.rid(this.A(ec)[3]);
      if (g && this.T(g) === 'SEAM_CURVE') continue;
      edgeSeen.add(ec);
      const ep = this.edgePts(ec);
      for (let i = 0; i < ep.length - 1; i++) edges.push(ep[i][0], ep[i][1], ep[i][2], ep[i + 1][0], ep[i + 1][1], ep[i + 1][2]);
    }
    const real = loops.filter((l) => !l.vertexLoop && l.pts.length >= 2);
    if (!real.length) return;
    const surf = surfId ? this.surface(surfId) : null;
    const i0 = m.idx.length;
    if (!surf || surf.kind === 'plane') this.planarFace(real, m, surf, same);
    else if (!this.curvedFace(surf, real, m, same)) { this.faceFallback++; this.planarFace(real, m, null, same); }
    if (this.faceLog) {
      // test hook (options._faceLog): triangles of this face in model units
      const pos: number[] = [], nrm: number[] = [];
      for (let k = i0; k < m.idx.length; k++) { const v = m.idx[k]; pos.push(m.pos[3 * v], m.pos[3 * v + 1], m.pos[3 * v + 2]); nrm.push(m.nrm[3 * v], m.nrm[3 * v + 1], m.nrm[3 * v + 2]); }
      this.faceLog.push({ solid: this.curSolid, fid, kind: surf ? surf.kind : 'none', same, tri: pos, nrm, loops: real.map((l) => ({ outer: l.outer, pts: l.pts })), surf });
    }
  }
  curSolid = 0;
  selfIntersecting = 0;
  faceLog: { solid: number; fid: number; kind: string; same: boolean; tri: number[]; nrm: number[]; loops: { outer: boolean; pts: number[][] }[]; surf: Surface | null }[] | null = null;
  planarFace(loops: { pts: number[][]; outer: boolean }[], m: NMesh, surf: Surface | null, same: boolean) {
    const L = loops.filter((l) => l.pts.length >= 3);
    if (!L.length) return;
    let oi = L.findIndex((l) => l.outer);
    const flat = (l: { pts: number[][] }) => { const o: number[] = []; for (const p of l.pts) o.push(p[0], p[1], p[2]); return o; };
    if (surf) {
      const uv = L.map((l) => { const o: number[] = []; for (const p of l.pts) { const r = surf.inv(p, null); o.push(r[0], r[1]); } return o; });
      // the outer boundary encloses all other loops, so it is the largest one (some writers flag a hole as FACE_OUTER_BOUND)
      if (L.length > 1) { let best = -1; uv.forEach((l, i) => { const ar = Math.abs(G.area2(l)); if (ar > best) { best = ar; oi = i; } }); }
      if (oi < 0) oi = 0;
      const holes = uv.filter((_, i) => i !== oi);
      const tri = G.triangulate(uv[oi], holes);
      // a self-intersecting loop (sliver face sampled coarser than its width) makes ear clipping cover
      // area outside the face: detect by area and fill with the even-odd rule instead
      const allUV = [uv[oi], ...holes].flat();
      let triArea = 0;
      for (let k = 0; k < tri.length; k += 3) { const a = tri[k], b = tri[k + 1], c = tri[k + 2]; triArea += Math.abs((allUV[2 * b] - allUV[2 * a]) * (allUV[2 * c + 1] - allUV[2 * a + 1]) - (allUV[2 * c] - allUV[2 * a]) * (allUV[2 * b + 1] - allUV[2 * a + 1])) / 2; }
      const expected = Math.abs(G.area2(uv[oi])) - holes.reduce((q, h) => q + Math.abs(G.area2(h)), 0);
      if (triArea > Math.abs(expected) * 1.02 + 1e-9 * Math.abs(G.area2(uv[oi]))) {
        const eo = G.evenOddFill(uv);
        const nn2 = [0, 0, 0], tp = [0, 0, 0];
        this.snormal(surf, 0, 0, same, nn2);
        const b0 = m.pos.length / 3;
        for (let i = 0; i < eo.pts.length; i += 2) { surf.eval(eo.pts[i], eo.pts[i + 1], tp); m.pos.push(tp[0], tp[1], tp[2]); m.nrm.push(nn2[0], nn2[1], nn2[2]); }
        for (let k = 0; k < eo.tri.length; k += 3) {
          if (same) m.idx.push(b0 + eo.tri[k], b0 + eo.tri[k + 1], b0 + eo.tri[k + 2]);
          else m.idx.push(b0 + eo.tri[k], b0 + eo.tri[k + 2], b0 + eo.tri[k + 1]);
        }
        this.selfIntersecting++;
        return;
      }
      const all = [L[oi], ...L.filter((_, i) => i !== oi)].flatMap((l) => l.pts);
      const base = m.pos.length / 3;
      const nn = [0, 0, 0];
      this.snormal(surf, 0, 0, same, nn);
      for (const p of all) { m.pos.push(p[0], p[1], p[2]); m.nrm.push(nn[0], nn[1], nn[2]); }
      for (let k = 0; k < tri.length; k += 3) {
        if (same) m.idx.push(base + tri[k], base + tri[k + 1], base + tri[k + 2]);
        else m.idx.push(base + tri[k], base + tri[k + 2], base + tri[k + 1]);
      }
      return;
    }
    if (L.length > 1 || oi < 0) { let best = -1; L.forEach((l, i) => { const n = G.len3(G.newell(flat(l))); if (n > best) { best = n; oi = i; } }); }
    const outer = flat(L[oi]), holes = L.filter((_, i) => i !== oi).map(flat);
    const tri = G.triangulate3D(outer, holes);
    const base = m.pos.length / 3;
    const nn = G.norm3(G.newell(outer));
    for (const v of outer) m.pos.push(v);
    for (const h of holes) for (const v of h) m.pos.push(v);
    for (let i = m.nrm.length; i < m.pos.length; i += 3) m.nrm.push(nn[0], nn[1], nn[2]);
    for (let k = 0; k < tri.length; k++) m.idx.push(base + tri[k]);
  }
  /** trimmed curved face: loops mapped to (u,v), seams and poles handled, refined on a grid */
  curvedFace(s: Surface, loops: { pts: number[][]; outer: boolean }[], m: NMesh, same: boolean): boolean {
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (const l of loops) for (const p of l.pts) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); z0 = Math.min(z0, p[2]); z1 = Math.max(z1, p[2]); }
    // the boundary only has to be mapped to (u,v); points stay exact. Accept edges lying off the surface by up to 3% of the face size
    const maxRes = Math.max(this.tol * 1000, Math.hypot(x1 - x0, y1 - y0, z1 - z0) * 0.03);
    const uvLoops: { pts: UVP[]; outer: boolean; ku: number; kv: number }[] = [];
    for (const l of loops) {
      const out: UVP[] = [];
      let hint: number[] | null = null;
      const sing: boolean[] = [];
      for (const p of l.pts) {
        if (s.singular(p)) { out.push({ u: NaN, v: NaN, p }); sing.push(true); continue; }
        const r = s.inv(p, hint);
        if (!(r[2] <= maxRes) || !isFinite(r[0]) || !isFinite(r[1])) { if (DEBUG) console.error('FAIL inv', s.kind, '#' + this.curFace, r[2], maxRes); return false; }
        let u = r[0], v = r[1];
        if (hint) {
          if (s.perU) u += Math.round((hint[0] - u) / s.perU) * s.perU;
          if (s.perV) v += Math.round((hint[1] - v) / s.perV) * s.perV;
        }
        hint = [u, v];
        out.push({ u, v, p }); sing.push(false);
      }
      // poles: replace by two points at the pole parameter, using neighbours' u
      if (sing.some((x) => x)) {
        const fixed: UVP[] = [];
        const n = out.length;
        for (let i = 0; i < n; i++) {
          if (!sing[i]) { fixed.push(out[i]); continue; }
          let a = (i - 1 + n) % n, b = (i + 1) % n;
          while (sing[a] && a !== i) a = (a - 1 + n) % n;
          while (sing[b] && b !== i) b = (b + 1) % n;
          if (sing[a] || sing[b]) { if (DEBUG) console.error('FAIL sing', s.kind, '#' + this.curFace); return false; }
          const pv = s.poleV ? s.poleV(out[i].p!) : NaN;
          const vv = isFinite(pv) ? pv : (out[a].v + out[b].v) / 2;
          let ub = out[b].u;
          if (s.perU) ub += Math.round((out[a].u - ub) / s.perU) * s.perU;
          fixed.push({ u: out[a].u, v: vv, p: out[i].p }, { u: ub, v: vv, p: out[i].p });
        }
        // re-unwrap after insertion
        for (let i = 1; i < fixed.length; i++) if (s.perU) fixed[i].u += Math.round((fixed[i - 1].u - fixed[i].u) / s.perU) * s.perU;
        out.length = 0; out.push(...fixed);
      }
      if (out.length < 2) continue;
      const first = out[0], last = out[out.length - 1];
      // closing step: the first point seen again after the last one
      let cu = first.u, cv = first.v;
      if (s.perU) cu += Math.round((last.u - first.u) / s.perU) * s.perU;
      if (s.perV) cv += Math.round((last.v - first.v) / s.perV) * s.perV;
      const ku = s.perU ? Math.round((cu - first.u) / s.perU) : 0;
      const kv = s.perV ? Math.round((cv - first.v) / s.perV) : 0;
      // a wrapping loop keeps its closing point explicitly (it is a different (u,v) than the start)
      if (ku || kv) out.push({ u: cu, v: cv, p: first.p });
      uvLoops.push({ pts: out, outer: l.outer, ku, kv });
    }
    if (!uvLoops.length) return true;
    const keep = same !== s.flip;
    // build the domain
    const wrapU = uvLoops.filter((l) => l.ku !== 0), wrapV = uvLoops.filter((l) => l.kv !== 0 && l.ku === 0);
    let outer: UVP[] | null = null;
    let holes: UVP[][] = [];
    const rest = uvLoops.filter((l) => l.ku === 0 && l.kv === 0);
    const pairWrap = (W: typeof uvLoops, axis: 'u' | 'v'): UVP[] | null => {
      const per = axis === 'u' ? s.perU : s.perV;
      const k = (l: (typeof uvLoops)[0]) => (axis === 'u' ? l.ku : l.kv);
      if (W.length >= 2) {
        const A = W[0];
        let B = W[1];
        let bp = B.pts.slice(0, -1); // without its closing duplicate
        if (Math.sign(k(A)) === Math.sign(k(B))) bp.reverse();
        const aEnd = A.pts[A.pts.length - 1][axis];
        // rotate B to start near aEnd (mod per)
        let bi = 0, bd = Infinity;
        bp.forEach((q, i) => { const d = Math.abs((((q[axis] - aEnd) % per) + per * 1.5) % per - per / 2); if (d < bd) { bd = d; bi = i; } });
        bp = [...bp.slice(bi), ...bp.slice(0, bi)];
        // re-unwrap B continuously, then shift so it starts at aEnd
        for (let i = 1; i < bp.length; i++) bp[i] = { ...bp[i], [axis]: bp[i][axis] + Math.round((bp[i - 1][axis] - bp[i][axis]) / per) * per };
        const sh = Math.round((aEnd - bp[0][axis]) / per) * per;
        bp = bp.map((q) => ({ ...q, [axis]: q[axis] + sh }));
        { const b0 = bp[0], bl = bp[bp.length - 1]; const kk = Math.round((bl[axis] - b0[axis]) / per); bp.push({ ...b0, [axis]: b0[axis] + kk * per }); }
        if (W.length > 2) this.warn('face with more than two periodic boundary loops: extra loops ignored');
        return [...A.pts, ...bp];
      }
      if (W.length === 1) {
        const A = W[0];
        if (axis !== 'u' || !s.poleV) return null;
        // region side: left of the loop in (u,v) when keep, right otherwise
        const dir = Math.sign(k(A));
        const up = (dir > 0) === keep;
        let pv: number;
        if (s.kind === 'sphere' || s.kind.endsWith('sphere')) pv = up ? Math.PI / 2 : -Math.PI / 2;
        else pv = s.poleV(A.pts[0].p!);
        if (!isFinite(pv)) return null;
        const f = A.pts[0], l = A.pts[A.pts.length - 1];
        return [...A.pts, { u: l.u, v: pv, p: null }, { u: f.u, v: pv, p: null }];
      }
      return null;
    };
    if (wrapU.length) { outer = pairWrap(wrapU, 'u'); if (!outer) { if (DEBUG) console.error('FAIL wrapU', s.kind, '#' + this.curFace, wrapU.length, uvLoops.length); return false; } }
    else if (wrapV.length) { outer = pairWrap(wrapV, 'v'); if (!outer) { if (DEBUG) console.error('FAIL wrapV', s.kind, '#' + this.curFace, wrapV.length); return false; } }
    else {
      let oi = rest.findIndex((l) => l.outer);
      if (oi < 0 || rest.length > 1) {
        let best = -1;
        rest.forEach((l, i) => { const ar = Math.abs(G.area2(l.pts.flatMap((q) => [q.u, q.v]))); if (ar > best) { best = ar; oi = i; } });
      }
      outer = rest[oi].pts;
      rest.splice(oi, 1);
    }
    holes = rest.map((l) => l.pts);
    // shift holes into the outer's parameter range
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const q of outer) { u0 = Math.min(u0, q.u); u1 = Math.max(u1, q.u); v0 = Math.min(v0, q.v); v1 = Math.max(v1, q.v); }
    holes = holes.map((h) => {
      let cu = 0, cv = 0;
      for (const q of h) { cu += q.u; cv += q.v; }
      cu /= h.length; cv /= h.length;
      const su = s.perU ? Math.round(((u0 + u1) / 2 - cu) / s.perU) * s.perU : 0;
      const sv = s.perV ? Math.round(((v0 + v1) / 2 - cv) / s.perV) * s.perV : 0;
      return su || sv ? h.map((q) => ({ u: q.u + su, v: q.v + sv, p: q.p })) : h;
    });
    let nu = Math.max(1, s.stepsU(u1 - u0)), nv = s.ruledV ? 1 : Math.max(1, s.stepsV(v1 - v0));
    if (nu * nv > 16384) { const k = Math.sqrt(16384 / (nu * nv)); nu = Math.max(1, Math.floor(nu * k)); nv = Math.max(1, Math.floor(nv * k)); }
    const t0i = m.idx.length;
    this.gridTess(s, outer, holes.filter((h) => h.length >= 3), nu, nv, m, keep);
    if (DEBUG) console.error('face', s.kind, '#' + this.curFace, 'loops', uvLoops.map((l) => `${l.pts.length}/${l.ku}/${l.kv}`).join(' '), 'u', (u1 - u0).toFixed(3), 'v', (v1 - v0).toFixed(3), 'nu', nu, 'nv', nv, 'tris', (m.idx.length - t0i) / 3);
    return true;
  }
  /** surface normal at (u,v): Su x Sv of our mapping, oriented as the face (keep = same !== flip) */
  snormal(s: Surface, u: number, v: number, same: boolean, out: number[], keepArg?: boolean) {
    const keep = keepArg ?? (same !== s.flip);
    const A = this.nA, B = this.nB;
    const hu = 1e-6 * Math.max(1, Math.abs(u)), hv = 1e-6 * Math.max(1, Math.abs(v));
    s.eval(u + hu, v, A); s.eval(u - hu, v, B);
    const sx = A[0] - B[0], sy = A[1] - B[1], sz = A[2] - B[2];
    s.eval(u, v + hv, A); s.eval(u, v - hv, B);
    const tx = A[0] - B[0], ty = A[1] - B[1], tz = A[2] - B[2];
    let nx = sy * tz - sz * ty, ny = sz * tx - sx * tz, nz = sx * ty - sy * tx;
    let l = Math.hypot(nx, ny, nz);
    if (!(l > 1e-30 * (1 + Math.abs(A[0]) + Math.abs(A[1]) + Math.abs(A[2])) ** 2) || !(l > 0)) {
      // degenerate (pole / collapsed row): take the normal slightly inside the patch
      const sv = v > 0 ? -1e-3 : 1e-3, su = u > 0 ? -1e-3 : 1e-3; // step towards the inside of the parameter range first
      for (const [ou, ov] of [[0, sv], [su, 0], [su, sv], [0, -sv], [-su, 0], [-su, -sv]]) {
        const uu = u + ou * Math.max(1, Math.abs(u)), vv = v + ov * Math.max(1, Math.abs(v));
        s.eval(uu + hu, vv, A); s.eval(uu - hu, vv, B);
        const ax = A[0] - B[0], ay = A[1] - B[1], az = A[2] - B[2];
        s.eval(uu, vv + hv, A); s.eval(uu, vv - hv, B);
        const bx = A[0] - B[0], by = A[1] - B[1], bz = A[2] - B[2];
        nx = ay * bz - az * by; ny = az * bx - ax * bz; nz = ax * by - ay * bx;
        l = Math.hypot(nx, ny, nz);
        if (l > 1e-30) break;
      }
      if (!(l > 0)) { nx = 0; ny = 0; nz = 1; l = 1; }
    }
    const sg = keep ? 1 / l : -1 / l;
    out[0] = nx * sg; out[1] = ny * sg; out[2] = nz * sg;
  }
  nA = [0, 0, 0]; nB = [0, 0, 0];
  curFace = 0;
  gridTess(s: Surface, outer: UVP[], holes: UVP[][], nu: number, nv: number, m: NMesh, keep: boolean) {
    const flat = (L: UVP[]) => { const o: number[] = []; for (const q of L) o.push(q.u, q.v); return o; };
    const all = [outer, ...holes].flat();
    const { pts, ring } = G.bridged(flat(outer), holes.map(flat));
    const tmp = [0, 0, 0], nn = [0, 0, 0];
    const vert = (q: UVP) => {
      const i = m.pos.length / 3;
      if (q.p) m.pos.push(q.p[0], q.p[1], q.p[2]);
      else { s.eval(q.u, q.v, tmp); m.pos.push(tmp[0], tmp[1], tmp[2]); }
      this.snormal(s, q.u, q.v, keep !== s.flip ? true : false, nn, keep);
      m.nrm.push(nn[0], nn[1], nn[2]);
      return i;
    };
    const emit = (L: UVP[], tri: number[]) => {
      const ids = L.map(vert);
      for (let k = 0; k < tri.length; k += 3) {
        if (keep) m.idx.push(ids[tri[k]], ids[tri[k + 1]], ids[tri[k + 2]]);
        else m.idx.push(ids[tri[k]], ids[tri[k + 2]], ids[tri[k + 1]]);
      }
    };
    if (nu * nv <= 1) {
      const tri = G.earClipRing(pts, ring);
      const ids = all.map(vert);
      for (let k = 0; k < tri.length; k += 3) {
        if (keep) m.idx.push(ids[tri[k]], ids[tri[k + 1]], ids[tri[k + 2]]);
        else m.idx.push(ids[tri[k]], ids[tri[k + 2]], ids[tri[k + 1]]);
      }
      return;
    }
    const poly: UVP[] = ring.map((i) => all[i]);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const q of poly) { u0 = Math.min(u0, q.u); u1 = Math.max(u1, q.u); v0 = Math.min(v0, q.v); v1 = Math.max(v1, q.v); }
    const du = (u1 - u0) / nu || 1, dv = (v1 - v0) / nv || 1;
    const marked = new Uint8Array(nu * nv);
    const n = poly.length;
    const ci = (u: number) => Math.max(0, Math.min(nu - 1, Math.floor((u - u0) / du)));
    const cj = (v: number) => Math.max(0, Math.min(nv - 1, Math.floor((v - v0) / dv)));
    for (let i = 0; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n];
      const i0 = ci(Math.min(a.u, b.u)), i1 = ci(Math.max(a.u, b.u)), j0 = cj(Math.min(a.v, b.v)), j1 = cj(Math.max(a.v, b.v));
      for (let x = i0; x <= i1; x++) for (let y = j0; y <= j1; y++) marked[x * nv + y] = 1;
    }
    const inside = (u: number, v: number) => {
      let c = false;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const a = poly[i], b = poly[j];
        if ((a.v > v) !== (b.v > v) && u < ((b.u - a.u) * (v - a.v)) / (b.v - a.v) + a.u) c = !c;
      }
      return c;
    };
    const clip = (P: UVP[], axis: 'u' | 'v', val: number, keepGreater: boolean): UVP[] => {
      const out: UVP[] = [];
      const k = P.length;
      for (let i = 0; i < k; i++) {
        const a = P[i], b = P[(i + 1) % k];
        const ia = keepGreater ? a[axis] >= val : a[axis] <= val, ib = keepGreater ? b[axis] >= val : b[axis] <= val;
        if (ia) out.push(a);
        if (ia !== ib) {
          const t = (val - a[axis]) / (b[axis] - a[axis]);
          out.push({ u: a.u + (b.u - a.u) * t, v: a.v + (b.v - a.v) * t, p: null });
        }
      }
      return out;
    };
    for (let x = 0; x < nu; x++) for (let y = 0; y < nv; y++) {
      const ua = u0 + x * du, ub = x === nu - 1 ? u1 : ua + du, va = v0 + y * dv, vb = y === nv - 1 ? v1 : va + dv;
      if (!marked[x * nv + y]) {
        if (inside((ua + ub) / 2, (va + vb) / 2)) {
          emit([{ u: ua, v: va, p: null }, { u: ub, v: va, p: null }, { u: ub, v: vb, p: null }, { u: ua, v: vb, p: null }], [0, 1, 2, 0, 2, 3]);
        }
        continue;
      }
      let c = clip(poly, 'u', ua, true);
      if (c.length >= 3) c = clip(c, 'u', ub, false);
      if (c.length >= 3) c = clip(c, 'v', va, true);
      if (c.length >= 3) c = clip(c, 'v', vb, false);
      if (c.length < 3) continue;
      const fl = flat(c);
      if (Math.abs(G.area2(fl)) < du * dv * 1e-9) continue;
      let tri = G.triangulate(fl);
      let L = c;
      // the (u,v) -> xyz map bends: a triangle that is fine in (u,v) can fold in 3D next to a curved
      // boundary. If it does, try a fan around the cell polygon's centroid and keep the better one.
      const f1 = this.folds(s, L, tri, keep);
      if (f1 > 0) {
        let cu = 0, cv = 0;
        for (const q of c) { cu += q.u; cv += q.v; }
        const cen: UVP = { u: cu / c.length, v: cv / c.length, p: null };
        const L2 = [...c, cen];
        const ccw = G.area2(fl) > 0;
        const t2: number[] = [];
        for (let i = 0; i < c.length; i++) { const j = (i + 1) % c.length; if (ccw) t2.push(i, j, c.length); else t2.push(j, i, c.length); }
        if (this.folds(s, L2, t2, keep) < f1 && inside(cen.u, cen.v)) { L = L2; tri = t2; }
      }
      emit(L, tri);
    }
  }
  /** number of triangles (CCW in (u,v)) whose 3D winding opposes the surface normal */
  folds(s: Surface, L: UVP[], tri: number[], keep: boolean): number {
    const P = L.map((q) => { if (q.p) return q.p; const o = [0, 0, 0]; s.eval(q.u, q.v, o); return o; });
    const n = [0, 0, 0];
    let k = 0;
    for (let i = 0; i < tri.length; i += 3) {
      const a = P[tri[i]], b = P[tri[i + 1]], c = P[tri[i + 2]];
      const g = G.cross3(G.sub3(b, a), G.sub3(c, a));
      if (G.dot3(g, g) === 0) continue;
      const q = L[tri[i]], r = L[tri[i + 1]], t = L[tri[i + 2]];
      this.snormal(s, (q.u + r.u + t.u) / 3, (q.v + r.v + t.v) / 3, true, n, true);
      if (G.dot3(g, n) < 0) k++;
    }
    void keep;
    return k;
  }

  // ------------------------------------------------------------------ items and representations
  shellFaces(shell: number, m: NMesh, edges: number[], seen: Set<number>, stylesOut: Map<number, NMesh>) {
    const t = this.f.typeOf(shell), a = this.A(shell);
    let faces: number[] = [];
    if (t === 'CLOSED_SHELL' || t === 'OPEN_SHELL' || t === 'CONNECTED_FACE_SET') faces = refs(a[1]);
    else if (t === 'ORIENTED_CLOSED_SHELL' || t === 'ORIENTED_OPEN_SHELL') { this.shellFaces(this.rid(a[2]), m, edges, seen, stylesOut); return; }
    else { this.warn(`shell ${t || '(complex)'} not supported`); return; }
    for (const fc of faces) {
      const st = this.itemStyle.get(fc);
      let target = m;
      if (st) { const k = fc; void k; let mm = stylesOut.get(fcKey(st)); if (!mm) { mm = nmesh(); stylesOut.set(fcKey(st), mm); styleByKey.set(fcKey(st), st); } target = mm; }
      try { this.face(fc, target, edges, seen); }
      catch (e) { this.warn(`face failed: ${(e as Error).message}`); }
    }
  }
  /** tessellate a representation item into a Geo (model units of its representation) */
  item(id: number, depth: number, repScale: number): Geo {
    const g = emptyGeo();
    if (depth > 20 || this.invisible.has(id) && !this.opt.hidden) return g;
    const t = this.f.typeOf(id), a = this.A(id);
    const own = this.itemStyle.get(id) || null;
    const brep = (shells: number[]) => {
      this.curSolid = id;
      const m = nmesh();
      const edges: number[] = [];
      const seen = new Set<number>();
      const byStyle = new Map<number, NMesh>();
      for (const sh of shells) {
        const shStyle = this.itemStyle.get(sh);
        if (shStyle && shStyle !== own) {
          const sub = nmesh();
          this.shellFaces(sh, sub, edges, seen, byStyle);
          if (sub.idx.length) g.parts.push({ pos: sub.pos, idx: sub.idx, nrm: sub.nrm, st: shStyle, featureEdges: false });
        } else this.shellFaces(sh, m, edges, seen, byStyle);
      }
      if (m.idx.length) g.parts.push({ pos: m.pos, idx: m.idx, nrm: m.nrm, st: own, featureEdges: false });
      for (const [k, mm] of byStyle) if (mm.idx.length) g.parts.push({ pos: mm.pos, idx: mm.idx, nrm: mm.nrm, st: styleByKey.get(k)!, featureEdges: false });
      for (const v of edges) g.edges.push(v);
      g.solids++;
    };
    switch (t) {
      case 'MANIFOLD_SOLID_BREP': case 'FACETED_BREP': brep([this.rid(a[1])]); break;
      case 'BREP_WITH_VOIDS': case 'FACETED_BREP_AND_BREP_WITH_VOIDS': brep([this.rid(a[1]), ...refs(a[2])]); break;
      case 'SHELL_BASED_SURFACE_MODEL': brep(refs(a[1])); break;
      case 'FACE_BASED_SURFACE_MODEL': brep(refs(a[1])); break;
      case 'CLOSED_SHELL': case 'OPEN_SHELL': brep([id]); break;
      case 'TESSELLATED_SOLID': case 'TESSELLATED_SHELL': {
        for (const it of refs(a[1])) { const sub = this.item(it, depth + 1, repScale); for (const p of sub.parts) { if (!p.st) p.st = own; g.parts.push(p); } }
        g.solids++;
        break;
      }
      case 'TRIANGULATED_FACE': case 'COMPLEX_TRIANGULATED_FACE': case 'TRIANGULATED_SURFACE_SET': case 'COMPLEX_TRIANGULATED_SURFACE_SET': {
        const m = this.tessFace(t, a);
        if (m.idx.length) g.parts.push({ pos: m.pos, idx: m.idx, nrm: null, st: own, featureEdges: true });
        break;
      }
      case 'MAPPED_ITEM': {
        const src = this.A(this.rid(a[1]));
        const mrep = this.rid(src[1]);
        if (this.childRepsOfOtherPd.has(mrep)) break; // placed through the product structure
        const childGeo = this.rep(mrep, depth + 1);
        const cs = this.repUnits(mrep).len;
        const origin = scaleM(this.axis(src[0]), cs);
        const target = scaleM(this.axis(a[2]), repScale);
        const tm = G.mul(target, G.inv(origin));
        const tg = transformGeo(childGeo, tm);
        g.bodies = (childGeo.bodies || []).map((b) => ({ name: b.name, geo: transformGeo(b.geo, tm) }));
        for (const p of tg.parts) { if (!p.st) p.st = own; g.parts.push(p); }
        for (const v of tg.edges) g.edges.push(v);
        g.solids += tg.solids;
        return g; // already in metres
      }
      case 'GEOMETRIC_CURVE_SET': case 'GEOMETRIC_SET': case 'AXIS2_PLACEMENT_3D': case 'TESSELLATED_CURVE_SET': case 'TESSELLATED_GEOMETRIC_SET':
      case 'CARTESIAN_POINT': case 'TESSELLATED_POINT_SET': case 'PLANAR_BOX': case 'CAMERA_MODEL_D3': case 'COMPOSITE_CURVE': case 'TRIMMED_CURVE': case 'POLYLINE':
        return g;
      case '': {
        const k = this.T(id);
        if (k.includes('MANIFOLD_SOLID_BREP') || k.includes('BREP_WITH_VOIDS')) {
          const mm = this.f.cx(id)!;
          const b = mm.get('MANIFOLD_SOLID_BREP');
          const v = mm.get('BREP_WITH_VOIDS');
          brep([...(b ? [this.rid(b[0])] : []), ...(v ? refs(v[0]) : [])]);
        } else if (k) this.warn(`representation item ${k} not supported`);
        break;
      }
      default:
        this.warn(`representation item ${t} not supported`);
    }
    // convert model units -> metres
    if (repScale !== 1) {
      for (const p of g.parts) for (let i = 0; i < p.pos.length; i++) p.pos[i] *= repScale;
      for (let i = 0; i < g.edges.length; i++) g.edges[i] *= repScale;
    }
    return g;
  }
  tessFace(t: string, a: Arg[]): Mesh {
    const cl = this.A(this.rid(a[1]));
    const coords = list(cl[2]);
    const pos: number[] = [];
    for (const c of coords) { const l = list(c); pos.push(num(l[0]), num(l[1]), num(l[2])); }
    const nv = pos.length / 3;
    const face = t === 'TRIANGULATED_FACE' || t === 'COMPLEX_TRIANGULATED_FACE';
    const pnIdx = list(a[face ? 5 : 4]).map((x) => num(x));
    const map = (k: number) => { const j = pnIdx.length ? (pnIdx[k - 1] ?? 0) : k; return j - 1; };
    const idx: number[] = [];
    const tri = (i0: number, i1: number, i2: number) => {
      if (i0 === i1 || i1 === i2 || i0 === i2) return;
      const a0 = map(i0), a1 = map(i1), a2 = map(i2);
      if (a0 < 0 || a1 < 0 || a2 < 0 || a0 >= nv || a1 >= nv || a2 >= nv) return;
      idx.push(a0, a1, a2);
    };
    if (t === 'TRIANGULATED_FACE' || t === 'TRIANGULATED_SURFACE_SET') {
      for (const tr of list(a[face ? 6 : 5])) { const l = list(tr).map((x) => num(x)); tri(l[0], l[1], l[2]); }
    } else {
      for (const st of list(a[face ? 6 : 5])) {
        const l = list(st).map((x) => num(x));
        for (let i = 0; i + 2 < l.length; i++) { if (i % 2 === 0) tri(l[i], l[i + 1], l[i + 2]); else tri(l[i + 1], l[i], l[i + 2]); }
      }
      for (const fn of list(a[face ? 7 : 6])) {
        const l = list(fn).map((x) => num(x));
        for (let i = 1; i + 1 < l.length; i++) tri(l[0], l[i], l[i + 1]);
      }
    }
    return { pos, idx };
  }
  /** geometry of a representation, in metres, in the representation's own coordinates (cached) */
  rep(id: number, depth = 0): Geo {
    const c = this.repGeoCache.get(id);
    if (c) return c;
    const g = emptyGeo();
    if (depth > 20) return g;
    const ra = this.repArgs(id);
    const u = this.units(this.rid(ra[2]));
    const saveAng = this.curAngScale;
    this.curAngScale = u.ang;
    const repStyle = this.itemStyle.get(id) || null;
    g.bodies = [];
    for (const it of refs(ra[1])) {
      let sub: Geo;
      try { sub = this.item(it, depth + 1, u.len); }
      catch (e) { this.warn(`item failed: ${(e as Error).message}`); continue; }
      for (const p of sub.parts) { if (!p.st) p.st = repStyle; g.parts.push(p); }
      for (const v of sub.edges) g.edges.push(v);
      g.solids += sub.solids;
      if (sub.parts.length) {
        if (sub.bodies && sub.bodies.length) for (const b of sub.bodies) g.bodies.push(b);
        else g.bodies.push({ name: str(this.A(it)[0]) || '', geo: sub });
      }
    }
    this.curAngScale = saveAng;
    this.repGeoCache.set(id, g);
    return g;
  }
}
const styleByKey = new Map<number, Style>();
const styleIds = new Map<string, number>();
function fcKey(st: Style): number { let k = styleIds.get(st.key); if (k === undefined) { k = styleIds.size + 1; styleIds.set(st.key, k); } return k; }

// ------------------------------------------------------------------ main
const PROTOCOLS: [RegExp, string][] = [
  [/^AP242|MANAGED_MODEL_BASED_3D_ENGINEERING/, 'AP242'],
  [/^AUTOMOTIVE_DESIGN|^AP214/, 'AP214'],
  [/^CONFIG_CONTROL_DESIGN|^AP203/, 'AP203'],
  [/^STRUCTURAL_ANALYSIS_DESIGN/, 'AP209'],
];

export async function readStep(
  bytes: Uint8Array,
  onProgress?: (stage: string, ratio: number) => void,
  options: StepReadOptions = {},
): Promise<StepReadResult> {
  const t0 = performance.now();
  const opt = { edges: options.edges ?? true, lod: options.lod ?? 'full', maxTriangles: options.maxTriangles ?? 20_000_000, hidden: options.hidden ?? false } as Required<StepReadOptions>;
  let container = 'step';
  if (isGzip(bytes)) { onProgress?.('unzip', 0); bytes = await gunzip(bytes); container = 'stpz (gzip)'; }
  else if (isZip(bytes)) {
    const e = zipEntries(bytes).find((x) => STEP_EXT.test(x.name) && !x.name.startsWith('__MACOSX'));
    if (!e) throw stepError('not-format', 'zip archive without a STEP file');
    bytes = await zipRead(bytes, e);
    container = 'zip';
  }
  const schemaH = headerSchema(bytes);
  if (schemaH === null) throw stepError('not-format', 'not an ISO 10303-21 file');
  if (/^IFC/.test(schemaH)) throw stepError('not-format', 'this is an IFC file (use the IFC reader)');
  onProgress?.('index', 0);
  let f: StepFile;
  try { f = new StepFile(bytes, onProgress); }
  catch (e) { if ((e as { code?: string }).code) throw e; throw stepError('corrupt', 'STEP parse failed: ' + (e as Error).message); }
  const warnings: string[] = [...f.warnings];
  const schema = (f.header.schemas[0] || '').toUpperCase();
  const protocol = PROTOCOLS.find(([re]) => re.test(schema))?.[1] || schema || 'unknown';
  if (protocol === schema) warnings.push(`schema ${schema} is not AP203/AP214/AP242; reading B-rep geometry anyway`);
  const R = new StepReader(f, opt);
  if (options._faceLog) R.faceLog = options._faceLog as NonNullable<StepReader['faceLog']>;
  // main units: first geometric context
  for (const k of [...f.idsOfType(''), ...f.idsOfType('GEOMETRIC_REPRESENTATION_CONTEXT')]) {
    if (!R.part(k, 'GLOBAL_UNIT_ASSIGNED_CONTEXT')) continue;
    const u = R.units(k);
    R.lenScale = u.len; R.angScale = u.ang;
    R.ctxUnits.clear();
    break;
  }
  R.curAngScale = R.angScale;
  R.tol = 1e-7 / R.lenScale;
  onProgress?.('styles', 0);
  R.readStyles();

  // ---- product structure
  const relArgs = (id: number) => f.argsNoCache(id) || [];
  const pdName = new Map<number, string>();
  const productOfPd = (pd: number) => {
    const a = R.A(pd);
    const form = R.A(R.rid(a[2]));
    const prod = R.rid(form[2]);
    const pa = R.A(prod);
    return { name: str(pa[1]) || str(pa[0]) || '', id: str(pa[0]) || '', product: prod };
  };
  const repsOfPd = new Map<number, number[]>();
  const pdOfRep = new Map<number, number>();
  for (const id of f.idsOfType('SHAPE_DEFINITION_REPRESENTATION')) {
    const a = relArgs(id);
    const pds = R.rid(a[0]);
    const rep = R.rid(a[1]);
    if (!pds || !rep) continue;
    const def = R.rid(R.A(pds)[2]);
    if (!def) continue;
    const dt = f.typeOf(def);
    if (dt !== 'PRODUCT_DEFINITION' && dt !== 'PRODUCT_DEFINITION_WITH_ASSOCIATED_DOCUMENTS' && dt !== '') continue;
    let l = repsOfPd.get(def); if (!l) repsOfPd.set(def, (l = [])); l.push(rep);
    pdOfRep.set(rep, def);
  }
  // plain shape representation relationships (no transformation)
  const plain = new Map<number, number[]>();
  const transRel: number[] = [];
  const addPlain = (x: number, y: number) => { let l = plain.get(x); if (!l) plain.set(x, (l = [])); l.push(y); };
  for (const id of f.idsOfType('SHAPE_REPRESENTATION_RELATIONSHIP', 'REPRESENTATION_RELATIONSHIP')) { const a = relArgs(id); addPlain(R.rid(a[2]), R.rid(a[3])); addPlain(R.rid(a[3]), R.rid(a[2])); }
  for (const id of f.idsOfType('')) {
    const m = f.cx(id);
    if (!m || !m.has('REPRESENTATION_RELATIONSHIP')) continue;
    if (m.has('REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION')) { transRel.push(id); continue; }
    const a = m.get('REPRESENTATION_RELATIONSHIP')!;
    addPlain(R.rid(a[2]), R.rid(a[3])); addPlain(R.rid(a[3]), R.rid(a[2]));
  }
  /** all reps holding geometry of a PD: its own reps plus plainly related ones not owned by other PDs */
  const geomReps = (pd: number): number[] => {
    const out: number[] = [];
    const seen = new Set<number>();
    const stack = [...(repsOfPd.get(pd) || [])];
    while (stack.length) {
      const r = stack.pop()!;
      if (seen.has(r)) continue;
      seen.add(r);
      const owner = pdOfRep.get(r);
      if (owner !== undefined && owner !== pd) continue;
      out.push(r);
      for (const n of plain.get(r) || []) stack.push(n);
    }
    return out;
  };
  // NAUOs and their transforms
  interface Use { nauo: number; child: number; name: string; m: M | null }
  const children = new Map<number, Use[]>();
  const isChild = new Set<number>();
  const nauoUse = new Map<number, Use>();
  for (const id of f.idsOfType('NEXT_ASSEMBLY_USAGE_OCCURRENCE', 'ASSEMBLY_COMPONENT_USAGE', 'SPECIFIED_HIGHER_USAGE_OCCURRENCE')) {
    if (f.typeOf(id) === 'SPECIFIED_HIGHER_USAGE_OCCURRENCE') continue;
    const a = relArgs(id);
    const parent = R.rid(a[3]), child = R.rid(a[4]);
    if (!parent || !child) continue;
    const u: Use = { nauo: id, child, name: str(a[1]) || str(a[0]) || '', m: null };
    let l = children.get(parent); if (!l) children.set(parent, (l = [])); l.push(u);
    isChild.add(child);
    nauoUse.set(id, u);
  }
  for (const pd of isChild) for (const r of repsOfPd.get(pd) || []) R.childRepsOfOtherPd.add(r);
  // context dependent shape representations
  for (const id of f.idsOfType('CONTEXT_DEPENDENT_SHAPE_REPRESENTATION')) {
    const a = relArgs(id);
    const rr = R.rid(a[0]), pds = R.rid(a[1]);
    const nauo = R.rid(R.A(pds)[2]);
    const use = nauoUse.get(nauo);
    if (!use || !rr) continue;
    const rel = R.part(rr, 'REPRESENTATION_RELATIONSHIP');
    const wt = R.part(rr, 'REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION');
    if (!rel || !wt) continue;
    const rep1 = R.rid(rel[2]), rep2 = R.rid(rel[3]);
    const op = R.rid(wt[0]);
    const childSet = new Set(geomReps(use.child));
    for (const r of repsOfPd.get(use.child) || []) childSet.add(r);
    const childIs1 = childSet.has(rep1) || (!childSet.has(rep2));
    const s1 = R.repUnits(rep1).len, s2 = R.repUnits(rep2).len;
    let mm: M;
    if (f.typeOf(op) === 'ITEM_DEFINED_TRANSFORMATION') {
      const ia = R.A(op);
      const A1 = scaleM(R.axis(ia[2]), s1), A2 = scaleM(R.axis(ia[3]), s2);
      mm = childIs1 ? G.mul(A2, G.inv(A1)) : G.mul(A1, G.inv(A2));
    } else {
      const parentScale = childIs1 ? s2 : s1;
      mm = scaleM(R.cto(op), parentScale);
      if (!childIs1) mm = G.inv(mm);
    }
    use.m = mm;
  }
  // NAUOs without CDSR: look for a mapped item in the parent's representation that maps the child's representation
  for (const [parent, uses] of children) {
    const pending = uses.filter((u) => !u.m);
    if (!pending.length) continue;
    const prs = geomReps(parent);
    const mapped: { rep: number; m: M }[] = [];
    for (const pr of prs) {
      const ps = R.repUnits(pr).len;
      for (const it of refs(R.repArgs(pr)[1])) {
        if (f.typeOf(it) !== 'MAPPED_ITEM') continue;
        const a = R.A(it), src = R.A(R.rid(a[1]));
        const mrep = R.rid(src[1]);
        const cs = R.repUnits(mrep).len;
        mapped.push({ rep: mrep, m: G.mul(scaleM(R.axis(a[2]), ps), G.inv(scaleM(R.axis(src[0]), cs))) });
      }
    }
    for (const u of pending) {
      const cr = new Set(geomReps(u.child));
      const k = mapped.findIndex((x) => cr.has(x.rep));
      if (k >= 0) { u.m = mapped[k].m; mapped.splice(k, 1); }
      else { u.m = G.ident(); R.warn('assembly component without placement (identity used)'); }
    }
  }
  // roots
  let roots = [...repsOfPd.keys(), ...children.keys()].filter((pd, i, arr) => arr.indexOf(pd) === i && !isChild.has(pd));
  const pdList = f.idsOfType('PRODUCT_DEFINITION');
  if (!roots.length && pdList.length) roots = pdList.filter((pd) => !isChild.has(pd));

  // ---- instance tree and output
  const buckets = new Map<string, BucketAcc>();
  const elements: GeomElement[] = [];
  const tree: StepTreeNode[] = [];
  const gbox = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  let triangles = 0, capped = false, instances = 0, solids = 0;
  const partsWithGeo = new Set<number>();
  let nodeId = 0;
  let lastYield = performance.now();
  const emit = (g: Geo, world: M, node: number, cat: string, name: string, levelName: string | null, levelId: number | null, typeName: string, familyName: string | null) => {
    const ebox = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    let et = 0;
    let firstBucket: BucketAcc | null = null;
    const flip = G.det3(world) < 0;
    for (const p of g.parts) {
      if (!p.idx.length) continue;
      const st = p.st || DEFAULT_STYLE;
      const key = `${cat}|${st.key}`;
      let b = buckets.get(key);
      if (!b) { b = { categoryName: cat, color: [st.r, st.g, st.b], opacity: st.a, pos: new F32(), nrm: new F32(), idx: new U32(), edges: new F32(), ranges: [] }; buckets.set(key, b); }
      if (!firstBucket) firstBucket = b;
      const P = new Float64Array(p.pos.length);
      for (let i = 0; i < P.length; i += 3) {
        const x = p.pos[i], y = p.pos[i + 1], z = p.pos[i + 2];
        P[i] = world[0] * x + world[1] * y + world[2] * z + world[3];
        P[i + 1] = world[4] * x + world[5] * y + world[6] * z + world[7];
        P[i + 2] = world[8] * x + world[9] * y + world[10] * z + world[11];
      }
      let I: number[] = p.idx;
      if (flip) { I = I.slice(); for (let i = 0; i < I.length; i += 3) { const t = I[i + 1]; I[i + 1] = I[i + 2]; I[i + 2] = t; } }
      if (p.nrm && p.nrm.length === p.pos.length) {
        const N = new Float64Array(p.nrm.length);
        xformNormals(normalM(world), p.nrm, N);
        et += emitWithNormals(b, node, P, N, I, ebox);
      } else et += emitMesh(b, node, P, I, opt.edges && p.featureEdges, ebox);
    }
    if (!et) return 0;
    if (opt.edges && g.edges.length && firstBucket) {
      const E = firstBucket.edges;
      E.reserve(g.edges.length);
      for (let i = 0; i < g.edges.length; i += 3) {
        const x = g.edges[i], y = g.edges[i + 1], z = g.edges[i + 2];
        E.a[E.n++] = world[0] * x + world[1] * y + world[2] * z + world[3];
        E.a[E.n++] = world[4] * x + world[5] * y + world[6] * z + world[7];
        E.a[E.n++] = world[8] * x + world[9] * y + world[10] * z + world[11];
      }
    }
    triangles += et;
    for (let k = 0; k < 3; k++) { gbox[k] = Math.min(gbox[k], ebox[k]); gbox[k + 3] = Math.max(gbox[k + 3], ebox[k + 3]); }
    elements.push({ id: node, category: null, categoryName: cat, className: 'STEP part', name, typeName, familyName, levelId, levelName, bbox: { min: [ebox[0], ebox[1], ebox[2]], max: [ebox[3], ebox[4], ebox[5]] } });
    return et;
  };
  const totalUses = Math.max(1, nauoUse.size + roots.length);
  const visit = async (pd: number, world: M, parent: number | null, path: string[], instName: string, cat: string | null, depth: number) => {
    if (depth > 30) { R.warn('assembly deeper than 30 levels (cycle?)'); return; }
    if (triangles > opt.maxTriangles) { capped = true; return; }
    const pr = productOfPd(pd);
    const id = ++nodeId;
    const label = pr.name || instName || `#${pd}`;
    const node: StepTreeNode = { id, parent, name: instName || label, product: label, depth, hasGeometry: false };
    tree.push(node);
    instances++;
    if (performance.now() - lastYield > 200) { onProgress?.('geometry', Math.min(1, instances / totalUses)); lastYield = performance.now(); await Promise.resolve(); }
    let category = cat ?? label;
    const bodies: { name: string; geo: Geo }[] = [];
    for (const r of geomReps(pd)) for (const b of R.rep(r).bodies || []) bodies.push(b);
    const levelName = path.length ? path.join(' / ') : null;
    const fam = pr.id && pr.id !== label ? pr.id : null;
    if (bodies.length === 1) {
      const n = emit(bodies[0].geo, world, id, category, node.name, levelName, parent, label, fam);
      if (n) { node.hasGeometry = true; partsWithGeo.add(pd); solids += bodies[0].geo.solids; }
    } else if (bodies.length > 1) {
      // multi-body part: one element per body, as children of the part node
      let k = 0;
      for (const b of bodies) {
        k++;
        const bid = ++nodeId;
        const bname = b.name && !/^(none|)$/i.test(b.name) ? b.name : `${label} body ${k}`;
        const bnode: StepTreeNode = { id: bid, parent: id, name: bname, product: label, depth: depth + 1, hasGeometry: false };
        tree.push(bnode);
        const bcat = cat ?? (children.get(pd)?.length || bodies.length > 24 ? label : bname); // keep the bucket count low
        const n = emit(b.geo, world, bid, bcat, bname, [...path, label].join(' / '), id, label, fam);
        if (n) { bnode.hasGeometry = true; node.hasGeometry = true; partsWithGeo.add(pd); solids += b.geo.solids; }
      }
      void category;
    }
    category = cat ?? label;
    for (const u of children.get(pd) || []) {
      const cw = G.mul(world, u.m || G.ident());
      await visit(u.child, cw, id, [...path, label], u.name, depth === 0 ? null : category, depth + 1);
    }
  };
  onProgress?.('geometry', 0);
  if (roots.length) {
    for (const r of roots) await visit(r, G.ident(), null, [], '', null, 0);
  } else {
    // no product structure: every shape representation with solids
    R.warn('no product structure: all shape representations drawn');
    for (const rid of f.idsOfType('ADVANCED_BREP_SHAPE_REPRESENTATION', 'MANIFOLD_SURFACE_SHAPE_REPRESENTATION', 'FACETED_BREP_SHAPE_REPRESENTATION', 'SHAPE_REPRESENTATION', 'TESSELLATED_SHAPE_REPRESENTATION')) {
      const g = R.rep(rid);
      if (!g.parts.length) continue;
      const id = ++nodeId;
      const nm = str(R.repArgs(rid)[0]) || `#${rid}`;
      tree.push({ id, parent: null, name: nm, product: nm, depth: 0, hasGeometry: true });
      emit(g, G.ident(), id, nm, nm, null, null, nm, null);
      solids += g.solids;
    }
  }
  if (!elements.length) {
    // broken or truncated file: draw the solids found anywhere
    const items = f.idsOfType('MANIFOLD_SOLID_BREP', 'BREP_WITH_VOIDS', 'FACETED_BREP', 'SHELL_BASED_SURFACE_MODEL', 'TESSELLATED_SOLID', 'TESSELLATED_SHELL', 'TRIANGULATED_SURFACE_SET', 'COMPLEX_TRIANGULATED_SURFACE_SET');
    if (items.length) R.warn('representations not reachable: solids drawn without product structure');
    for (const it of items) {
      let g: Geo;
      try { g = R.item(it, 0, R.lenScale); } catch { continue; }
      if (!g.parts.length) continue;
      const id = ++nodeId;
      const nm = str(R.A(it)[0]) || `#${it}`;
      tree.push({ id, parent: null, name: nm, product: nm, depth: 0, hasGeometry: true });
      emit(g, G.ident(), id, 'solids', nm, null, null, nm, null);
      solids += g.solids;
    }
  }
  onProgress?.('geometry', 1);

  // ---- output
  // far coordinates: shift
  let offset = [0, 0, 0];
  if (isFinite(gbox[0]) && Math.max(...gbox.map(Math.abs)) > 1e4) {
    offset = [0, 1, 2].map((k) => Math.round((gbox[k] + gbox[k + 3]) / 2000) * 1000);
    for (const b of buckets.values()) {
      for (let i = 0; i < b.pos.n; i += 3) { b.pos.a[i] -= offset[0]; b.pos.a[i + 1] -= offset[1]; b.pos.a[i + 2] -= offset[2]; }
      for (let i = 0; i < b.edges.n; i += 3) { b.edges.a[i] -= offset[0]; b.edges.a[i + 1] -= offset[1]; b.edges.a[i + 2] -= offset[2]; }
    }
    for (const e of elements) if (e.bbox) for (let k = 0; k < 3; k++) { e.bbox.min[k] -= offset[k]; e.bbox.max[k] -= offset[k]; }
    for (let k = 0; k < 3; k++) { gbox[k] -= offset[k]; gbox[k + 3] -= offset[k]; }
    warnings.push(`coordinates shifted by -(${offset.join(', ')}) m to keep float precision (info.originOffset)`);
  }
  const outBuckets: GeomBucket[] = [];
  const outEdges: Array<{ category: number | null; categoryName?: string | null; positions: Float32Array }> = [];
  for (const b of buckets.values()) {
    if (!b.idx.n) continue;
    const gb: GeomBucket = { category: null, categoryName: b.categoryName, color: b.color, positions: b.pos.done(), normals: b.nrm.done(), indices: b.idx.done(), ranges: b.ranges };
    if (b.opacity < 1) gb.opacity = b.opacity;
    outBuckets.push(gb);
    outEdges.push({ category: null, categoryName: b.categoryName, positions: b.edges.done() });
  }
  if (R.faceFallback) R.warn(`${R.faceFallback} curved faces could not be mapped to their surface parameters and were triangulated from their boundary only`);
  if (capped) warnings.push(`triangle limit ${opt.maxTriangles} reached: remaining parts skipped`);
  for (const [m, n] of R.warnCounts) warnings.push(n > 1 ? `${m} (x${n})` : m);
  if (!elements.length) warnings.push('no displayable 3D geometry found');
  const ms = Math.round(performance.now() - t0);
  const bbox: BBox3 = isFinite(gbox[0]) ? { min: [gbox[0], gbox[1], gbox[2]], max: [gbox[3], gbox[4], gbox[5]] } : { min: [0, 0, 0], max: [0, 0, 0] };
  const geometry: StepGeometry = {
    units: 'm', up: 'z', bbox, buckets: outBuckets, edges: opt.edges ? outEdges : undefined, elements,
    stats: { elements: elements.length, triangles, skippedFaces: R.faceFallback, ms }, warnings, tree,
  };
  const h = f.header;
  const info: Record<string, string | number> = {
    format: container === 'step' ? 'STEP' : `STEP (${container})`, protocol, schema, entities: f.count,
    lengthUnit: [...R.ctxUnits.values()][0]?.lenName || 'unknown', lengthScaleToMetre: R.lenScale,
    parts: partsWithGeo.size, products: f.idsOfType('PRODUCT').length, instances: elements.length, assemblyNodes: tree.length,
    solids, faces: R.facesTotal, facesFromBoundaryOnly: R.faceFallback, ms,
  };
  if (h.originatingSystem) info.originatingSystem = h.originatingSystem;
  if (h.preprocessor) info.preprocessor = h.preprocessor;
  if (h.authorization) info.authorization = h.authorization;
  if (h.timeStamp) info.timeStamp = h.timeStamp;
  if (h.fileName) info.fileName = h.fileName;
  if (h.author.length) info.author = h.author.join(', ');
  if (h.organization.length) info.organization = h.organization.join(', ');
  if (h.description.length) info.description = h.description.join(' ');
  const rootNames = tree.filter((n) => n.parent === null).map((n) => n.product);
  if (rootNames.length) info.rootProducts = rootNames.slice(0, 20).join(', ');
  if (offset[0] || offset[1] || offset[2]) info.originOffset = offset.join(',');
  return { kind: '3d', geometry, info };
}
