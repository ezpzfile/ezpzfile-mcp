// Geometry helpers for the IFC reader: affine matrices, polygon triangulation (ear clipping
// with hole bridging), extrusion / revolution / sweep mesh builders. Own implementation.

/** Affine 3x4 matrix, row major: [r0c0 r0c1 r0c2 tx, r1c0 r1c1 r1c2 ty, r2c0 r2c1 r2c2 tz] */
export type M = Float64Array;

export function ident(): M { const m = new Float64Array(12); m[0] = m[5] = m[10] = 1; return m; }
export function fromAxes(o: number[], x: number[], y: number[], z: number[]): M {
  const m = new Float64Array(12);
  m[0] = x[0]; m[4] = x[1]; m[8] = x[2];
  m[1] = y[0]; m[5] = y[1]; m[9] = y[2];
  m[2] = z[0]; m[6] = z[1]; m[10] = z[2];
  m[3] = o[0]; m[7] = o[1]; m[11] = o[2];
  return m;
}
export function mul(a: M, b: M): M {
  const m = new Float64Array(12);
  for (let r = 0; r < 3; r++) {
    const a0 = a[r * 4], a1 = a[r * 4 + 1], a2 = a[r * 4 + 2];
    m[r * 4] = a0 * b[0] + a1 * b[4] + a2 * b[8];
    m[r * 4 + 1] = a0 * b[1] + a1 * b[5] + a2 * b[9];
    m[r * 4 + 2] = a0 * b[2] + a1 * b[6] + a2 * b[10];
    m[r * 4 + 3] = a0 * b[3] + a1 * b[7] + a2 * b[11] + a[r * 4 + 3];
  }
  return m;
}
export function isIdent(m: M): boolean {
  return m[0] === 1 && m[5] === 1 && m[10] === 1 && !m[1] && !m[2] && !m[3] && !m[4] && !m[6] && !m[7] && !m[8] && !m[9] && !m[11];
}
export function det3(m: M): number {
  return m[0] * (m[5] * m[10] - m[6] * m[9]) - m[1] * (m[4] * m[10] - m[6] * m[8]) + m[2] * (m[4] * m[9] - m[5] * m[8]);
}
export function inv(m: M): M {
  const d = det3(m) || 1e-300;
  const r = new Float64Array(12);
  r[0] = (m[5] * m[10] - m[6] * m[9]) / d; r[1] = (m[2] * m[9] - m[1] * m[10]) / d; r[2] = (m[1] * m[6] - m[2] * m[5]) / d;
  r[4] = (m[6] * m[8] - m[4] * m[10]) / d; r[5] = (m[0] * m[10] - m[2] * m[8]) / d; r[6] = (m[2] * m[4] - m[0] * m[6]) / d;
  r[8] = (m[4] * m[9] - m[5] * m[8]) / d; r[9] = (m[1] * m[8] - m[0] * m[9]) / d; r[10] = (m[0] * m[5] - m[1] * m[4]) / d;
  r[3] = -(r[0] * m[3] + r[1] * m[7] + r[2] * m[11]);
  r[7] = -(r[4] * m[3] + r[5] * m[7] + r[6] * m[11]);
  r[11] = -(r[8] * m[3] + r[9] * m[7] + r[10] * m[11]);
  return r;
}
export function applyM(m: M, p: number[] | Float64Array, out: number[]) {
  const x = p[0], y = p[1], z = p[2];
  out[0] = m[0] * x + m[1] * y + m[2] * z + m[3];
  out[1] = m[4] * x + m[5] * y + m[6] * z + m[7];
  out[2] = m[8] * x + m[9] * y + m[10] * z + m[11];
}
/** transform a flat xyz array in place */
export function transformPos(m: M, P: number[] | Float64Array) {
  for (let i = 0; i < P.length; i += 3) {
    const x = P[i], y = P[i + 1], z = P[i + 2];
    P[i] = m[0] * x + m[1] * y + m[2] * z + m[3];
    P[i + 1] = m[4] * x + m[5] * y + m[6] * z + m[7];
    P[i + 2] = m[8] * x + m[9] * y + m[10] * z + m[11];
  }
}

export const sub3 = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const dot3 = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross3 = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len3 = (a: number[]) => Math.hypot(a[0], a[1], a[2]);
export function norm3(a: number[]): number[] { const l = len3(a); return l > 1e-300 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 1]; }

/** Simple mesh: flat positions and triangle indices */
export interface Mesh { pos: number[]; idx: number[] }
export const emptyMesh = (): Mesh => ({ pos: [], idx: [] });
export function appendMesh(dst: Mesh, src: Mesh) {
  const base = dst.pos.length / 3;
  for (let i = 0; i < src.pos.length; i++) dst.pos.push(src.pos[i]);
  for (let i = 0; i < src.idx.length; i++) dst.idx.push(src.idx[i] + base);
}
export function signedVolume(m: Mesh): number {
  const P = m.pos, I = m.idx;
  let v = 0;
  // relative to first vertex to limit cancellation
  const ox = P[0] || 0, oy = P[1] || 0, oz = P[2] || 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = 3 * I[t], b = 3 * I[t + 1], c = 3 * I[t + 2];
    const ax = P[a] - ox, ay = P[a + 1] - oy, az = P[a + 2] - oz;
    const bx = P[b] - ox, by = P[b + 1] - oy, bz = P[b + 2] - oz;
    const cx = P[c] - ox, cy = P[c + 1] - oy, cz = P[c + 2] - oz;
    v += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return v / 6;
}
export function flipMesh(m: Mesh) { const I = m.idx; for (let t = 0; t < I.length; t += 3) { const x = I[t + 1]; I[t + 1] = I[t + 2]; I[t + 2] = x; } }
export function orientOutward(m: Mesh) { if (signedVolume(m) < 0) flipMesh(m); }
export function meshBBox(P: ArrayLike<number>): [number, number, number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < P.length; i += 3) {
    const x = P[i], y = P[i + 1], z = P[i + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  return [x0, y0, z0, x1, y1, z1];
}

// ------------------------------------------------------------------ 2D polygons
/** flat [x0,y0,x1,y1,...] */
export type Loop2 = number[];
export function area2(L: Loop2): number {
  let a = 0;
  const n = L.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) a += (L[2 * j] - L[2 * i]) * (L[2 * j + 1] + L[2 * i + 1]);
  return a / 2;
}
export function reverseLoop(L: Loop2): Loop2 {
  const o: number[] = [];
  for (let i = L.length - 2; i >= 0; i -= 2) o.push(L[i], L[i + 1]);
  return o;
}
/** remove consecutive duplicates (and closing duplicate) */
export function cleanLoop(L: Loop2, eps: number): Loop2 {
  const o: number[] = [];
  for (let i = 0; i < L.length; i += 2) {
    const n = o.length;
    if (n >= 2 && Math.abs(o[n - 2] - L[i]) <= eps && Math.abs(o[n - 1] - L[i + 1]) <= eps) continue;
    o.push(L[i], L[i + 1]);
  }
  while (o.length >= 4 && Math.abs(o[0] - o[o.length - 2]) <= eps && Math.abs(o[1] - o[o.length - 1]) <= eps) o.length -= 2;
  return o;
}

/**
 * Triangulate a polygon with holes. Returns triangle indices into the concatenation
 * [outer, hole0, hole1, ...] (vertex units). Outer is made CCW and holes CW internally;
 * the returned triangles are CCW in the plane.
 */
/** test hook: when `on`, every triangulate() call records its loops and result (used by facecheck.mjs) */
export const triLog: { on: boolean; items: { loops: Loop2[]; tri: number[]; extra?: number[] }[] } = { on: false, items: [] };

export function triangulate(outer: Loop2, holes: Loop2[] = []): number[] {
  const r = triangulateImpl(outer, holes);
  if (triLog.on) triLog.items.push({ loops: [outer, ...holes], tri: r });
  return r;
}
function triangulateImpl(outer: Loop2, holes: Loop2[] = []): number[] {
  // the outer boundary encloses the others, so it is the largest loop (some files flag a hole as outer)
  if (holes.length) {
    let bi = -1, ba = Math.abs(area2(outer));
    holes.forEach((h, i) => { const x = Math.abs(area2(h)); if (x > ba) { ba = x; bi = i; } });
    if (bi >= 0) {
      const loops = [outer, ...holes];
      const order = [bi + 1, ...loops.map((_, i) => i).filter((i) => i !== bi + 1)];
      const offs: number[] = []; let o = 0; for (const L of loops) { offs.push(o); o += L.length / 2; }
      const newOffs: number[] = []; let q = 0; for (const k of order) { newOffs.push(q); q += loops[k].length / 2; }
      const t = triangulateImpl(loops[order[0]], order.slice(1).map((k) => loops[k]));
      return t.map((v) => { let j = order.length - 1; while (j > 0 && v < newOffs[j]) j--; return offs[order[j]] + (v - newOffs[j]); });
    }
  }
  const pts: number[] = [];
  const n0 = outer.length / 2;
  if (n0 < 3) return [];
  for (const v of outer) pts.push(v);
  let ring: number[] = [];
  const outerCCW = area2(outer) > 0;
  for (let i = 0; i < n0; i++) ring.push(outerCCW ? i : n0 - 1 - i);
  if (n0 === 3 && !holes.length) return [ring[0], ring[1], ring[2]];
  // holes
  const hs: { ring: number[]; maxX: number }[] = [];
  let base = n0;
  for (const h of holes) {
    const n = h.length / 2;
    if (n < 3) { for (const v of h) pts.push(v); base += n; continue; }
    for (const v of h) pts.push(v);
    const cw = area2(h) < 0;
    const r: number[] = [];
    for (let i = 0; i < n; i++) r.push(base + (cw ? i : n - 1 - i));
    let mx = -Infinity;
    for (const k of r) if (pts[2 * k] > mx) mx = pts[2 * k];
    hs.push({ ring: r, maxX: mx });
    base += n;
  }
  hs.sort((a, b) => b.maxX - a.maxX);
  for (const h of hs) ring = bridgeHole(pts, ring, h.ring);
  return earClip(pts, ring);
}

function bridgeHole(P: number[], ring: number[], hole: number[]): number[] {
  // rightmost hole vertex
  let hi = 0;
  for (let i = 1; i < hole.length; i++) if (P[2 * hole[i]] > P[2 * hole[hi]]) hi = i;
  const mx = P[2 * hole[hi]], my = P[2 * hole[hi] + 1];
  // ray to +x: nearest edge intersection
  let best = -1, bestX = Infinity;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    const ax = P[2 * a], ay = P[2 * a + 1], bx = P[2 * b], by = P[2 * b + 1];
    if ((ay > my) === (by > my) && !(ay === my || by === my)) continue;
    if (ay === by) continue;
    const t = (my - ay) / (by - ay);
    if (t < 0 || t > 1) continue;
    const x = ax + t * (bx - ax);
    if (x < mx - 1e-12) continue;
    if (x < bestX) { bestX = x; best = ax > bx ? i : (i + 1) % n; }
  }
  if (best < 0) {
    // fallback: nearest vertex
    let d = Infinity;
    for (let i = 0; i < n; i++) { const dd = (P[2 * ring[i]] - mx) ** 2 + (P[2 * ring[i] + 1] - my) ** 2; if (dd < d) { d = dd; best = i; } }
  } else {
    // check reflex vertices inside triangle (M, I, Pbest); choose the one with smallest angle
    const px = P[2 * ring[best]], py = P[2 * ring[best] + 1];
    const ix = bestX, iy = my;
    let cand = best, candAng = Infinity, candD = Infinity;
    for (let i = 0; i < n; i++) {
      const k = ring[i];
      const x = P[2 * k], y = P[2 * k + 1];
      if (x < mx) continue;
      if (!pointInTri(x, y, mx, my, ix, iy, px, py) && i !== best) continue;
      const ang = Math.abs(Math.atan2(y - my, x - mx));
      const dd = (x - mx) ** 2 + (y - my) ** 2;
      if (ang < candAng - 1e-12 || (Math.abs(ang - candAng) <= 1e-12 && dd < candD)) {
        // must be reflex or the original candidate
        const pa = ring[(i - 1 + n) % n], pb = ring[(i + 1) % n];
        const cr = (P[2 * k] - P[2 * pa]) * (P[2 * pb + 1] - P[2 * k + 1]) - (P[2 * k + 1] - P[2 * pa + 1]) * (P[2 * pb] - P[2 * k]);
        if (i === best || cr <= 0) { cand = i; candAng = ang; candD = dd; }
      }
    }
    best = cand;
  }
  // the bridge target may exist several times in the ring (earlier bridges duplicate vertices):
  // take the copy whose interior wedge contains the hole vertex, otherwise the bridge cuts the ring
  {
    const bx = P[2 * ring[best]], by = P[2 * ring[best] + 1];
    const left = (ax: number, ay: number, cx: number, cy: number, px: number, py: number) => (cx - ax) * (py - ay) - (cy - ay) * (px - ax);
    const inWedge = (i: number) => {
      const a = ring[(i - 1 + n) % n], c = ring[(i + 1) % n];
      const ax = P[2 * a], ay = P[2 * a + 1], cx = P[2 * c], cy = P[2 * c + 1];
      const convex = left(ax, ay, bx, by, cx, cy) >= 0;
      const l1 = left(ax, ay, bx, by, mx, my) > 0, l2 = left(bx, by, cx, cy, mx, my) > 0;
      return convex ? l1 && l2 : l1 || l2;
    };
    if (!inWedge(best)) {
      for (let i = 0; i < n; i++) {
        if (i === best || P[2 * ring[i]] !== bx || P[2 * ring[i] + 1] !== by) continue;
        if (inWedge(i)) { best = i; break; }
      }
    }
  }
  const out: number[] = [];
  for (let i = 0; i <= best; i++) out.push(ring[i]);
  for (let i = 0; i <= hole.length; i++) out.push(hole[(hi + i) % hole.length]);
  out.push(ring[best]);
  for (let i = best + 1; i < n; i++) out.push(ring[i]);
  return out;
}

function pointInTri(x: number, y: number, ax: number, ay: number, bx: number, by: number, cx: number, cy: number): boolean {
  const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by);
  const d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy);
  const d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

function earClip(P: number[], ring: number[]): number[] {
  const n = ring.length;
  const out: number[] = [];
  if (n < 3) return out;
  const prev = new Int32Array(n), next = new Int32Array(n);
  for (let i = 0; i < n; i++) { prev[i] = (i - 1 + n) % n; next[i] = (i + 1) % n; }
  const X = (i: number) => P[2 * ring[i]], Y = (i: number) => P[2 * ring[i] + 1];
  const cross = (a: number, b: number, c: number) => (X(b) - X(a)) * (Y(c) - Y(b)) - (Y(b) - Y(a)) * (X(c) - X(b));
  let remaining = n, cur = 0, stall = 0;
  // scale-relative epsilon
  let ext = 0;
  for (let i = 0; i < n; i++) ext = Math.max(ext, Math.abs(X(i)), Math.abs(Y(i)));
  const eps = (ext || 1) * (ext || 1) * 1e-14;
  const isEar = (i: number): boolean => {
    const a = prev[i], c = next[i];
    if (cross(a, i, c) <= eps) return false;
    const ax = X(a), ay = Y(a), bx = X(i), by = Y(i), cx = X(c), cy = Y(c);
    let j = next[c];
    while (j !== a) {
      const x = X(j), y = Y(j);
      // ignore vertices coincident with triangle corners (bridge duplicates)
      if (!((x === ax && y === ay) || (x === bx && y === by) || (x === cx && y === cy))) {
        if (cross(prev[j], j, next[j]) <= eps && pointInTri(x, y, ax, ay, bx, by, cx, cy)) return false;
      }
      j = next[j];
    }
    return true;
  };
  while (remaining > 3) {
    if (isEar(cur)) {
      const a = prev[cur], c = next[cur];
      out.push(ring[a], ring[cur], ring[c]);
      next[a] = c; prev[c] = a; remaining--;
      cur = c; stall = 0;
      continue;
    }
    cur = next[cur];
    if (++stall > remaining) {
      // degenerate: drop a collinear/flat vertex or force an ear
      let k = cur, found = -1;
      for (let s = 0; s < remaining; s++) { if (Math.abs(cross(prev[k], k, next[k])) <= eps) { found = k; break; } k = next[k]; }
      const v = found >= 0 ? found : cur;
      const a = prev[v], c = next[v];
      if (found < 0) out.push(ring[a], ring[v], ring[c]);
      next[a] = c; prev[c] = a; remaining--;
      cur = c; stall = 0;
    }
  }
  const a = prev[cur], c = next[cur];
  if (Math.abs(cross(a, cur, c)) > eps) out.push(ring[a], ring[cur], ring[c]);
  return out;
}

/** Newell normal of a 3D loop (flat xyz) */
export function newell(P: number[]): number[] {
  let nx = 0, ny = 0, nz = 0;
  const n = P.length / 3;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x0 = P[3 * i], y0 = P[3 * i + 1], z0 = P[3 * i + 2], x1 = P[3 * j], y1 = P[3 * j + 1], z1 = P[3 * j + 2];
    nx += (y0 - y1) * (z0 + z1); ny += (z0 - z1) * (x0 + x1); nz += (x0 - x1) * (y0 + y1);
  }
  return [nx, ny, nz];
}

/**
 * Triangulate a planar 3D face (outer loop + holes as flat xyz arrays). Returns indices into the
 * concatenated vertex list, wound like the outer loop.
 */
export function triangulate3DFill(outer: number[], holes: number[][] = []): { tri: number[]; extra3: number[] } {
  const n = outer.length / 3;
  if (n < 3) return { tri: [], extra3: [] };
  if (n === 3 && !holes.length) return { tri: [0, 1, 2], extra3: [] };
  const N = newell(outer);
  const ax = Math.abs(N[0]), ay = Math.abs(N[1]), az = Math.abs(N[2]);
  if (ax + ay + az < 1e-300) return { tri: [], extra3: [] };
  if (n === 4 && !holes.length) {
    // quad: choose diagonal that keeps both triangles facing N
    const tri = (a: number, b: number, c: number) => {
      const u = [outer[3 * b] - outer[3 * a], outer[3 * b + 1] - outer[3 * a + 1], outer[3 * b + 2] - outer[3 * a + 2]];
      const v = [outer[3 * c] - outer[3 * a], outer[3 * c + 1] - outer[3 * a + 1], outer[3 * c + 2] - outer[3 * a + 2]];
      return dot3(cross3(u, v), N);
    };
    if (tri(0, 1, 2) > 0 && tri(0, 2, 3) > 0) return { tri: [0, 1, 2, 0, 2, 3], extra3: [] };
    if (tri(1, 2, 3) > 0 && tri(1, 3, 0) > 0) return { tri: [1, 2, 3, 1, 3, 0], extra3: [] };
  }
  // project dropping the dominant axis; keep orientation
  let i0: number, i1: number, flip: boolean;
  if (az >= ax && az >= ay) { i0 = 0; i1 = 1; flip = N[2] < 0; }
  else if (ax >= ay) { i0 = 1; i1 = 2; flip = N[0] < 0; }
  else { i0 = 2; i1 = 0; flip = N[1] < 0; }
  const proj = (L: number[]) => { const o: number[] = []; for (let i = 0; i < L.length; i += 3) o.push(L[i + i0], flip ? -L[i + i1] : L[i + i1]); return o; };
  const o2 = proj(outer);
  const h2 = holes.map(proj);
  const r = triangulateFill(o2, h2);
  // lift new fill vertices back onto the face plane
  const extra3: number[] = [];
  if (r.extra.length) {
    let d = 0;
    for (let i = 0; i < n; i++) d += N[0] * outer[3 * i] + N[1] * outer[3 * i + 1] + N[2] * outer[3 * i + 2];
    d /= n;
    const k = 3 - i0 - i1;
    for (let i = 0; i < r.extra.length; i += 2) {
      const p = [0, 0, 0];
      p[i0] = r.extra[i]; p[i1] = flip ? -r.extra[i + 1] : r.extra[i + 1];
      p[k] = (d - N[i0] * p[i0] - N[i1] * p[i1]) / N[k];
      extra3.push(p[0], p[1], p[2]);
    }
  }
  return { tri: r.tri, extra3 };
}
/** indices only (no fill vertices): kept for callers that cannot add vertices */
export function triangulate3D(outer: number[], holes: number[][] = []): number[] {
  const r = triangulate3DFill(outer, holes);
  if (!r.extra3.length) return r.tri;
  const N = newell(outer);
  const ax = Math.abs(N[0]), ay = Math.abs(N[1]), az = Math.abs(N[2]);
  let i0: number, i1: number, flip: boolean;
  if (az >= ax && az >= ay) { i0 = 0; i1 = 1; flip = N[2] < 0; } else if (ax >= ay) { i0 = 1; i1 = 2; flip = N[0] < 0; } else { i0 = 2; i1 = 0; flip = N[1] < 0; }
  const proj = (L: number[]) => { const o: number[] = []; for (let i = 0; i < L.length; i += 3) o.push(L[i + i0], flip ? -L[i + i1] : L[i + i1]); return o; };
  return triangulate(proj(outer), holes.map(proj));
}

// ------------------------------------------------------------------ mesh builders
export interface Profile { outer: Loop2; holes: Loop2[] }

/** Extrude profiles along dir by depth (dir in profile coordinates, not necessarily unit). */
export function extrude(profiles: Profile[], dir: number[], depth: number): Mesh {
  const m = emptyMesh();
  const d = norm3(dir);
  const ex = d[0] * depth, ey = d[1] * depth, ez = d[2] * depth;
  for (const pr of profiles) {
    const loops = [pr.outer, ...pr.holes].filter((l) => l.length >= 6);
    if (!loops.length || pr.outer.length < 6) continue;
    const tf = triangulateFill(pr.outer, pr.holes.filter((l) => l.length >= 6));
    const tri = tf.tri;
    // vertices: bottom ring(s) then top ring(s)
    const base = m.pos.length / 3;
    let nv = 0;
    for (const L of [pr.outer, ...pr.holes.filter((l) => l.length >= 6)]) nv += L.length / 2;
    const all: number[] = [];
    for (const L of [pr.outer, ...pr.holes.filter((l) => l.length >= 6)]) for (const v of L) all.push(v);
    for (let i = 0; i < nv; i++) m.pos.push(all[2 * i], all[2 * i + 1], 0);
    for (let i = 0; i < nv; i++) m.pos.push(all[2 * i] + ex, all[2 * i + 1] + ey, ez);
    const up = ez >= 0;
    // even-odd fill vertices (self-crossing profile): own cap vertices after the rings
    const ne = tf.extra.length / 2;
    const eb = m.pos.length / 3;
    for (let i = 0; i < ne; i++) m.pos.push(tf.extra[2 * i], tf.extra[2 * i + 1], 0);
    for (let i = 0; i < ne; i++) m.pos.push(tf.extra[2 * i] + ex, tf.extra[2 * i + 1] + ey, ez);
    const capB = (i: number) => (i < nv ? base + i : eb + i - nv), capT = (i: number) => (i < nv ? base + nv + i : eb + ne + i - nv);
    for (let t = 0; t < tri.length; t += 3) {
      const a = tri[t], b = tri[t + 1], c = tri[t + 2];
      if (ne) {
        if (up) { m.idx.push(capB(a), capB(c), capB(b)); m.idx.push(capT(a), capT(b), capT(c)); }
        else { m.idx.push(capB(a), capB(b), capB(c)); m.idx.push(capT(a), capT(c), capT(b)); }
        continue;
      }
      // tri is CCW (normal +z). bottom faces -dir, top faces +dir
      if (up) { m.idx.push(base + a, base + c, base + b); m.idx.push(base + nv + a, base + nv + b, base + nv + c); }
      else { m.idx.push(base + a, base + b, base + c); m.idx.push(base + nv + a, base + nv + c, base + nv + b); }
    }
    // sides
    let off = 0;
    const outerCCW = area2(pr.outer) > 0;
    const loopsUsed = [pr.outer, ...pr.holes.filter((l) => l.length >= 6)];
    for (let li = 0; li < loopsUsed.length; li++) {
      const L = loopsUsed[li];
      const n = L.length / 2;
      // desired: outer CCW, holes CW (so side normals point out of the material)
      const ccw = area2(L) > 0;
      const wantCCW = li === 0 ? true : false;
      const rev = ccw !== wantCCW;
      void outerCCW;
      for (let i = 0; i < n; i++) {
        let a = off + i, b = off + (i + 1) % n;
        if (rev) { const x = a; a = b; b = x; }
        const a0 = base + a, b0 = base + b, a1 = base + nv + a, b1 = base + nv + b;
        if (up) m.idx.push(a0, b0, b1, a0, b1, a1); else m.idx.push(a0, b1, b0, a0, a1, b1);
      }
      off += n;
    }
  }
  return m;
}

/** Revolve profiles (in XY plane) around an axis through o with direction ax, by angle (radians). */
export function revolve(profiles: Profile[], o: number[], ax: number[], angle: number, segs: number): Mesh {
  const m = emptyMesh();
  const a = norm3(ax);
  const full = Math.abs(angle) >= 2 * Math.PI - 1e-6;
  const ns = Math.max(3, segs);
  const rings = full ? ns : ns + 1;
  const rot = (p: number[], th: number) => {
    // Rodrigues rotation of p around (o, a)
    const v = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
    const c = Math.cos(th), s = Math.sin(th);
    const k = cross3(a, v), d = dot3(a, v);
    return [o[0] + v[0] * c + k[0] * s + a[0] * d * (1 - c), o[1] + v[1] * c + k[1] * s + a[1] * d * (1 - c), o[2] + v[2] * c + k[2] * s + a[2] * d * (1 - c)];
  };
  for (const pr of profiles) {
    const loops = [pr.outer, ...pr.holes].filter((l) => l.length >= 6);
    for (const L of loops) {
      const n = L.length / 2;
      const base = m.pos.length / 3;
      for (let r = 0; r < rings; r++) {
        const th = (angle * r) / ns;
        for (let i = 0; i < n; i++) { const p = rot([L[2 * i], L[2 * i + 1], 0], th); m.pos.push(p[0], p[1], p[2]); }
      }
      for (let r = 0; r < ns; r++) {
        const r0 = base + r * n, r1 = base + ((r + 1) % rings) * n;
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          m.idx.push(r0 + i, r0 + j, r1 + j, r0 + i, r1 + j, r1 + i);
        }
      }
    }
    if (!full) {
      const tri = triangulate(pr.outer, pr.holes.filter((l) => l.length >= 6));
      const all: number[] = [];
      for (const L of loops) for (const v of L) all.push(v);
      const nv = all.length / 2;
      const b0 = m.pos.length / 3;
      for (let i = 0; i < nv; i++) m.pos.push(all[2 * i], all[2 * i + 1], 0);
      const b1 = m.pos.length / 3;
      for (let i = 0; i < nv; i++) { const p = rot([all[2 * i], all[2 * i + 1], 0], angle); m.pos.push(p[0], p[1], p[2]); }
      for (let t = 0; t < tri.length; t += 3) {
        m.idx.push(b0 + tri[t], b0 + tri[t + 2], b0 + tri[t + 1]);
        m.idx.push(b1 + tri[t], b1 + tri[t + 1], b1 + tri[t + 2]);
      }
    }
  }
  orientOutward(m);
  return m;
}

/** frames along a polyline (parallel transport). Returns per-point [tangent, u, v] */
export function pathFrames(path: number[][], ref?: number[] | null): { t: number[]; u: number[]; v: number[] }[] {
  const n = path.length;
  const tans: number[][] = [];
  for (let i = 0; i < n; i++) {
    const a = path[Math.max(0, i - 1)], b = path[Math.min(n - 1, i + 1)];
    let t: number[];
    if (i > 0 && i < n - 1) {
      const t0 = norm3(sub3(path[i], path[i - 1])), t1 = norm3(sub3(path[i + 1], path[i]));
      t = norm3([t0[0] + t1[0], t0[1] + t1[1], t0[2] + t1[2]]);
      if (len3([t0[0] + t1[0], t0[1] + t1[1], t0[2] + t1[2]]) < 1e-9) t = t1;
    } else t = norm3(sub3(b, a));
    tans.push(t);
  }
  const out: { t: number[]; u: number[]; v: number[] }[] = [];
  let u: number[];
  const t0 = tans[0];
  if (ref) {
    u = sub3(ref, t0.map((x) => x * dot3(ref, t0)));
    if (len3(u) < 1e-9) u = Math.abs(t0[2]) < 0.9 ? cross3([0, 0, 1], t0) : cross3([1, 0, 0], t0);
  } else u = Math.abs(t0[2]) < 0.9 ? cross3([0, 0, 1], t0) : cross3([1, 0, 0], t0);
  u = norm3(u);
  for (let i = 0; i < n; i++) {
    const t = tans[i];
    if (ref) {
      let uu = sub3(ref, t.map((x) => x * dot3(ref, t)));
      if (len3(uu) > 1e-9) u = norm3(uu);
      else { uu = sub3(u, t.map((x) => x * dot3(u, t))); u = norm3(uu); }
    } else if (i > 0) {
      const uu = sub3(u, t.map((x) => x * dot3(u, t)));
      u = len3(uu) > 1e-9 ? norm3(uu) : u;
    }
    out.push({ t, u, v: cross3(t, u) });
  }
  return out;
}

/** Sweep profiles (2D, profile x -> frame u, y -> frame v) along a 3D polyline. */
export function sweep(profiles: Profile[], path: number[][], ref?: number[] | null, closedPath = false): Mesh {
  const m = emptyMesh();
  if (path.length < 2) return m;
  const fr = pathFrames(path, ref);
  // miter scale at joints
  const scaleAt = (i: number) => {
    if (i === 0 || i === path.length - 1) return 1;
    const t0 = norm3(sub3(path[i], path[i - 1]));
    const c = dot3(t0, fr[i].t);
    return c > 0.2 ? 1 / c : 5;
  };
  for (const pr of profiles) {
    const loops = [pr.outer, ...pr.holes].filter((l) => l.length >= 6);
    const ringsStart: number[] = [];
    for (const L of loops) {
      const n = L.length / 2;
      const base = m.pos.length / 3;
      ringsStart.push(base);
      for (let k = 0; k < path.length; k++) {
        const { t, u, v } = fr[k];
        const s = scaleAt(k);
        const p = path[k];
        for (let i = 0; i < n; i++) {
          const x = L[2 * i], y = L[2 * i + 1];
          // miter: stretch the component along the bend direction
          let px = u[0] * x + v[0] * y, py = u[1] * x + v[1] * y, pz = u[2] * x + v[2] * y;
          if (s !== 1) {
            const t0 = norm3(sub3(path[k], path[k - 1]));
            const bend = norm3(sub3(t0, t.map((q) => q * dot3(t0, t))));
            const along = px * bend[0] + py * bend[1] + pz * bend[2];
            px += bend[0] * along * (s - 1); py += bend[1] * along * (s - 1); pz += bend[2] * along * (s - 1);
          }
          m.pos.push(p[0] + px, p[1] + py, p[2] + pz);
        }
      }
      for (let k = 0; k < path.length - 1; k++) {
        const r0 = base + k * n, r1 = base + (k + 1) * n;
        for (let i = 0; i < n; i++) { const j = (i + 1) % n; m.idx.push(r0 + i, r0 + j, r1 + j, r0 + i, r1 + j, r1 + i); }
      }
    }
    if (!closedPath && loops.length) {
      const tri = triangulate(pr.outer, pr.holes.filter((l) => l.length >= 6));
      // caps reuse ring vertices of first and last path points
      const capIdx = (k: number) => {
        const map: number[] = [];
        loops.forEach((L, li) => { const n = L.length / 2; for (let i = 0; i < n; i++) map.push(ringsStart[li] + k * n + i); });
        return map;
      };
      const c0 = capIdx(0), c1 = capIdx(path.length - 1);
      for (let t = 0; t < tri.length; t += 3) {
        m.idx.push(c0[tri[t]], c0[tri[t + 2]], c0[tri[t + 1]]);
        m.idx.push(c1[tri[t]], c1[tri[t + 1]], c1[tri[t + 2]]);
      }
    }
  }
  orientOutward(m);
  return m;
}

export function circleLoop(r: number, segs: number, cx = 0, cy = 0): Loop2 {
  const o: number[] = [];
  for (let i = 0; i < segs; i++) { const a = (2 * Math.PI * i) / segs; o.push(cx + r * Math.cos(a), cy + r * Math.sin(a)); }
  return o;
}

export function boxMesh(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Mesh {
  const pos = [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1];
  const idx = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7];
  return { pos, idx };
}

export function sphereMesh(r: number, segs: number): Mesh {
  const m = emptyMesh();
  const rings = Math.max(4, segs >> 1);
  for (let i = 0; i <= rings; i++) {
    const th = (Math.PI * i) / rings;
    for (let j = 0; j < segs; j++) {
      const ph = (2 * Math.PI * j) / segs;
      m.pos.push(r * Math.sin(th) * Math.cos(ph), r * Math.sin(th) * Math.sin(ph), r * Math.cos(th));
    }
  }
  for (let i = 0; i < rings; i++) for (let j = 0; j < segs; j++) {
    const a = i * segs + j, b = i * segs + (j + 1) % segs, c = (i + 1) * segs + j, d = (i + 1) * segs + (j + 1) % segs;
    if (i > 0) m.idx.push(a, c, b);
    if (i < rings - 1) m.idx.push(b, c, d);
  }
  orientOutward(m);
  return m;
}

/** cone / cylinder along +z from z=0 to h, radii r0 (bottom) r1 (top) */
export function coneMesh(r0: number, r1: number, h: number, segs: number): Mesh {
  const m = emptyMesh();
  for (let j = 0; j < segs; j++) { const a = (2 * Math.PI * j) / segs; m.pos.push(r0 * Math.cos(a), r0 * Math.sin(a), 0); }
  for (let j = 0; j < segs; j++) { const a = (2 * Math.PI * j) / segs; m.pos.push(r1 * Math.cos(a), r1 * Math.sin(a), h); }
  m.pos.push(0, 0, 0, 0, 0, h);
  const cb = 2 * segs, ct = 2 * segs + 1;
  for (let j = 0; j < segs; j++) {
    const k = (j + 1) % segs;
    m.idx.push(j, k, segs + k, j, segs + k, segs + j);
    m.idx.push(cb, k, j);
    m.idx.push(ct, segs + j, segs + k);
  }
  orientOutward(m);
  return m;
}
/**
 * Even-odd scanline fill of loops (flat x,y arrays) into triangles. Used when a loop polygon
 * self-intersects (thin sliver faces sampled coarser than their width), where ear clipping would
 * cover area outside the region. Returns new vertices (x,y pairs) and triangle indices.
 */
export function evenOddFill(loops: Loop2[]): { pts: number[]; tri: number[] } {
  const edges: number[][] = [];
  const ys: number[] = [];
  for (const L of loops) {
    const n = L.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const x0 = L[2 * i], y0 = L[2 * i + 1], x1 = L[2 * j], y1 = L[2 * j + 1];
      ys.push(y0);
      if (y0 !== y1) edges.push(y0 < y1 ? [x0, y0, x1, y1] : [x1, y1, x0, y0]);
    }
  }
  // add y of edge crossings so slabs contain no crossings (only when the count is manageable)
  if (edges.length < 3000) {
    for (let a = 0; a < edges.length; a++) for (let b = a + 1; b < edges.length; b++) {
      const e = edges[a], f = edges[b];
      if (e[3] <= f[1] || f[3] <= e[1]) continue;
      const dx1 = e[2] - e[0], dy1 = e[3] - e[1], dx2 = f[2] - f[0], dy2 = f[3] - f[1];
      const den = dx1 * dy2 - dy1 * dx2;
      if (Math.abs(den) < 1e-300) continue;
      const t = ((f[0] - e[0]) * dy2 - (f[1] - e[1]) * dx2) / den, s = ((f[0] - e[0]) * dy1 - (f[1] - e[1]) * dx1) / den;
      if (t > 0 && t < 1 && s > 0 && s < 1) ys.push(e[1] + dy1 * t);
    }
  }
  ys.sort((p, q) => p - q);
  const Y: number[] = [];
  for (const y of ys) if (!Y.length || y - Y[Y.length - 1] > 1e-12 * (Math.abs(y) + 1)) Y.push(y);
  const pts: number[] = [], tri: number[] = [];
  const xAt = (e: number[], y: number) => e[0] + ((e[2] - e[0]) * (y - e[1])) / (e[3] - e[1]);
  for (let k = 0; k + 1 < Y.length; k++) {
    const y0 = Y[k], y1 = Y[k + 1], ym = (y0 + y1) / 2;
    const xs: [number, number, number][] = [];
    for (const e of edges) if (e[1] <= ym && e[3] > ym) xs.push([xAt(e, ym), xAt(e, y0), xAt(e, y1)]);
    xs.sort((p, q) => p[0] - q[0]);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const a = xs[i], b = xs[i + 1];
      const base = pts.length / 2;
      pts.push(a[1], y0, b[1], y0, b[2], y1, a[2], y1);
      tri.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  return { pts, tri };
}

/**
 * triangulate() plus a check: when the loops cross themselves (sliver faces, inconsistent input) ear
 * clipping covers area outside the region; then the even-odd fill is used instead. Triangle indices
 * refer to [outer, holes..., extra] where extra holds the new (x,y) vertices of the fill.
 */
export function triangulateFill(outer: Loop2, holes: Loop2[] = []): { tri: number[]; extra: number[] } {
  const tri = triangulate(outer, holes);
  const loops = [outer, ...holes];
  let nv = 0, npts = 0;
  for (const L of loops) { nv += L.length / 2; npts += L.length / 2; }
  if (npts > 5000 || nv < 4) return { tri, extra: [] };
  const all = loops.flat();
  let ta = 0;
  for (let k = 0; k < tri.length; k += 3) { const a = tri[k], b = tri[k + 1], c = tri[k + 2]; ta += Math.abs((all[2 * b] - all[2 * a]) * (all[2 * c + 1] - all[2 * a + 1]) - (all[2 * c] - all[2 * a]) * (all[2 * b + 1] - all[2 * a + 1])) / 2; }
  const areas = loops.map((L) => Math.abs(area2(L)));
  const big = Math.max(...areas);
  const expected = big - (areas.reduce((x, y) => x + y, 0) - big);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < all.length; i += 2) { x0 = Math.min(x0, all[i]); x1 = Math.max(x1, all[i]); y0 = Math.min(y0, all[i + 1]); y1 = Math.max(y1, all[i + 1]); }
  if (ta <= Math.abs(expected) * 1.02 + ((x1 - x0) ** 2 + (y1 - y0) ** 2) * 1e-7) return { tri, extra: [] };
  const eo = evenOddFill(loops.filter((L) => L.length >= 6));
  const res = { tri: eo.tri.map((i) => i + nv), extra: eo.pts };
  if (triLog.on && triLog.items.length) { const last = triLog.items[triLog.items.length - 1]; last.tri = res.tri; last.extra = res.extra; }
  return res;
}
