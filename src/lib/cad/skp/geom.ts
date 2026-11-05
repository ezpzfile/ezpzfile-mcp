// Geometry output helpers for the SketchUp engine: growable arrays, 4x4 matrices and the RvtGeometry builder.
// Clean-room code written for ezpzfile.com (structure follows our own mesh engine helpers).
// Runs in a Web Worker: no DOM, no Node APIs.

import type { BBox3, GeomBucket, GeomElement, RvtGeometry, RvtMaterial } from './types.ts';

export type SkpErrorCode = 'unsupported-version' | 'corrupt' | 'encrypted' | 'too-large' | 'not-format';
export class SkpError extends Error {
  code: SkpErrorCode;
  constructor(code: SkpErrorCode, message: string) { super(message); this.name = 'SkpError'; this.code = code; }
}

/** loop closure statistics of the last read (diagnostics, reset by readSkp) */
export const LOOP_STATS = { loops: 0, open: 0, broken: 0 };

export class GrowF32 {
  a: Float32Array; n = 0;
  constructor(cap = 1024) { this.a = new Float32Array(cap); }
  reserve(extra: number) {
    if (this.n + extra <= this.a.length) return;
    let c = this.a.length * 2; while (c < this.n + extra) c *= 2;
    const b = new Float32Array(c); b.set(this.a.subarray(0, this.n)); this.a = b;
  }
  push3(x: number, y: number, z: number) { this.reserve(3); const a = this.a, n = this.n; a[n] = x; a[n + 1] = y; a[n + 2] = z; this.n = n + 3; }
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
  take(): Uint32Array { return this.a.slice(0, this.n); }
}

// 4x4 column-major matrices
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
export function det3(m: Mat4): number {
  return m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
}
export function isIdentity(m: Mat4): boolean {
  for (let i = 0; i < 16; i++) if (Math.abs(m[i] - (i % 5 === 0 ? 1 : 0)) > 1e-12) return false;
  return true;
}

export interface MatSpec {
  key: string;                       // dedupe key
  name: string;
  color: [number, number, number];   // display colour 0..1 (sRGB)
  opacity?: number;
  textureName?: string;
  schema?: string;
}
export interface ElemSpec {
  name: string | null;
  className: string;
  categoryName?: string | null;
  typeName?: string | null;
  familyName?: string | null;
}
interface BucketAcc {
  mat: MatSpec; categoryName: string | null;
  pos: GrowF32; nrm: GrowF32; idx: GrowU32;
  ranges: Array<{ elementId: number; start: number; count: number }>;
}

export class GeomBuilder {
  private warnCounts = new Map<string, number>();
  private warnKeys: string[] = [];
  private warnMsg = new Map<string, string>();
  private buckets: BucketAcc[] = [];
  private bucketByKey = new Map<string, number>();
  private elements: GeomElement[] = [];
  private elBox = new Map<number, BBox3>();
  private lines = new Map<string, GrowF32>();
  triangles = 0;
  skippedFaces = 0;
  maxTriangles: number;
  maxEdgeSegments = 6_000_000;
  edgeSegments = 0;
  capped = false;
  private t0 = Date.now();

  constructor(maxTriangles = 20_000_000) { this.maxTriangles = maxTriangles; }

  warn(msg: string, key?: string) {
    const k = key ?? msg;
    const n = this.warnCounts.get(k) ?? 0;
    this.warnCounts.set(k, n + 1);
    if (n === 0) { this.warnKeys.push(k); this.warnMsg.set(k, msg); }
  }

  bucket(categoryName: string | null, mat: MatSpec): number {
    const key = `${categoryName ?? ''}\u0000${mat.key}`;
    let i = this.bucketByKey.get(key);
    if (i !== undefined) return i;
    i = this.buckets.length;
    this.buckets.push({ mat, categoryName, pos: new GrowF32(), nrm: new GrowF32(), idx: new GrowU32(), ranges: [] });
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

  private box(elementId: number): BBox3 {
    let box = this.elBox.get(elementId);
    if (!box) { box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }; this.elBox.set(elementId, box); }
    return box;
  }

  /**
   * Add flat-shaded triangles. pos: local xyz, idx: triangle indices, m: local to output transform (or null).
   * Vertices are de-indexed so every triangle gets its face normal.
   */
  addTriangles(elementId: number, bucketIdx: number, pos: ArrayLike<number>, idx: ArrayLike<number>, m: Mat4 | null): void {
    const ntri = Math.floor(idx.length / 3);
    if (!ntri) return;
    if (this.triangles + ntri > this.maxTriangles) {
      if (!this.capped) this.warn(`Triangle limit (${this.maxTriangles}) reached: the rest of the model is skipped`);
      this.capped = true; this.skippedFaces += ntri; return;
    }
    const b = this.buckets[bucketIdx];
    const flip = m ? det3(m) < 0 : false;
    const box = this.box(elementId);
    const start = b.idx.n;
    b.pos.reserve(ntri * 9); b.nrm.reserve(ntri * 9); b.idx.reserve(ntri * 3);
    const P = new Float64Array(9);
    let added = 0;
    const nv = pos.length / 3;
    for (let t = 0; t < ntri; t++) {
      let i0 = idx[t * 3], i1 = idx[t * 3 + 1], i2 = idx[t * 3 + 2];
      if (i0 >= nv || i1 >= nv || i2 >= nv || i0 === i1 || i1 === i2 || i0 === i2) { this.skippedFaces++; continue; }
      if (flip) { const s = i1; i1 = i2; i2 = s; }
      const ii = [i0, i1, i2];
      for (let k = 0; k < 3; k++) {
        const x = pos[ii[k] * 3], y = pos[ii[k] * 3 + 1], z = pos[ii[k] * 3 + 2];
        if (m) {
          const w = m[15] && m[15] !== 1 ? m[15] : 1;
          P[k * 3] = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
          P[k * 3 + 1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
          P[k * 3 + 2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
        } else { P[k * 3] = x; P[k * 3 + 1] = y; P[k * 3 + 2] = z; }
      }
      let ok = true;
      for (let k = 0; k < 9; k++) if (!isFinite(P[k])) { ok = false; break; }
      if (!ok) { this.skippedFaces++; continue; }
      const ux = P[3] - P[0], uy = P[4] - P[1], uz = P[5] - P[2], vx = P[6] - P[0], vy = P[7] - P[1], vz = P[8] - P[2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz);
      if (l > 0) { nx /= l; ny /= l; nz /= l; } else { nx = 0; ny = 0; nz = 1; }
      const base = b.pos.n / 3;
      for (let k = 0; k < 3; k++) {
        const x = P[k * 3], y = P[k * 3 + 1], z = P[k * 3 + 2];
        b.pos.push3(x, y, z); b.nrm.push3(nx, ny, nz);
        if (x < box.min[0]) box.min[0] = x; if (y < box.min[1]) box.min[1] = y; if (z < box.min[2]) box.min[2] = z;
        if (x > box.max[0]) box.max[0] = x; if (y > box.max[1]) box.max[1] = y; if (z > box.max[2]) box.max[2] = z;
      }
      b.idx.push3(base, base + 1, base + 2);
      added++;
    }
    if (!added) return;
    this.triangles += added;
    const last = b.ranges[b.ranges.length - 1];
    if (last && last.elementId === elementId && last.start + last.count === start) last.count += added * 3;
    else b.ranges.push({ elementId, start, count: added * 3 });
  }

  /** line segments (pairs of local points) for the outline layer of one category */
  addSegments(categoryName: string | null, elementId: number, pos: ArrayLike<number>, pairs: ArrayLike<number>, m: Mat4 | null): void {
    const nseg = pairs.length / 2;
    if (!nseg) return;
    if (this.edgeSegments + nseg > this.maxEdgeSegments) {
      this.warn(`Edge limit (${this.maxEdgeSegments} segments) reached: some outline edges are not drawn`);
      return;
    }
    const key = categoryName ?? '';
    let g = this.lines.get(key);
    if (!g) { g = new GrowF32(1024); this.lines.set(key, g); }
    g.reserve(nseg * 6);
    const box = this.box(elementId);
    for (let s = 0; s < nseg; s++) {
      for (let k = 0; k < 2; k++) {
        const i = pairs[s * 2 + k];
        const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
        let X = x, Y = y, Z = z;
        if (m) {
          const w = m[15] && m[15] !== 1 ? m[15] : 1;
          X = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w; Y = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w; Z = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
        }
        g.push3(X, Y, Z);
        if (X < box.min[0]) box.min[0] = X; if (Y < box.min[1]) box.min[1] = Y; if (Z < box.min[2]) box.min[2] = Z;
        if (X > box.max[0]) box.max[0] = X; if (Y > box.max[1]) box.max[1] = Y; if (Z > box.max[2]) box.max[2] = Z;
      }
    }
    this.edgeSegments += nseg;
  }

  finish(postScale: number): RvtGeometry {
    const s = postScale;
    const buckets: GeomBucket[] = [];
    const materials: RvtMaterial[] = [];
    const matIds = new Map<string, number>();
    const bbox: BBox3 = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    const grow = (a: Float32Array) => {
      for (let i = 0; i < a.length; i++) a[i] *= s;
      for (let i = 0; i < a.length; i += 3) for (let k = 0; k < 3; k++) { const v = a[i + k]; if (v < bbox.min[k]) bbox.min[k] = v; if (v > bbox.max[k]) bbox.max[k] = v; }
    };
    for (const b of this.buckets) {
      if (b.idx.n === 0) continue;
      const positions = b.pos.take();
      grow(positions);
      const mat = b.mat;
      let materialId = matIds.get(mat.key);
      if (materialId === undefined) {
        materialId = materials.length + 1;
        matIds.set(mat.key, materialId);
        materials.push({
          id: materialId, name: mat.name, materialClass: null, color: mat.color, opacity: mat.opacity ?? 1,
          appearance: {
            kind: mat.opacity !== undefined && mat.opacity < 0.6 ? 'glass' : 'generic',
            schema: mat.schema ?? null, assetName: mat.name, assetCategory: null, color: mat.color,
            ...(mat.textureName ? { textureName: mat.textureName } : {}),
          },
        });
      }
      const bucket: GeomBucket = {
        category: null, categoryName: b.categoryName, color: mat.color, materialId,
        positions, normals: b.nrm.take(), indices: b.idx.take(), ranges: b.ranges,
      };
      if (mat.opacity !== undefined && mat.opacity < 1) bucket.opacity = mat.opacity;
      buckets.push(bucket);
    }
    for (const e of this.elements) {
      const b = this.elBox.get(e.id);
      if (b && isFinite(b.min[0])) e.bbox = { min: [b.min[0] * s, b.min[1] * s, b.min[2] * s], max: [b.max[0] * s, b.max[1] * s, b.max[2] * s] };
    }
    const edges: NonNullable<RvtGeometry['edges']> = [];
    for (const [cat, g] of this.lines) {
      const positions = g.take();
      grow(positions);
      edges.push({ category: null, categoryName: cat || null, positions });
    }
    if (!isFinite(bbox.min[0])) { bbox.min = [0, 0, 0]; bbox.max = [0, 0, 0]; }
    return {
      units: 'm', up: 'z', bbox, buckets, edges, elements: this.elements, materials,
      stats: { elements: this.elements.length, triangles: this.triangles, skippedFaces: this.skippedFaces, ms: Date.now() - this.t0 },
      warnings: this.warnKeys.map((k) => { const n = this.warnCounts.get(k) ?? 1, m = this.warnMsg.get(k) ?? k; return n > 1 ? `${m} (x${n})` : m; }),
    };
  }
}
