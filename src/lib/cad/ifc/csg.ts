// Mesh booleans with BSP trees (classic solid-modelling BSP merge, own implementation).
// Used for IfcBooleanResult / IfcBooleanClippingResult / half spaces and for openings
// (IfcRelVoidsElement). Polygons must form closed, outward oriented solids for exact results.

import type { Mesh } from './geom.ts';

interface Poly { v: number[]; nx: number; ny: number; nz: number; w: number }

const COPLANAR = 0, FRONT = 1, BACK = 2, SPANNING = 3;

function polyFrom(v: number[]): Poly | null {
  // Newell normal
  let nx = 0, ny = 0, nz = 0;
  const n = v.length / 3;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    nx += (v[3 * i + 1] - v[3 * j + 1]) * (v[3 * i + 2] + v[3 * j + 2]);
    ny += (v[3 * i + 2] - v[3 * j + 2]) * (v[3 * i] + v[3 * j]);
    nz += (v[3 * i] - v[3 * j]) * (v[3 * i + 1] + v[3 * j + 1]);
  }
  const l = Math.hypot(nx, ny, nz);
  if (!(l > 1e-300)) return null;
  nx /= l; ny /= l; nz /= l;
  // plane offset: average of vertices
  let w = 0;
  for (let i = 0; i < n; i++) w += nx * v[3 * i] + ny * v[3 * i + 1] + nz * v[3 * i + 2];
  return { v, nx, ny, nz, w: w / n };
}

function flipPoly(p: Poly): Poly {
  const n = p.v.length / 3;
  const v: number[] = new Array(p.v.length);
  for (let i = 0; i < n; i++) { const j = n - 1 - i; v[3 * i] = p.v[3 * j]; v[3 * i + 1] = p.v[3 * j + 1]; v[3 * i + 2] = p.v[3 * j + 2]; }
  return { v, nx: -p.nx, ny: -p.ny, nz: -p.nz, w: -p.w };
}

interface Plane { nx: number; ny: number; nz: number; w: number }

function split(pl: Plane, p: Poly, eps: number, cf: Poly[], cb: Poly[], f: Poly[], b: Poly[]) {
  const n = p.v.length / 3;
  let type = 0;
  const types = new Uint8Array(n);
  const ds = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const d = pl.nx * p.v[3 * i] + pl.ny * p.v[3 * i + 1] + pl.nz * p.v[3 * i + 2] - pl.w;
    ds[i] = d;
    const t = d < -eps ? BACK : d > eps ? FRONT : COPLANAR;
    types[i] = t; type |= t;
  }
  if (type === COPLANAR) { (pl.nx * p.nx + pl.ny * p.ny + pl.nz * p.nz > 0 ? cf : cb).push(p); return; }
  if (type === FRONT) { f.push(p); return; }
  if (type === BACK) { b.push(p); return; }
  const fv: number[] = [], bv: number[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ti = types[i], tj = types[j];
    const x = p.v[3 * i], y = p.v[3 * i + 1], z = p.v[3 * i + 2];
    if (ti !== BACK) fv.push(x, y, z);
    if (ti !== FRONT) bv.push(x, y, z);
    if ((ti | tj) === SPANNING) {
      const t = ds[i] / (ds[i] - ds[j]);
      const X = x + (p.v[3 * j] - x) * t, Y = y + (p.v[3 * j + 1] - y) * t, Z = z + (p.v[3 * j + 2] - z) * t;
      fv.push(X, Y, Z); bv.push(X, Y, Z);
    }
  }
  if (fv.length >= 9) f.push({ v: fv, nx: p.nx, ny: p.ny, nz: p.nz, w: p.w });
  if (bv.length >= 9) b.push({ v: bv, nx: p.nx, ny: p.ny, nz: p.nz, w: p.w });
}

class Node {
  plane: Plane | null = null;
  front: Node | null = null;
  back: Node | null = null;
  polys: Poly[] = [];
}

export class BSP {
  root = new Node();
  eps: number;
  budget: { ops: number };
  constructor(polys: Poly[], eps: number, budget: { ops: number }) { this.eps = eps; this.budget = budget; if (polys.length) this.build(polys); }

  build(polys: Poly[]) {
    const stack: [Node, Poly[]][] = [[this.root, polys]];
    while (stack.length) {
      const [node, ps] = stack.pop()!;
      if (!ps.length) continue;
      if (!node.plane) { const p0 = ps[0]; node.plane = { nx: p0.nx, ny: p0.ny, nz: p0.nz, w: p0.w }; }
      const f: Poly[] = [], b: Poly[] = [];
      for (const p of ps) split(node.plane, p, this.eps, node.polys, node.polys, f, b);
      this.budget.ops += ps.length;
      if (this.budget.ops > 4e7) throw new Error('csg-budget');
      if (f.length) { if (!node.front) node.front = new Node(); stack.push([node.front, f]); }
      if (b.length) { if (!node.back) node.back = new Node(); stack.push([node.back, b]); }
    }
  }
  invert() {
    const stack: Node[] = [this.root];
    while (stack.length) {
      const n = stack.pop()!;
      n.polys = n.polys.map(flipPoly);
      if (n.plane) n.plane = { nx: -n.plane.nx, ny: -n.plane.ny, nz: -n.plane.nz, w: -n.plane.w };
      const t = n.front; n.front = n.back; n.back = t;
      if (n.front) stack.push(n.front);
      if (n.back) stack.push(n.back);
    }
  }
  clipPolys(polys: Poly[]): Poly[] {
    const out: Poly[] = [];
    const stack: [Node, Poly[]][] = [[this.root, polys]];
    while (stack.length) {
      const [n, ps] = stack.pop()!;
      if (!n.plane) { for (const p of ps) out.push(p); continue; }
      const f: Poly[] = [], b: Poly[] = [];
      for (const p of ps) split(n.plane, p, this.eps, f, b, f, b);
      this.budget.ops += ps.length;
      if (this.budget.ops > 4e7) throw new Error('csg-budget');
      if (n.front) { if (f.length) stack.push([n.front, f]); } else for (const p of f) out.push(p);
      if (n.back) { if (b.length) stack.push([n.back, b]); }
    }
    return out;
  }
  clipTo(o: BSP) {
    const stack: Node[] = [this.root];
    while (stack.length) {
      const n = stack.pop()!;
      if (n.polys.length) n.polys = o.clipPolys(n.polys);
      if (n.front) stack.push(n.front);
      if (n.back) stack.push(n.back);
    }
  }
  all(): Poly[] {
    const out: Poly[] = [];
    const stack: Node[] = [this.root];
    while (stack.length) {
      const n = stack.pop()!;
      for (const p of n.polys) out.push(p);
      if (n.front) stack.push(n.front);
      if (n.back) stack.push(n.back);
    }
    return out;
  }
}

export function meshToPolys(m: Mesh): Poly[] {
  const out: Poly[] = [];
  const P = m.pos, I = m.idx;
  for (let t = 0; t < I.length; t += 3) {
    const a = 3 * I[t], b = 3 * I[t + 1], c = 3 * I[t + 2];
    const p = polyFrom([P[a], P[a + 1], P[a + 2], P[b], P[b + 1], P[b + 2], P[c], P[c + 1], P[c + 2]]);
    if (p) out.push(p);
  }
  return out;
}
export function polysToMesh(ps: Poly[]): Mesh {
  const pos: number[] = [], idx: number[] = [];
  for (const p of ps) {
    const base = pos.length / 3;
    const n = p.v.length / 3;
    for (const x of p.v) pos.push(x);
    for (let i = 1; i < n - 1; i++) idx.push(base, base + i, base + i + 1);
  }
  return { pos, idx };
}

export type BoolOp = 'union' | 'difference' | 'intersection';

/** Boolean of two closed meshes. Throws Error('csg-budget') when too expensive. */
export function meshBoolean(A: Mesh, B: Mesh, op: BoolOp, eps: number, budget = { ops: 0 }): Mesh {
  const a = new BSP(meshToPolys(A), eps, budget);
  const b = new BSP(meshToPolys(B), eps, budget);
  if (op === 'union') {
    a.clipTo(b); b.clipTo(a); b.invert(); b.clipTo(a); b.invert(); a.build(b.all());
  } else if (op === 'difference') {
    a.invert(); a.clipTo(b); b.clipTo(a); b.invert(); b.clipTo(a); b.invert(); a.build(b.all()); a.invert();
  } else {
    a.invert(); b.clipTo(a); b.invert(); a.clipTo(b); b.clipTo(a); a.build(b.all()); a.invert();
  }
  return polysToMesh(a.all());
}

/** Subtract several cutters from A in one go (cutters are unioned implicitly by sequential clipping). */
export function meshSubtractMany(A: Mesh, cutters: Mesh[], eps: number, budget = { ops: 0 }): Mesh {
  let cur = A;
  for (const c of cutters) cur = meshBoolean(cur, c, 'difference', eps, budget);
  return cur;
}

/**
 * Remove T-junctions left by BSP splitting: vertices lying in the interior of another
 * triangle's edge are inserted into that triangle (centroid fan). Keeps the surface the
 * same but makes the mesh edge-conforming, so feature edges and normals come out clean.
 */
export function fixTJunctions(m: Mesh, eps: number): Mesh {
  const P = m.pos, I = m.idx;
  const nv0 = P.length / 3;
  if (!I.length) return m;
  // weld
  const q = 1 / (eps * 4);
  const key = new Map<string, number>();
  const V: number[] = [];
  const remap = new Int32Array(nv0);
  for (let i = 0; i < nv0; i++) {
    const k = `${Math.round(P[3 * i] * q)},${Math.round(P[3 * i + 1] * q)},${Math.round(P[3 * i + 2] * q)}`;
    let v = key.get(k);
    if (v === undefined) { v = V.length / 3; V.push(P[3 * i], P[3 * i + 1], P[3 * i + 2]); key.set(k, v); }
    remap[i] = v;
  }
  const nv = V.length / 3;
  const T: number[] = [];
  for (let t = 0; t < I.length; t += 3) {
    const a = remap[I[t]], b = remap[I[t + 1]], c = remap[I[t + 2]];
    if (a !== b && b !== c && a !== c) T.push(a, b, c);
  }
  // grid over vertices
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < nv; i++) { const x = V[3 * i], y = V[3 * i + 1], z = V[3 * i + 2]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z; }
  const ext = Math.max(x1 - x0, y1 - y0, z1 - z0, eps);
  const res = Math.max(1, Math.min(64, Math.round(Math.cbrt(nv) * 1.5)));
  const h = ext / res + eps;
  const cell = (x: number, y: number, z: number) => (Math.floor((x - x0) / h) * 73 + Math.floor((y - y0) / h)) * 73 + Math.floor((z - z0) / h);
  const grid = new Map<number, number[]>();
  for (let i = 0; i < nv; i++) { const c = cell(V[3 * i], V[3 * i + 1], V[3 * i + 2]); let l = grid.get(c); if (!l) grid.set(c, (l = [])); l.push(i); }
  const onEdge = new Map<number, number[]>(); // edge key -> sorted vertex list (by t)
  const edgePts = (u: number, v: number): number[] => {
    const ek = u < v ? u * nv + v : v * nv + u;
    const got = onEdge.get(ek);
    if (got) return u < v ? got : got.slice().reverse();
    const ax = V[3 * u], ay = V[3 * u + 1], az = V[3 * u + 2];
    const dx = V[3 * v] - ax, dy = V[3 * v + 1] - ay, dz = V[3 * v + 2] - az;
    const L2 = dx * dx + dy * dy + dz * dz;
    const found: [number, number][] = [];
    const cx0 = Math.floor((Math.min(ax, ax + dx) - eps - x0) / h), cx1 = Math.floor((Math.max(ax, ax + dx) + eps - x0) / h);
    const cy0 = Math.floor((Math.min(ay, ay + dy) - eps - y0) / h), cy1 = Math.floor((Math.max(ay, ay + dy) + eps - y0) / h);
    const cz0 = Math.floor((Math.min(az, az + dz) - eps - z0) / h), cz1 = Math.floor((Math.max(az, az + dz) + eps - z0) / h);
    if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) * (cz1 - cz0 + 1) <= 4096 && L2 > 0) {
      for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) for (let cz = cz0; cz <= cz1; cz++) {
        const l = grid.get((cx * 73 + cy) * 73 + cz);
        if (!l) continue;
        for (const w of l) {
          if (w === u || w === v) continue;
          const px = V[3 * w] - ax, py = V[3 * w + 1] - ay, pz = V[3 * w + 2] - az;
          const t = (px * dx + py * dy + pz * dz) / L2;
          if (t <= 1e-9 || t >= 1 - 1e-9) continue;
          const ex = px - t * dx, ey = py - t * dy, ez = pz - t * dz;
          if (ex * ex + ey * ey + ez * ez <= eps * eps * 4) found.push([t, w]);
        }
      }
    }
    found.sort((p, q2) => p[0] - q2[0]);
    const lst = found.map((f) => f[1]);
    onEdge.set(ek, u < v ? lst : lst.slice().reverse());
    return lst;
  };
  const outIdx: number[] = [];
  for (let t = 0; t < T.length; t += 3) {
    const a = T[t], b = T[t + 1], c = T[t + 2];
    const e0 = edgePts(a, b), e1 = edgePts(b, c), e2 = edgePts(c, a);
    if (!e0.length && !e1.length && !e2.length) { outIdx.push(a, b, c); continue; }
    const loop = [a, ...e0, b, ...e1, c, ...e2];
    const ci = V.length / 3;
    V.push((V[3 * a] + V[3 * b] + V[3 * c]) / 3, (V[3 * a + 1] + V[3 * b + 1] + V[3 * c + 1]) / 3, (V[3 * a + 2] + V[3 * b + 2] + V[3 * c + 2]) / 3);
    for (let k = 0; k < loop.length; k++) outIdx.push(ci, loop[k], loop[(k + 1) % loop.length]);
  }
  return { pos: V, idx: outIdx };
}
