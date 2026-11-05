// 3D board (own code): the outline extruded to the board thickness with real drill holes and cut-outs, and the
// outer layers laid on it as thin sheets: copper (dark green under the mask), mask openings (gold), silkscreen
// (white). Metres, z up; one bucket and one element per layer.
import { resolvePolarity } from './build2d.ts';
import { type Part, type Ring, circleRing, pointInPart, ringArea } from './geom.ts';
import type { PcbDoc, PLayer } from './model.ts';
import type { Outline } from './outline.ts';
import { triangulateRings } from './triangulate.ts';
import type { GeomBucket, GeomElement, RvtGeometry } from './types.ts';

const MAX_TRIS = 3_000_000;

export function build3D(doc: PcbDoc, outline: Outline, opts: { maxTriangles?: number } = {}): RvtGeometry {
  const t0 = Date.now();
  const maxTris = opts.maxTriangles ?? MAX_TRIS;
  const warnings: string[] = [];
  const T = doc.thickness ?? 1.6;
  const cuT = 0.035;
  const S = 0.001; // mm -> m
  const buckets: GeomBucket[] = [];
  const elements: GeomElement[] = [];
  const edges: Array<{ category: number | null; categoryName?: string | null; positions: Float32Array }> = [];
  let tris = 0;
  const bbMin: [number, number, number] = [Infinity, Infinity, Infinity], bbMax: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  class B {
    pos = new Float32Array(9 * 1024); nrm = new Float32Array(9 * 1024); n = 0; name: string; color: [number, number, number]; opacity?: number;
    constructor(name: string, color: [number, number, number], opacity?: number) { this.name = name; this.color = color; this.opacity = opacity; }
    private grow() {
      const a = new Float32Array(this.pos.length * 2); a.set(this.pos); this.pos = a;
      const b = new Float32Array(this.nrm.length * 2); b.set(this.nrm); this.nrm = b;
    }
    private v(x: number, y: number, z: number, nx: number, ny: number, nz: number) {
      if (this.n + 3 > this.pos.length) this.grow();
      const k = this.n;
      this.pos[k] = x * S; this.pos[k + 1] = y * S; this.pos[k + 2] = z * S;
      this.nrm[k] = nx; this.nrm[k + 1] = ny; this.nrm[k + 2] = nz;
      this.n += 3;
    }
    tri(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, nx: number, ny: number, nz: number) {
      const ux = bx - ax, uy = by - ay, uz = bz - az, vx = cx - ax, vy = cy - ay, vz = cz - az;
      const kx = uy * vz - uz * vy, ky = uz * vx - ux * vz, kz = ux * vy - uy * vx;
      this.v(ax, ay, az, nx, ny, nz);
      if (kx * nx + ky * ny + kz * nz < 0) { this.v(cx, cy, cz, nx, ny, nz); this.v(bx, by, bz, nx, ny, nz); }
      else { this.v(bx, by, bz, nx, ny, nz); this.v(cx, cy, cz, nx, ny, nz); }
      tris++;
    }
    flat(xy: number[], z: number, up: boolean) {
      const nz = up ? 1 : -1;
      for (let i = 0; i < xy.length; i += 6) this.tri(xy[i], xy[i + 1], z, xy[i + 2], xy[i + 3], z, xy[i + 4], xy[i + 5], z, 0, 0, nz);
    }
  }
  const finish = (b: B, catName: string) => {
    if (!b.n) return;
    const id = elements.length + 1;
    const positions = b.pos.slice(0, b.n);
    for (let i = 0; i < positions.length; i += 3) for (let k = 0; k < 3; k++) { const v = positions[i + k]; if (v < bbMin[k]) bbMin[k] = v; if (v > bbMax[k]) bbMax[k] = v; }
    const n = positions.length / 3;
    const indices = new Uint32Array(n);
    for (let i = 0; i < n; i++) indices[i] = i;
    const bk: GeomBucket = { category: null, categoryName: catName, color: b.color, positions, normals: b.nrm.slice(0, b.n), indices, ranges: [{ elementId: id, start: 0, count: n }] };
    if (b.opacity !== undefined) bk.opacity = b.opacity;
    buckets.push(bk);
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < positions.length; i += 3) { x0 = Math.min(x0, positions[i]); x1 = Math.max(x1, positions[i]); y0 = Math.min(y0, positions[i + 1]); y1 = Math.max(y1, positions[i + 1]); z0 = Math.min(z0, positions[i + 2]); z1 = Math.max(z1, positions[i + 2]); }
    elements.push({ id, category: null, categoryName: catName, className: 'PcbLayer', name: b.name, typeName: null, familyName: null, levelId: null, levelName: null, bbox: { min: [x0, y0, z0], max: [x1, y1, z1] } });
  };

  // ---- drill holes (cut through the board), deduplicated
  const holes: Array<{ x: number; y: number; r: number }> = [];
  const hk = new Map<string, number>();
  const outerPart: Part = [outline.outer];
  for (const L of doc.layers) {
    if (L.kind !== 'drill') continue;
    for (const o of L.objs) {
      if (o.t !== 'hole' && o.t !== 'flash') continue;
      const x = (o.bb[0] + o.bb[2]) / 2, y = (o.bb[1] + o.bb[3]) / 2, r = (o.bb[2] - o.bb[0]) / 2;
      if (!(r > 0.01)) continue;
      const k = `${Math.round(x * 100)},${Math.round(y * 100)}`;
      const prev = hk.get(k);
      if (prev !== undefined) { if (holes[prev].r < r) holes[prev].r = r; continue; }
      if (!pointInPart(x, y, outerPart)) continue;
      hk.set(k, holes.length);
      holes.push({ x, y, r });
    }
  }
  // overlapping holes would cancel under even-odd: keep the bigger one
  const cell = 2;
  const grid = new Map<string, number[]>();
  const keep: boolean[] = holes.map(() => true);
  holes.sort((a, b) => b.r - a.r);
  holes.forEach((h, i) => {
    const gx = Math.floor(h.x / cell), gy = Math.floor(h.y / cell);
    for (let dx = -1; dx <= 1 && keep[i]; dx++) for (let dy = -1; dy <= 1 && keep[i]; dy++) for (const j of grid.get(gx + dx + ',' + (gy + dy)) ?? []) {
      const o = holes[j];
      if (Math.hypot(o.x - h.x, o.y - h.y) < o.r + h.r) { keep[i] = false; break; }
    }
    if (keep[i]) { const k = gx + ',' + gy; const l = grid.get(k); if (l) l.push(i); else grid.set(k, [i]); }
  });
  const holeRings: Ring[] = [];
  holes.forEach((h, i) => { if (keep[i]) holeRings.push(circleRing(h.x, h.y, h.r, Math.max(0.005, h.r * 0.02))); });
  const cutouts = outline.holes.filter((r) => Math.abs(ringArea(r)) > 1e-3);

  // ---- board
  const hasMask = doc.layers.some((l) => l.kind === 'mask');
  const board = new B('Board', hasMask ? [0.09, 0.33, 0.16] : [0.72, 0.66, 0.42]);
  const allRings = [outline.outer, ...cutouts, ...holeRings];
  const xy: number[] = [];
  triangulateRings(allRings, xy);
  board.flat(xy, T, true);
  board.flat(xy, 0, false);
  const edgeLines: number[] = [];
  const wall = (r: Ring, isHole: boolean) => {
    const ccw = ringArea(r) > 0;
    const n = r.length;
    for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
      const ax = r[j], ay = r[j + 1], bx = r[i], by = r[i + 1];
      const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
      if (len < 1e-9) continue;
      const sg = (isHole ? -1 : 1) * (ccw ? 1 : -1);
      const nx = (sg * dy) / len, ny = (-sg * dx) / len;
      board.tri(ax, ay, 0, bx, by, 0, bx, by, T, nx, ny, 0);
      board.tri(ax, ay, 0, bx, by, T, ax, ay, T, nx, ny, 0);
      if (!isHole || r.length < 400) edgeLines.push(ax * S, ay * S, T * S, bx * S, by * S, T * S, ax * S, ay * S, 0, bx * S, by * S, 0);
    }
  };
  wall(outline.outer, false);
  for (const r of cutouts) wall(r, true);
  for (const r of holeRings) wall(r, true);
  finish(board, 'Board');
  edges.push({ category: null, categoryName: 'Board', positions: new Float32Array(edgeLines) });

  // ---- layers on the outer faces
  const holeGrid = new Map<string, number[]>();
  const kept = holes.filter((_h, i) => keep[i]);
  kept.forEach((h, i) => { const k = Math.floor(h.x / cell) + ',' + Math.floor(h.y / cell); const l = holeGrid.get(k); if (l) l.push(i); else holeGrid.set(k, [i]); });
  const holesIn = (p: Part): Ring[] => {
    // drill holes that sit inside a pad are cut out of it
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const r of p) for (let i = 0; i < r.length; i += 2) { x0 = Math.min(x0, r[i]); x1 = Math.max(x1, r[i]); y0 = Math.min(y0, r[i + 1]); y1 = Math.max(y1, r[i + 1]); }
    if ((x1 - x0) * (y1 - y0) > 400) return [];
    const out: Ring[] = [];
    for (let gx = Math.floor(x0 / cell); gx <= Math.floor(x1 / cell); gx++) for (let gy = Math.floor(y0 / cell); gy <= Math.floor(y1 / cell); gy++) for (const i of holeGrid.get(gx + ',' + gy) ?? []) {
      const h = kept[i];
      if (h.x - h.r > x0 && h.x + h.r < x1 && h.y - h.r > y0 && h.y + h.r < y1 && pointInPart(h.x, h.y, p) && pointInPart(h.x + h.r * 0.99, h.y, p) && pointInPart(h.x - h.r * 0.99, h.y, p)) out.push(circleRing(h.x, h.y, h.r, Math.max(0.005, h.r * 0.02)));
    }
    return out;
  };
  const sheet = (L: PLayer, z: number, up: boolean, color: [number, number, number], name: string, cut: boolean) => {
    if (tris > maxTris) { warnings.push(`3D: triangle budget reached, ${L.name} left out`); return; }
    const b = new B(name, color);
    const parts = resolvePolarity(L, outline.bb, L.kind === 'copper' ? outline : null, warnings, 20000);
    const buf: number[] = [];
    for (const obj of parts) for (const p of obj) {
      buf.length = 0;
      triangulateRings(cut ? [...p, ...holesIn(p)] : p, buf);
      b.flat(buf, z, up);
      if (tris > maxTris) break;
    }
    finish(b, name);
  };
  const outer = (side: 'top' | 'bottom') => doc.layers.filter((l) => l.side === side);
  for (const side of ['top', 'bottom'] as const) {
    const up = side === 'top';
    const base = up ? T : 0;
    const dir = up ? 1 : -1;
    const ls = outer(side);
    const cu = ls.find((l) => l.kind === 'copper');
    const mask = ls.find((l) => l.kind === 'mask');
    const silk = ls.find((l) => l.kind === 'silk');
    if (cu) sheet(cu, base + dir * cuT, up, hasMask ? [0.13, 0.45, 0.2] : [0.85, 0.6, 0.3], cu.name, true);
    if (mask) sheet(mask, base + dir * (cuT + 0.012), up, [0.86, 0.68, 0.3], `${mask.name} (openings)`, true);
    if (silk) sheet(silk, base + dir * (cuT + 0.025), up, [0.95, 0.95, 0.93], silk.name, false);
  }
  return {
    units: 'm', up: 'z',
    bbox: { min: bbMin, max: bbMax },
    buckets, edges, elements,
    stats: { elements: elements.length, triangles: tris, skippedFaces: 0, ms: Date.now() - t0 },
    warnings,
  };
}
