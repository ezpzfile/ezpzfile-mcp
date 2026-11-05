// Parametric surfaces for B-rep face trimming: evaluation (u,v) -> xyz and inverse mapping
// xyz -> (u,v), per ISO 10303-42 surface definitions. Own implementation.

import type { M } from './geom.ts';
import { inv, applyM } from './geom.ts';

export interface Surface {
  kind: string;
  perU: number;           // period in u (0 = not periodic)
  perV: number;
  flip: boolean;          // true when (u,v) of this mapping is swapped relative to the ISO 10303-42 normal
  ruledV: boolean;        // straight along v (no subdivision needed in v)
  eval(u: number, v: number, out: number[]): void;
  /** inverse; hint = previous (u,v) for continuity. Returns [u, v, residual distance] */
  inv(p: number[], hint: number[] | null): number[];
  /** number of grid steps for a parameter range */
  stepsU(du: number): number;
  stepsV(dv: number): number;
  /** u is undefined at this point (pole / apex) */
  singular(p: number[]): boolean;
  /** v of the pole nearest to a point (sphere / cone apex) */
  poleV?(p: number[]): number;
}

const TWO_PI = Math.PI * 2;

function local(m: M, im: M, p: number[], q: number[]) { applyM(im, p, q); void m; }

export function planeSurface(m: M): Surface {
  const im = inv(m);
  const q = [0, 0, 0];
  return {
    kind: 'plane', perU: 0, perV: 0, flip: false, ruledV: true,
    eval(u, v, out) { applyM(m, [u, v, 0], out); },
    inv(p) { local(m, im, p, q); return [q[0], q[1], Math.abs(q[2])]; },
    stepsU: () => 1, stepsV: () => 1, singular: () => false,
  };
}

export function cylinderSurface(m: M, r: number, segsFull: number): Surface {
  const im = inv(m);
  const q = [0, 0, 0];
  return {
    kind: 'cylinder', perU: TWO_PI, perV: 0, flip: false, ruledV: true,
    eval(u, v, out) { applyM(m, [r * Math.cos(u), r * Math.sin(u), v], out); },
    inv(p) { local(m, im, p, q); return [Math.atan2(q[1], q[0]), q[2], Math.abs(Math.hypot(q[0], q[1]) - r)]; },
    stepsU: (du) => Math.max(1, Math.ceil((Math.abs(du) / TWO_PI) * segsFull - 1e-6)),
    stepsV: () => 1,
    singular: () => false,
  };
}

/** semi angle in radians; radius at v = 0 */
export function coneSurface(m: M, r: number, semi: number, segsFull: number): Surface {
  const im = inv(m);
  const q = [0, 0, 0];
  const t = Math.tan(semi);
  const apexV = Math.abs(t) > 1e-12 ? -r / t : -Infinity;
  return {
    kind: 'cone', perU: TWO_PI, perV: 0, flip: false, ruledV: true,
    eval(u, v, out) { const rr = r + v * t; applyM(m, [rr * Math.cos(u), rr * Math.sin(u), v], out); },
    inv(p) { local(m, im, p, q); const v = q[2]; return [Math.atan2(q[1], q[0]), v, Math.abs(Math.hypot(q[0], q[1]) - Math.abs(r + v * t)) * Math.cos(semi)]; },
    stepsU: (du) => Math.max(1, Math.ceil((Math.abs(du) / TWO_PI) * segsFull - 1e-6)),
    stepsV: () => 1,
    singular(p) { local(m, im, p, q); return Math.hypot(q[0], q[1]) < Math.max(1e-9, Math.abs(r) * 1e-7 + 1e-9); },
    poleV: () => apexV,
  };
}

export function sphereSurface(m: M, r: number, segsFull: number): Surface {
  const im = inv(m);
  const q = [0, 0, 0];
  return {
    kind: 'sphere', perU: TWO_PI, perV: 0, flip: false, ruledV: false,
    eval(u, v, out) { const c = Math.cos(v); applyM(m, [r * c * Math.cos(u), r * c * Math.sin(u), r * Math.sin(v)], out); },
    inv(p) { local(m, im, p, q); const h = Math.hypot(q[0], q[1]); return [Math.atan2(q[1], q[0]), Math.atan2(q[2], h), Math.abs(Math.hypot(h, q[2]) - r)]; },
    stepsU: (du) => Math.max(1, Math.ceil((Math.abs(du) / TWO_PI) * segsFull - 1e-6)),
    stepsV: (dv) => Math.max(1, Math.ceil((Math.abs(dv) / TWO_PI) * segsFull - 1e-6)),
    singular(p) { local(m, im, p, q); return Math.hypot(q[0], q[1]) < r * 1e-7 + 1e-12; },
    poleV(p) { local(m, im, p, q); return q[2] >= 0 ? Math.PI / 2 : -Math.PI / 2; },
  };
}

export function torusSurface(m: M, R: number, r: number, segsMajor: number, segsMinor: number): Surface {
  const im = inv(m);
  const q = [0, 0, 0];
  return {
    kind: 'torus', perU: TWO_PI, perV: TWO_PI, flip: false, ruledV: false,
    eval(u, v, out) { const rr = R + r * Math.cos(v); applyM(m, [rr * Math.cos(u), rr * Math.sin(u), r * Math.sin(v)], out); },
    inv(p) {
      local(m, im, p, q);
      const u = Math.atan2(q[1], q[0]);
      const rho = Math.hypot(q[0], q[1]) - R;
      return [u, Math.atan2(q[2], rho), Math.abs(Math.hypot(rho, q[2]) - Math.abs(r))];
    },
    stepsU: (du) => Math.max(1, Math.ceil((Math.abs(du) / TWO_PI) * segsMajor - 1e-6)),
    stepsV: (dv) => Math.max(1, Math.ceil((Math.abs(dv) / TWO_PI) * segsMinor - 1e-6)),
    singular: () => false,
  };
}

/** polyline helper: nearest parameter (segment index + fraction) of point (in a projected 2D/3D space) */
function nearestOnPolyline(P: number[][], p: number[], dims: number): [number, number] {
  let best = 0, bd = Infinity;
  for (let i = 0; i < P.length - 1; i++) {
    const a = P[i], b = P[i + 1];
    let ab2 = 0, ap = 0;
    for (let k = 0; k < dims; k++) { const d = b[k] - a[k]; ab2 += d * d; ap += (p[k] - a[k]) * d; }
    let t = ab2 > 0 ? ap / ab2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    let d2 = 0;
    for (let k = 0; k < dims; k++) { const x = a[k] + (b[k] - a[k]) * t - p[k]; d2 += x * x; }
    if (d2 < bd) { bd = d2; best = i + t; }
  }
  return [best, Math.sqrt(bd)];
}
function atPolyline(P: number[][], s: number, out: number[], dims: number) {
  const n = P.length - 1;
  const i = Math.max(0, Math.min(n - 1, Math.floor(s)));
  const t = s - i;
  for (let k = 0; k < dims; k++) out[k] = P[i][k] + (P[i + 1][k] - P[i][k]) * t;
}

/** surface of revolution of a profile polyline (3D points) about axis (o, d). u = angle, v = profile index */
export function revolutionSurface(profile: number[][], o: number[], d: number[], segsFull: number): Surface {
  // axis frame: z = d, x = from axis towards the first profile point not on the axis
  const z = d;
  let x = [1, 0, 0];
  for (const p of profile) {
    const w = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
    const s = w[0] * z[0] + w[1] * z[1] + w[2] * z[2];
    const r = [w[0] - s * z[0], w[1] - s * z[1], w[2] - s * z[2]];
    const l = Math.hypot(r[0], r[1], r[2]);
    if (l > 1e-9) { x = [r[0] / l, r[1] / l, r[2] / l]; break; }
  }
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  const rz = profile.map((p) => {
    const w = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
    const s = w[0] * z[0] + w[1] * z[1] + w[2] * z[2];
    return [Math.hypot(w[0] - s * z[0], w[1] - s * z[1], w[2] - s * z[2]), s];
  });
  const tmp = [0, 0];
  return {
    kind: 'revolution', perU: TWO_PI, perV: 0, flip: true, ruledV: false,
    eval(u, v, out) {
      atPolyline(rz, v, tmp, 2);
      const c = Math.cos(u) * tmp[0], s = Math.sin(u) * tmp[0];
      for (let k = 0; k < 3; k++) out[k] = o[k] + x[k] * c + y[k] * s + z[k] * tmp[1];
    },
    inv(p) {
      const w = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
      const a = w[0] * x[0] + w[1] * x[1] + w[2] * x[2], b = w[0] * y[0] + w[1] * y[1] + w[2] * y[2], h = w[0] * z[0] + w[1] * z[1] + w[2] * z[2];
      const [v, dist] = nearestOnPolyline(rz, [Math.hypot(a, b), h], 2);
      return [Math.atan2(b, a), v, dist];
    },
    stepsU: (du) => Math.max(1, Math.ceil((Math.abs(du) / TWO_PI) * segsFull - 1e-6)),
    stepsV: (dv) => Math.max(1, Math.ceil(Math.abs(dv))),
    singular(p) {
      const w = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
      const s = w[0] * z[0] + w[1] * z[1] + w[2] * z[2];
      return Math.hypot(w[0] - s * z[0], w[1] - s * z[1], w[2] - s * z[2]) < 1e-9;
    },
  };
}

/** linear extrusion of a profile polyline along unit direction d. u = profile index, v = distance */
export function extrusionSurface(profile: number[][], d: number[]): Surface {
  const o = profile[0];
  // project profile into the plane through o perpendicular to d
  const proj = profile.map((p) => { const s = (p[0] - o[0]) * d[0] + (p[1] - o[1]) * d[1] + (p[2] - o[2]) * d[2]; return [p[0] - s * d[0], p[1] - s * d[1], p[2] - s * d[2], s]; });
  const tmp = [0, 0, 0, 0];
  return {
    kind: 'extrusion', perU: 0, perV: 0, flip: false, ruledV: true,
    eval(u, v, out) {
      atPolyline(profile, u, tmp, 3);
      out[0] = tmp[0] + d[0] * v; out[1] = tmp[1] + d[1] * v; out[2] = tmp[2] + d[2] * v;
    },
    inv(p) {
      const s = (p[0] - o[0]) * d[0] + (p[1] - o[1]) * d[1] + (p[2] - o[2]) * d[2];
      const pp = [p[0] - s * d[0], p[1] - s * d[1], p[2] - s * d[2]];
      const [u, dist] = nearestOnPolyline(proj, pp, 3);
      atPolyline(proj, u, tmp, 4);
      return [u, s - tmp[3], dist];
    },
    stepsU: (du) => Math.max(1, Math.ceil(Math.abs(du))),
    stepsV: () => 1,
    singular: () => false,
  };
}

// ------------------------------------------------------------------ B-splines
export function findSpan(n: number, p: number, t: number, U: number[]): number {
  if (t >= U[n + 1]) return n;
  if (t <= U[p]) return p;
  let lo = p, hi = n + 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (t < U[mid]) hi = mid; else lo = mid; }
  return lo;
}
const LEFT = new Float64Array(64), RIGHT = new Float64Array(64);
export function basisFuns(i: number, t: number, p: number, U: number[], N: number[] | Float64Array) {
  const left = LEFT, right = RIGHT;
  N[0] = 1;
  for (let j = 1; j <= p; j++) {
    left[j] = t - U[i + 1 - j]; right[j] = U[i + j] - t;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const den = right[r + 1] + left[j - r];
      const tmp = den !== 0 ? N[r] / den : 0;
      N[r] = saved + right[r + 1] * tmp;
      saved = left[j - r] * tmp;
    }
    N[j] = saved;
  }
}

const NU = new Float64Array(64), NV = new Float64Array(64);
export interface BCurve { p: number; P: number[][]; U: number[]; W: number[] | null; closed: boolean }
export function bcurveEval(c: BCurve, t: number, out: number[]) {
  const n = c.P.length - 1;
  const span = findSpan(n, c.p, t, c.U);
  const N = NU;
  basisFuns(span, t, c.p, c.U, N);
  let x = 0, y = 0, z = 0, w = 0;
  for (let j = 0; j <= c.p; j++) {
    const k = span - c.p + j;
    const q = c.P[k], wt = c.W ? c.W[k] : 1;
    const b = N[j] * wt;
    x += b * q[0]; y += b * q[1]; z += b * (q[2] || 0); w += b;
  }
  out[0] = x / w; out[1] = y / w; out[2] = z / w;
}
export function bcurveRange(c: BCurve): [number, number] { return [c.U[c.p], c.U[c.P.length]]; }
/** closest parameter to a point */
export function bcurveProject(c: BCurve, p: number[], samples: number[][] | null = null): number {
  const [t0, t1] = bcurveRange(c);
  const n = Math.max(16, c.P.length * 8);
  const q = [0, 0, 0];
  let bt = t0, bd = Infinity;
  for (let i = 0; i <= n; i++) {
    const t = t0 + ((t1 - t0) * i) / n;
    bcurveEval(c, t, q);
    const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2;
    if (d < bd) { bd = d; bt = t; }
  }
  void samples;
  // refine by golden section in the neighbourhood
  let a = Math.max(t0, bt - (t1 - t0) / n), b = Math.min(t1, bt + (t1 - t0) / n);
  const f = (t: number) => { bcurveEval(c, t, q); return (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2; };
  const g = 0.6180339887;
  let x1 = b - g * (b - a), x2 = a + g * (b - a), f1 = f(x1), f2 = f(x2);
  for (let k = 0; k < 40; k++) {
    if (f1 < f2) { b = x2; x2 = x1; f2 = f1; x1 = b - g * (b - a); f1 = f(x1); }
    else { a = x1; x1 = x2; f1 = f2; x2 = a + g * (b - a); f2 = f(x2); }
  }
  return (a + b) / 2;
}

export interface BSurf { pu: number; pv: number; P: number[][][]; U: number[]; V: number[]; W: number[][] | null }
export function bsurfEval(s: BSurf, u: number, v: number, out: number[]) {
  const nu = s.P.length - 1, nv = s.P[0].length - 1;
  const su = findSpan(nu, s.pu, u, s.U), sv = findSpan(nv, s.pv, v, s.V);
  const Nu = NU, Nv = NV;
  basisFuns(su, u, s.pu, s.U, Nu); basisFuns(sv, v, s.pv, s.V, Nv);
  let x = 0, y = 0, z = 0, w = 0;
  for (let i = 0; i <= s.pu; i++) {
    const row = s.P[su - s.pu + i], wr = s.W ? s.W[su - s.pu + i] : null;
    for (let j = 0; j <= s.pv; j++) {
      const k = sv - s.pv + j;
      const b = Nu[i] * Nv[j] * (wr ? wr[k] : 1);
      const q = row[k];
      x += b * q[0]; y += b * q[1]; z += b * q[2]; w += b;
    }
  }
  out[0] = x / w; out[1] = y / w; out[2] = z / w;
}

export function bsplineSurface(s: BSurf, closedU: boolean, closedV: boolean): Surface {
  const u0 = s.U[s.pu], u1 = s.U[s.P.length], v0 = s.V[s.pv], v1 = s.V[s.P[0].length];
  // grid for initial guesses
  // sample grid sized by the control net (so every span is visited), at most about 20000 points
  let GU = Math.max(8, Math.min(1024, (s.P.length - 1) * 2)), GV = Math.max(8, Math.min(1024, (s.P[0].length - 1) * 2));
  if (GU * GV > 20000) { const k = Math.sqrt(20000 / (GU * GV)); GU = Math.max(4, Math.round(GU * k)); GV = Math.max(4, Math.round(GV * k)); }
  const grid: number[][] = [];
  const q = [0, 0, 0];
  for (let i = 0; i <= GU; i++) for (let j = 0; j <= GV; j++) {
    const u = u0 + ((u1 - u0) * i) / GU, v = v0 + ((v1 - v0) * j) / GV;
    bsurfEval(s, u, v, q);
    grid.push([u, v, q[0], q[1], q[2]]);
  }
  let ext = 0;
  for (const g of grid) ext = Math.max(ext, Math.abs(g[2]), Math.abs(g[3]), Math.abs(g[4]));
  const hU = (u1 - u0) * 1e-6, hV = (v1 - v0) * 1e-6;
  // faces may be trimmed slightly beyond the patch: allow polynomial extension of the end spans
  const eu0 = u0 - (u1 - u0) * 0.5, eu1 = u1 + (u1 - u0) * 0.5, ev0 = v0 - (v1 - v0) * 0.5, ev1 = v1 + (v1 - v0) * 0.5;
  const newton = (p: number[], u: number, v: number): number[] => {
    const S = [0, 0, 0], A = [0, 0, 0], B = [0, 0, 0];
    let d = Infinity;
    for (let it = 0; it < 12; it++) {
      bsurfEval(s, u, v, S);
      const r = [p[0] - S[0], p[1] - S[1], p[2] - S[2]];
      d = Math.hypot(r[0], r[1], r[2]);
      if (d < ext * 1e-12) break;
      const ua = u + hU, ub = u - hU, va = v + hV, vb = v - hV;
      bsurfEval(s, ua, v, A); bsurfEval(s, ub, v, B);
      const Su = [(A[0] - B[0]) / (ua - ub), (A[1] - B[1]) / (ua - ub), (A[2] - B[2]) / (ua - ub)];
      bsurfEval(s, u, va, A); bsurfEval(s, u, vb, B);
      const Sv = [(A[0] - B[0]) / (va - vb), (A[1] - B[1]) / (va - vb), (A[2] - B[2]) / (va - vb)];
      const a = Su[0] * Su[0] + Su[1] * Su[1] + Su[2] * Su[2], b = Su[0] * Sv[0] + Su[1] * Sv[1] + Su[2] * Sv[2], c = Sv[0] * Sv[0] + Sv[1] * Sv[1] + Sv[2] * Sv[2];
      const e = Su[0] * r[0] + Su[1] * r[1] + Su[2] * r[2], f = Sv[0] * r[0] + Sv[1] * r[1] + Sv[2] * r[2];
      const det = a * c - b * b;
      if (!(Math.abs(det) > 1e-300)) break;
      let du = (c * e - b * f) / det, dv = (a * f - b * e) / det;
      // limit step
      const mu = (u1 - u0) * 0.25, mv = (v1 - v0) * 0.25;
      du = Math.max(-mu, Math.min(mu, du)); dv = Math.max(-mv, Math.min(mv, dv));
      u = Math.max(eu0, Math.min(eu1, u + du)); v = Math.max(ev0, Math.min(ev1, v + dv));
      if (Math.abs(du) < (u1 - u0) * 1e-12 && Math.abs(dv) < (v1 - v0) * 1e-12) break;
    }
    bsurfEval(s, u, v, S);
    d = Math.hypot(p[0] - S[0], p[1] - S[1], p[2] - S[2]);
    return [u, v, d];
  };
  // turning of the surface normal along u and along v (max over grid rows / columns), for adaptive steps
  const gp = (a: number, b: number) => grid[Math.max(0, Math.min(GU, a)) * (GV + 1) + Math.max(0, Math.min(GV, b))];
  const nrm = (i: number, j: number) => {
    const pu = gp(i + 1, j), mu = gp(i - 1, j), pv = gp(i, j + 1), mv = gp(i, j - 1);
    const a = [pu[2] - mu[2], pu[3] - mu[3], pu[4] - mu[4]], b = [pv[2] - mv[2], pv[3] - mv[3], pv[4] - mv[4]];
    const n = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const l = Math.hypot(n[0], n[1], n[2]);
    return l > 0 ? [n[0] / l, n[1] / l, n[2] / l] : null;
  };
  const N: (number[] | null)[] = [];
  for (let i = 0; i <= GU; i++) for (let j = 0; j <= GV; j++) N.push(nrm(i, j));
  const ang = (a: number[] | null, b: number[] | null) => (a && b ? Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) : 0);
  let turnU = 0, turnV = 0;
  for (let j = 0; j <= GV; j++) { let t = 0; for (let i = 0; i < GU; i++) t += ang(N[i * (GV + 1) + j], N[(i + 1) * (GV + 1) + j]); turnU = Math.max(turnU, t); }
  for (let i = 0; i <= GU; i++) { let t = 0; for (let j = 0; j < GV; j++) t += ang(N[i * (GV + 1) + j], N[i * (GV + 1) + j + 1]); turnV = Math.max(turnV, t); }
  const angStep = Math.PI / 16;
  return {
    kind: 'bspline', perU: 0, perV: 0, flip: false, ruledV: false,
    eval(u, v, out) { bsurfEval(s, Math.max(eu0, Math.min(eu1, u)), Math.max(ev0, Math.min(ev1, v)), out); },
    inv(p, hint) {
      let best: number[] | null = null;
      if (hint) { best = newton(p, Math.max(eu0, Math.min(eu1, hint[0])), Math.max(ev0, Math.min(ev1, hint[1]))); if (best[2] < ext * 1e-7 + 1e-12) return best; }
      // three nearest grid samples as starting points
      const c = [-1, -1, -1], cd = [Infinity, Infinity, Infinity];
      for (let k = 0; k < grid.length; k++) {
        const g = grid[k]; const d = (g[2] - p[0]) ** 2 + (g[3] - p[1]) ** 2 + (g[4] - p[2]) ** 2;
        if (d < cd[2]) { if (d < cd[0]) { c[2] = c[1]; cd[2] = cd[1]; c[1] = c[0]; cd[1] = cd[0]; c[0] = k; cd[0] = d; } else if (d < cd[1]) { c[2] = c[1]; cd[2] = cd[1]; c[1] = k; cd[1] = d; } else { c[2] = k; cd[2] = d; } }
      }
      for (const k of c) {
        if (k < 0) continue;
        const r = newton(p, grid[k][0], grid[k][1]);
        if (!best || r[2] < best[2]) best = r;
        if (best[2] < ext * 1e-7 + 1e-12) break;
      }
      return best!;
    },
    stepsU: (du) => Math.max(1, Math.min(400, Math.ceil(((Math.abs(du) / (u1 - u0 || 1)) * turnU) / angStep))),
    stepsV: (dv) => Math.max(1, Math.min(400, Math.ceil(((Math.abs(dv) / (v1 - v0 || 1)) * turnV) / angStep))),
    singular: () => false,
  };
  void closedU; void closedV;
}

/** offset of a basis surface by distance d along its normal (numerical normal) */
export function offsetSurface(b: Surface, d: number): Surface {
  const A = [0, 0, 0], B = [0, 0, 0], C = [0, 0, 0];
  const normal = (u: number, v: number, n: number[]) => {
    const h = 1e-6;
    b.eval(u + h, v, A); b.eval(u - h, v, B);
    const su = [A[0] - B[0], A[1] - B[1], A[2] - B[2]];
    b.eval(u, v + h, A); b.eval(u, v - h, B);
    const sv = [A[0] - B[0], A[1] - B[1], A[2] - B[2]];
    let nx = su[1] * sv[2] - su[2] * sv[1], ny = su[2] * sv[0] - su[0] * sv[2], nz = su[0] * sv[1] - su[1] * sv[0];
    const l = Math.hypot(nx, ny, nz) || 1;
    const sg = b.flip ? -1 : 1;
    n[0] = (sg * nx) / l; n[1] = (sg * ny) / l; n[2] = (sg * nz) / l;
  };
  return {
    ...b, kind: 'offset:' + b.kind,
    eval(u, v, out) { b.eval(u, v, out); normal(u, v, C); out[0] += d * C[0]; out[1] += d * C[1]; out[2] += d * C[2]; },
    inv(p, hint) {
      let r = b.inv(p, hint);
      normal(r[0], r[1], C);
      r = b.inv([p[0] - d * C[0], p[1] - d * C[1], p[2] - d * C[2]], [r[0], r[1]]);
      return r;
    },
  };
}
