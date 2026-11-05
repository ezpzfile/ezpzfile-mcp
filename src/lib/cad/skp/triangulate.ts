// Planar polygon triangulation with holes: holes are bridged into the outer ring, then ear clipping.
// Written from scratch for the ezpzfile.com SketchUp engine. No dependencies, runs in a Web Worker.
//
// Input: one outer ring and zero or more hole rings as 3D points (xyz triplets) of one planar face, plus
// the plane normal. Output: triangle indices into the concatenated point list (outer ring first, then
// each hole), wound counter clockwise when seen from the side the normal points to.

interface Node {
  i: number;          // index into the concatenated point list
  x: number; y: number;
  prev: Node; next: Node;
}

/** > 0 when a, b, c make a left (counter clockwise) turn */
const cross = (ax: number, ay: number, bx: number, by: number, cx: number, cy: number) => (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
const turn = (a: Node, b: Node, c: Node) => cross(a.x, a.y, b.x, b.y, c.x, c.y);

function ringArea(xs: Float64Array, ys: Float64Array, start: number, n: number): number {
  let a = 0;
  for (let k = 0, j = n - 1; k < n; j = k++) a += xs[start + j] * ys[start + k] - xs[start + k] * ys[start + j];
  return a / 2; // > 0 counter clockwise
}

function insertAfter(i: number, x: number, y: number, last: Node | null): Node {
  const nd = { i, x, y } as Node;
  if (!last) { nd.prev = nd; nd.next = nd; }
  else { nd.next = last.next; nd.prev = last; last.next.prev = nd; last.next = nd; }
  return nd;
}
function unlink(n: Node) { n.next.prev = n.prev; n.prev.next = n.next; }

function makeRing(xs: Float64Array, ys: Float64Array, start: number, n: number, wantCcw: boolean): Node | null {
  if (n < 3) return null;
  const ccw = ringArea(xs, ys, start, n) > 0;
  let last: Node | null = null;
  if (ccw === wantCcw) for (let k = 0; k < n; k++) last = insertAfter(start + k, xs[start + k], ys[start + k], last);
  else for (let k = n - 1; k >= 0; k--) last = insertAfter(start + k, xs[start + k], ys[start + k], last);
  // drop duplicates that follow each other
  let p = last!, guard = n + 2;
  while (guard-- > 0 && p.next !== p) {
    if (p.x === p.next.x && p.y === p.next.y) { const q = p.next; unlink(q); if (q === last) last = p; }
    else { p = p.next; if (p === last) break; }
  }
  if (last!.next === last || last!.next.next === last) return null;
  return last!.next;
}

function inTri(a: Node, b: Node, c: Node, px: number, py: number): boolean {
  return cross(a.x, a.y, b.x, b.y, px, py) >= 0 && cross(b.x, b.y, c.x, c.y, px, py) >= 0 && cross(c.x, c.y, a.x, a.y, px, py) >= 0;
}

/** bridge one hole (clockwise ring) into the outer ring (counter clockwise) */
function eliminateHole(hole: Node, outer: Node): void {
  let m = hole, p = hole.next;
  while (p !== hole) { if (p.x > m.x || (p.x === m.x && p.y < m.y)) m = p; p = p.next; }
  const hx = m.x, hy = m.y;
  // ray to +x, nearest crossing edge of the outer ring
  let best: Node | null = null, bestX = Infinity;
  p = outer;
  do {
    const q = p.next;
    if ((p.y <= hy && q.y >= hy) || (q.y <= hy && p.y >= hy)) {
      const x = p.y === q.y ? Math.min(p.x, q.x) : p.x + ((hy - p.y) * (q.x - p.x)) / (q.y - p.y);
      if (x >= hx && x < bestX) { bestX = x; best = p.x > q.x ? p : q; if (x === p.x && hy === p.y) best = p; else if (x === q.x && hy === q.y) best = q; }
    }
    p = q;
  } while (p !== outer);
  if (!best) {
    let d = Infinity; p = outer;
    do { const dd = (p.x - hx) ** 2 + (p.y - hy) ** 2; if (dd < d) { d = dd; best = p; } p = p.next; } while (p !== outer);
  } else if (!(best.x === bestX && best.y === hy)) {
    // reflex outer vertices inside triangle (m, intersection, best) may block the bridge: take the one closest in angle
    const ix = bestX;
    const A = { x: hx, y: hy } as Node, B = { x: ix, y: hy } as Node, C = { x: best.x, y: best.y } as Node;
    const tri = best.y < hy ? [A, C, B] : [A, B, C];
    let tanMin = Infinity;
    const cand = best;
    p = outer;
    do {
      if (p !== cand && p.x >= hx && turn(p.prev, p, p.next) <= 0 && inTri(tri[0], tri[1], tri[2], p.x, p.y)) {
        const tan = p.x > hx ? Math.abs(hy - p.y) / (p.x - hx) : Infinity;
        if (tan < tanMin || (tan === tanMin && p.x < best.x)) { tanMin = tan; best = p; }
      }
      p = p.next;
    } while (p !== outer);
  }
  // splice: best -> m ... (hole) ... m' -> best' -> best.next
  const b = best!;
  const b2 = { i: b.i, x: b.x, y: b.y } as Node, m2 = { i: m.i, x: m.x, y: m.y } as Node;
  const bn = b.next, mp = m.prev;
  b.next = m; m.prev = b;
  mp.next = m2; m2.prev = mp;
  m2.next = b2; b2.prev = m2;
  b2.next = bn; bn.prev = b2;
}

function isEar(ear: Node): boolean {
  const a = ear.prev, b = ear, c = ear.next;
  if (turn(a, b, c) <= 0) return false;
  let p = c.next;
  while (p !== a) {
    // only reflex vertices can be inside a convex corner's triangle
    if (p.i !== a.i && p.i !== b.i && p.i !== c.i && turn(p.prev, p, p.next) <= 0 && inTri(a, b, c, p.x, p.y)) {
      if (!((p.x === a.x && p.y === a.y) || (p.x === b.x && p.y === b.y) || (p.x === c.x && p.y === c.y))) return false;
    }
    p = p.next;
  }
  return true;
}

function earClip(start: Node, out: number[]) {
  let n = 0; { let p = start; do { n++; p = p.next; } while (p !== start); }
  let ear = start, stop = start, stage = 0;
  let guard = 4 * n * n + 1000;
  while (n > 3 && guard-- > 0) {
    if (isEar(ear)) {
      out.push(ear.prev.i, ear.i, ear.next.i);
      const nx = ear.next; unlink(ear); n--;
      ear = nx; stop = nx; stage = 0;
      continue;
    }
    ear = ear.next;
    if (ear === stop) {
      if (stage === 0) {
        // remove collinear and duplicate points, then retry
        let p = ear, removed = false, k = n;
        while (k-- > 0 && n > 3) {
          if (turn(p.prev, p, p.next) === 0) { const q = p.prev; unlink(p); n--; p = q; removed = true; }
          else p = p.next;
        }
        ear = stop = p; stage = removed ? 0 : 1;
        if (!removed) stage = 1;
      } else if (stage === 1) {
        // accept the least bad convex corner (tolerates touching rings from hole bridges)
        let p = ear, found: Node | null = null;
        do { if (turn(p.prev, p, p.next) > 0) { found = p; break; } p = p.next; } while (p !== ear);
        if (!found) break;
        out.push(found.prev.i, found.i, found.next.i);
        const nx = found.next; unlink(found); n--;
        ear = stop = nx;
      }
    }
  }
  if (n === 3) out.push(ear.prev.i, ear.i, ear.next.i);
  else if (n > 3) { // give up: fan whatever is left so the face stays visible
    const s = ear; let p = s.next;
    while (p.next !== s) { out.push(s.i, p.i, p.next.i); p = p.next; }
  }
}

/** make the new triangles face the normal (projection keeps orientation, this is a safety net) */
function orient(pts: ArrayLike<number>, out: number[], from: number, nx: number, ny: number, nz: number): number {
  let sx = 0, sy = 0, sz = 0;
  for (let t = from; t < out.length; t += 3) {
    const a = out[t] * 3, b = out[t + 1] * 3, c = out[t + 2] * 3;
    const ux = pts[b] - pts[a], uy = pts[b + 1] - pts[a + 1], uz = pts[b + 2] - pts[a + 2];
    const vx = pts[c] - pts[a], vy = pts[c + 1] - pts[a + 1], vz = pts[c + 2] - pts[a + 2];
    sx += uy * vz - uz * vy; sy += uz * vx - ux * vz; sz += ux * vy - uy * vx;
  }
  if (sx * nx + sy * ny + sz * nz < 0) for (let t = from; t < out.length; t += 3) { const s = out[t + 1]; out[t + 1] = out[t + 2]; out[t + 2] = s; }
  return (out.length - from) / 3;
}

/**
 * pts: xyz triplets (outer ring, then holes); ringStarts / ringCounts per ring (ring 0 = outer);
 * (nx, ny, nz): plane normal. Appends triangle indices to out and returns the number of triangles.
 */
export function triangulateFace(pts: ArrayLike<number>, ringStarts: number[], ringCounts: number[], nx: number, ny: number, nz: number, out: number[]): number {
  const before = out.length;
  const n0 = ringCounts[0];
  if (n0 < 3) return 0;
  const s0 = ringStarts[0];
  if (ringStarts.length === 1 && n0 === 3) { out.push(s0, s0 + 1, s0 + 2); return orient(pts, out, before, nx, ny, nz); }
  const total = pts.length / 3;
  const xs = new Float64Array(total), ys = new Float64Array(total);
  // drop the dominant normal axis, keeping a right handed 2D frame seen from the normal side
  const ax = Math.abs(nx), ay = Math.abs(ny), az = Math.abs(nz);
  if (az >= ax && az >= ay) { const s = nz >= 0 ? 1 : -1; for (let i = 0; i < total; i++) { xs[i] = pts[i * 3]; ys[i] = pts[i * 3 + 1] * s; } }
  else if (ax >= ay) { const s = nx >= 0 ? 1 : -1; for (let i = 0; i < total; i++) { xs[i] = pts[i * 3 + 1]; ys[i] = pts[i * 3 + 2] * s; } }
  else { const s = ny >= 0 ? 1 : -1; for (let i = 0; i < total; i++) { xs[i] = pts[i * 3 + 2]; ys[i] = pts[i * 3] * s; } }
  if (ringStarts.length === 1 && n0 === 4) {
    const c = (a: number, b: number, d: number) => cross(xs[a], ys[a], xs[b], ys[b], xs[d], ys[d]);
    const sg = ringArea(xs, ys, s0, 4) >= 0 ? 1 : -1;
    if (c(s0, s0 + 1, s0 + 2) * sg > 0 && c(s0, s0 + 2, s0 + 3) * sg > 0) out.push(s0, s0 + 1, s0 + 2, s0, s0 + 2, s0 + 3);
    else out.push(s0 + 1, s0 + 2, s0 + 3, s0 + 1, s0 + 3, s0);
    return orient(pts, out, before, nx, ny, nz);
  }
  const outer = makeRing(xs, ys, s0, n0, true);
  if (!outer) return 0;
  if (ringStarts.length > 1) {
    const holes: Array<{ h: Node; mx: number }> = [];
    for (let r = 1; r < ringStarts.length; r++) {
      const h = makeRing(xs, ys, ringStarts[r], ringCounts[r], false);
      if (!h) continue;
      let mx = -Infinity, p = h; do { if (p.x > mx) mx = p.x; p = p.next; } while (p !== h);
      holes.push({ h, mx });
    }
    holes.sort((a, b) => b.mx - a.mx);
    for (const { h } of holes) eliminateHole(h, outer);
  }
  earClip(outer, out);
  return orient(pts, out, before, nx, ny, nz);
}
