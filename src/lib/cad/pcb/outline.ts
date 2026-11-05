// Board outline: chain the centre lines of the profile layer (draws, arcs, rout paths, region edges) into closed
// loops. The loop with the largest area is the board; loops inside it are cut-outs. Own code.
import { type Part, type Ring, ringArea, pointInPart } from './geom.ts';
import type { PLayer, PObj } from './model.ts';

export interface Outline { outer: Ring; holes: Ring[]; area: number; bb: [number, number, number, number] }

export function chainLoops(paths: Float64Array[], tol = 0.02): Ring[] {
  // segments as polylines; join their end points within tol
  type Chain = { pts: number[]; used: boolean };
  const chains: Chain[] = [];
  for (const p of paths) if (p.length >= 4) chains.push({ pts: Array.from(p), used: false });
  const cell = tol * 2;
  const grid = new Map<string, Array<{ c: number; end: 0 | 1 }>>();
  const k = (x: number, y: number) => Math.floor(x / cell) + ',' + Math.floor(y / cell);
  const add = (ci: number, end: 0 | 1) => {
    const p = chains[ci].pts;
    const x = end ? p[p.length - 2] : p[0], y = end ? p[p.length - 1] : p[1];
    const key = k(x, y);
    let l = grid.get(key);
    if (!l) grid.set(key, (l = []));
    l.push({ c: ci, end });
  };
  chains.forEach((_c, i) => { add(i, 0); add(i, 1); });
  const find = (x: number, y: number, skip: number): { c: number; end: 0 | 1 } | null => {
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
    let best: { c: number; end: 0 | 1 } | null = null, bd = tol;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const l = grid.get(cx + dx + ',' + (cy + dy));
      if (!l) continue;
      for (const e of l) {
        if (e.c === skip || chains[e.c].used) continue;
        const p = chains[e.c].pts;
        const ex = e.end ? p[p.length - 2] : p[0], ey = e.end ? p[p.length - 1] : p[1];
        const d = Math.hypot(ex - x, ey - y);
        if (d <= bd) { bd = d; best = e; }
      }
    }
    return best;
  };
  const loops: Ring[] = [];
  for (let i = 0; i < chains.length; i++) {
    if (chains[i].used) continue;
    chains[i].used = true;
    const pts = chains[i].pts.slice();
    const sx = pts[0], sy = pts[1];
    let closed = Math.hypot(pts[pts.length - 2] - sx, pts[pts.length - 1] - sy) <= tol && pts.length >= 6;
    for (let guard = 0; !closed && guard < chains.length; guard++) {
      const ex = pts[pts.length - 2], ey = pts[pts.length - 1];
      const nx = find(ex, ey, i);
      if (!nx) break;
      chains[nx.c].used = true;
      const q = chains[nx.c].pts;
      if (nx.end === 0) for (let j = 2; j < q.length; j++) pts.push(q[j]);
      else for (let j = q.length - 4; j >= 0; j -= 2) pts.push(q[j], q[j + 1]);
      if (Math.hypot(pts[pts.length - 2] - sx, pts[pts.length - 1] - sy) <= tol) closed = true;
    }
    if (closed) {
      if (Math.hypot(pts[pts.length - 2] - sx, pts[pts.length - 1] - sy) <= tol) pts.length -= 2;
      if (pts.length >= 6) loops.push(Float64Array.from(pts));
    }
  }
  return loops;
}

function objPaths(o: PObj): Float64Array[] {
  if (o.path && o.path.length >= 4) return [o.path];
  if (o.t === 'region' || o.t === 'surface') {
    const out: Float64Array[] = [];
    for (const p of o.parts) for (const r of p) { const c = new Float64Array(r.length + 2); c.set(r); c[r.length] = r[0]; c[r.length + 1] = r[1]; out.push(c); }
    return out;
  }
  return [];
}

export function loopsToOutline(loops: Ring[]): Outline | null {
  if (!loops.length) return null;
  let bi = -1, ba = 0;
  loops.forEach((l, i) => { const a = Math.abs(ringArea(l)); if (a > ba) { ba = a; bi = i; } });
  if (bi < 0 || ba < 1) return null;
  const outer = loops[bi];
  const holes: Ring[] = [];
  const op: Part = [outer];
  loops.forEach((l, i) => {
    if (i === bi) return;
    const a = Math.abs(ringArea(l));
    if (a < 1e-4 || a > ba * 0.999) return;
    if (pointInPart(l[0], l[1], op)) holes.push(l);
  });
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < outer.length; i += 2) { x0 = Math.min(x0, outer[i]); x1 = Math.max(x1, outer[i]); y0 = Math.min(y0, outer[i + 1]); y1 = Math.max(y1, outer[i + 1]); }
  return { outer, holes, area: ba, bb: [x0, y0, x1, y1] };
}

/** board outline from the outline layers of a document (first that closes) */
export function findOutline(layers: PLayer[], profile?: Part[]): Outline | null {
  if (profile && profile.length) {
    const loops: Ring[] = [];
    for (const p of profile) for (const r of p) loops.push(r);
    const o = loopsToOutline(loops);
    if (o) return o;
  }
  const cands = layers.filter((l) => l.kind === 'outline');
  // Altium style: mechanical layers may carry the outline when no keep-out / profile layer closes
  const more = layers.filter((l) => l.kind === 'drawing' && /mechanical 1$|board outline|outline/i.test(l.name));
  const cu: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const L of layers) if (L.kind === 'copper') for (const o of L.objs) { cu[0] = Math.min(cu[0], o.bb[0]); cu[1] = Math.min(cu[1], o.bb[1]); cu[2] = Math.max(cu[2], o.bb[2]); cu[3] = Math.max(cu[3], o.bb[3]); }
  const cuArea = Number.isFinite(cu[0]) ? (cu[2] - cu[0]) * (cu[3] - cu[1]) : 0;
  // the biggest closed loop over all outline layers; a loop much smaller than the copper is a detail, not the board
  let found: Outline | null = null;
  // X2 Profile layers first, then other outline layers, routed edges and mechanical layers last
  const rank = (L: PLayer) => (/^Profile/i.test(L.fn ?? '') ? 0 : L.format === 'excellon' || /rout/i.test(L.name) ? 2 : L.kind === 'outline' ? 1 : 3);
  const ordered = [...cands, ...more].sort((a, b) => rank(a) - rank(b));
  let bestRank = 99;
  for (const L of ordered) {
    if (found && rank(L) > bestRank) break;
    const paths: Float64Array[] = [];
    for (const o of L.objs) for (const p of objPaths(o)) paths.push(p);
    const o = loopsToOutline(chainLoops(paths));
    if (o && (!cuArea || o.area > cuArea * 0.2) && (!found || o.area > found.area)) { found = o; bestRank = rank(L); }
  }
  if (found && (!cuArea || found.area > cuArea * 0.2)) return found;
  // last resort (Allegro films): a closed loop on a drawing layer that just encloses all copper
  if (!Number.isFinite(cu[0])) return found;
  let best: Outline | null = null, bestA = Infinity;
  for (const L of layers) {
    if (L.kind !== 'drawing' && L.kind !== 'other') continue;
    const paths: Float64Array[] = [];
    for (const o of L.objs) if (o.path && o.path.length >= 4) paths.push(o.path);
    for (const loop of chainLoops(paths)) {
      const ol = loopsToOutline([loop]);
      if (!ol) continue;
      const b = ol.bb, tol = 1.5;
      const encloses = b[0] <= cu[0] + tol && b[1] <= cu[1] + tol && b[2] >= cu[2] - tol && b[3] >= cu[3] - tol;
      const tight = (b[2] - b[0]) * (b[3] - b[1]) <= (cu[2] - cu[0] + 10) * (cu[3] - cu[1] + 10);
      if (encloses && tight && ol.area < bestA) { bestA = ol.area; best = ol; }
    }
  }
  return best ?? found;
}
