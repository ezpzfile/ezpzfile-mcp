// IGES-specific parametric surfaces, written from the IGES 5.3 entity definitions (sections 4.15
// parametric spline surface 114, 4.16 ruled surface 118). Inverse mapping (xyz -> u,v) and the
// curvature-adaptive grid steps follow our own B-spline surface code in surf.ts.

import type { Surface } from './surf.ts';

/** generic surface from an evaluator over [u0,u1] x [v0,v1]: grid seeds, Newton inverse, adaptive steps */
export function numericSurface(kind: string, ev: (u: number, v: number, out: number[]) => void,
  u0: number, u1: number, v0: number, v1: number, gu: number, gv: number, ruledV = false): Surface {
  let GU = Math.max(8, Math.min(1024, gu)), GV = Math.max(8, Math.min(1024, gv));
  if (GU * GV > 4096) { const k = Math.sqrt(4096 / (GU * GV)); GU = Math.max(8, Math.round(GU * k)); GV = Math.max(8, Math.round(GV * k)); }
  if (GU * GV > 20000) { const k = Math.sqrt(20000 / (GU * GV)); GU = Math.max(4, Math.round(GU * k)); GV = Math.max(4, Math.round(GV * k)); }
  const eu0 = u0 - (u1 - u0) * 0.5, eu1 = u1 + (u1 - u0) * 0.5, ev0 = v0 - (v1 - v0) * 0.5, ev1 = v1 + (v1 - v0) * 0.5;
  const E = (u: number, v: number, out: number[]) => ev(Math.max(eu0, Math.min(eu1, u)), Math.max(ev0, Math.min(ev1, v)), out);
  // seed grid, normal turning and extent are built on first use (many faces only evaluate)
  let grid: number[][] = [];
  let ext = 0, turnU = 0, turnV = 0, ready = false;
  const hU = (u1 - u0) * 1e-6 || 1e-9, hV = (v1 - v0) * 1e-6 || 1e-9;
  const init = () => {
    ready = true;
    const q = [0, 0, 0];
    grid = [];
    for (let i = 0; i <= GU; i++) for (let j = 0; j <= GV; j++) {
      const u = u0 + ((u1 - u0) * i) / GU, v = v0 + ((v1 - v0) * j) / GV;
      E(u, v, q);
      grid.push([u, v, q[0], q[1], q[2]]);
    }
    for (const g of grid) ext = Math.max(ext, Math.abs(g[2]), Math.abs(g[3]), Math.abs(g[4]));
    const gp = (a: number, b: number) => grid[Math.max(0, Math.min(GU, a)) * (GV + 1) + Math.max(0, Math.min(GV, b))];
    const N: (number[] | null)[] = [];
    for (let i = 0; i <= GU; i++) for (let j = 0; j <= GV; j++) {
      const pu = gp(i + 1, j), mu = gp(i - 1, j), pv = gp(i, j + 1), mv = gp(i, j - 1);
      const a = [pu[2] - mu[2], pu[3] - mu[3], pu[4] - mu[4]], b = [pv[2] - mv[2], pv[3] - mv[3], pv[4] - mv[4]];
      const n = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
      const l = Math.hypot(n[0], n[1], n[2]);
      N.push(l > 0 ? [n[0] / l, n[1] / l, n[2] / l] : null);
    }
    const ang = (a: number[] | null, b: number[] | null) => (a && b ? Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) : 0);
    for (let j = 0; j <= GV; j++) { let t = 0; for (let i = 0; i < GU; i++) t += ang(N[i * (GV + 1) + j], N[(i + 1) * (GV + 1) + j]); turnU = Math.max(turnU, t); }
    for (let i = 0; i <= GU; i++) { let t = 0; for (let j = 0; j < GV; j++) t += ang(N[i * (GV + 1) + j], N[i * (GV + 1) + j + 1]); turnV = Math.max(turnV, t); }
  };
  const newton = (p: number[], u: number, v: number): number[] => {
    const S = [0, 0, 0], A = [0, 0, 0], B = [0, 0, 0];
    let d = Infinity;
    for (let it = 0; it < 14; it++) {
      E(u, v, S);
      const r = [p[0] - S[0], p[1] - S[1], p[2] - S[2]];
      d = Math.hypot(r[0], r[1], r[2]);
      if (d < ext * 1e-12) break;
      E(u + hU, v, A); E(u - hU, v, B);
      const Su = [(A[0] - B[0]) / (2 * hU), (A[1] - B[1]) / (2 * hU), (A[2] - B[2]) / (2 * hU)];
      E(u, v + hV, A); E(u, v - hV, B);
      const Sv = [(A[0] - B[0]) / (2 * hV), (A[1] - B[1]) / (2 * hV), (A[2] - B[2]) / (2 * hV)];
      const a = Su[0] * Su[0] + Su[1] * Su[1] + Su[2] * Su[2], b = Su[0] * Sv[0] + Su[1] * Sv[1] + Su[2] * Sv[2], c = Sv[0] * Sv[0] + Sv[1] * Sv[1] + Sv[2] * Sv[2];
      const e = Su[0] * r[0] + Su[1] * r[1] + Su[2] * r[2], f = Sv[0] * r[0] + Sv[1] * r[1] + Sv[2] * r[2];
      const det = a * c - b * b;
      if (!(Math.abs(det) > 1e-300)) break;
      let du = (c * e - b * f) / det, dv = (a * f - b * e) / det;
      const mu = (u1 - u0) * 0.25 || 1, mv = (v1 - v0) * 0.25 || 1;
      du = Math.max(-mu, Math.min(mu, du)); dv = Math.max(-mv, Math.min(mv, dv));
      u = Math.max(eu0, Math.min(eu1, u + du)); v = Math.max(ev0, Math.min(ev1, v + dv));
      if (Math.abs(du) < (u1 - u0) * 1e-12 && Math.abs(dv) < (v1 - v0) * 1e-12) break;
    }
    E(u, v, S);
    return [u, v, Math.hypot(p[0] - S[0], p[1] - S[1], p[2] - S[2])];
  };
  const angStep = Math.PI / 16;
  return {
    kind, perU: 0, perV: 0, flip: false, ruledV,
    eval: E,
    inv(p, hint) {
      if (!ready) init();
      let best: number[] | null = null;
      if (hint) { best = newton(p, Math.max(eu0, Math.min(eu1, hint[0])), Math.max(ev0, Math.min(ev1, hint[1]))); if (best[2] < ext * 1e-7 + 1e-12) return best; }
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
    stepsU: (du) => { if (!ready) init(); return Math.max(1, Math.min(400, Math.ceil(((Math.abs(du) / (u1 - u0 || 1)) * turnU) / angStep))); },
    stepsV: (dv) => { if (!ready) init(); return ruledV ? 1 : Math.max(1, Math.min(400, Math.ceil(((Math.abs(dv) / (v1 - v0 || 1)) * turnV) / angStep))); },
    singular: () => false,
  };
}

/**
 * Parametric spline surface (114): bicubic patches. TU (M+1 breakpoints), TV (N+1 breakpoints),
 * coef[i][j] = 48 numbers for patch i (u) j (v): 16 for x, y, z each, in the order
 * A B C D E F G H K L M N O P Q R with x = sum over s^a t^b, a = k % 4, b = k / 4 (k = 0..15).
 */
export function spline114(TU: number[], TV: number[], coef: number[][][]): Surface {
  const M = TU.length - 1, N = TV.length - 1;
  const seg = (T: number[], n: number, x: number) => { let i = 0; while (i < n - 1 && x >= T[i + 1]) i++; return i; };
  const ev = (u: number, v: number, out: number[]) => {
    const i = seg(TU, M, u), j = seg(TV, N, v);
    const s = u - TU[i], t = v - TV[j];
    const c = coef[i][j];
    const sp = [1, s, s * s, s * s * s], tp = [1, t, t * t, t * t * t];
    for (let k = 0; k < 3; k++) {
      let r = 0;
      for (let m = 0; m < 16; m++) r += c[16 * k + m] * sp[m & 3] * tp[m >> 2];
      out[k] = r;
    }
  };
  return numericSurface('spline114', ev, TU[0], TU[M], TV[0], TV[N], M * 6, N * 6);
}

/** polyline parametrised on [0,1], either by arc length or by point index (uniform parameter samples) */
export function polyParam(P: number[][], byLength: boolean): (t: number, out: number[]) => void {
  const n = P.length;
  const s = new Float64Array(n);
  for (let i = 1; i < n; i++) s[i] = s[i - 1] + (byLength ? Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1], P[i][2] - P[i - 1][2]) : 1);
  const L = s[n - 1] || 1;
  for (let i = 0; i < n; i++) s[i] /= L;
  return (t, out) => {
    if (n === 1) { out[0] = P[0][0]; out[1] = P[0][1]; out[2] = P[0][2]; return; }
    t = Math.max(0, Math.min(1, t));
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (s[m] <= t) lo = m; else hi = m; }
    const d = s[hi] - s[lo], f = d > 0 ? (t - s[lo]) / d : 0;
    for (let k = 0; k < 3; k++) out[k] = P[lo][k] + (P[hi][k] - P[lo][k]) * f;
  };
}

/** ruled surface (118) between two sampled curves, u along the curves, v across (straight) */
export function ruled118(C1: number[][], C2: number[][], byLength: boolean): Surface {
  const f1 = polyParam(C1, byLength), f2 = polyParam(C2, byLength);
  const a = [0, 0, 0], b = [0, 0, 0];
  const ev = (u: number, v: number, out: number[]) => {
    f1(u, a); f2(u, b);
    for (let k = 0; k < 3; k++) out[k] = a[k] + (b[k] - a[k]) * v;
  };
  return numericSurface('ruled', ev, 0, 1, 0, 1, Math.max(C1.length, C2.length) * 2, 8, true);
}
