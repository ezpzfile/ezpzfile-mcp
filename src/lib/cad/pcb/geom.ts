// Plane geometry for the PCB engine (own code). Units are mm.
// A ring is a closed polygon stored as Float64Array [x0,y0,x1,y1,...] without repeating the first point.
// A part is a list of rings filled with the even-odd rule (one ring, or an outline with holes / cut-ins).
// An object (one Gerber graphical object, one drill hole, one ODB++ feature) is the union of its parts.

export type Ring = Float64Array;
export type Part = Ring[];
export type BB = [number, number, number, number];

const TAU = Math.PI * 2;

/** chord tolerance in mm for arcs and circles (0.002 mm = 2 um, invisible even at strong zoom) */
export let ARC_TOL = 0.002;
export function setArcTolerance(t: number) { ARC_TOL = Math.max(1e-4, t); }

export function segsFor(r: number, sweep: number, tol = ARC_TOL): number {
  const a = Math.abs(sweep);
  if (!(r > 0) || !(a > 0)) return 1;
  const x = Math.min(1, tol / r);
  const step = 2 * Math.acos(1 - x);
  let n = Math.ceil(a / Math.max(step, 1e-6));
  const full = Math.ceil((a / TAU) * 12);
  if (n < full) n = full;
  const cap = Math.ceil((a / TAU) * 360);
  if (n > cap) n = cap;
  return Math.max(1, n);
}

export function circleRing(cx: number, cy: number, r: number, tol = ARC_TOL): Ring {
  const n = Math.max(8, segsFor(r, TAU, tol));
  const out = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU;
    out[i * 2] = cx + r * Math.cos(a);
    out[i * 2 + 1] = cy + r * Math.sin(a);
  }
  return out;
}

/** append arc points (radius may change linearly from r0 to r1); includes start when withStart */
export function arcPts(cx: number, cy: number, r0: number, r1: number, a0: number, sweep: number, out: number[], withStart: boolean, tol = ARC_TOL) {
  const n = segsFor(Math.max(r0, r1), sweep, tol);
  for (let i = withStart ? 0 : 1; i <= n; i++) {
    const t = i / n;
    const a = a0 + sweep * t;
    const r = r0 + (r1 - r0) * t;
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
}

/** draw object: straight segment stroked with a circle of radius r (Minkowski sum, round ends) */
export function stadium(x0: number, y0: number, x1: number, y1: number, r: number, tol = ARC_TOL): Ring {
  const dx = x1 - x0, dy = y1 - y0;
  const L = Math.hypot(dx, dy);
  if (L < 1e-9) return circleRing(x0, y0, r, tol);
  const th = Math.atan2(dy, dx);
  const n = segsFor(r, Math.PI, tol);
  const out = new Float64Array((n + 1) * 4);
  let k = 0;
  for (let i = 0; i <= n; i++) { const a = th - Math.PI / 2 + (Math.PI * i) / n; out[k++] = x1 + r * Math.cos(a); out[k++] = y1 + r * Math.sin(a); }
  for (let i = 0; i <= n; i++) { const a = th + Math.PI / 2 + (Math.PI * i) / n; out[k++] = x0 + r * Math.cos(a); out[k++] = y0 + r * Math.sin(a); }
  return out;
}

/** arc object: circular arc (centre, start radius r0, end radius r1, start angle, signed sweep) stroked with radius w */
export function arcStroke(cx: number, cy: number, r0: number, r1: number, a0: number, sweep: number, w: number, tol = ARC_TOL): Part {
  if (Math.abs(sweep) >= TAU - 1e-9) {
    const R = (r0 + r1) / 2;
    if (R > w) return [circleRing(cx, cy, R + w, tol), circleRing(cx, cy, R - w, tol)];
    return [circleRing(cx, cy, R + w, tol)];
  }
  const s = sweep >= 0 ? 1 : -1;
  const a1 = a0 + sweep;
  const out: number[] = [];
  // outer offset
  arcPts(cx, cy, r0 + w, r1 + w, a0, sweep, out, true, tol);
  // end cap
  const ex = cx + r1 * Math.cos(a1), ey = cy + r1 * Math.sin(a1);
  arcPts(ex, ey, w, w, a1, s * Math.PI, out, false, tol);
  // inner offset, backwards (radius clamped at the centre for tiny arcs with a fat aperture)
  const n = segsFor(Math.max(r0, r1) + w, sweep, tol);
  for (let i = n - 1; i >= 0; i--) {
    const t = i / n;
    const a = a0 + sweep * t;
    const r = Math.max(0, r0 + (r1 - r0) * t - w);
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  // start cap
  const sx = cx + r0 * Math.cos(a0), sy = cy + r0 * Math.sin(a0);
  arcPts(sx, sy, w, w, a0 + s * Math.PI, s * Math.PI, out, false, tol);
  out.length -= 2; // last point equals the first
  return [Float64Array.from(out)];
}

export function rectRing(cx: number, cy: number, w: number, h: number): Ring {
  const x0 = cx - w / 2, x1 = cx + w / 2, y0 = cy - h / 2, y1 = cy + h / 2;
  return Float64Array.of(x0, y0, x1, y0, x1, y1, x0, y1);
}

export function obroundRing(cx: number, cy: number, w: number, h: number, tol = ARC_TOL): Ring {
  if (Math.abs(w - h) < 1e-12) return circleRing(cx, cy, w / 2, tol);
  if (w > h) { const d = (w - h) / 2; return stadium(cx - d, cy, cx + d, cy, h / 2, tol); }
  const d = (h - w) / 2;
  return stadium(cx, cy - d, cx, cy + d, w / 2, tol);
}

/** regular polygon, circumscribed diameter d, n vertices, first vertex at rotation deg */
export function polygonRing(cx: number, cy: number, d: number, n: number, rotDeg: number): Ring {
  n = Math.max(3, Math.min(64, Math.round(n)));
  const out = new Float64Array(n * 2);
  const r = d / 2, a0 = (rotDeg * Math.PI) / 180;
  for (let i = 0; i < n; i++) {
    const a = a0 + (i / n) * TAU;
    out[i * 2] = cx + r * Math.cos(a);
    out[i * 2 + 1] = cy + r * Math.sin(a);
  }
  return out;
}

/** rectangle with rounded (radius r) and/or chamfered (c) corners; corners bit mask: 1 ur, 2 ul, 4 ll, 8 lr (all when 0) */
export function roundRectRing(cx: number, cy: number, w: number, h: number, r: number, chamfer: boolean, corners = 15, tol = ARC_TOL): Ring {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  if (r <= 1e-9) return rectRing(cx, cy, w, h);
  const out: number[] = [];
  const hx = w / 2, hy = h / 2;
  const cs: Array<[number, number, number, number]> = [
    [hx, hy, 0, 1], [-hx, hy, Math.PI / 2, 2], [-hx, -hy, Math.PI, 4], [hx, -hy, (3 * Math.PI) / 2, 8],
  ];
  for (const [px, py, a, bit] of cs) {
    if (!(corners & bit)) { out.push(cx + px, cy + py); continue; }
    const ox = px - Math.sign(px) * r, oy = py - Math.sign(py) * r;
    if (chamfer) {
      out.push(cx + ox + r * Math.cos(a), cy + oy + r * Math.sin(a));
      out.push(cx + ox + r * Math.cos(a + Math.PI / 2), cy + oy + r * Math.sin(a + Math.PI / 2));
    } else arcPts(cx + ox, cy + oy, r, r, a, Math.PI / 2, out, true, tol);
  }
  return Float64Array.from(out);
}

/** transform: mirror (x then y), rotate deg ccw, scale, then translate */
export interface Xf { mx: boolean; my: boolean; rot: number; s: number; tx: number; ty: number }
export const XF_ID: Xf = { mx: false, my: false, rot: 0, s: 1, tx: 0, ty: 0 };

export function xfRing(r: Ring, x: Xf): Ring {
  const out = new Float64Array(r.length);
  const c = Math.cos((x.rot * Math.PI) / 180), sn = Math.sin((x.rot * Math.PI) / 180);
  const sx = (x.mx ? -1 : 1) * x.s, sy = (x.my ? -1 : 1) * x.s;
  for (let i = 0; i < r.length; i += 2) {
    const px = r[i] * sx, py = r[i + 1] * sy;
    out[i] = px * c - py * sn + x.tx;
    out[i + 1] = px * sn + py * c + x.ty;
  }
  return out;
}
export function xfPart(p: Part, x: Xf): Part { return p.map((r) => xfRing(r, x)); }
export function xfPoint(px: number, py: number, x: Xf): [number, number] {
  const c = Math.cos((x.rot * Math.PI) / 180), sn = Math.sin((x.rot * Math.PI) / 180);
  px *= (x.mx ? -1 : 1) * x.s; py *= (x.my ? -1 : 1) * x.s;
  return [px * c - py * sn + x.tx, px * sn + py * c + x.ty];
}
export function translateRing(r: Ring, dx: number, dy: number): Ring {
  const out = new Float64Array(r.length);
  for (let i = 0; i < r.length; i += 2) { out[i] = r[i] + dx; out[i + 1] = r[i + 1] + dy; }
  return out;
}

export function emptyBB(): BB { return [Infinity, Infinity, -Infinity, -Infinity]; }
export function bbAddRing(b: BB, r: Ring) {
  for (let i = 0; i < r.length; i += 2) {
    const x = r[i], y = r[i + 1];
    if (x < b[0]) b[0] = x; if (x > b[2]) b[2] = x;
    if (y < b[1]) b[1] = y; if (y > b[3]) b[3] = y;
  }
}
export function partsBB(parts: Part[]): BB {
  const b = emptyBB();
  for (const p of parts) for (const r of p) bbAddRing(b, r);
  return b;
}
export function bbUnion(a: BB, b: BB) {
  if (b[0] < a[0]) a[0] = b[0]; if (b[1] < a[1]) a[1] = b[1];
  if (b[2] > a[2]) a[2] = b[2]; if (b[3] > a[3]) a[3] = b[3];
}
export function bbOverlap(a: BB | Float64Array, b: BB | Float64Array, e = 0): boolean {
  return a[0] <= b[2] + e && b[0] <= a[2] + e && a[1] <= b[3] + e && b[1] <= a[3] + e;
}

export function ringArea(r: Ring): number {
  let s = 0;
  const n = r.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) s += (r[j] - r[i]) * (r[j + 1] + r[i + 1]);
  return s / 2;
}

/** even-odd point in part */
export function pointInPart(x: number, y: number, p: Part): boolean {
  let inside = false;
  for (const r of p) {
    const n = r.length;
    for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
      const yi = r[i + 1], yj = r[j + 1];
      if ((yi > y) !== (yj > y)) {
        const xi = r[i] + ((y - yi) * (r[j] - r[i])) / (yj - yi);
        if (xi > x) inside = !inside;
      }
    }
  }
  return inside;
}

/** convex hull (monotone chain) of a flat point list */
export function convexHull(pts: number[]): Ring {
  const idx: number[] = [];
  for (let i = 0; i < pts.length; i += 2) idx.push(i);
  idx.sort((a, b) => pts[a] - pts[b] || pts[a + 1] - pts[b + 1]);
  const cross = (o: number, a: number, b: number) => (pts[a] - pts[o]) * (pts[b + 1] - pts[o + 1]) - (pts[a + 1] - pts[o + 1]) * (pts[b] - pts[o]);
  const lower: number[] = [], upper: number[] = [];
  for (const i of idx) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], i) <= 0) lower.pop(); lower.push(i); }
  for (let k = idx.length - 1; k >= 0; k--) { const i = idx[k]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], i) <= 0) upper.pop(); upper.push(i); }
  lower.pop(); upper.pop();
  const h = lower.concat(upper);
  const out = new Float64Array(h.length * 2);
  h.forEach((i, k) => { out[k * 2] = pts[i]; out[k * 2 + 1] = pts[i + 1]; });
  return out;
}

/** Minkowski sum of a convex ring with a segment (convex hull of both translated copies) */
export function sweepConvex(r: Ring, x0: number, y0: number, x1: number, y1: number): Ring {
  const pts: number[] = [];
  for (let i = 0; i < r.length; i += 2) pts.push(r[i] + x0, r[i + 1] + y0, r[i] + x1, r[i + 1] + y1);
  return convexHull(pts);
}

/** rings of a part joined into one even-odd path for a 'fill' item: each ring is closed, then a bridge back */
export function partToFillPts(p: Part): number[] {
  if (p.length === 1) return Array.from(p[0]);
  const out: number[] = [];
  const x0 = p[0][0], y0 = p[0][1];
  // every bridge (first point of ring 0 to first point of ring k) is walked twice, so it cancels under even-odd
  for (let k = 0; k < p.length; k++) {
    const r = p[k];
    for (let i = 0; i < r.length; i++) out.push(r[i]);
    out.push(r[0], r[1]);
    if (k > 0) out.push(x0, y0);
  }
  return out;
}
