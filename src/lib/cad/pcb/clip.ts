// Polygon difference on even-odd segment soups (own code).
//
// A region is kept as a bag of directionless segments: a point is inside when a ray to +x crosses an odd number of
// them. To take B away from A, both edge sets are split where they meet, and each split piece is kept when the
// region A-and-not-B differs on its two sides (tested a few nanometres to each side). Shared edges are kept once.
// This only needs local work around B, so clearances can be cut one by one out of a big copper pour.
import { type BB, type Part, type Ring, bbOverlap, emptyBB, pointInPart } from './geom.ts';

export class Soup {
  s: number[] = []; // x0,y0,x1,y1 per segment id
  alive: Uint8Array = new Uint8Array(64);
  n = 0;
  live = 0;
  bb: BB = emptyBB();
  // grid
  gx = 0; gy = 0; gw = 1; gh = 1; nx = 0; ny = 0;
  cells: number[][] | null = null;
  extra: number[] = []; // ids added outside the grid area
  builtAt = 0;
  builtN = 0;
  stamp = new Uint32Array(64);
  gen = 1;

  constructor(parts?: Part[]) {
    if (parts) for (const p of parts) for (const r of p) this.addRing(r);
  }

  addSeg(x0: number, y0: number, x1: number, y1: number) {
    if (x0 === x1 && y0 === y1) return;
    const id = this.n++;
    if (id >= this.alive.length) {
      const a = new Uint8Array(this.alive.length * 2); a.set(this.alive); this.alive = a;
      const st = new Uint32Array(this.stamp.length * 2); st.set(this.stamp); this.stamp = st;
    }
    this.alive[id] = 1;
    this.live++;
    this.s.push(x0, y0, x1, y1);
    if (this.cells) this.gridAdd(id);
    const b = this.bb;
    if (x0 < b[0]) b[0] = x0; if (x1 < b[0]) b[0] = x1; if (x0 > b[2]) b[2] = x0; if (x1 > b[2]) b[2] = x1;
    if (y0 < b[1]) b[1] = y0; if (y1 < b[1]) b[1] = y1; if (y0 > b[3]) b[3] = y0; if (y1 > b[3]) b[3] = y1;
  }
  addRing(r: Ring) {
    const n = r.length;
    if (n < 6) return;
    for (let i = 0, j = n - 2; i < n; j = i, i += 2) this.addSeg(r[j], r[j + 1], r[i], r[i + 1]);
  }
  kill(id: number) { if (this.alive[id]) { this.alive[id] = 0; this.live--; } }

  private build() {
    const b = this.bb;
    const w = Math.max(b[2] - b[0], 1e-6), h = Math.max(b[3] - b[1], 1e-6);
    const k = Math.max(1, Math.min(1024, Math.ceil(Math.sqrt(this.live / 3))));
    this.nx = Math.min(2048, Math.max(1, Math.round(k * Math.sqrt(w / h)))); this.ny = Math.min(2048, Math.max(1, Math.round(k * Math.sqrt(h / w))));
    this.gx = b[0]; this.gy = b[1]; this.gw = (w * 1.000001) / this.nx; this.gh = (h * 1.000001) / this.ny;
    const cells: number[][] = new Array(this.nx * this.ny);
    for (let i = 0; i < cells.length; i++) cells[i] = [];
    this.cells = cells;
    this.extra = [];
    for (let id = 0; id < this.n; id++) if (this.alive[id]) this.gridAdd(id);
    this.builtAt = this.live; this.builtN = this.n;
  }
  private gridAdd(id: number) {
    const s = this.s;
    const x0 = Math.min(s[id * 4], s[id * 4 + 2]), x1 = Math.max(s[id * 4], s[id * 4 + 2]);
    const y0 = Math.min(s[id * 4 + 1], s[id * 4 + 3]), y1 = Math.max(s[id * 4 + 1], s[id * 4 + 3]);
    const gx1 = this.gx + this.gw * this.nx, gy1 = this.gy + this.gh * this.ny;
    if (x0 < this.gx || y0 < this.gy || x1 > gx1 || y1 > gy1) { this.extra.push(id); return; }
    const a = this.cx(x0), c = this.cy(y0), e = this.cx(x1), d = this.cy(y1);
    const cells = this.cells!;
    for (let y = c; y <= d; y++) for (let x = a; x <= e; x++) cells[y * this.nx + x].push(id);
  }
  private cx(x: number) { return Math.max(0, Math.min(this.nx - 1, Math.floor((x - this.gx) / this.gw))); }
  private cy(y: number) { return Math.max(0, Math.min(this.ny - 1, Math.floor((y - this.gy) / this.gh))); }
  private ensureGrid() {
    if (this.live < 48) { this.cells = null; return; }
    if (!this.cells || this.extra.length > 256 || this.n - this.builtN > this.builtAt * 3 + 64) this.build();
  }

  /** ids of live segments whose box meets b */
  query(b: BB): number[] {
    this.ensureGrid();
    const s = this.s, out: number[] = [];
    const test = (id: number) => {
      const x0 = s[id * 4], y0 = s[id * 4 + 1], x1 = s[id * 4 + 2], y1 = s[id * 4 + 3];
      return Math.min(x0, x1) <= b[2] && Math.max(x0, x1) >= b[0] && Math.min(y0, y1) <= b[3] && Math.max(y0, y1) >= b[1];
    };
    if (!this.cells) {
      for (let id = 0; id < this.n; id++) if (this.alive[id] && test(id)) out.push(id);
      return out;
    }
    const g = ++this.gen;
    const a = this.cx(b[0]), c = this.cy(b[1]), e = this.cx(b[2]), d = this.cy(b[3]);
    for (let y = c; y <= d; y++) for (let x = a; x <= e; x++) {
      const cell: number[] = this.cells[y * this.nx + x];
      for (let k = 0; k < cell.length; k++) {
        const id = cell[k];
        if (this.stamp[id] === g || !this.alive[id]) continue;
        this.stamp[id] = g;
        if (test(id)) out.push(id);
      }
    }
    for (const id of this.extra) if (this.alive[id] && this.stamp[id] !== g && test(id)) out.push(id);
    return out;
  }

  /** even-odd inside test (ray to +x) */
  inside(px: number, py: number): boolean {
    const s = this.s;
    let inside = false;
    const cross = (id: number) => {
      const y0 = s[id * 4 + 1], y1 = s[id * 4 + 3];
      if ((y0 > py) !== (y1 > py)) {
        const x0 = s[id * 4], x1 = s[id * 4 + 2];
        const xi = x0 + ((py - y0) * (x1 - x0)) / (y1 - y0);
        if (xi > px) inside = !inside;
      }
    };
    if (py < this.bb[1] || py > this.bb[3] || px > this.bb[2]) return false;
    this.ensureGrid();
    if (!this.cells) {
      for (let id = 0; id < this.n; id++) if (this.alive[id]) cross(id);
      return inside;
    }
    const g = ++this.gen;
    const row = this.cy(py);
    const left = px - this.bb[0] < this.bb[2] - px;
    let insideL = false;
    const crossL = (id: number) => {
      const y0 = s[id * 4 + 1], y1 = s[id * 4 + 3];
      if ((y0 > py) !== (y1 > py)) {
        const x0 = s[id * 4], x1 = s[id * 4 + 2];
        const xi = x0 + ((py - y0) * (x1 - x0)) / (y1 - y0);
        if (xi < px) insideL = !insideL;
      }
    };
    const f = left ? crossL : cross;
    const c0 = this.cx(px);
    const from = left ? 0 : c0, to = left ? c0 : this.nx - 1;
    for (let x = from; x <= to; x++) {
      const cell: number[] = this.cells[row * this.nx + x];
      for (let k = 0; k < cell.length; k++) {
        const id = cell[k];
        if (this.stamp[id] === g || !this.alive[id]) continue;
        this.stamp[id] = g;
        f(id);
      }
    }
    for (const id of this.extra) if (this.alive[id] && this.stamp[id] !== g) { this.stamp[id] = g; f(id); }
    return left ? insideL : inside;
  }

  /** chain the live segments into closed rings (end points matched at 1 nm with a typed hash table) */
  toRings(): Ring[] {
    const s = this.s;
    const ids: number[] = [];
    for (let id = 0; id < this.n; id++) if (this.alive[id]) ids.push(id);
    const m = ids.length;
    if (!m) return [];
    // end point e of segment ids[k] -> slot 2k+e
    const qx = new Int32Array(m * 2), qy = new Int32Array(m * 2);
    for (let k = 0; k < m; k++) {
      const id = ids[k];
      qx[2 * k] = Math.round(s[id * 4] * 1e6); qy[2 * k] = Math.round(s[id * 4 + 1] * 1e6);
      qx[2 * k + 1] = Math.round(s[id * 4 + 2] * 1e6); qy[2 * k + 1] = Math.round(s[id * 4 + 3] * 1e6);
    }
    let size = 1;
    while (size < m * 4) size <<= 1;
    const head = new Int32Array(size).fill(-1);
    const nxt = new Int32Array(m * 2);
    const hash = (x: number, y: number) => (Math.imul(x, 73856093) ^ Math.imul(y, 19349663)) & (size - 1);
    for (let e = 0; e < m * 2; e++) { const h = hash(qx[e], qy[e]); nxt[e] = head[h]; head[h] = e; }
    const used = new Uint8Array(m);
    const rings: Ring[] = [];
    const findFree = (x: number, y: number): number => {
      for (let e = head[hash(x, y)]; e >= 0; e = nxt[e]) if (!used[e >> 1] && qx[e] === x && qy[e] === y) return e;
      return -1;
    };
    for (let k0 = 0; k0 < m; k0++) {
      if (used[k0]) continue;
      used[k0] = 1;
      const id0 = ids[k0];
      const pts: number[] = [s[id0 * 4], s[id0 * 4 + 1]];
      const sx = qx[2 * k0], sy = qy[2 * k0];
      let ex = 2 * k0 + 1;
      for (let guard = 0; guard <= m; guard++) {
        const x = qx[ex], y = qy[ex];
        if (x === sx && y === sy) break;
        const id = ids[ex >> 1];
        const off = (ex & 1) ? 2 : 0;
        pts.push(s[id * 4 + off], s[id * 4 + off + 1]);
        const e = findFree(x, y);
        if (e < 0) break;
        used[e >> 1] = 1;
        ex = e ^ 1; // walk to the other end of that segment
      }
      if (pts.length >= 6) rings.push(Float64Array.from(pts));
    }
    return rings;
  }
}

const QK = (ax: number, ay: number, bx: number, by: number) => {
  const a = Math.round(ax * 1e7) + ',' + Math.round(ay * 1e7), b = Math.round(bx * 1e7) + ',' + Math.round(by * 1e7);
  return a < b ? a + '|' + b : b + '|' + a;
};

/** take the even-odd part C away from soup P (in place). Returns false when nothing changed. */
export function subtract(P: Soup, C: Part, cbb?: BB): boolean {
  if (P.live === 0) return false;
  let cb = cbb;
  if (!cb) { cb = emptyBB(); for (const r of C) for (let i = 0; i < r.length; i += 2) { const x = r[i], y = r[i + 1]; if (x < cb[0]) cb[0] = x; if (x > cb[2]) cb[2] = x; if (y < cb[1]) cb[1] = y; if (y > cb[3]) cb[3] = y; } }
  const e = 1e-7;
  const qb: BB = [cb[0] - e, cb[1] - e, cb[2] + e, cb[3] + e];
  if (!bbOverlap(P.bb, qb)) return false;
  const cand = P.query(qb);
  // C segments
  const cs: number[] = [];
  for (const r of C) { const n = r.length; if (n < 6) continue; for (let i = 0, j = n - 2; i < n; j = i, i += 2) if (r[j] !== r[i] || r[j + 1] !== r[i + 1]) cs.push(r[j], r[j + 1], r[i], r[i + 1]); }
  if (!cs.length) return false;
  if (!cand.length) {
    if (P.inside(cs[0] + 0, cs[1] + 0) || P.inside((cs[0] + cs[2]) / 2, (cs[1] + cs[3]) / 2)) {
      for (let i = 0; i < cs.length; i += 4) P.addSeg(cs[i], cs[i + 1], cs[i + 2], cs[i + 3]);
      return true;
    }
    return false;
  }
  const s = P.s;
  const np = cand.length, nc = cs.length / 4;
  // split lists: per segment [t, x, y, ...]
  const pSplit: number[][] = new Array(np);
  const cSplit: number[][] = new Array(nc);
  for (let i = 0; i < np; i++) pSplit[i] = [];
  for (let j = 0; j < nc; j++) cSplit[j] = [];
  const cbbs = new Float64Array(nc * 4);
  for (let j = 0; j < nc; j++) {
    const x0 = cs[j * 4], y0 = cs[j * 4 + 1], x1 = cs[j * 4 + 2], y1 = cs[j * 4 + 3];
    cbbs[j * 4] = Math.min(x0, x1); cbbs[j * 4 + 1] = Math.min(y0, y1); cbbs[j * 4 + 2] = Math.max(x0, x1); cbbs[j * 4 + 3] = Math.max(y0, y1);
  }
  for (let i = 0; i < np; i++) {
    const id = cand[i];
    const ax = s[id * 4], ay = s[id * 4 + 1], bx = s[id * 4 + 2], by = s[id * 4 + 3];
    const rx = bx - ax, ry = by - ay;
    const rl2 = rx * rx + ry * ry;
    const px0 = Math.min(ax, bx) - e, px1 = Math.max(ax, bx) + e, py0 = Math.min(ay, by) - e, py1 = Math.max(ay, by) + e;
    for (let j = 0; j < nc; j++) {
      if (cbbs[j * 4] > px1 || cbbs[j * 4 + 2] < px0 || cbbs[j * 4 + 1] > py1 || cbbs[j * 4 + 3] < py0) continue;
      const cx0 = cs[j * 4], cy0 = cs[j * 4 + 1], cx1 = cs[j * 4 + 2], cy1 = cs[j * 4 + 3];
      const sx = cx1 - cx0, sy = cy1 - cy0;
      const sl2 = sx * sx + sy * sy;
      const d = rx * sy - ry * sx;
      const qx = cx0 - ax, qy = cy0 - ay;
      if (Math.abs(d) > 1e-12 * Math.sqrt(rl2 * sl2)) {
        let t = (qx * sy - qy * sx) / d;
        let u = (qx * ry - qy * rx) / d;
        const et = 1e-9 / Math.sqrt(rl2), eu = 1e-9 / Math.sqrt(sl2);
        if (t < -et || t > 1 + et || u < -eu || u > 1 + eu) continue;
        let x = ax + t * rx, y = ay + t * ry;
        if (u <= eu) { x = cx0; y = cy0; u = 0; } else if (u >= 1 - eu) { x = cx1; y = cy1; u = 1; }
        if (t <= et) { t = 0; x = ax; y = ay; } else if (t >= 1 - et) { t = 1; x = bx; y = by; }
        if (t > 0 && t < 1) pSplit[i].push(t, x, y);
        if (u > 0 && u < 1) cSplit[j].push(u, x, y);
      } else {
        // parallel: collinear overlap splits each at the other's end points
        const dist = Math.abs(qx * ry - qy * rx) / Math.sqrt(rl2);
        if (dist > 1e-9) continue;
        for (const [ex, ey] of [[cx0, cy0], [cx1, cy1]]) {
          const t = ((ex - ax) * rx + (ey - ay) * ry) / rl2;
          if (t > 1e-12 && t < 1 - 1e-12) pSplit[i].push(t, ex, ey);
        }
        for (const [ex, ey] of [[ax, ay], [bx, by]]) {
          const u = ((ex - cx0) * sx + (ey - cy0) * sy) / sl2;
          if (u > 1e-12 && u < 1 - 1e-12) cSplit[j].push(u, ex, ey);
        }
      }
    }
  }
  const kept = new Map<string, number[]>();
  const cIn = (x: number, y: number) => pointInPart(x, y, C);
  // inside P: one full ray cast from a reference corner of the query box, then parity of the crossings of the
  // short segment reference -> point with the candidate edges only (every P edge that can cross it is a candidate)
  const rx0 = qb[0] + 1.37e-8 * 0.731, ry0 = qb[1] + 1.37e-8 * 0.419;
  const refIn = P.inside(rx0, ry0);
  const pIn = (x: number, y: number): boolean => {
    let par = refIn;
    const dx = x - rx0, dy = y - ry0;
    for (let i = 0; i < np; i++) {
      const id = cand[i];
      const ax = s[id * 4], ay = s[id * 4 + 1], bx = s[id * 4 + 2], by = s[id * 4 + 3];
      const o1 = dx * (ay - ry0) - dy * (ax - rx0), o2 = dx * (by - ry0) - dy * (bx - rx0);
      if ((o1 > 0) === (o2 > 0) || o1 === 0 || o2 === 0) continue;
      const ex = bx - ax, ey = by - ay;
      const o3 = ex * (ry0 - ay) - ey * (rx0 - ax), o4 = ex * (y - ay) - ey * (x - ax);
      if ((o3 > 0) !== (o4 > 0) && o3 !== 0 && o4 !== 0) par = !par;
    }
    return par;
  };
  const region = (x: number, y: number) => pIn(x, y) && !cIn(x, y);
  const classify = (ax: number, ay: number, bx: number, by: number) => {
    const dx = bx - ax, dy = by - ay;
    const L = Math.hypot(dx, dy);
    if (L < 1e-10) return;
    const ep = Math.min(1e-5, L * 1e-3);
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    const nx = (-dy / L) * ep, ny = (dx / L) * ep;
    if (region(mx + nx, my + ny) !== region(mx - nx, my - ny)) {
      const k = QK(ax, ay, bx, by);
      if (!kept.has(k)) kept.set(k, [ax, ay, bx, by]);
    }
  };
  const pieces = (ax: number, ay: number, bx: number, by: number, sp: number[], fn: (a: number, b: number, c: number, d: number) => void) => {
    if (!sp.length) { fn(ax, ay, bx, by); return; }
    const order: number[] = [];
    for (let k = 0; k < sp.length; k += 3) order.push(k);
    order.sort((p, q) => sp[p] - sp[q]);
    let lx = ax, ly = ay;
    for (const k of order) {
      const x = sp[k + 1], y = sp[k + 2];
      if (Math.abs(x - lx) < 1e-12 && Math.abs(y - ly) < 1e-12) continue;
      fn(lx, ly, x, y);
      lx = x; ly = y;
    }
    fn(lx, ly, bx, by);
  };
  // classify everything first (P is still unmodified), then edit P
  for (let i = 0; i < np; i++) {
    const id = cand[i];
    pieces(s[id * 4], s[id * 4 + 1], s[id * 4 + 2], s[id * 4 + 3], pSplit[i], classify);
  }
  for (let j = 0; j < nc; j++) pieces(cs[j * 4], cs[j * 4 + 1], cs[j * 4 + 2], cs[j * 4 + 3], cSplit[j], classify);
  for (const id of cand) P.kill(id);
  for (const v of kept.values()) P.addSeg(v[0], v[1], v[2], v[3]);
  return true;
}

/** A minus B for small parts (aperture macros with exposure off) */
export function differencePart(a: Part, b: Part): Part {
  const S = new Soup([a]);
  subtract(S, b);
  return S.toRings();
}
