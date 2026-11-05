// Shared helpers for the mesh engines (glTF, OBJ, STL, 3DS, FBX).
// Clean-room code written for ezpzfile.com. Output contract: RvtGeometry (types.ts, copied verbatim from the site).
// Runs in a Web Worker: no DOM, no Node APIs.

import type { BBox3, GeomBucket, GeomElement, RvtGeometry, RvtMaterial } from './types.ts';

export type MeshErrorCode = 'unsupported-version' | 'corrupt' | 'encrypted' | 'too-large' | 'not-format';

export class MeshError extends Error {
  code: MeshErrorCode;
  constructor(code: MeshErrorCode, message: string) {
    super(message);
    this.name = 'MeshError';
    this.code = code;
  }
}

export type Progress = (stage: string, ratio: number) => void;
export type Info = Record<string, string | number>;
export interface MeshResult { kind: '3d'; geometry: RvtGeometry; info: Info }

// ------------------------------------------------------------------ growable typed arrays
export class GrowF32 {
  a: Float32Array; n = 0;
  constructor(cap = 1024) { this.a = new Float32Array(cap); }
  reserve(extra: number) {
    if (this.n + extra <= this.a.length) return;
    let c = this.a.length * 2; while (c < this.n + extra) c *= 2;
    const b = new Float32Array(c); b.set(this.a.subarray(0, this.n)); this.a = b;
  }
  push3(x: number, y: number, z: number) { this.reserve(3); const a = this.a, n = this.n; a[n] = x; a[n + 1] = y; a[n + 2] = z; this.n = n + 3; }
  push(v: number) { this.reserve(1); this.a[this.n++] = v; }
  take(): Float32Array { return this.a.slice(0, this.n); }
}
export class GrowU32 {
  a: Uint32Array; n = 0;
  constructor(cap = 1024) { this.a = new Uint32Array(cap); }
  reserve(extra: number) {
    if (this.n + extra <= this.a.length) return;
    let c = this.a.length * 2; while (c < this.n + extra) c *= 2;
    const b = new Uint32Array(c); b.set(this.a.subarray(0, this.n)); this.a = b;
  }
  push3(x: number, y: number, z: number) { this.reserve(3); const a = this.a, n = this.n; a[n] = x; a[n + 1] = y; a[n + 2] = z; this.n = n + 3; }
  push(v: number) { this.reserve(1); this.a[this.n++] = v; }
  take(): Uint32Array { return this.a.slice(0, this.n); }
}

// ------------------------------------------------------------------ 4x4 matrices, column-major (glTF style)
export type Mat4 = Float64Array;
export function identity(): Mat4 { const m = new Float64Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; }
export function mul(a: Mat4, b: Mat4): Mat4 {
  const r = new Float64Array(16);
  for (let c = 0; c < 4; c++) for (let rr = 0; rr < 4; rr++) {
    let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + rr] * b[c * 4 + k];
    r[c * 4 + rr] = s;
  }
  return r;
}
export function translation(x: number, y: number, z: number): Mat4 { const m = identity(); m[12] = x; m[13] = y; m[14] = z; return m; }
export function scaling(x: number, y: number, z: number): Mat4 { const m = identity(); m[0] = x; m[5] = y; m[10] = z; return m; }
export function fromQuat(x: number, y: number, z: number, w: number): Mat4 {
  const m = identity();
  m[0] = 1 - 2 * (y * y + z * z); m[1] = 2 * (x * y + z * w); m[2] = 2 * (x * z - y * w);
  m[4] = 2 * (x * y - z * w); m[5] = 1 - 2 * (x * x + z * z); m[6] = 2 * (y * z + x * w);
  m[8] = 2 * (x * z + y * w); m[9] = 2 * (y * z - x * w); m[10] = 1 - 2 * (x * x + y * y);
  return m;
}
export function rotX(deg: number): Mat4 { const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r); const m = identity(); m[5] = c; m[6] = s; m[9] = -s; m[10] = c; return m; }
export function rotY(deg: number): Mat4 { const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r); const m = identity(); m[0] = c; m[2] = -s; m[8] = s; m[10] = c; return m; }
export function rotZ(deg: number): Mat4 { const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r); const m = identity(); m[0] = c; m[1] = s; m[4] = -s; m[5] = c; return m; }
export function invert(m: Mat4): Mat4 {
  const inv = new Float64Array(16);
  inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
  inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
  inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
  inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
  inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
  inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
  inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
  inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
  inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
  inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
  inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
  inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
  inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
  inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
  inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
  inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];
  let det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
  if (!det || !isFinite(det)) return identity();
  det = 1 / det;
  for (let i = 0; i < 16; i++) inv[i] *= det;
  return inv;
}
export function det3(m: Mat4): number {
  return m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
}
/** Y-up (glTF, OBJ, FBX default) to Z-up: (x, y, z) -> (x, -z, y) */
export const Y_UP_TO_Z_UP: Mat4 = (() => { const m = new Float64Array(16); m[0] = 1; m[6] = 1; m[9] = -1; m[15] = 1; return m; })();

// ------------------------------------------------------------------ colours
export function linearToSrgb(c: number): number {
  c = Math.min(1, Math.max(0, c));
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}
export const DEFAULT_GREY: [number, number, number] = [0.72, 0.72, 0.72];
export function clamp01(v: number): number { return isFinite(v) ? Math.min(1, Math.max(0, v)) : 0; }

// ------------------------------------------------------------------ text helpers
export function latin1(bytes: Uint8Array, start = 0, end = bytes.length): string {
  let s = '';
  for (let i = start; i < end; i += 8192) s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, Math.min(end, i + 8192))));
  return s;
}
export function utf8(bytes: Uint8Array): string { return new TextDecoder('utf-8', { fatal: false }).decode(bytes); }
/** decode text: UTF-8 when valid, else latin1 */
export function decodeText(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return new TextDecoder('latin1').decode(bytes); }
}

// ------------------------------------------------------------------ geometry builder
export interface MatSpec {
  name: string;
  color: [number, number, number];   // display colour 0..1 (sRGB)
  opacity?: number;
  textureName?: string;
  schema?: string;                   // e.g. 'glTF pbrMetallicRoughness', 'OBJ usemtl', 'FBX Lambert'
  roughness?: number;
  metallic?: boolean;
}
export interface ElemSpec {
  name: string | null;
  className: string;
  categoryName?: string | null;
  typeName?: string | null;
  familyName?: string | null;
}
interface BucketAcc {
  mat: MatSpec; materialId: number;
  pos: GrowF32; nrm: GrowF32; idx: GrowU32;
  ranges: Array<{ elementId: number; start: number; count: number }>;
}

export class GeomBuilder {
  warnings: string[] = [];
  private warnCounts = new Map<string, number>();
  private buckets: BucketAcc[] = [];
  private bucketByKey = new Map<string, number>();
  private elements: GeomElement[] = [];
  private elBox = new Map<number, BBox3>();
  private lines: GrowF32 = new GrowF32(64);
  triangles = 0;
  skippedFaces = 0;
  maxTriangles: number;
  private t0 = Date.now();
  private capped = false;

  constructor(maxTriangles = 20_000_000) { this.maxTriangles = maxTriangles; }

  /** add a warning; repeated warnings with the same key are collapsed into one line with a count */
  warn(msg: string, key?: string) {
    const k = key ?? msg;
    const n = this.warnCounts.get(k) ?? 0;
    this.warnCounts.set(k, n + 1);
    if (n === 0) { this.warnKeys.push(k); this.warnMsg.set(k, msg); this.warnings.push(msg); }
  }
  private warnKeys: string[] = [];
  private warnMsg = new Map<string, string>();

  bucket(key: string, mat: MatSpec): number {
    let i = this.bucketByKey.get(key);
    if (i !== undefined) return i;
    i = this.buckets.length;
    this.buckets.push({ mat, materialId: i, pos: new GrowF32(), nrm: new GrowF32(), idx: new GrowU32(), ranges: [] });
    this.bucketByKey.set(key, i);
    return i;
  }

  element(spec: ElemSpec): number {
    const id = this.elements.length + 1;
    this.elements.push({
      id, category: null, categoryName: spec.categoryName ?? null, className: spec.className,
      name: spec.name ?? null, typeName: spec.typeName ?? null, familyName: spec.familyName ?? null,
      levelId: null, levelName: null, bbox: null,
    });
    return id;
  }

  /** line segments (x0,y0,z0,x1,y1,z1 ...) already in output space, e.g. glTF LINES primitives */
  addLines(seg: ArrayLike<number>, m: Mat4 | null) {
    for (let i = 0; i + 5 < seg.length; i += 3) {
      if ((i / 3) % 2 === 1) continue;
      for (let k = 0; k < 6; k += 3) {
        const x = seg[i + k], y = seg[i + k + 1], z = seg[i + k + 2];
        if (m) this.lines.push3(m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]);
        else this.lines.push3(x, y, z);
      }
    }
  }

  /**
   * Add one indexed triangle mesh.
   * pos: xyz in the mesh's local space, m: local to output (metres, Z-up) transform or null.
   * nrm: per-vertex normals (local space) or null: then flat normals are computed (vertices get de-indexed).
   * idx: triangle indices or null (sequential).
   */
  addMesh(elementId: number, bucketIdx: number, pos: ArrayLike<number>, nrm: ArrayLike<number> | null, idx: ArrayLike<number> | null, m: Mat4 | null) {
    const nv = Math.floor(pos.length / 3);
    let ntri = idx ? Math.floor(idx.length / 3) : Math.floor(nv / 3);
    if (ntri === 0 || nv === 0) return;
    if (this.triangles + ntri > this.maxTriangles) {
      if (!this.capped) this.warn(`Triangle limit (${this.maxTriangles}) reached: the rest of the model is skipped`);
      this.capped = true;
      this.skippedFaces += ntri;
      return;
    }
    const b = this.buckets[bucketIdx];
    const flip = m ? det3(m) < 0 : false;
    // normal matrix (inverse transpose of the upper 3x3)
    let nm: Mat4 | null = null;
    if (m) { const inv = invert(m); nm = new Float64Array(16); for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) nm[c * 4 + r] = inv[r * 4 + c]; }
    let box = this.elBox.get(elementId);
    if (!box) { box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }; this.elBox.set(elementId, box); }
    const tp = (i: number, out: number[]) => {
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      if (m) { out[0] = m[0] * x + m[4] * y + m[8] * z + m[12]; out[1] = m[1] * x + m[5] * y + m[9] * z + m[13]; out[2] = m[2] * x + m[6] * y + m[10] * z + m[14]; }
      else { out[0] = x; out[1] = y; out[2] = z; }
    };
    const start = b.idx.n;
    const P = [0, 0, 0];
    const growBox = () => {
      if (P[0] < box!.min[0]) box!.min[0] = P[0]; if (P[1] < box!.min[1]) box!.min[1] = P[1]; if (P[2] < box!.min[2]) box!.min[2] = P[2];
      if (P[0] > box!.max[0]) box!.max[0] = P[0]; if (P[1] > box!.max[1]) box!.max[1] = P[1]; if (P[2] > box!.max[2]) box!.max[2] = P[2];
    };
    let added = 0;
    if (nrm && nrm.length >= nv * 3) {
      const base = b.pos.n / 3;
      b.pos.reserve(nv * 3); b.nrm.reserve(nv * 3);
      for (let i = 0; i < nv; i++) {
        tp(i, P);
        if (!isFinite(P[0]) || !isFinite(P[1]) || !isFinite(P[2])) { P[0] = P[1] = P[2] = 0; }
        else growBox();
        b.pos.push3(P[0], P[1], P[2]);
        let nx = nrm[i * 3], ny = nrm[i * 3 + 1], nz = nrm[i * 3 + 2];
        if (nm) { const a = nm[0] * nx + nm[4] * ny + nm[8] * nz, bb = nm[1] * nx + nm[5] * ny + nm[9] * nz, c = nm[2] * nx + nm[6] * ny + nm[10] * nz; nx = a; ny = bb; nz = c; }
        const l = Math.hypot(nx, ny, nz) || 1;
        b.nrm.push3(nx / l, ny / l, nz / l);
      }
      b.idx.reserve(ntri * 3);
      for (let t = 0; t < ntri; t++) {
        let i0 = idx ? idx[t * 3] : t * 3, i1 = idx ? idx[t * 3 + 1] : t * 3 + 1, i2 = idx ? idx[t * 3 + 2] : t * 3 + 2;
        if (i0 >= nv || i1 >= nv || i2 >= nv || i0 < 0 || i1 < 0 || i2 < 0 || i0 === i1 || i1 === i2 || i0 === i2) { this.skippedFaces++; continue; }
        if (flip) { const s = i1; i1 = i2; i2 = s; }
        b.idx.push3(base + i0, base + i1, base + i2);
        added++;
      }
    } else {
      // flat shading: de-index
      const A = [0, 0, 0], B = [0, 0, 0], C = [0, 0, 0];
      b.pos.reserve(ntri * 9); b.nrm.reserve(ntri * 9); b.idx.reserve(ntri * 3);
      for (let t = 0; t < ntri; t++) {
        let i0 = idx ? idx[t * 3] : t * 3, i1 = idx ? idx[t * 3 + 1] : t * 3 + 1, i2 = idx ? idx[t * 3 + 2] : t * 3 + 2;
        if (i0 >= nv || i1 >= nv || i2 >= nv || i0 < 0 || i1 < 0 || i2 < 0 || i0 === i1 || i1 === i2 || i0 === i2) { this.skippedFaces++; continue; }
        if (flip) { const s = i1; i1 = i2; i2 = s; }
        tp(i0, A); tp(i1, B); tp(i2, C);
        if (!isFinite(A[0] + A[1] + A[2] + B[0] + B[1] + B[2] + C[0] + C[1] + C[2])) { this.skippedFaces++; continue; }
        const ux = B[0] - A[0], uy = B[1] - A[1], uz = B[2] - A[2], vx = C[0] - A[0], vy = C[1] - A[1], vz = C[2] - A[2];
        let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const l = Math.hypot(nx, ny, nz);
        if (l > 0) { nx /= l; ny /= l; nz /= l; } else { nx = 0; ny = 0; nz = 1; }
        const base = b.pos.n / 3;
        for (const Q of [A, B, C]) { b.pos.push3(Q[0], Q[1], Q[2]); b.nrm.push3(nx, ny, nz); P[0] = Q[0]; P[1] = Q[1]; P[2] = Q[2]; growBox(); }
        b.idx.push3(base, base + 1, base + 2);
        added++;
      }
    }
    if (added === 0) return;
    this.triangles += added;
    const last = b.ranges[b.ranges.length - 1];
    if (last && last.elementId === elementId && last.start + last.count === start) last.count += added * 3;
    else b.ranges.push({ elementId, start, count: added * 3 });
  }

  /** current bbox of everything added so far (output space before postScale) */
  extents(): BBox3 | null {
    const bb: BBox3 = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    for (const b of this.elBox.values()) for (let k = 0; k < 3; k++) { bb.min[k] = Math.min(bb.min[k], b.min[k]); bb.max[k] = Math.max(bb.max[k], b.max[k]); }
    return isFinite(bb.min[0]) ? bb : null;
  }

  finish(opts: { postScale?: number; edges?: boolean; edgeAngleDeg?: number } = {}): RvtGeometry {
    const s = opts.postScale ?? 1;
    const buckets: GeomBucket[] = [];
    const materials: RvtMaterial[] = [];
    const bbox: BBox3 = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    for (const b of this.buckets) {
      if (b.idx.n === 0) continue;
      const positions = b.pos.take();
      if (s !== 1) for (let i = 0; i < positions.length; i++) positions[i] *= s;
      for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k++) {
        const v = positions[i + k]; if (v < bbox.min[k]) bbox.min[k] = v; if (v > bbox.max[k]) bbox.max[k] = v;
      }
      const materialId = materials.length + 1;
      const mat = b.mat;
      materials.push({
        id: materialId, name: mat.name, materialClass: null, color: mat.color, opacity: mat.opacity ?? 1,
        appearance: {
          kind: mat.opacity !== undefined && mat.opacity < 0.6 ? 'glass' : mat.metallic ? 'metal' : 'generic',
          schema: mat.schema ?? null, assetName: mat.name, assetCategory: null, color: mat.color,
          ...(mat.textureName ? { textureName: mat.textureName } : {}),
          ...(mat.roughness !== undefined ? { roughness: mat.roughness } : {}),
          ...(mat.metallic !== undefined ? { metallic: mat.metallic } : {}),
        },
      });
      const bucket: GeomBucket = {
        category: null, categoryName: mat.name, color: mat.color, materialId,
        positions, normals: b.nrm.take(), indices: b.idx.take(), ranges: b.ranges,
      };
      if (mat.opacity !== undefined && mat.opacity < 1) bucket.opacity = mat.opacity;
      buckets.push(bucket);
    }
    for (const e of this.elements) {
      const b = this.elBox.get(e.id);
      if (b && isFinite(b.min[0])) e.bbox = { min: [b.min[0] * s, b.min[1] * s, b.min[2] * s], max: [b.max[0] * s, b.max[1] * s, b.max[2] * s] };
    }
    if (this.lines.n) for (let i = 0; i < this.lines.n; i++) {
      const v = this.lines.a[i] * s, k = i % 3; this.lines.a[i] = v;
      if (v < bbox.min[k]) bbox.min[k] = v; if (v > bbox.max[k]) bbox.max[k] = v;
    }
    if (!isFinite(bbox.min[0])) { bbox.min = [0, 0, 0]; bbox.max = [0, 0, 0]; }
    let edges: RvtGeometry['edges'];
    if (opts.edges !== false) {
      edges = [];
      if (this.triangles <= 4_000_000) {
        const cosLim = Math.cos(((opts.edgeAngleDeg ?? 35) * Math.PI) / 180);
        for (const b of buckets) { const e = featureEdges(b.positions, b.indices, cosLim); if (e.length) edges.push({ category: null, categoryName: b.categoryName, positions: e }); }
      } else this.warn('Model is large: outline edges were not computed');
      if (this.lines.n) edges.push({ category: null, positions: this.lines.take() });
    }
    const geometry: RvtGeometry = {
      units: 'm', up: 'z', bbox, buckets, elements: this.elements, materials,
      stats: { elements: this.elements.length, triangles: this.triangles, skippedFaces: this.skippedFaces, ms: Date.now() - this.t0 },
      warnings: this.warnKeys.map((k) => { const n = this.warnCounts.get(k) ?? 1, m = this.warnMsg.get(k) ?? k; return n > 1 ? `${m} (x${n})` : m; }),
    };
    if (edges) geometry.edges = edges;
    return geometry;
  }
}

// ------------------------------------------------------------------ feature edges
/** Weld by position, then keep boundary edges and edges whose dihedral angle is sharper than the limit. */
export function featureEdges(pos: Float32Array, idx: Uint32Array, cosLim: number): Float32Array {
  const nv = pos.length / 3;
  if (nv === 0) return new Float32Array(0);
  // bbox based quantisation
  let mnx = Infinity, mny = Infinity, mnz = Infinity, mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    if (x < mnx) mnx = x; if (y < mny) mny = y; if (z < mnz) mnz = z; if (x > mxx) mxx = x; if (y > mxy) mxy = y; if (z > mxz) mxz = z;
  }
  const size = Math.max(mxx - mnx, mxy - mny, mxz - mnz) || 1;
  const q = 1e6 / size; // about 1 ppm of the bucket size
  // open addressing hash table for welding
  let cap = 1; while (cap < nv * 2) cap <<= 1;
  const keys = new Int32Array(cap * 3), slot = new Int32Array(cap).fill(-1);
  const weld = new Uint32Array(nv);
  let nu = 0;
  for (let i = 0; i < nv; i++) {
    const a = Math.round((pos[i * 3] - mnx) * q) | 0, b = Math.round((pos[i * 3 + 1] - mny) * q) | 0, c = Math.round((pos[i * 3 + 2] - mnz) * q) | 0;
    let h = (Math.imul(a, 73856093) ^ Math.imul(b, 19349663) ^ Math.imul(c, 83492791)) & (cap - 1);
    for (;;) {
      const s = slot[h];
      if (s < 0) { slot[h] = nu; keys[nu * 3] = a; keys[nu * 3 + 1] = b; keys[nu * 3 + 2] = c; weld[i] = nu++; break; }
      if (keys[s * 3] === a && keys[s * 3 + 1] === b && keys[s * 3 + 2] === c) { weld[i] = s; break; }
      h = (h + 1) & (cap - 1);
    }
  }
  const ntri = idx.length / 3;
  const fn = new Float32Array(ntri * 3);
  for (let t = 0; t < ntri; t++) {
    const i0 = idx[t * 3] * 3, i1 = idx[t * 3 + 1] * 3, i2 = idx[t * 3 + 2] * 3;
    const ux = pos[i1] - pos[i0], uy = pos[i1 + 1] - pos[i0 + 1], uz = pos[i1 + 2] - pos[i0 + 2];
    const vx = pos[i2] - pos[i0], vy = pos[i2 + 1] - pos[i0 + 1], vz = pos[i2 + 2] - pos[i0 + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1; fn[t * 3] = nx / l; fn[t * 3 + 1] = ny / l; fn[t * 3 + 2] = nz / l;
  }
  // edge table: key = lo * nu + hi (fits in 2^53 for nu < 9e7)
  const edgeFace = new Map<number, number>(); // first face, or -2 when sharp / non-manifold already decided
  const out = new GrowF32(1024);
  const emit = (va: number, vb: number) => {
    out.push3(keys[va * 3] / q + mnx, keys[va * 3 + 1] / q + mny, keys[va * 3 + 2] / q + mnz);
    out.push3(keys[vb * 3] / q + mnx, keys[vb * 3 + 1] / q + mny, keys[vb * 3 + 2] / q + mnz);
  };
  const smooth = -3;
  for (let t = 0; t < ntri; t++) {
    for (let e = 0; e < 3; e++) {
      const a = weld[idx[t * 3 + e]], b = weld[idx[t * 3 + ((e + 1) % 3)]];
      if (a === b) continue;
      const lo = a < b ? a : b, hi = a < b ? b : a;
      const key = lo * nu + hi;
      const f = edgeFace.get(key);
      if (f === undefined) edgeFace.set(key, t);
      else if (f >= 0) {
        const d = fn[f * 3] * fn[t * 3] + fn[f * 3 + 1] * fn[t * 3 + 1] + fn[f * 3 + 2] * fn[t * 3 + 2];
        if (d < cosLim) { emit(lo, hi); edgeFace.set(key, -2); } else edgeFace.set(key, smooth);
      }
    }
  }
  for (const [key, f] of edgeFace) if (f >= 0) { const lo = Math.floor(key / nu), hi = key - lo * nu; emit(lo, hi); }
  return out.take();
}

// ------------------------------------------------------------------ unit heuristic for unitless formats (OBJ, STL)
/** returns scale to metres and the assumption text */
export function guessUnits(ext: BBox3 | null, hint?: 'mm' | 'm' | 'cm' | 'in' | null, mmAbove = 200): { scale: number; unit: string; why: string } {
  if (hint) {
    const s = { mm: 0.001, m: 1, cm: 0.01, in: 0.0254 }[hint];
    return { scale: s, unit: hint, why: `units taken from the file header (${hint})` };
  }
  if (!ext) return { scale: 1, unit: 'm', why: 'empty model, metres assumed' };
  const size = Math.max(ext.max[0] - ext.min[0], ext.max[1] - ext.min[1], ext.max[2] - ext.min[2]);
  if (size > mmAbove) return { scale: 0.001, unit: 'mm', why: `largest extent ${fmt(size)} units looks like millimetres` };
  return { scale: 1, unit: 'm', why: `largest extent ${fmt(size)} units looks like metres` };
}
function fmt(v: number): string { return v >= 100 ? v.toFixed(0) : v.toPrecision(3); }

export function yieldTick(): Promise<void> { return new Promise((r) => setTimeout(r, 0)); }
