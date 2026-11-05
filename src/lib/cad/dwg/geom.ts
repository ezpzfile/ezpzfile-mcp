// 2D geometry helpers. Affine matrix [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f.
export type M2 = [number, number, number, number, number, number];
export const IDENT: M2 = [1, 0, 0, 1, 0, 0];

export function mul(p: M2, q: M2): M2 { // p after q
  return [
    p[0] * q[0] + p[2] * q[1], p[1] * q[0] + p[3] * q[1],
    p[0] * q[2] + p[2] * q[3], p[1] * q[2] + p[3] * q[3],
    p[0] * q[4] + p[2] * q[5] + p[4], p[1] * q[4] + p[3] * q[5] + p[5],
  ];
}
export function apx(m: M2, x: number, y: number): number { return m[0] * x + m[2] * y + m[4]; }
export function apy(m: M2, x: number, y: number): number { return m[1] * x + m[3] * y + m[5]; }
export function det(m: M2): number { return m[0] * m[3] - m[1] * m[2]; }
export function mscale(m: M2): number { return Math.sqrt(Math.abs(det(m))) || Math.hypot(m[0], m[1]); }
export function isSimilar(m: M2): boolean {
  const sx = Math.hypot(m[0], m[1]), sy = Math.hypot(m[2], m[3]);
  const dot = m[0] * m[2] + m[1] * m[3];
  return Math.abs(sx - sy) <= 1e-6 * Math.max(sx, sy) && Math.abs(dot) <= 1e-6 * sx * sy;
}

// Arbitrary axis algorithm (public DXF reference): OCS x/y axes for a normal N
export function ocsAxes(n: number[]): [number[], number[]] {
  let [nx, ny, nz] = n;
  const l = Math.hypot(nx, ny, nz) || 1;
  nx /= l; ny /= l; nz /= l;
  let ax: number[];
  if (Math.abs(nx) < 1 / 64 && Math.abs(ny) < 1 / 64) ax = [nz, 0, -nx]; // Wy x N
  else ax = [-ny, nx, 0]; // Wz x N
  const al = Math.hypot(ax[0], ax[1], ax[2]); ax = [ax[0] / al, ax[1] / al, ax[2] / al];
  const ay = [ny * ax[2] - nz * ax[1], nz * ax[0] - nx * ax[2], nx * ax[1] - ny * ax[0]];
  return [ax, ay];
}
// matrix mapping OCS (x, y) at elevation z to WCS (x, y) (orthographic plan projection)
export function ocsMatrix(n: number[] | null | undefined, elev = 0): M2 {
  if (!n || (Math.abs(n[0]) < 1e-12 && Math.abs(n[1]) < 1e-12 && n[2] > 0)) return [1, 0, 0, 1, 0, 0];
  if (Math.abs(n[0]) < 1e-12 && Math.abs(n[1]) < 1e-12 && n[2] < 0) return [-1, 0, 0, 1, 0, 0];
  const [ax, ay] = ocsAxes(n);
  const l = Math.hypot(n[0], n[1], n[2]) || 1;
  return [ax[0], ax[1], ay[0], ay[1], elev * n[0] / l, elev * n[1] / l];
}

// bulge arc between two points -> intermediate points (exclusive of start, inclusive of end)
export function bulgePts(x0: number, y0: number, x1: number, y1: number, b: number, out: number[], segDeg = 6) {
  if (!b || Math.abs(b) < 1e-9) { out.push(x1, y1); return; }
  const ang = 4 * Math.atan(b);
  const dx = x1 - x0, dy = y1 - y0;
  const chord = Math.hypot(dx, dy);
  if (chord < 1e-12) { out.push(x1, y1); return; }
  const r = chord / (2 * Math.sin(Math.abs(ang) / 2));
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  const h = r * Math.cos(ang / 2) * Math.sign(b);
  // centre to the left of the chord for positive bulge
  const cx = mx - (dy / chord) * h, cy = my + (dx / chord) * h;
  const a0 = Math.atan2(y0 - cy, x0 - cx);
  const n = Math.max(2, Math.min(256, Math.ceil(Math.abs(ang) * 180 / Math.PI / segDeg)));
  for (let i = 1; i < n; i++) {
    const t = a0 + ang * i / n;
    out.push(cx + Math.abs(r) * Math.cos(t), cy + Math.abs(r) * Math.sin(t));
  }
  out.push(x1, y1);
}

export function arcPts(cx: number, cy: number, r: number, a0: number, a1: number, out: number[], segDeg = 6) {
  let sweep = a1 - a0;
  while (sweep <= 0) sweep += Math.PI * 2;
  if (sweep > Math.PI * 2) sweep = Math.PI * 2;
  const n = Math.max(2, Math.min(512, Math.ceil(sweep * 180 / Math.PI / segDeg)));
  for (let i = 0; i <= n; i++) { const t = a0 + sweep * i / n; out.push(cx + r * Math.cos(t), cy + r * Math.sin(t)); }
}

// B-spline (optionally rational) evaluation by de Boor, dim = 2 or 3 control point stride
export function bspline(deg: number, knots: ArrayLike<number>, ctrl: ArrayLike<number>, dim: number, weights: ArrayLike<number> | null, out: number[], segsPerSpan = 8) {
  const n = ctrl.length / dim;
  if (n < 2) return;
  const p = Math.max(1, Math.min(deg, n - 1));
  let k: number[] = Array.from(knots);
  if (k.length !== n + p + 1) {
    // build a clamped uniform knot vector
    k = [];
    for (let i = 0; i <= p; i++) k.push(0);
    for (let i = 1; i < n - p; i++) k.push(i);
    for (let i = 0; i <= p; i++) k.push(n - p);
  }
  const t0 = k[p], t1 = k[n];
  if (!(t1 > t0)) { for (let i = 0; i < n; i++) out.push(ctrl[i * dim], ctrl[i * dim + 1]); return; }
  const spans = Math.max(1, n - p);
  const steps = Math.min(4000, spans * segsPerSpan);
  const d = new Float64Array((p + 1) * 3);
  for (let s = 0; s <= steps; s++) {
    let t = t0 + (t1 - t0) * s / steps;
    if (s === steps) t = t1 - 1e-12 * (t1 - t0);
    let span = p;
    while (span < n - 1 && t >= k[span + 1]) span++;
    for (let j = 0; j <= p; j++) {
      const i = span - p + j;
      const w = weights ? weights[i] || 1 : 1;
      d[j * 3] = ctrl[i * dim] * w; d[j * 3 + 1] = ctrl[i * dim + 1] * w; d[j * 3 + 2] = w;
    }
    for (let r = 1; r <= p; r++) {
      for (let j = p; j >= r; j--) {
        const i = span - p + j;
        const den = k[i + p - r + 1] - k[i];
        const a = den > 0 ? (t - k[i]) / den : 0;
        d[j * 3] = (1 - a) * d[(j - 1) * 3] + a * d[j * 3];
        d[j * 3 + 1] = (1 - a) * d[(j - 1) * 3 + 1] + a * d[j * 3 + 1];
        d[j * 3 + 2] = (1 - a) * d[(j - 1) * 3 + 2] + a * d[j * 3 + 2];
      }
    }
    const w = d[p * 3 + 2] || 1;
    out.push(d[p * 3] / w, d[p * 3 + 1] / w);
  }
}

// Catmull-Rom through fit points (used when a spline has fit points only)
export function catmull(pts: number[], dim: number, out: number[], seg = 8) {
  const n = pts.length / dim;
  if (n < 2) return;
  const P = (i: number) => { i = Math.max(0, Math.min(n - 1, i)); return [pts[i * dim], pts[i * dim + 1]]; };
  out.push(pts[0], pts[1]);
  for (let i = 0; i < n - 1; i++) {
    const p0 = P(i - 1), p1 = P(i), p2 = P(i + 1), p3 = P(i + 2);
    for (let s = 1; s <= seg; s++) {
      const t = s / seg, t2 = t * t, t3 = t2 * t;
      out.push(
        0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
        0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
      );
    }
  }
}

export function polyArea(p: ArrayLike<number>): number {
  let a = 0; const n = p.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) a += (p[j * 2] + p[i * 2]) * (p[j * 2 + 1] - p[i * 2 + 1]);
  return a / 2;
}
export function pointInPoly(x: number, y: number, p: ArrayLike<number>): boolean {
  let c = false; const n = p.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = p[i * 2], yi = p[i * 2 + 1], xj = p[j * 2], yj = p[j * 2 + 1];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}

// ------------------------------------------------------------------ clipping to an axis aligned box
export function clipPolyline(pts: number[], x0: number, y0: number, x1: number, y1: number): number[][] {
  const out: number[][] = [];
  let cur: number[] | null = null;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    let ax = pts[i], ay = pts[i + 1], bx = pts[i + 2], by = pts[i + 3];
    let t0 = 0, t1 = 1;
    const dx = bx - ax, dy = by - ay;
    const p = [-dx, dx, -dy, dy], q = [ax - x0, x1 - ax, ay - y0, y1 - ay];
    let ok = true;
    for (let k = 0; k < 4; k++) {
      if (p[k] === 0) { if (q[k] < 0) { ok = false; break; } }
      else {
        const r = q[k] / p[k];
        if (p[k] < 0) { if (r > t1) { ok = false; break; } if (r > t0) t0 = r; }
        else { if (r < t0) { ok = false; break; } if (r < t1) t1 = r; }
      }
    }
    if (!ok) { cur = null; continue; }
    const sx = ax + t0 * dx, sy = ay + t0 * dy, ex = ax + t1 * dx, ey = ay + t1 * dy;
    if (cur && t0 === 0) cur.push(ex, ey);
    else { cur = [sx, sy, ex, ey]; out.push(cur); }
    if (t1 < 1) cur = null;
    void bx; void by;
  }
  return out;
}

export function clipPolygon(pts: number[], x0: number, y0: number, x1: number, y1: number): number[] {
  let poly = pts;
  const edges: [number, number, number][] = [[0, x0, 1], [0, x1, -1], [1, y0, 1], [1, y1, -1]];
  for (const [ax, v, s] of edges) {
    if (poly.length < 6) return [];
    const res: number[] = [];
    const n = poly.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ac = poly[i * 2 + ax], bc = poly[j * 2 + ax];
      const ain = (ac - v) * s >= 0, bin = (bc - v) * s >= 0;
      if (ain) res.push(poly[i * 2], poly[i * 2 + 1]);
      if (ain !== bin) {
        const t = (v - ac) / (bc - ac);
        res.push(poly[i * 2] + t * (poly[j * 2] - poly[i * 2]), poly[i * 2 + 1] + t * (poly[j * 2 + 1] - poly[i * 2 + 1]));
      }
    }
    poly = res;
  }
  return poly.length >= 6 ? poly : [];
}
