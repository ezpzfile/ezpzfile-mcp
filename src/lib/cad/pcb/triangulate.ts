// Even-odd polygon fill to triangles by horizontal slabs (own code). Robust for any ring set: between two vertex
// heights the edges crossing the slab are sorted and paired, and each pair gives a trapezoid (two triangles).
// Output: flat xy list, three points per triangle, counter-clockwise seen from +z.
import type { Ring } from './geom.ts';

export function triangulateRings(rings: Ring[], out: number[]): number {
  // edges (skip horizontal)
  const ex0: number[] = [], ey0: number[] = [], ex1: number[] = [], ey1: number[] = [];
  const ys: number[] = [];
  for (const r of rings) {
    const n = r.length;
    if (n < 6) continue;
    for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
      let ax = r[j], ay = r[j + 1], bx = r[i], by = r[i + 1];
      ys.push(by);
      if (ay === by) continue;
      if (ay > by) { const tx = ax, ty = ay; ax = bx; ay = by; bx = tx; by = ty; }
      ex0.push(ax); ey0.push(ay); ex1.push(bx); ey1.push(by);
    }
  }
  const E = ex0.length;
  if (!E) return 0;
  ys.sort((a, b) => a - b);
  const uy: number[] = [];
  for (const y of ys) if (!uy.length || y - uy[uy.length - 1] > 1e-12) uy.push(y);
  const order = Array.from({ length: E }, (_, i) => i).sort((a, b) => ey0[a] - ey0[b]);
  let next = 0;
  let active: number[] = [];
  let tris = 0;
  const xat = (e: number, y: number) => ex0[e] + ((y - ey0[e]) * (ex1[e] - ex0[e])) / (ey1[e] - ey0[e]);
  const emit = (ya: number, yb: number, act: number[], depth: number) => {
    const ym = (ya + yb) / 2;
    const xs = act.map((e) => ({ e, m: xat(e, ym) })).sort((p, q) => p.m - q.m);
    // edges that cross inside the slab change order: split the slab
    if (depth < 8) {
      let bad = false;
      for (let k = 1; k < xs.length && !bad; k++) {
        if (xat(xs[k - 1].e, ya) > xat(xs[k].e, ya) + 1e-9 || xat(xs[k - 1].e, yb) > xat(xs[k].e, yb) + 1e-9) bad = true;
      }
      if (bad) { emit(ya, ym, act, depth + 1); emit(ym, yb, act, depth + 1); return; }
    }
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const l = xs[k].e, r = xs[k + 1].e;
      const la = xat(l, ya), lb = xat(l, yb), ra = xat(r, ya), rb = xat(r, yb);
      if (ra - la > 1e-12) { out.push(la, ya, ra, ya, rb, yb); tris++; }
      if (rb - lb > 1e-12) { out.push(la, ya, rb, yb, lb, yb); tris++; }
    }
  };
  for (let s = 0; s + 1 < uy.length; s++) {
    const ya = uy[s], yb = uy[s + 1];
    while (next < E && ey0[order[next]] <= ya + 1e-12) active.push(order[next++]);
    active = active.filter((e) => ey1[e] > ya + 1e-12);
    const act = active.filter((e) => ey0[e] <= ya + 1e-12 && ey1[e] >= yb - 1e-12);
    if (act.length >= 2) emit(ya, yb, act, 0);
  }
  return tris;
}
