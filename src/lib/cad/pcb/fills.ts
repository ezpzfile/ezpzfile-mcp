// Turn an even-odd set of rings into simple "fill" point lists without crossing bridges (own code).
// Every hole is joined to the boundary directly to its left by a horizontal cut (keyhole): the cut is the first edge
// hit by a ray going left from the hole's leftmost vertex, so it crosses nothing and is walked once each way.
// That keeps canvas / SVG even-odd fills free of the hairline seams that long crossing bridges leave.
import type { Ring } from './geom.ts';

export function ringsToFills(rings: Ring[]): number[][] {
  if (rings.length === 1) { const r = rings[0]; if (r.length < 6) return []; const a: number[] = new Array(r.length); for (let i = 0; i < r.length; i++) a[i] = r[i]; return [a]; }
  const rs = rings.filter((r) => r.length >= 6);
  if (rs.length === 0) return [];
  // nodes: flat arrays
  let N = 0;
  for (const r of rs) N += r.length / 2;
  const cap = N * 4 + 16;
  let X = new Float64Array(cap), Y = new Float64Array(cap), NX = new Int32Array(cap);
  let nn = 0;
  const node = (x: number, y: number) => {
    if (nn >= X.length) {
      const g = (a: Float64Array) => { const b = new Float64Array(a.length * 2); b.set(a); return b; };
      X = g(X); Y = g(Y); const n2 = new Int32Array(NX.length * 2); n2.set(NX); NX = n2;
    }
    X[nn] = x; Y[nn] = y; NX[nn] = -1; return nn++;
  };
  const first: number[] = [];
  const lefty: number[] = [];
  const predOf: number[] = [];
  for (const r of rs) {
    const n = r.length / 2;
    const f = nn;
    let lm = 0;
    for (let i = 0; i < n; i++) {
      node(r[i * 2], r[i * 2 + 1]);
      if (r[i * 2] < r[lm * 2] || (r[i * 2] === r[lm * 2] && r[i * 2 + 1] < r[lm * 2 + 1])) lm = i;
    }
    for (let i = 0; i < n; i++) NX[f + i] = f + ((i + 1) % n);
    first.push(f);
    lefty.push(f + lm);
    predOf.push(f + ((lm + n - 1) % n));
  }
  // edges by row bins: edge id = start node (original nodes only)
  const E = nn;
  let y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < E; i++) { if (Y[i] < y0) y0 = Y[i]; if (Y[i] > y1) y1 = Y[i]; }
  const rows = Math.max(1, Math.min(8192, Math.ceil(E / 6)));
  const rh = (y1 - y0) / rows || 1;
  const rowOf = (y: number) => Math.max(0, Math.min(rows - 1, Math.floor((y - y0) / rh)));
  const cnt = new Int32Array(rows + 1);
  for (let i = 0; i < E; i++) {
    const j = NX[i];
    if (Y[i] === Y[j]) continue;
    const a = rowOf(Math.min(Y[i], Y[j])), b = rowOf(Math.max(Y[i], Y[j]));
    for (let k = a; k <= b; k++) cnt[k + 1]++;
  }
  for (let k = 0; k < rows; k++) cnt[k + 1] += cnt[k];
  const fill = cnt.slice(0, rows);
  const list = new Int32Array(cnt[rows]);
  for (let i = 0; i < E; i++) {
    const j = NX[i];
    if (Y[i] === Y[j]) continue;
    const a = rowOf(Math.min(Y[i], Y[j])), b = rowOf(Math.max(Y[i], Y[j]));
    for (let k = a; k <= b; k++) list[fill[k]++] = i;
  }
  // ray cast left from every ring's leftmost vertex
  const hits: Array<{ e: number; t: number; x: number; y: number; ring: number }> = [];
  const isHole = new Uint8Array(rs.length);
  for (let r = 0; r < rs.length; r++) {
    const m = lefty[r];
    const mx = X[m], my = Y[m];
    const row = rowOf(my);
    let par = false, bestX = -Infinity, bestE = -1;
    for (let k = cnt[row]; k < cnt[row + 1]; k++) {
      const i = list[k];
      const j = NX[i];
      const ya = Y[i], yb = Y[j];
      if ((ya > my) === (yb > my)) continue;
      const xi = X[i] + ((my - ya) * (X[j] - X[i])) / (yb - ya);
      if (xi < mx) {
        par = !par;
        if (xi > bestX) { bestX = xi; bestE = i; }
      }
    }
    if (par && bestE >= 0) {
      isHole[r] = 1;
      const i = bestE, j = NX[i];
      const t = Math.abs(X[j] - X[i]) > Math.abs(Y[j] - Y[i]) ? (bestX - X[i]) / (X[j] - X[i]) : (my - Y[i]) / (Y[j] - Y[i]);
      hits.push({ e: i, t, x: bestX, y: my, ring: r });
    }
  }
  // insert the cut points (and their twins) on the hit edges, in order along each edge
  hits.sort((a, b) => a.e - b.e || a.t - b.t);
  const cutAt: Array<{ I: number; Id: number; ring: number }> = [];
  const lastOnEdge = new Map<number, number>();
  let k = 0;
  while (k < hits.length) {
    const e = hits[k].e;
    const end = NX[e];
    let prev = e;
    while (k < hits.length && hits[k].e === e) {
      const h = hits[k];
      const I = node(h.x, h.y), Id = node(h.x, h.y);
      NX[prev] = I; NX[I] = Id; NX[Id] = end;
      prev = Id;
      lastOnEdge.set(e, Id);
      cutAt.push({ I, Id, ring: h.ring });
      k++;
    }
  }
  // splice each hole: I -> M ... (around the hole) ... -> M' -> I' -> rest
  for (const c of cutAt) {
    const M = lefty[c.ring];
    const po = predOf[c.ring];
    const pred = lastOnEdge.get(po) ?? po;
    const Md = node(X[M], Y[M]);
    NX[pred] = Md;
    NX[Md] = c.Id;
    NX[c.I] = M;
  }
  const out: number[][] = [];
  for (let r = 0; r < rs.length; r++) {
    if (isHole[r]) continue;
    const pts: number[] = [];
    let p = first[r], guard = 0;
    do { pts.push(X[p], Y[p]); p = NX[p]; } while (p !== first[r] && p >= 0 && guard++ < nn);
    if (pts.length >= 6) out.push(pts);
  }
  return out;
}
