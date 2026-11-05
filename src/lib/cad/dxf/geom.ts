// Small 2D/3D geometry helpers shared by the DXF and DWF engines.
// Own code: affine matrices, polygon clipping (Liang-Barsky, Sutherland-Hodgman), ring nesting and keyhole merge.

import type { SheetItem } from './types.ts';

/** 3D affine matrix, column major 3x4: [m0 m3 m6 m9; m1 m4 m7 m10; m2 m5 m8 m11] => x' = m0 x + m3 y + m6 z + m9 */
export type M3 = Float64Array;

export function m3Identity(): M3 {
  const m = new Float64Array(12);
  m[0] = 1; m[4] = 1; m[8] = 1;
  return m;
}
/** a * b (apply b first, then a) */
export function m3Mul(a: M3, b: M3): M3 {
  const r = new Float64Array(12);
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 3], b1 = b[c * 3 + 1], b2 = b[c * 3 + 2];
    r[c * 3] = a[0] * b0 + a[3] * b1 + a[6] * b2 + (c === 3 ? a[9] : 0);
    r[c * 3 + 1] = a[1] * b0 + a[4] * b1 + a[7] * b2 + (c === 3 ? a[10] : 0);
    r[c * 3 + 2] = a[2] * b0 + a[5] * b1 + a[8] * b2 + (c === 3 ? a[11] : 0);
  }
  return r;
}
export function m3FromAxes(x: number[], y: number[], z: number[], t: number[]): M3 {
  const m = new Float64Array(12);
  m[0] = x[0]; m[1] = x[1]; m[2] = x[2];
  m[3] = y[0]; m[4] = y[1]; m[5] = y[2];
  m[6] = z[0]; m[7] = z[1]; m[8] = z[2];
  m[9] = t[0]; m[10] = t[1]; m[11] = t[2];
  return m;
}
export function m3Translate(x: number, y: number, z: number): M3 {
  const m = m3Identity();
  m[9] = x; m[10] = y; m[11] = z;
  return m;
}
export function m3Scale(x: number, y: number, z: number): M3 {
  const m = new Float64Array(12);
  m[0] = x; m[4] = y; m[8] = z;
  return m;
}
export function m3RotZ(a: number): M3 {
  const m = m3Identity();
  const c = Math.cos(a), s = Math.sin(a);
  m[0] = c; m[1] = s; m[3] = -s; m[4] = c;
  return m;
}
export function m3Apply(m: M3, x: number, y: number, z: number): [number, number, number] {
  return [m[0] * x + m[3] * y + m[6] * z + m[9], m[1] * x + m[4] * y + m[7] * z + m[10], m[2] * x + m[5] * y + m[8] * z + m[11]];
}

/** Arbitrary axis algorithm (DXF reference, "About Arbitrary Axis Algorithm"): OCS to WCS matrix for normal n */
export function ocsMatrix(nx: number, ny: number, nz: number): M3 | null {
  const len = Math.hypot(nx, ny, nz);
  if (len < 1e-12) return null;
  nx /= len; ny /= len; nz /= len;
  if (Math.abs(nx) < 1e-12 && Math.abs(ny) < 1e-12 && nz > 0) return null; // identity
  let ax: number[];
  if (Math.abs(nx) < 1 / 64 && Math.abs(ny) < 1 / 64) ax = cross([0, 1, 0], [nx, ny, nz]);
  else ax = cross([0, 0, 1], [nx, ny, nz]);
  ax = norm(ax);
  const ay = norm(cross([nx, ny, nz], ax));
  return m3FromAxes(ax, ay, [nx, ny, nz], [0, 0, 0]);
}
export function cross(a: number[], b: number[]): number[] {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
export function norm(a: number[]): number[] {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

/** Linear 2D part of m when projecting to XY: returns [a, b, c, d] with x' = a x + c y, y' = b x + d y */
export function lin2(m: M3): [number, number, number, number] {
  return [m[0], m[1], m[3], m[4]];
}
/** If the 2D linear part is a similarity, returns { s, rot, mirror } */
export function similarity(m: M3): { s: number; rot: number; mirror: boolean } | null {
  const a = m[0], b = m[1], c = m[3], d = m[4];
  const sx = Math.hypot(a, b), sy = Math.hypot(c, d);
  if (sx < 1e-300 || sy < 1e-300) return null;
  if (Math.abs(sx - sy) > 1e-9 * Math.max(sx, sy)) return null;
  if (Math.abs(a * c + b * d) > 1e-9 * sx * sy) return null;
  const det = a * d - b * c;
  return { s: sx, rot: Math.atan2(b, a), mirror: det < 0 };
}

// ------------------------------------------------------------------ curve tessellation

/** Number of segments for an arc of radius r (drawing units) and sweep (radians) */
export function arcSegs(sweep: number, r: number, tol: number): number {
  if (!(r > 0) || !(tol > 0)) return Math.max(4, Math.ceil(Math.abs(sweep) / (Math.PI / 18)));
  const ratio = Math.min(1, tol / r);
  const step = 2 * Math.acos(1 - ratio);
  let n = Math.ceil(Math.abs(sweep) / Math.max(step, 0.01));
  if (!isFinite(n)) n = 64;
  return Math.max(2, Math.min(720, n));
}

/** bulge segment from p0 to p1 into points (excluding p0, including p1) appended to out */
export function bulgePoints(x0: number, y0: number, x1: number, y1: number, bulge: number, tol: number, out: number[]) {
  if (!bulge || Math.abs(bulge) < 1e-12) { out.push(x1, y1); return; }
  const dx = x1 - x0, dy = y1 - y0;
  const chord = Math.hypot(dx, dy);
  if (chord < 1e-15) { out.push(x1, y1); return; }
  const theta = 4 * Math.atan(bulge);
  const r = chord / (2 * Math.sin(Math.abs(theta) / 2));
  // centre
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  const sagDist = Math.sqrt(Math.max(0, r * r - (chord / 2) * (chord / 2)));
  const sign = (bulge > 0 ? 1 : -1) * (Math.abs(theta) > Math.PI ? -1 : 1);
  const nx = -dy / chord, ny = dx / chord;
  const cx = mx + nx * sagDist * sign, cy = my + ny * sagDist * sign;
  const a0 = Math.atan2(y0 - cy, x0 - cx);
  const n = arcSegs(theta, r, tol);
  for (let i = 1; i <= n; i++) {
    const a = a0 + (theta * i) / n;
    if (i === n) out.push(x1, y1);
    else out.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
}

export function cubicPoints(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, x3: number, y3: number, tol: number, out: number[]) {
  const d = Math.hypot(x1 - x0, y1 - y0) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x3 - x2, y3 - y2);
  let n = tol > 0 ? Math.ceil(Math.sqrt(d / tol)) : 16;
  n = Math.max(2, Math.min(100, n));
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, e = t * t * t;
    out.push(a * x0 + b * x1 + c * x2 + e * x3, a * y0 + b * y1 + c * y2 + e * y3);
  }
}

// ------------------------------------------------------------------ clipping

export type Rect = [number, number, number, number];

/** Clip a polyline to a rectangle, returns zero or more polylines */
export function clipPolyline(pts: number[], r: Rect): number[][] {
  const out: number[][] = [];
  let cur: number[] | null = null;
  const [xmin, ymin, xmax, ymax] = r;
  for (let i = 0; i + 3 < pts.length; i += 2) {
    const x0 = pts[i], y0 = pts[i + 1], x1 = pts[i + 2], y1 = pts[i + 3];
    let t0 = 0, t1 = 1;
    const dx = x1 - x0, dy = y1 - y0;
    const p = [-dx, dx, -dy, dy];
    const q = [x0 - xmin, xmax - x0, y0 - ymin, ymax - y0];
    let ok = true;
    for (let k = 0; k < 4; k++) {
      if (p[k] === 0) { if (q[k] < 0) { ok = false; break; } }
      else {
        const t = q[k] / p[k];
        if (p[k] < 0) { if (t > t1) { ok = false; break; } if (t > t0) t0 = t; }
        else { if (t < t0) { ok = false; break; } if (t < t1) t1 = t; }
      }
    }
    if (!ok) { cur = null; continue; }
    const ax = x0 + dx * t0, ay = y0 + dy * t0, bx = x0 + dx * t1, by = y0 + dy * t1;
    if (cur && t0 === 0) cur.push(bx, by);
    else { cur = [ax, ay, bx, by]; out.push(cur); }
    if (t1 < 1) cur = null;
  }
  return out;
}

/** Sutherland-Hodgman polygon clip to rectangle */
export function clipPolygon(pts: number[], r: Rect): number[] {
  let poly = pts;
  const edges: Array<(x: number, y: number) => number> = [
    (x) => x - r[0], (x) => r[2] - x, (_x, y) => y - r[1], (_x, y) => r[3] - y,
  ];
  for (const f of edges) {
    const n = poly.length / 2;
    if (n === 0) break;
    const res: number[] = [];
    for (let i = 0; i < n; i++) {
      const ax = poly[i * 2], ay = poly[i * 2 + 1];
      const j = (i + 1) % n;
      const bx = poly[j * 2], by = poly[j * 2 + 1];
      const da = f(ax, ay), db = f(bx, by);
      if (da >= 0) res.push(ax, ay);
      if ((da >= 0) !== (db >= 0)) {
        const t = da / (da - db);
        res.push(ax + (bx - ax) * t, ay + (by - ay) * t);
      }
    }
    poly = res;
  }
  return poly;
}

// ------------------------------------------------------------------ rings and holes

export function ringArea(p: number[]): number {
  let a = 0;
  const n = p.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) a += (p[j * 2] + p[i * 2]) * (p[j * 2 + 1] - p[i * 2 + 1]);
  return -a / 2;
}
export function pointInRing(x: number, y: number, p: number[]): boolean {
  let inside = false;
  const n = p.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = p[i * 2], yi = p[i * 2 + 1], xj = p[j * 2], yj = p[j * 2 + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function reverseRing(p: number[]): number[] {
  const r: number[] = new Array(p.length);
  const n = p.length / 2;
  for (let i = 0; i < n; i++) { r[i * 2] = p[(n - 1 - i) * 2]; r[i * 2 + 1] = p[(n - 1 - i) * 2 + 1]; }
  return r;
}

/**
 * Even-odd set of rings to simple polygons (one per outer ring) with holes bridged in ("keyhole"),
 * because the sheet renderer fills one closed polygon per item.
 */
export function ringsToPolygons(rings: number[][]): number[][] {
  const rs = rings.filter((r) => r.length >= 6 && Math.abs(ringArea(r)) > 0);
  if (rs.length === 0) return [];
  if (rs.length === 1) return [rs[0]];
  if (rs.length > 400) return rs; // too many to nest cheaply: draw each ring filled
  // nesting depth by containment of a sample point
  const depth = rs.map((r, i) => {
    let d = 0;
    const x = r[0], y = r[1];
    for (let j = 0; j < rs.length; j++) if (j !== i && Math.abs(ringArea(rs[j])) > Math.abs(ringArea(r)) && pointInRing(x, y, rs[j])) d++;
    return d;
  });
  const out: number[][] = [];
  for (let i = 0; i < rs.length; i++) {
    if (depth[i] % 2 !== 0) continue;
    let outer = ringArea(rs[i]) < 0 ? reverseRing(rs[i]) : rs[i].slice();
    // holes: rings at depth+1 inside this ring
    const holes: number[][] = [];
    for (let j = 0; j < rs.length; j++) {
      if (depth[j] === depth[i] + 1 && pointInRing(rs[j][0], rs[j][1], rs[i])) holes.push(ringArea(rs[j]) > 0 ? reverseRing(rs[j]) : rs[j]);
    }
    // bridge holes, rightmost first
    holes.sort((a, b) => maxX(b) - maxX(a));
    for (const h of holes) outer = bridge(outer, h);
    out.push(outer);
  }
  return out;
}
function maxX(p: number[]) { let m = -Infinity; for (let i = 0; i < p.length; i += 2) if (p[i] > m) m = p[i]; return m; }
function bridge(outer: number[], hole: number[]): number[] {
  // hole vertex with max x, connect to nearest outer vertex
  let hi = 0;
  for (let i = 2; i < hole.length; i += 2) if (hole[i] > hole[hi]) hi = i;
  const hx = hole[hi], hy = hole[hi + 1];
  let oi = 0, best = Infinity;
  for (let i = 0; i < outer.length; i += 2) {
    const d = (outer[i] - hx) ** 2 + (outer[i + 1] - hy) ** 2;
    if (d < best) { best = d; oi = i; }
  }
  const res: number[] = outer.slice(0, oi + 2);
  const hn = hole.length;
  for (let k = 0; k <= hn; k += 2) { const idx = (hi + k) % hn; res.push(hole[idx], hole[idx + 1]); }
  res.push(outer[oi], outer[oi + 1]);
  for (let i = oi + 2; i < outer.length; i++) res.push(outer[i]);
  return res;
}

// ------------------------------------------------------------------ item transforms

/** Bounding box of items [xmin, ymin, xmax, ymax] or null */
export function itemsBounds(items: SheetItem[]): Rect | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x: number, y: number) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
  for (const it of items) {
    switch (it.kind) {
      case 'line': case 'fill': for (let i = 0; i + 1 < it.pts.length; i += 2) add(it.pts[i], it.pts[i + 1]); break;
      case 'arc': {
        if (![it.cx, it.cy, it.r, it.a0, it.a1].every(Number.isFinite)) break;
        let sw = it.a1 - it.a0;
        sw = sw - Math.floor(sw / (Math.PI * 2)) * Math.PI * 2;
        if (sw === 0 && it.a1 !== it.a0) sw = Math.PI * 2;
        if (sw >= Math.PI * 2 - 1e-9) { add(it.cx - it.r, it.cy - it.r); add(it.cx + it.r, it.cy + it.r); break; }
        add(it.cx + it.r * Math.cos(it.a0), it.cy + it.r * Math.sin(it.a0));
        add(it.cx + it.r * Math.cos(it.a0 + sw), it.cy + it.r * Math.sin(it.a0 + sw));
        // axis extremes inside the sweep (start angle normalised so the loop stays short)
        const a0n = it.a0 - Math.floor(it.a0 / (Math.PI * 2)) * Math.PI * 2;
        for (let k = Math.ceil(a0n / (Math.PI / 2)); k * (Math.PI / 2) <= a0n + sw && k < 12; k++) {
          const a = k * (Math.PI / 2);
          add(it.cx + it.r * Math.cos(a), it.cy + it.r * Math.sin(a));
        }
        break;
      }
      case 'text': {
        // rough text box: 0.55 em per character, 0.75 em high
        const w = it.text.length * it.size * 0.55, h = it.size * 0.75;
        const c = Math.cos(it.rot ?? 0), sn = Math.sin(it.rot ?? 0);
        const x0 = it.align === 'center' ? -w / 2 : it.align === 'right' ? -w : 0;
        for (const [u, v] of [[x0, 0], [x0 + w, 0], [x0, h], [x0 + w, h]]) add(it.x + u * c - v * sn, it.y + u * sn + v * c);
        break;
      }
      case 'image': add(it.x, it.y); add(it.x + it.w, it.y + it.h); break;
    }
  }
  if (!isFinite(x0)) return null;
  return [x0, y0, x1, y1];
}

/** x' = s * x + tx, y' = s * y + ty, in place */
export function scaleItems(items: SheetItem[], s: number, tx: number, ty: number) {
  for (const it of items) {
    switch (it.kind) {
      case 'line': case 'fill': {
        const p = it.pts;
        for (let i = 0; i + 1 < p.length; i += 2) { p[i] = p[i] * s + tx; p[i + 1] = p[i + 1] * s + ty; }
        if (it.kind === 'line') {
          if (it.dash) it.dash = it.dash.map((d) => +(d * s).toPrecision(6));
          // width given in drawing units (polyline width): scale it with the geometry
          const a = it as { wu?: number; w?: number };
          if (a.wu !== undefined) { a.w = +(a.wu * s).toPrecision(6); delete a.wu; }
        }
        break;
      }
      case 'arc': it.cx = it.cx * s + tx; it.cy = it.cy * s + ty; it.r *= s; break;
      case 'text': it.x = it.x * s + tx; it.y = it.y * s + ty; it.size *= s; break;
      case 'image': it.x = it.x * s + tx; it.y = it.y * s + ty; it.w *= s; it.h *= s; break;
    }
  }
}

/** Clip items to a rectangle (used for paper space viewports and XPS clips) */
export function clipItems(items: SheetItem[], r: Rect, tol: number): SheetItem[] {
  const out: SheetItem[] = [];
  const inside = (x: number, y: number) => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];
  for (const it of items) {
    if (it.kind === 'line') {
      let allIn = true;
      for (let i = 0; i < it.pts.length; i += 2) if (!inside(it.pts[i], it.pts[i + 1])) { allIn = false; break; }
      if (allIn) { out.push(it); continue; }
      for (const p of clipPolyline(it.pts, r)) out.push({ ...it, pts: p });
    } else if (it.kind === 'arc') {
      if (it.cx - it.r >= r[0] && it.cx + it.r <= r[2] && it.cy - it.r >= r[1] && it.cy + it.r <= r[3]) { out.push(it); continue; }
      if (it.cx + it.r < r[0] || it.cx - it.r > r[2] || it.cy + it.r < r[1] || it.cy - it.r > r[3]) continue;
      let sweep = it.a1 - it.a0;
      if (!Number.isFinite(sweep) || Math.abs(sweep) > 1e6) sweep = Math.PI * 2;
      while (sweep <= 0) sweep += Math.PI * 2;
      const n = arcSegs(sweep, it.r, tol);
      const pts: number[] = [];
      for (let i = 0; i <= n; i++) { const a = it.a0 + (sweep * i) / n; pts.push(it.cx + it.r * Math.cos(a), it.cy + it.r * Math.sin(a)); }
      const wu = (it as { wu?: number }).wu;
      for (const p of clipPolyline(pts, r)) {
        const ln: SheetItem = { kind: 'line', pts: p, color: it.color, layer: it.layer };
        if (it.w !== undefined) ln.w = it.w;
        if (wu !== undefined) (ln as { wu?: number }).wu = wu;
        out.push(ln);
      }
    } else if (it.kind === 'fill') {
      const p = clipPolygon(it.pts, r);
      if (p.length >= 6) out.push({ ...it, pts: p });
    } else if (it.kind === 'text') {
      if (inside(it.x, it.y)) out.push(it);
    } else if (it.kind === 'image') {
      if (it.x < r[2] && it.x + it.w > r[0] && it.y < r[3] && it.y + it.h > r[1]) out.push(it);
    }
  }
  return out;
}

/** Drops items with non-finite numbers and normalises arc angles (the site's renderer loops on sweep < 0). */
export function saneItem(it: SheetItem): boolean {
  switch (it.kind) {
    case 'line': case 'fill':
      for (let i = 0; i < it.pts.length; i++) if (!Number.isFinite(it.pts[i]) || Math.abs(it.pts[i]) > 1e12) return false;
      return it.pts.length >= 2;
    case 'arc': {
      if (![it.cx, it.cy, it.r, it.a0, it.a1].every(Number.isFinite) || !(it.r > 0) || it.r > 1e12) return false;
      const TAU = Math.PI * 2;
      let sw = it.a1 - it.a0;
      if (Math.abs(sw) >= TAU - 1e-9 || Math.abs(sw) > 1e6) { it.a0 = 0; it.a1 = TAU; return true; }
      const a0 = it.a0 - Math.floor(it.a0 / TAU) * TAU;
      sw = sw - Math.floor(sw / TAU) * TAU;
      it.a0 = a0; it.a1 = a0 + sw;
      return true;
    }
    case 'text': return Number.isFinite(it.x) && Number.isFinite(it.y) && it.size > 0 && it.size < 1e9 && (it.rot === undefined || Number.isFinite(it.rot));
    case 'image': return [it.x, it.y, it.w, it.h].every(Number.isFinite);
  }
  return true;
}
