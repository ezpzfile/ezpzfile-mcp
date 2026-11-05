// SketchUp 2021+ container: "SketchUp Model" header, version string, "VFF" block, then a ZIP archive with
// model.dat (a tree of tagged records), materials/<name>/material.xml (+ texture images), thumbnails, styles.
// model.dat record: u16 tag, u32 byte length, payload (either raw data or more records). Layout learned from
// sample files only, see NOTEBOOK.md (section "VFF model.dat").

import { SkpError, LOOP_STATS } from './geom.ts';
import { emptyEntities, type SkpEntities, type SkpFace, type SkpInstance, type SkpModel, type SkpMaterial } from './model.ts';
import { zipEntries, zipRead, type ZipEntry } from './zip.ts';

const T = {
  // top level sections
  ROOT_ENTS: 0x01f6, MATERIALS: 0x01f7, LAYERS: 0x01f8, DEFINITIONS: 0x01f9,
  // common
  ENTITY: 0x05dc, ENTITY_EXT: 0x05dd, ENTITY_ID: 0x05de,
  DRAWEL: 0x07d0, DE_MATERIAL: 0x07d1, DE_LAYER: 0x07d2, DE_FLAGS: 0x07d3,
  // entities list
  ENTS: 0x1388, VERTS: 0x1389, EDGES: 0x138a, FACES: 0x138b, COMPS: 0x138c, GROUPS: 0x138d,
  CPOINTS: 0x1391, CLINES: 0x1392, CURVES: 0x1396, ARCCURVES: 0x1397,
  VERTEX: 0x09c4, VERTEX_POS: 0x09c5,
  EDGE: 0x0bb8, EDGE_V0: 0x0bb9, EDGE_V1: 0x0bba,
  FACE: 0x0dac, FACE_PLANE: 0x0dad, FACE_LOOPS: 0x0dae, FACE_BACK: 0x0daf,
  LOOP: 0x1194, LOOP_USES: 0x1195, EDGEUSE: 0x0fa0, EU_EDGE: 0x0fa1, EU_DIR: 0x0fa2,
  INSTANCE: 0x1964, INST_NAME: 0x1965, INST_XF: 0x1966, INST_DEF: 0x1967,
  GROUP: 0x1d4c,
  DEF_LIST: 0x1770, DEF_LIST2: 0x1771, DEF: 0x157c, DEF_NAME: 0x157e,
  MAT_L1: 0x30d4, MAT_L2: 0x30d5, MAT: 0x32c8, MAT_NAME: 0x32cc,
  LAY_L1: 0x3a98, LAY_L2: 0x3a99, LAYER: 0x3c8c, LAYER_NAME: 0x3c8d, LAYER_HIDDEN: 0x3c8e,
};

class Rec {
  b: Uint8Array; dv: DataView;
  constructor(b: Uint8Array, dv: DataView) { this.b = b; this.dv = dv; }
  /** iterate child records of [p, e) */
  each(p: number, e: number, cb: (tag: number, q: number, n: number) => void) {
    const b = this.b, dv = this.dv;
    while (p + 6 <= e) {
      const t = b[p] | (b[p + 1] << 8);
      const n = dv.getUint32(p + 2, true);
      const q = p + 6;
      if (q + n > e) throw new SkpError('corrupt', `model.dat: record 0x${t.toString(16)} at ${p} overruns its parent`);
      cb(t, q, n);
      p = q + n;
    }
  }
  first(p: number, e: number, tag: number): [number, number] | null {
    const b = this.b, dv = this.dv;
    while (p + 6 <= e) {
      const t = b[p] | (b[p + 1] << 8);
      const n = dv.getUint32(p + 2, true);
      if (t === tag) return [p + 6, n];
      p += 6 + n;
    }
    return null;
  }
  uint(q: number, n: number): number { let v = 0; for (let i = Math.min(n, 6) - 1; i >= 0; i--) v = v * 256 + this.b[q + i]; return v; }
  str(q: number, n: number): string { return new TextDecoder('utf-8').decode(this.b.subarray(q, q + n)); }
  f64(q: number) { return this.dv.getFloat64(q, true); }
}

interface DE { id: number; mat: number; layer: number; flags: number }

function drawEl(r: Rec, q: number, n: number): DE {
  const de: DE = { id: 0, mat: 0, layer: 0, flags: 6 };
  r.each(q, q + n, (t, a, l) => {
    if (t === T.ENTITY) { const id = r.first(a, a + l, T.ENTITY_ID); if (id) de.id = r.uint(id[0], id[1]); }
    else if (t === T.DE_MATERIAL) de.mat = r.uint(a, l);
    else if (t === T.DE_LAYER) de.layer = r.uint(a, l);
    else if (t === T.DE_FLAGS) de.flags = r.b[a];
  });
  return de;
}
function entityId(r: Rec, q: number, n: number): number {
  const e = r.first(q, q + n, T.ENTITY);
  if (!e) return 0;
  const id = r.first(e[0], e[0] + e[1], T.ENTITY_ID);
  return id ? r.uint(id[0], id[1]) : 0;
}

function readInstance(r: Rec, q: number, n: number, group: boolean): SkpInstance {
  const inst: SkpInstance = { id: 0, def: 0, xf: new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]), name: '', mat: 0, layer: 0, hidden: false, group };
  r.each(q, q + n, (t, a, l) => {
    if (t === T.DRAWEL) { const de = drawEl(r, a, l); inst.id = de.id; inst.mat = de.mat; inst.layer = de.layer; inst.hidden = (de.flags & 1) !== 0; }
    else if (t === T.INST_NAME) inst.name = r.str(a, l);
    else if (t === T.INST_DEF) inst.def = r.uint(a, l);
    else if (t === T.INST_XF && l >= 104) {
      const m = inst.xf;
      // 3x3 part stored row by row (checked against the embedded thumbnails), then origin, then w
      for (let rr = 0; rr < 3; rr++) for (let c = 0; c < 3; c++) m[c * 4 + rr] = r.f64(a + (rr * 3 + c) * 8);
      for (let k = 0; k < 3; k++) m[12 + k] = r.f64(a + 72 + k * 8);
      const w = r.f64(a + 96);
      m[15] = isFinite(w) && w !== 0 ? w : 1;
    }
  });
  return inst;
}

/** decode one entities list (record 0x1388) */
function readEntities(r: Rec, q: number, n: number, warn: (m: string) => void): SkpEntities {
  const ents = emptyEntities();
  const vIndex = new Map<number, number>();
  const pos: number[] = [];
  const edgeEnds = new Map<number, number>(); // edge id -> index into edgeV
  const edgeV: number[] = [];
  const visEdges: number[] = [], visLayers: number[] = [];
  const faceRecs: Array<[number, number]> = [];
  r.each(q, q + n, (t, a, l) => {
    switch (t) {
      case T.VERTS:
        r.each(a, a + l, (t2, a2, l2) => {
          if (t2 !== T.VERTEX) return;
          let id = 0, x = 0, y = 0, z = 0;
          r.each(a2, a2 + l2, (t3, a3, l3) => {
            if (t3 === T.ENTITY) { const e = r.first(a3, a3 + l3, T.ENTITY_ID); if (e) id = r.uint(e[0], e[1]); }
            else if (t3 === T.VERTEX_POS && l3 >= 24) { x = r.f64(a3); y = r.f64(a3 + 8); z = r.f64(a3 + 16); }
          });
          vIndex.set(id, pos.length / 3); pos.push(x, y, z);
        });
        break;
      case T.EDGES:
        r.each(a, a + l, (t2, a2, l2) => {
          if (t2 !== T.EDGE) return;
          let de: DE | null = null, v0 = 0, v1 = 0;
          r.each(a2, a2 + l2, (t3, a3, l3) => {
            if (t3 === T.DRAWEL) de = drawEl(r, a3, l3);
            else if (t3 === T.EDGE_V0) v0 = r.uint(a3, l3);
            else if (t3 === T.EDGE_V1) v1 = r.uint(a3, l3);
          });
          const d = de as DE | null;
          const id = d ? d.id : 0;
          edgeEnds.set(id, edgeV.length); edgeV.push(v0, v1);
          ents.counts.edges++;
          const fl = d ? d.flags : 6;
          if (fl & 1) { ents.counts.hiddenEdges++; return; }
          if (fl & 0x18) { ents.counts.softEdges++; return; }
          const i0 = vIndex.get(v0), i1 = vIndex.get(v1);
          if (i0 === undefined || i1 === undefined) return;
          visEdges.push(i0, i1); visLayers.push(d ? d.layer : 0);
        });
        break;
      case T.FACES:
        r.each(a, a + l, (t2, a2, l2) => { if (t2 === T.FACE) faceRecs.push([a2, l2]); });
        break;
      case T.COMPS:
        r.each(a, a + l, (t2, a2, l2) => { if (t2 === T.INSTANCE) ents.instances.push(readInstance(r, a2, l2, false)); });
        break;
      case T.GROUPS:
        r.each(a, a + l, (t2, a2, l2) => {
          if (t2 !== T.GROUP) return;
          const g = r.first(a2, a2 + l2, T.INSTANCE);
          if (g) ents.instances.push(readInstance(r, g[0], g[1], true));
        });
        break;
      case T.CURVES: case T.ARCCURVES:
        r.each(a, a + l, () => { ents.counts.curves++; });
        break;
      case T.CPOINTS: case T.CLINES:
        r.each(a, a + l, () => { ents.counts.guides++; });
        break;
    }
  });
  // faces need the edge table, which may come after the faces in the stream
  let badLoops = 0;
  for (const [a2, l2] of faceRecs) {
    const f: SkpFace = { loops: [], normal: [0, 0, 1], mat: 0, back: 0, layer: 0, hidden: false };
    r.each(a2, a2 + l2, (t3, a3, l3) => {
      if (t3 === T.DRAWEL) { const de = drawEl(r, a3, l3); f.mat = de.mat; f.layer = de.layer; f.hidden = (de.flags & 1) !== 0; }
      else if (t3 === T.FACE_PLANE && l3 >= 24) f.normal = [r.f64(a3), r.f64(a3 + 8), r.f64(a3 + 16)];
      else if (t3 === T.FACE_BACK) f.back = r.uint(a3, l3);
      else if (t3 === T.FACE_LOOPS) {
        r.each(a3, a3 + l3, (t4, a4, l4) => {
          if (t4 !== T.LOOP) return;
          const uses: number[] = [];
          r.each(a4, a4 + l4, (t5, a5, l5) => {
            if (t5 !== T.LOOP_USES) return;
            r.each(a5, a5 + l5, (t6, a6, l6) => {
              if (t6 !== T.EDGEUSE) return;
              let eid = 0, dir = 0;
              r.each(a6, a6 + l6, (t7, a7, l7) => { if (t7 === T.EU_EDGE) eid = r.uint(a7, l7); else if (t7 === T.EU_DIR) dir = r.b[a7]; });
              uses.push(eid, dir);
            });
          });
          const loop = chainLoop(uses, edgeEnds, edgeV, vIndex);
          if (loop) f.loops.push(loop); else badLoops++;
        });
      }
    });
    if (f.loops.length) ents.faces.push(f);
  }
  if (badLoops) warn(`${badLoops} face loops could not be closed and were skipped`);
  ents.verts = new Float64Array(pos);
  ents.edges = new Int32Array(visEdges);
  ents.edgeLayers = new Int32Array(visLayers);
  return ents;
}

/** turn the edge uses of one loop into an ordered vertex index list */
export function chainLoop(uses: number[], edgeEnds: Map<number, number>, edgeV: number[], vIndex: Map<number, number>): Int32Array | null {
  const n = uses.length / 2;
  if (n < 2) return null;
  const ends: number[] = [];
  for (let k = 0; k < n; k++) {
    const e = edgeEnds.get(uses[k * 2]);
    if (e === undefined) return null;
    const a = vIndex.get(edgeV[e]), b = vIndex.get(edgeV[e + 1]);
    if (a === undefined || b === undefined) return null;
    ends.push(a, b);
  }
  // orientation by connectivity: each use starts where the previous one ended
  const out = new Int32Array(n);
  let a0 = ends[0], b0 = ends[1];
  const a1 = ends[2], b1 = ends[3];
  if (!(b0 === a1 || b0 === b1) && (a0 === a1 || a0 === b1)) { const s = a0; a0 = b0; b0 = s; }
  out[0] = a0;
  let cur = b0;
  for (let k = 1; k < n; k++) {
    const a = ends[k * 2], b = ends[k * 2 + 1];
    out[k] = cur;
    if (a === cur) cur = b; else if (b === cur) cur = a; else { cur = b; LOOP_STATS.broken++; } // broken chain: keep going
  }
  if (cur !== out[0]) LOOP_STATS.open++;
  LOOP_STATS.loops++;
  return out;
}

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', gif: 'image/gif', tga: 'image/x-tga', webp: 'image/webp', psd: 'image/vnd.adobe.photoshop' };

function xmlAttr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? m[1].replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : null;
}

export async function readVff(bytes: Uint8Array, zipStart: number, version: string, onProgress?: (stage: string, ratio: number) => void): Promise<SkpModel> {
  const zip = bytes.subarray(zipStart);
  const entries = zipEntries(zip);
  const byName = new Map<string, ZipEntry>();
  for (const e of entries) byName.set(e.name, e);
  const md = byName.get('model.dat');
  if (!md) throw new SkpError('corrupt', 'SketchUp 2021+ file without model.dat');
  if (md.flags & 1) throw new SkpError('encrypted', 'model.dat is encrypted');
  if (md.size > 1_500_000_000) throw new SkpError('too-large', `model.dat is ${md.size} bytes`);
  onProgress?.('inflate', 0.05);
  const dat = await zipRead(zip, md);
  onProgress?.('parse', 0.2);
  const warnings: string[] = [];
  const warnSet = new Set<string>();
  const warn = (m: string) => { if (!warnSet.has(m)) { warnSet.add(m); warnings.push(m); } };
  const r = new Rec(dat, new DataView(dat.buffer, dat.byteOffset, dat.byteLength));
  const model: SkpModel = {
    version, container: 'vff', defs: new Map(), root: emptyEntities(), materials: new Map(), layers: new Map(),
    defaultLayer: 0, textures: [], info: {}, warnings,
  };
  // file starts with u16 0x01f4 + u32, then the top level records
  if (dat.length < 6 || (dat[0] | (dat[1] << 8)) !== 0x01f4) throw new SkpError('corrupt', 'model.dat: unexpected start');
  const top = new Map<number, [number, number]>();
  try {
    r.each(6, dat.length, (t, q, n) => { if (!top.has(t)) top.set(t, [q, n]); });
  } catch (e) { warn('model.dat ends early: ' + (e as Error).message); }

  // materials: ids + names here, colours from materials/<name>/material.xml
  const xmlByName = new Map<string, { xml: string; dir: string; name: string }>();
  const xmlByDir = new Map<string, { xml: string; dir: string; name: string }>();
  for (const e of entries) {
    if (!/^materials\/.*material\.xml$/i.test(e.name)) continue;
    try {
      const xml = new TextDecoder('utf-8').decode(await zipRead(zip, e));
      const m = /<mat:material\s[^>]*>/.exec(xml);
      const nm = m ? xmlAttr(m[0], 'name') : null;
      const dir = e.name.slice(0, e.name.length - 'material.xml'.length);
      const rec = { xml, dir, name: nm ?? '' };
      if (nm !== null && !xmlByName.has(nm)) xmlByName.set(nm, rec);
      // model.dat stores the folder name (special characters replaced), so index by folder too
      xmlByDir.set(dir.slice('materials/'.length, -1), rec);
    } catch { warn('A material.xml could not be read'); }
  }
  let texBytes = 0;
  const texByPath = new Map<string, number>();
  const readMaterial = async (q: number, n: number): Promise<SkpMaterial | null> => {
    const id = entityId(r, q, n);
    const nm = r.first(q, q + n, T.MAT_NAME);
    const name = nm ? r.str(nm[0], nm[1]) : `Material ${id}`;
    const mat: SkpMaterial = { id, name, color: [0.8, 0.8, 0.8], opacity: 1 };
    const x = xmlByDir.get(name) ?? xmlByName.get(name);
    if (x) {
      if (x.name) mat.name = x.name;
      const tag = /<mat:material\s[^>]*>/.exec(x.xml)![0];
      const cr = Number(xmlAttr(tag, 'colorRed')), cg = Number(xmlAttr(tag, 'colorGreen')), cb = Number(xmlAttr(tag, 'colorBlue'));
      if (isFinite(cr) && isFinite(cg) && isFinite(cb)) mat.color = [cr / 255, cg / 255, cb / 255];
      const useTrans = xmlAttr(tag, 'useTrans') === '1';
      const tr = Number(xmlAttr(tag, 'trans'));
      // alpha only applies when use-transparency is on; 0 with a texture means "alpha from the image"
      if (useTrans && isFinite(tr) && tr > 0 && tr < 1) mat.opacity = Math.max(0.05, tr);
      const tex = /<mat:texture\s[^>]*>/.exec(x.xml);
      if (tex && xmlAttr(tag, 'hasTexture') !== '0') {
        const fn = xmlAttr(tex[0], 'textureFilename');
        const img = /<mat:image\s[^>]*>/.exec(x.xml);
        const rel = img ? (xmlAttr(img[0], 'path') ?? xmlAttr(img[0], 'file_name')) : fn;
        if (fn) mat.textureName = fn;
        if (rel) {
          const path = x.dir + rel.replace(/^\.\//, '');
          const ze = byName.get(path);
          if (ze) {
            let ti = texByPath.get(path);
            if (ti === undefined && texBytes + ze.size <= 96 * 1024 * 1024) {
              try {
                const data = await zipRead(zip, ze);
                const ext = (path.split('.').pop() ?? '').toLowerCase();
                ti = model.textures.length;
                model.textures.push({ name: fn ?? rel, mime: MIME[ext] ?? 'application/octet-stream', bytes: data.slice() });
                texBytes += ze.size; texByPath.set(path, ti);
              } catch { warn('A texture image could not be inflated'); }
            } else if (ti === undefined) warn('Texture images above 96 MB in total are not returned');
            if (ti !== undefined) mat.textureIndex = ti;
          }
        }
      }
    } else warn('Some materials have no material.xml: default colour used');
    return mat;
  };
  const mats = top.get(T.MATERIALS);
  if (mats) {
    const recs: Array<[number, number]> = [];
    const collect = (q: number, n: number) => r.each(q, q + n, (t, a, l) => { if (t === T.MAT) recs.push([a, l]); else if (t === T.MAT_L1 || t === T.MAT_L2) collect(a, l); });
    collect(mats[0], mats[1]);
    for (const [a, l] of recs) { const m = await readMaterial(a, l); if (m) model.materials.set(m.id, m); }
  }
  // layers (tags); each layer carries its own colour material (not used for display)
  const lays = top.get(T.LAYERS);
  if (lays) {
    const collect = (q: number, n: number) => r.each(q, q + n, (t, a, l) => {
      if (t === T.LAYER) {
        const id = entityId(r, a, l);
        const nm = r.first(a, a + l, T.LAYER_NAME);
        const hid = r.first(a, a + l, T.LAYER_HIDDEN);
        const name = nm ? r.str(nm[0], nm[1]) : `Tag ${id}`;
        model.layers.set(id, { id, name, visible: !(hid && r.b[hid[0]] === 1) });
        if (!model.defaultLayer) model.defaultLayer = id;
      } else if (t === T.LAY_L1 || t === T.LAY_L2) collect(a, l);
    });
    collect(lays[0], lays[1]);
    for (const l of model.layers.values()) if (l.name === 'Layer0' || l.name === 'Untagged') { model.defaultLayer = l.id; break; }
  }
  // definitions
  const defsRec = top.get(T.DEFINITIONS);
  if (defsRec) {
    const recs: Array<[number, number]> = [];
    const collect = (q: number, n: number) => r.each(q, q + n, (t, a, l) => { if (t === T.DEF) recs.push([a, l]); else if (t === T.DEF_LIST || t === T.DEF_LIST2) collect(a, l); });
    collect(defsRec[0], defsRec[1]);
    let k = 0;
    for (const [a, l] of recs) {
      let name = '';
      let entsRec: [number, number] | null = null;
      r.each(a, a + l, (t, q, n) => { if (t === T.DEF_NAME) name = r.str(q, n); else if (t === T.ENTS && !entsRec) entsRec = [q, n]; });
      if (!entsRec) continue;
      const er = entsRec as [number, number];
      const dr = r.first(er[0], er[0] + er[1], T.DRAWEL);
      const id = dr ? drawEl(r, dr[0], dr[1]).id : 0;
      try {
        const ents = readEntities(r, er[0], er[1], warn);
        model.defs.set(id, { id, name, ents });
      } catch (e) { warn(`Definition "${name}" could not be read: ${(e as Error).message}`); }
      if ((++k & 31) === 0) onProgress?.('parse', 0.2 + 0.4 * (k / recs.length));
    }
  }
  const rootRec = top.get(T.ROOT_ENTS);
  if (rootRec) {
    const e = r.first(rootRec[0], rootRec[0] + rootRec[1], T.ENTS);
    if (e) model.root = readEntities(r, e[0], e[1], warn);
  } else warn('No model entities record found');
  model.info.modelDatBytes = dat.length;
  model.info.zipEntries = entries.length;
  return model;
}
