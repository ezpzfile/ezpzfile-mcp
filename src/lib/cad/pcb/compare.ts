// Compare two PCB data sets layer by layer (own code). Layers are paired by function (X2 .FileFunction, ODB++ /
// IPC-2581 layer type, file name convention: kind + side + copper number), then by name. Both sides of a pair are
// rasterised on the same grid; pixels only in A are "removed" (red), only in B "added" (green). The common copper is
// drawn grey from A's exact vectors. Every connected difference becomes an entry of the difference list.
import { defaultVisible, resolvePolarity, stackRank } from './build2d.ts';
import { Soup } from './clip.ts';
import { ringsToFills } from './fills.ts';
import { type BB, emptyBB, bbUnion } from './geom.ts';
import type { PLayer } from './model.ts';
import { findOutline } from './outline.ts';
import { loadPcbDoc, type PcbOptions } from './pcb.ts';
import { makeGrid, rasterLayer, type Grid } from './raster.ts';
import type { InFile } from './container.ts';
import { CadError, type CadInfo, type LayerInfo, type Progress, type RvtSheet2D, type SheetItem } from './types.ts';

export interface PcbDiff {
  layer: string;
  kind: 'added' | 'removed';
  /** centre and box in mm (file coordinates) */
  x: number; y: number;
  box: [number, number, number, number];
  areaMm2: number;
}

export interface PcbCompareResult {
  kind: '2d';
  sheets: RvtSheet2D[];
  layers: LayerInfo[];
  info: CadInfo;
  diffs: PcbDiff[];
  /** layer pairs: name in A, name in B (null when the layer exists on one side only) */
  pairs: Array<{ a: string | null; b: string | null; added: number; removed: number }>;
  warnings: string[];
}

const COLORS = { same: '#9aa0a6', added: '#18a840', removed: '#d42a2a', marker: '#ff8c00' };

export function layerKey(L: PLayer): string {
  if (L.kind === 'copper') return `copper|${L.side}|${L.side === 'inner' ? L.order : ''}`;
  if (L.kind === 'drill') return `drill|${L.plated === false ? 'np' : 'p'}`;
  if (L.kind === 'other' || L.kind === 'drawing') return `${L.kind}|${L.name}`;
  return `${L.kind}|${L.side}`;
}

export async function comparePcb(a: InFile[], b: InFile[], onProgress?: Progress, opts: PcbOptions & { maxPx?: number } = {}): Promise<PcbCompareResult> {
  try { return await compareInner(a, b, onProgress, opts); }
  catch (e) { if ((e as CadError).code) throw e; throw new CadError('corrupt', `PCB compare failed: ${(e as Error).message}`); }
}

async function compareInner(a: InFile[], b: InFile[], onProgress?: Progress, opts: PcbOptions & { maxPx?: number } = {}): Promise<PcbCompareResult> {
  onProgress?.('read A', 0);
  const A = await loadPcbDoc(a, undefined, opts);
  onProgress?.('read B', 0.2);
  const B = await loadPcbDoc(b, undefined, opts);
  const warnings: string[] = [];
  // pairs
  const used = new Set<PLayer>();
  const pairs: Array<{ a: PLayer | null; b: PLayer | null }> = [];
  for (const la of A.layers) {
    let lb = B.layers.find((x) => !used.has(x) && layerKey(x) === layerKey(la));
    if (!lb) lb = B.layers.find((x) => !used.has(x) && x.name === la.name);
    if (!lb) lb = B.layers.find((x) => !used.has(x) && x.file === la.file);
    if (lb) used.add(lb);
    pairs.push({ a: la, b: lb ?? null });
  }
  for (const lb of B.layers) if (!used.has(lb)) pairs.push({ a: null, b: lb });
  // common grid
  const bb = emptyBB();
  for (const D of [A, B]) for (const L of D.layers) if (L.kind === 'copper' || L.kind === 'outline' || L.kind === 'drill') for (const o of L.objs) bbUnion(bb, o.bb);
  if (!Number.isFinite(bb[0])) for (const D of [A, B]) for (const L of D.layers) for (const o of L.objs) bbUnion(bb, o.bb);
  if (!Number.isFinite(bb[0])) throw new Error('nothing to compare');
  const g = makeGrid(bb, opts.maxPx ?? 4000, 0.005);
  const outA = findOutline(A.layers, A.profile), outB = findOutline(B.layers, B.profile);
  const items: SheetItem[] = [];
  const infos: LayerInfo[] = [];
  const diffs: PcbDiff[] = [];
  const pairOut: PcbCompareResult['pairs'] = [];
  const order = pairs.map((p, i) => ({ p, i })).sort((x, y) => stackRank((x.p.a ?? x.p.b)!) - stackRank((y.p.a ?? y.p.b)!) || x.i - y.i);
  const minArea = Math.max(4, Math.ceil((0.03 / g.res) ** 2));
  let k = 0;
  for (const { p } of order) {
    k++;
    onProgress?.('compare', 0.3 + 0.65 * (k / order.length));
    const ref = (p.a ?? p.b)!;
    const name = p.a && p.b ? (p.a.name === p.b.name ? p.a.name : `${p.a.name} / ${p.b.name}`) : p.a ? `${p.a.name} (only in A)` : `${p.b!.name} (only in B)`;
    const ia = p.a ? rasterLayer(p.a, g, outA) : new Uint8Array(g.w * g.h);
    const ib = p.b ? rasterLayer(p.b, g, outB) : new Uint8Array(g.w * g.h);
    const rem = new Uint8Array(g.w * g.h), add = new Uint8Array(g.w * g.h);
    let nr = 0, na = 0;
    for (let i = 0; i < ia.length; i++) { if (ia[i] && !ib[i]) { rem[i] = 1; nr++; } else if (ib[i] && !ia[i]) { add[i] = 1; na++; } }
    let n = 0;
    // grey: exact vectors of A (or of B when the layer is new)
    const base = p.a ?? p.b!;
    for (const parts of resolvePolarity(base, bb, base.kind === 'copper' ? (p.a ? outA : outB) : null, warnings, 20000)) for (const part of parts) for (const pts of ringsToFills(part)) { items.push({ kind: 'fill', pts, color: COLORS.same, layer: name }); n++; }
    const regions = (m: Uint8Array, kind: 'added' | 'removed') => {
      const comps = components(m, g, minArea);
      for (const c of comps) {
        const box: [number, number, number, number] = [g.x0 + c.i0 * g.res, g.y0 + c.j0 * g.res, g.x0 + (c.i1 + 1) * g.res, g.y0 + (c.j1 + 1) * g.res];
        diffs.push({ layer: name, kind, x: (box[0] + box[2]) / 2, y: (box[1] + box[3]) / 2, box, areaMm2: +(c.n * g.res * g.res).toFixed(4) });
        const pad = Math.max(0.3, 3 * g.res);
        items.push({ kind: 'line', pts: [box[0] - pad, box[1] - pad, box[2] + pad, box[1] - pad, box[2] + pad, box[3] + pad, box[0] - pad, box[3] + pad, box[0] - pad, box[1] - pad], w: 0.05, color: COLORS.marker, layer: 'Difference markers' });
      }
      return comps.length;
    };
    const cr = nr ? regions(rem, 'removed') : 0;
    const ca = na ? regions(add, 'added') : 0;
    if (nr) for (const pts of traceMask(rem, g)) { items.push({ kind: 'fill', pts, color: COLORS.removed, layer: name }); n++; }
    if (na) for (const pts of traceMask(add, g)) { items.push({ kind: 'fill', pts, color: COLORS.added, layer: name }); n++; }
    infos.push({ name, color: COLORS.same, visible: defaultVisible(ref) || cr + ca > 0 && ref.kind === 'copper', items: n, kind: ref.kind, side: ref.side, order: ref.order || undefined });
    pairOut.push({ a: p.a?.name ?? null, b: p.b?.name ?? null, added: ca, removed: cr });
  }
  infos.push({ name: 'Difference markers', color: COLORS.marker, visible: true, items: diffs.length, kind: 'diff', side: null });
  // sheet in a common frame
  const m = Math.max(2, 0.03 * Math.max(bb[2] - bb[0], bb[3] - bb[1]));
  const ox = bb[0] - m, oy = bb[1] - m;
  for (const it of items) if (it.kind === 'fill' || it.kind === 'line') { const q = it.pts; for (let i = 0; i < q.length; i += 2) { q[i] -= ox; q[i + 1] -= oy; } }
  const sheet: RvtSheet2D = { id: 1, number: 'DIFF', name: 'PCB compare', size: { w: bb[2] - bb[0] + 2 * m, h: bb[3] - bb[1] + 2 * m }, items, viewports: [], completeness: 'full', warnings: warnings.slice(0, 100), origin: [ox, oy] };
  const info: CadInfo = {
    format: `${A.source} vs ${B.source}`, layersA: A.layers.length, layersB: B.layers.length, pairs: pairs.filter((p) => p.a && p.b).length,
    differences: diffs.length, added: diffs.filter((d) => d.kind === 'added').length, removed: diffs.filter((d) => d.kind === 'removed').length,
    resolutionMm: +g.res.toFixed(4),
  };
  onProgress?.('done', 1);
  return { kind: '2d', sheets: [sheet], layers: infos, info, diffs, pairs: pairOut, warnings };
}

/** 4-connected components with their pixel count and box; tiny specks are dropped */
function components(m: Uint8Array, g: Grid, minArea: number) {
  const lab = new Int32Array(m.length);
  const out: Array<{ n: number; i0: number; j0: number; i1: number; j1: number }> = [];
  const stack: number[] = [];
  let id = 0;
  for (let s = 0; s < m.length; s++) {
    if (!m[s] || lab[s]) continue;
    id++;
    let n = 0, i0 = Infinity, j0 = Infinity, i1 = -1, j1 = -1;
    stack.push(s); lab[s] = id;
    while (stack.length) {
      const q = stack.pop()!;
      n++;
      const i = q % g.w, j = (q - i) / g.w;
      if (i < i0) i0 = i; if (i > i1) i1 = i; if (j < j0) j0 = j; if (j > j1) j1 = j;
      if (i > 0 && m[q - 1] && !lab[q - 1]) { lab[q - 1] = id; stack.push(q - 1); }
      if (i < g.w - 1 && m[q + 1] && !lab[q + 1]) { lab[q + 1] = id; stack.push(q + 1); }
      if (j > 0 && m[q - g.w] && !lab[q - g.w]) { lab[q - g.w] = id; stack.push(q - g.w); }
      if (j < g.h - 1 && m[q + g.w] && !lab[q + g.w]) { lab[q + g.w] = id; stack.push(q + g.w); }
    }
    if (n >= minArea && i1 - i0 >= 1 && j1 - j0 >= 1) out.push({ n, i0, j0, i1, j1 });
    if (out.length > 5000) break;
  }
  return out;
}

/** pixel mask boundary to fill point lists (merged runs, collinear points removed) */
function traceMask(m: Uint8Array, g: Grid): number[][] {
  const S = new Soup();
  const { w, h, x0, y0, res } = g;
  const at = (i: number, j: number) => (i >= 0 && j >= 0 && i < w && j < h ? m[j * w + i] : 0);
  for (let j = 0; j <= h; j++) {
    let run = -1, side = 0;
    for (let i = 0; i <= w; i++) {
      const sd = i < w && at(i, j - 1) !== at(i, j) ? (at(i, j) ? 1 : 2) : 0;
      if (sd !== side) { if (side) S.addSeg(x0 + run * res, y0 + j * res, x0 + i * res, y0 + j * res); run = i; side = sd; }
    }
  }
  for (let i = 0; i <= w; i++) {
    let run = -1, side = 0;
    for (let j = 0; j <= h; j++) {
      const sd = j < h && at(i - 1, j) !== at(i, j) ? (at(i, j) ? 1 : 2) : 0;
      if (sd !== side) { if (side) S.addSeg(x0 + i * res, y0 + run * res, x0 + i * res, y0 + j * res); run = j; side = sd; }
    }
  }
  // the runs above end at every point where the inside side changes, so chained rings stay valid
  const rings = S.toRings().map(simplify);
  const out: number[][] = [];
  // group rings into simple fills (each with its holes)
  for (const pts of ringsToFills(rings)) out.push(pts);
  return out;
}

function simplify(r: Float64Array): Float64Array {
  const n = r.length / 2;
  if (n < 4) return r;
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    const a = (k + n - 1) % n, c = (k + 1) % n;
    const ax = r[a * 2], ay = r[a * 2 + 1], bx = r[k * 2], by = r[k * 2 + 1], cx = r[c * 2], cy = r[c * 2 + 1];
    if (Math.abs((bx - ax) * (cy - by) - (by - ay) * (cx - bx)) < 1e-12) continue;
    out.push(bx, by);
  }
  return out.length >= 6 ? Float64Array.from(out) : r;
}

export type { BB };
