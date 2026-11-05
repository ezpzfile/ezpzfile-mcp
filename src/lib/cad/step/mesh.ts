// Mesh output helpers copied from our own IFC engine (/tmp/cad/ifc/ifc.ts): growable typed arrays,
// vertex welding, feature edges and crease-aware normals.

export class F32 { a: Float32Array; n = 0; constructor(c = 1024) { this.a = new Float32Array(c); }
  reserve(k: number) { if (this.n + k > this.a.length) { let c = this.a.length * 2; while (c < this.n + k) c *= 2; const t = new Float32Array(c); t.set(this.a.subarray(0, this.n)); this.a = t; } }
  done() { return this.a.slice(0, this.n); } }
export class U32 { a: Uint32Array; n = 0; constructor(c = 1024) { this.a = new Uint32Array(c); }
  reserve(k: number) { if (this.n + k > this.a.length) { let c = this.a.length * 2; while (c < this.n + k) c *= 2; const t = new Uint32Array(c); t.set(this.a.subarray(0, this.n)); this.a = t; } }
  done() { return this.a.slice(0, this.n); } }

export interface BucketAcc {
  categoryName: string; color: [number, number, number]; opacity: number;
  pos: F32; nrm: F32; idx: U32; edges: F32;
  ranges: { elementId: number; start: number; count: number }[];
}

const COS_EDGE = Math.cos((30 * Math.PI) / 180);
const COS_SMOOTH = Math.cos((40 * Math.PI) / 180);

/** weld, compute feature edges and crease-aware normals, append to bucket. P in metres (already offset). */
export function emitMesh(b: BucketAcc, elementId: number, P: Float64Array, I: ArrayLike<number>, wantEdges: boolean, bbox: number[]): number {
  const nIn = P.length / 3;
  // weld by quantised position (0.01 mm)
  const q = 1e5;
  let cap = 16;
  while (cap < nIn * 2) cap <<= 1;
  const table = new Int32Array(cap).fill(-1);
  const remap = new Int32Array(nIn);
  const wx: number[] = [];
  const keyX = new Int32Array(nIn), keyY = new Int32Array(nIn), keyZ = new Int32Array(nIn);
  let nW = 0;
  for (let i = 0; i < nIn; i++) {
    const x = Math.round(P[3 * i] * q), y = Math.round(P[3 * i + 1] * q), z = Math.round(P[3 * i + 2] * q);
    let h = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791)) & (cap - 1);
    for (;;) {
      const e = table[h];
      if (e < 0) { table[h] = nW; keyX[nW] = x; keyY[nW] = y; keyZ[nW] = z; wx.push(P[3 * i], P[3 * i + 1], P[3 * i + 2]); remap[i] = nW++; break; }
      if (keyX[e] === x && keyY[e] === y && keyZ[e] === z) { remap[i] = e; break; }
      h = (h + 1) & (cap - 1);
    }
  }
  // triangles + face normals
  const nT0 = I.length / 3;
  const tri = new Int32Array(I.length);
  const fn = new Float64Array(I.length);
  const sliver = new Uint8Array(nT0);
  let nT = 0;
  for (let t = 0; t < nT0; t++) {
    const a = remap[I[3 * t]], c1 = remap[I[3 * t + 1]], c2 = remap[I[3 * t + 2]];
    if (a === c1 || c1 === c2 || a === c2) continue;
    const ux = wx[3 * c1] - wx[3 * a], uy = wx[3 * c1 + 1] - wx[3 * a + 1], uz = wx[3 * c1 + 2] - wx[3 * a + 2];
    const vx = wx[3 * c2] - wx[3 * a], vy = wx[3 * c2 + 1] - wx[3 * a + 1], vz = wx[3 * c2 + 2] - wx[3 * a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (!(l > 1e-14)) continue;
    nx /= l; ny /= l; nz /= l;
    const wx2 = wx[3 * c2] - wx[3 * c1], wy2 = wx[3 * c2 + 1] - wx[3 * c1 + 1], wz2 = wx[3 * c2 + 2] - wx[3 * c1 + 2];
    const me = Math.max(ux * ux + uy * uy + uz * uz, vx * vx + vy * vy + vz * vz, wx2 * wx2 + wy2 * wy2 + wz2 * wz2);
    sliver[nT] = l < me * 2e-4 ? 1 : 0;
    tri[3 * nT] = a; tri[3 * nT + 1] = c1; tri[3 * nT + 2] = c2;
    fn[3 * nT] = nx; fn[3 * nT + 1] = ny; fn[3 * nT + 2] = nz;
    nT++;
  }
  if (!nT) return 0;
  // edges
  if (wantEdges) {
    const em = new Map<number, number>(); // key -> triangle index + 1 (negative when already used twice)
    const out = b.edges;
    const pushEdge = (u: number, v: number) => {
      out.reserve(6);
      out.a[out.n++] = wx[3 * u]; out.a[out.n++] = wx[3 * u + 1]; out.a[out.n++] = wx[3 * u + 2];
      out.a[out.n++] = wx[3 * v]; out.a[out.n++] = wx[3 * v + 1]; out.a[out.n++] = wx[3 * v + 2];
    };
    for (let t = 0; t < nT; t++) {
      for (let k = 0; k < 3; k++) {
        const u = tri[3 * t + k], v = tri[3 * t + (k + 1) % 3];
        const key = u < v ? u * nW + v : v * nW + u;
        const e = em.get(key);
        if (sliver[t]) { if (e === undefined) em.set(key, 0); else if (e > 0) em.set(key, e); continue; }
        if (e === undefined) em.set(key, t + 1);
        else if (e === 0) { /* edge shared with a sliver: ignore */ }
        else if (e > 0) {
          const s = e - 1;
          const d = fn[3 * s] * fn[3 * t] + fn[3 * s + 1] * fn[3 * t + 1] + fn[3 * s + 2] * fn[3 * t + 2];
          if (d < COS_EDGE) pushEdge(u, v);
          em.set(key, 0);
        }
      }
    }
    for (const [key, e] of em) if (e > 0) { const u = Math.floor(key / nW), v = key - u * nW; pushEdge(u, v); }
  }
  // crease-aware normals: split vertices by normal clusters
  const head = new Int32Array(nW).fill(-1);
  const outV: number[] = []; // per output vertex: welded index
  const nextS: number[] = [];
  const acc: number[] = []; // accumulated normal
  const first: number[] = []; // first face normal of cluster
  const outIdx = new Uint32Array(nT * 3);
  for (let pass = 0; pass < 2; pass++) for (let t = 0; t < nT; t++) {
    if (sliver[t] !== pass) continue;
    const nx = fn[3 * t], ny = fn[3 * t + 1], nz = fn[3 * t + 2];
    for (let k = 0; k < 3; k++) {
      const v = tri[3 * t + k];
      let s = head[v], found = -1, bestD = -2;
      while (s >= 0) {
        const d = first[3 * s] * nx + first[3 * s + 1] * ny + first[3 * s + 2] * nz;
        if (pass === 0 && d > COS_SMOOTH) { found = s; break; }
        if (pass === 1 && d > bestD) { bestD = d; found = s; }
        s = nextS[s];
      }
      if (pass === 1 && found >= 0) { outIdx[3 * t + k] = found; continue; }
      if (found < 0) {
        found = outV.length;
        outV.push(v); nextS.push(head[v]); head[v] = found;
        first.push(nx, ny, nz); acc.push(0, 0, 0);
      }
      acc[3 * found] += nx; acc[3 * found + 1] += ny; acc[3 * found + 2] += nz;
      outIdx[3 * t + k] = found;
    }
  }
  const nO = outV.length;
  const base = b.pos.n / 3;
  b.pos.reserve(nO * 3); b.nrm.reserve(nO * 3);
  for (let i = 0; i < nO; i++) {
    const v = outV[i];
    const x = wx[3 * v], y = wx[3 * v + 1], z = wx[3 * v + 2];
    b.pos.a[b.pos.n++] = x; b.pos.a[b.pos.n++] = y; b.pos.a[b.pos.n++] = z;
    if (x < bbox[0]) bbox[0] = x; if (y < bbox[1]) bbox[1] = y; if (z < bbox[2]) bbox[2] = z;
    if (x > bbox[3]) bbox[3] = x; if (y > bbox[4]) bbox[4] = y; if (z > bbox[5]) bbox[5] = z;
    let nx = acc[3 * i], ny = acc[3 * i + 1], nz = acc[3 * i + 2];
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    b.nrm.a[b.nrm.n++] = nx; b.nrm.a[b.nrm.n++] = ny; b.nrm.a[b.nrm.n++] = nz;
  }
  const start = b.idx.n;
  b.idx.reserve(nT * 3);
  for (let i = 0; i < nT * 3; i++) b.idx.a[b.idx.n++] = outIdx[i] + base;
  const last = b.ranges[b.ranges.length - 1];
  if (last && last.elementId === elementId && last.start + last.count === start) last.count += nT * 3;
  else b.ranges.push({ elementId, start, count: nT * 3 });
  return nT;
}


/** append a mesh that carries its own (analytic) vertex normals: no welding, no normal recomputation */
export function emitWithNormals(b: BucketAcc, elementId: number, P: Float64Array, N: Float64Array, I: ArrayLike<number>, bbox: number[]): number {
  const nV = P.length / 3;
  const base = b.pos.n / 3;
  b.pos.reserve(nV * 3); b.nrm.reserve(nV * 3);
  for (let i = 0; i < nV; i++) {
    const x = P[3 * i], y = P[3 * i + 1], z = P[3 * i + 2];
    b.pos.a[b.pos.n++] = x; b.pos.a[b.pos.n++] = y; b.pos.a[b.pos.n++] = z;
    if (x < bbox[0]) bbox[0] = x; if (y < bbox[1]) bbox[1] = y; if (z < bbox[2]) bbox[2] = z;
    if (x > bbox[3]) bbox[3] = x; if (y > bbox[4]) bbox[4] = y; if (z > bbox[5]) bbox[5] = z;
    b.nrm.a[b.nrm.n++] = N[3 * i]; b.nrm.a[b.nrm.n++] = N[3 * i + 1]; b.nrm.a[b.nrm.n++] = N[3 * i + 2];
  }
  const start = b.idx.n;
  let nT = 0;
  b.idx.reserve(I.length);
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t], c = I[t + 1], d = I[t + 2];
    if (a === c || c === d || a === d) continue;
    // drop zero-area triangles (e.g. at poles where two parameter points share one 3D point)
    const ux = P[3 * c] - P[3 * a], uy = P[3 * c + 1] - P[3 * a + 1], uz = P[3 * c + 2] - P[3 * a + 2];
    const vx = P[3 * d] - P[3 * a], vy = P[3 * d + 1] - P[3 * a + 1], vz = P[3 * d + 2] - P[3 * a + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (cx * cx + cy * cy + cz * cz <= 1e-30 * ((ux * ux + uy * uy + uz * uz) * (vx * vx + vy * vy + vz * vz) + 1e-300)) continue;
    b.idx.a[b.idx.n++] = a + base; b.idx.a[b.idx.n++] = c + base; b.idx.a[b.idx.n++] = d + base;
    nT++;
  }
  if (!nT) return 0;
  const last = b.ranges[b.ranges.length - 1];
  if (last && last.elementId === elementId && last.start + last.count === start) last.count += nT * 3;
  else b.ranges.push({ elementId, start, count: nT * 3 });
  return nT;
}
