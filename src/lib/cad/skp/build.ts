// SkpModel -> RvtGeometry: triangulate faces once per definition, then place every instance.
// Elements: one per group / component instance at the selection level (the top level, or one to three levels
// deeper when the model is wrapped in one or two groups); nested content is merged into that element. Plus one
// "Loose geometry" element per tag for faces and edges at the model root.
// Buckets: one per (tag, material); categoryName = tag (layer) name. Units inches -> metres, SketchUp is Z-up.

import { GeomBuilder, identity, mul, type MatSpec, type Mat4 } from './geom.ts';
import { triangulateFace } from './triangulate.ts';
import type { SkpDefinition, SkpEntities, SkpModel } from './model.ts';
import type { RvtGeometry } from './types.ts';

export const INCH = 0.0254;
const DEFAULT_MAT: MatSpec = { key: 'default', name: 'Default', color: [0.92, 0.92, 0.9], schema: 'SketchUp default face' };

interface FaceGroup { mat: number; back: number; layer: number; pos: number[]; idx: number[] }
interface Prepared { groups: FaceGroup[]; edgeGroups: Map<number, number[]>; faces: number; hasGeom: boolean }

export interface BuildOptions { maxTriangles?: number; edges?: boolean; onProgress?: (ratio: number) => void }

export function buildGeometry(model: SkpModel, opts: BuildOptions = {}): { geometry: RvtGeometry; stats: Record<string, number> } {
  // elements: one per group / component instance at the selection level (see selDepth), nested content is merged in
  const gb = new GeomBuilder(opts.maxTriangles ?? 20_000_000);
  for (const w of model.warnings) gb.warn(w);
  const stats = { instancesPlaced: 0, hiddenSkipped: 0, hiddenLayerSkipped: 0, badFaces: 0, recursionCut: 0, missingDefs: 0 };
  const prepCache = new Map<SkpEntities, Prepared>();
  const matSpecs = new Map<number, MatSpec>();
  const matSpec = (id: number): MatSpec => {
    if (!id) return DEFAULT_MAT;
    let s = matSpecs.get(id);
    if (s) return s;
    const m = model.materials.get(id);
    if (!m) return DEFAULT_MAT;
    s = { key: 'm' + id, name: m.name, color: m.color, schema: 'SketchUp material' };
    if (m.opacity < 1) s.opacity = m.opacity;
    if (m.textureName) s.textureName = m.textureName;
    matSpecs.set(id, s);
    return s;
  };
  const layerName = (id: number): string => {
    const l = model.layers.get(id) ?? model.layers.get(model.defaultLayer);
    return l ? l.name : 'Layer0';
  };
  const isDefaultLayer = (id: number) => !id || id === model.defaultLayer;
  const layerVisible = (id: number) => { const l = model.layers.get(id); return !l || l.visible; };

  const prepare = (ents: SkpEntities): Prepared => {
    let p = prepCache.get(ents);
    if (p) return p;
    const byKey = new Map<string, FaceGroup>();
    const V = ents.verts;
    const tmp: number[] = [];
    let nf = 0;
    for (const f of ents.faces) {
      if (f.hidden) { stats.hiddenSkipped++; continue; }
      const key = `${f.mat}|${f.back}|${f.layer}`;
      let g = byKey.get(key);
      if (!g) { g = { mat: f.mat, back: f.back, layer: f.layer, pos: [], idx: [] }; byKey.set(key, g); }
      const base = g.pos.length / 3;
      const starts: number[] = [], counts: number[] = [];
      const local: number[] = [];
      for (const loop of f.loops) {
        starts.push(local.length / 3); counts.push(loop.length);
        for (let k = 0; k < loop.length; k++) { const v = loop[k] * 3; local.push(V[v], V[v + 1], V[v + 2]); }
      }
      tmp.length = 0;
      const nt = triangulateFace(local, starts, counts, f.normal[0], f.normal[1], f.normal[2], tmp);
      if (!nt) { stats.badFaces++; continue; }
      for (let k = 0; k < local.length; k++) g.pos.push(local[k]);
      for (let k = 0; k < tmp.length; k++) g.idx.push(base + tmp[k]);
      nf++;
    }
    const edgeGroups = new Map<number, number[]>();
    for (let e = 0; e < ents.edgeLayers.length; e++) {
      const l = ents.edgeLayers[e];
      let a = edgeGroups.get(l);
      if (!a) { a = []; edgeGroups.set(l, a); }
      a.push(ents.edges[e * 2], ents.edges[e * 2 + 1]);
    }
    p = { groups: [...byKey.values()], edgeGroups, faces: nf, hasGeom: byKey.size > 0 || ents.edgeLayers.length > 0 };
    prepCache.set(ents, p);
    return p;
  };

  // count work for progress
  const totalTop = model.root.instances.length + 1;
  let doneTop = 0;
  const wantEdges = opts.edges !== false;

  const emit = (ents: SkpEntities, xf: Mat4 | null, elementId: number, inhMat: number, inhLayer: number) => {
    const p = prepare(ents);
    for (const g of p.groups) {
      const effLayer = isDefaultLayer(g.layer) ? inhLayer : g.layer;
      if (!layerVisible(g.layer)) { stats.hiddenLayerSkipped += g.idx.length / 3; continue; }
      const mid = g.mat || inhMat || g.back;
      const b = gb.bucket(layerName(effLayer), matSpec(mid));
      gb.addTriangles(elementId, b, g.pos, g.idx, xf);
    }
    if (wantEdges) for (const [l, pairs] of p.edgeGroups) {
      if (!layerVisible(l)) continue;
      const effLayer = isDefaultLayer(l) ? inhLayer : l;
      gb.addSegments(layerName(effLayer), elementId, ents.verts, pairs, xf);
    }
  };

  const defName = (d: SkpDefinition | undefined) => d?.name || null;
  // does a definition (or anything inside it) carry geometry?
  const deepGeom = new Map<number, boolean>();
  const hasDeep = (defId: number, guard = 0): boolean => {
    const c = deepGeom.get(defId);
    if (c !== undefined) return c;
    const d = model.defs.get(defId);
    if (!d || guard > 64) return false;
    deepGeom.set(defId, false); // cycle guard
    let r = prepare(d.ents).hasGeom;
    if (!r) for (const i of d.ents.instances) if (hasDeep(i.def, guard + 1)) { r = true; break; }
    deepGeom.set(defId, r);
    return r;
  };
  // selection level: SketchUp selects top level groups / components; when the model is wrapped in very few
  // groups, go down until there is something to pick from (at most 3 levels)
  let selDepth = 0;
  {
    let level = model.root.instances.filter((i) => !i.hidden && hasDeep(i.def));
    const rootLoose = model.root.faces.length > 0;
    while (!rootLoose && level.length > 0 && level.length <= 2 && selDepth < 3) {
      const next = level.flatMap((i) => model.defs.get(i.def)?.ents.instances.filter((c) => !c.hidden && hasDeep(c.def)) ?? []);
      if (next.length <= level.length) break;
      level = next; selDepth++;
    }
  }
  const walk = (ents: SkpEntities, xf: Mat4, inhMat: number, inhLayer: number, path: string[], depth: number, stack: Set<number>, owner: number) => {
    for (const inst of ents.instances) {
      if (gb.capped) return;
      if (inst.hidden) { stats.hiddenSkipped++; continue; }
      if (!layerVisible(inst.layer)) { stats.hiddenSkipped++; continue; }
      const def = model.defs.get(inst.def);
      if (!def) { stats.missingDefs++; gb.warn('Some instances refer to a missing component definition', 'missingdef'); continue; }
      if (stack.has(inst.def) || depth > 64) { stats.recursionCut++; gb.warn('Recursive or very deep component nesting was cut', 'recursion'); continue; }
      const m = mul(xf, inst.xf);
      const mat = inst.mat || inhMat;
      const layer = isDefaultLayer(inst.layer) ? inhLayer : inst.layer;
      const name = inst.name || def.name || (inst.group ? 'Group' : 'Component');
      const p = prepare(def.ents);
      stats.instancesPlaced++;
      let el = owner;
      if (depth <= selDepth && (depth === selDepth ? hasDeep(inst.def) : p.hasGeom)) {
        el = gb.element({
          name, className: inst.group ? 'SkpGroup' : 'SkpComponentInstance', categoryName: layerName(layer),
          typeName: defName(def), familyName: path.length ? path.join(' / ') : null,
        });
      }
      if (p.hasGeom && el > 0) emit(def.ents, m, el, mat, layer);
      if (def.ents.instances.length) {
        stack.add(inst.def);
        walk(def.ents, m, mat, layer, [...path, name], depth + 1, stack, depth >= selDepth ? el : 0);
        stack.delete(inst.def);
      }
      if (depth === 0) { doneTop++; if (opts.onProgress && (doneTop & 63) === 0) opts.onProgress(doneTop / totalTop); }
    }
  };

  // loose root geometry: one element per tag
  const rootPrep = prepare(model.root);
  if (rootPrep.hasGeom) {
    const layersUsed = new Set<number>();
    for (const g of rootPrep.groups) layersUsed.add(g.layer);
    for (const l of rootPrep.edgeGroups.keys()) layersUsed.add(l);
    for (const l of layersUsed) {
      const el = gb.element({ name: 'Loose geometry', className: 'SkpLooseGeometry', categoryName: layerName(l), typeName: null, familyName: null });
      const sub: SkpEntities = { ...model.root, faces: model.root.faces.filter((f) => f.layer === l) };
      const idxs: number[] = [];
      for (let e = 0; e < model.root.edgeLayers.length; e++) if (model.root.edgeLayers[e] === l) idxs.push(e);
      sub.edges = new Int32Array(idxs.length * 2); sub.edgeLayers = new Int32Array(idxs.length);
      idxs.forEach((e, k) => { sub.edges[k * 2] = model.root.edges[e * 2]; sub.edges[k * 2 + 1] = model.root.edges[e * 2 + 1]; sub.edgeLayers[k] = l; });
      emit(sub, null, el, 0, l);
    }
  }
  walk(model.root, identity(), 0, 0, [], 0, new Set(), 0);
  if (stats.hiddenLayerSkipped) gb.warn(`${stats.hiddenLayerSkipped} triangles on hidden tags (layers) are not shown`);
  if (stats.badFaces) gb.warn(`${stats.badFaces} faces could not be triangulated (degenerate loops)`);
  const geometry = gb.finish(INCH);
  return { geometry, stats };
}
