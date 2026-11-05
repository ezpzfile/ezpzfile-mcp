// Autodesk 3D Studio (.3ds) reader. Clean-room: written from publicly circulated descriptions of the chunk
// layout (no official specification was published) and from analysis of the sample files (see NOTEBOOK.md).
// 3DS is Z-up; it has no reliable unit, so units are guessed like OBJ/STL.

import { GeomBuilder, MeshError, guessUnits, DEFAULT_GREY, GrowF32, type MeshResult, type Progress } from './common.ts';

export function sniff3ds(bytes: Uint8Array): boolean {
  if (bytes.length < 16) return false;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint16(0, true) !== 0x4d4d) return false;
  const len = dv.getUint32(2, true);
  if (len < 6 || len > bytes.length + 16) return false;
  const sub = dv.getUint16(6, true);
  return sub === 0x0002 || sub === 0x3d3d || sub === 0xb000 || sub === 0x0001;
}

interface Mat { name: string; color: [number, number, number] | null; opacity: number; texture?: string }
interface Obj {
  name: string;
  verts: Float32Array | null;
  faces: Uint16Array | null; // a b c flags
  groups: Array<{ mat: string; faces: Uint16Array }>;
  smooth: Uint32Array | null;
  matrix: number[] | null;
}

export async function read3ds(bytes: Uint8Array, onProgress?: Progress): Promise<MeshResult> {
  const t0 = Date.now();
  if (!sniff3ds(bytes)) throw new MeshError('not-format', 'Not a 3D Studio (.3ds) file');
  const gb = new GeomBuilder();
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = Math.min(bytes.length, dv.getUint32(2, true));
  if (dv.getUint32(2, true) > bytes.length) gb.warn('File is shorter than its main chunk says (truncated): reading what is there');
  let version = 0, meshVersion = 0, masterScale = 1;
  const mats = new Map<string, Mat>();
  const objs: Obj[] = [];
  let lights = 0, cameras = 0, badChunks = 0;
  const hier: Array<{ name: string; parent: number; id: number }> = [];

  const cstr = (o: number, lim: number): [string, number] => {
    let e = o; while (e < lim && bytes[e] !== 0) e++;
    let s = ''; for (let i = o; i < e; i++) s += String.fromCharCode(bytes[i]);
    return [s, Math.min(lim, e + 1)];
  };
  const readColor = (o: number, lim: number): [number, number, number] | null => {
    let best: [number, number, number] | null = null, bestPri = 0;
    while (o + 6 <= lim) {
      const id = dv.getUint16(o, true), len = dv.getUint32(o + 2, true);
      if (len < 6 || o + len > lim) break;
      let c: [number, number, number] | null = null, pri = 0;
      if ((id === 0x0011 || id === 0x0012) && len >= 9) { c = [bytes[o + 6] / 255, bytes[o + 7] / 255, bytes[o + 8] / 255]; pri = id === 0x0011 ? 4 : 3; }
      else if ((id === 0x0010 || id === 0x0013) && len >= 18) { c = [dv.getFloat32(o + 6, true), dv.getFloat32(o + 10, true), dv.getFloat32(o + 14, true)]; pri = id === 0x0010 ? 2 : 1; }
      if (c && pri > bestPri) { best = c; bestPri = pri; }
      o += len;
    }
    return best;
  };
  const readPercent = (o: number, lim: number): number | null => {
    while (o + 6 <= lim) {
      const id = dv.getUint16(o, true), len = dv.getUint32(o + 2, true);
      if (len < 6 || o + len > lim) break;
      if (id === 0x0030 && len >= 8) return dv.getInt16(o + 6, true) / 100;
      if (id === 0x0031 && len >= 10) return dv.getFloat32(o + 6, true) / 100;
      o += len;
    }
    return null;
  };

  const parseMaterial = (o: number, lim: number) => {
    const m: Mat = { name: '', color: null, opacity: 1 };
    while (o + 6 <= lim) {
      const id = dv.getUint16(o, true), len = dv.getUint32(o + 2, true);
      if (len < 6 || o + len > lim) { badChunks++; break; }
      const b = o + 6, e = o + len;
      if (id === 0xa000) m.name = cstr(b, e)[0];
      else if (id === 0xa020) m.color = readColor(b, e);
      else if (id === 0xa050) { const p = readPercent(b, e); if (p !== null) m.opacity = Math.max(0.05, 1 - Math.min(1, Math.max(0, p))); }
      else if (id === 0xa200 && !m.texture) {
        let q = b; while (q + 6 <= e) { const sid = dv.getUint16(q, true), sl = dv.getUint32(q + 2, true); if (sl < 6 || q + sl > e) break; if (sid === 0xa300) m.texture = cstr(q + 6, q + sl)[0]; q += sl; }
      }
      o = e;
    }
    if (m.name) mats.set(m.name, m);
  };

  const parseTriObject = (obj: Obj, o: number, lim: number) => {
    while (o + 6 <= lim) {
      const id = dv.getUint16(o, true), len = dv.getUint32(o + 2, true);
      if (len < 6 || o + len > lim) { badChunks++; break; }
      const b = o + 6, e = o + len;
      if (id === 0x4110 && e - b >= 2) {
        const n = Math.min(dv.getUint16(b, true), Math.floor((e - b - 2) / 12));
        const v = new Float32Array(n * 3);
        for (let i = 0; i < n * 3; i++) v[i] = dv.getFloat32(b + 2 + i * 4, true);
        obj.verts = v;
      } else if (id === 0x4120 && e - b >= 2) {
        const n = Math.min(dv.getUint16(b, true), Math.floor((e - b - 2) / 8));
        const f = new Uint16Array(n * 4);
        for (let i = 0; i < n * 4; i++) f[i] = dv.getUint16(b + 2 + i * 2, true);
        obj.faces = f;
        // sub chunks after the face list
        let q = b + 2 + n * 8;
        while (q + 6 <= e) {
          const sid = dv.getUint16(q, true), sl = dv.getUint32(q + 2, true);
          if (sl < 6 || q + sl > e) { badChunks++; break; }
          if (sid === 0x4130) {
            const [name, p] = cstr(q + 6, q + sl);
            const cnt = Math.min(dv.getUint16(p, true), Math.floor((q + sl - p - 2) / 2));
            const g = new Uint16Array(cnt); for (let i = 0; i < cnt; i++) g[i] = dv.getUint16(p + 2 + i * 2, true);
            obj.groups.push({ mat: name, faces: g });
          } else if (sid === 0x4150) {
            const cnt = Math.min(n, Math.floor((sl - 6) / 4));
            const s = new Uint32Array(n); for (let i = 0; i < cnt; i++) s[i] = dv.getUint32(q + 6 + i * 4, true);
            obj.smooth = s;
          }
          q += sl;
        }
      } else if (id === 0x4160 && e - b >= 48) {
        obj.matrix = []; for (let i = 0; i < 12; i++) obj.matrix.push(dv.getFloat32(b + i * 4, true));
      }
      o = e;
    }
  };

  const parseEditor = (o: number, lim: number) => {
    while (o + 6 <= lim) {
      const id = dv.getUint16(o, true), len = dv.getUint32(o + 2, true);
      if (len < 6 || o + len > lim) { badChunks++; gb.warn('A chunk runs past its parent: rest of the editor data skipped'); break; }
      const b = o + 6, e = o + len;
      if (id === 0x3d3e && len >= 10) meshVersion = dv.getUint32(b, true);
      else if (id === 0x0100 && len >= 10) masterScale = dv.getFloat32(b, true);
      else if (id === 0xafff) parseMaterial(b, e);
      else if (id === 0x4000) {
        const [name, p] = cstr(b, e);
        let q = p;
        while (q + 6 <= e) {
          const sid = dv.getUint16(q, true), sl = dv.getUint32(q + 2, true);
          if (sl < 6 || q + sl > e) { badChunks++; break; }
          if (sid === 0x4100) { const obj: Obj = { name, verts: null, faces: null, groups: [], smooth: null, matrix: null }; parseTriObject(obj, q + 6, q + sl); objs.push(obj); }
          else if (sid === 0x4600) lights++;
          else if (sid === 0x4700) cameras++;
          q += sl;
        }
      }
      o = e;
      onProgress?.('chunks', o / end);
    }
  };
  const parseKeyframer = (o: number, lim: number) => {
    while (o + 6 <= lim) {
      const id = dv.getUint16(o, true), len = dv.getUint32(o + 2, true);
      if (len < 6 || o + len > lim) break;
      if (id === 0xb002) {
        let q = o + 6, name = '', parent = -1, nid = hier.length;
        while (q + 6 <= o + len) {
          const sid = dv.getUint16(q, true), sl = dv.getUint32(q + 2, true);
          if (sl < 6 || q + sl > o + len) break;
          if (sid === 0xb010) { const [s, p] = cstr(q + 6, q + sl); name = s; parent = dv.getInt16(p + 4, true); }
          else if (sid === 0xb030 && sl >= 8) nid = dv.getInt16(q + 6, true);
          q += sl;
        }
        hier.push({ name, parent, id: nid });
      }
      o += len;
    }
  };

  let o = 6;
  while (o + 6 <= end) {
    const id = dv.getUint16(o, true), len = dv.getUint32(o + 2, true);
    if (len < 6) { badChunks++; break; }
    const e = Math.min(end, o + len);
    if (o + len > end) gb.warn('Top level chunk is truncated');
    if (id === 0x0002 && len >= 10) version = dv.getUint32(o + 6, true);
    else if (id === 0x3d3d) parseEditor(o + 6, e);
    else if (id === 0xb000) parseKeyframer(o + 6, e);
    o += len;
  }
  if (badChunks) gb.warn(`${badChunks} malformed chunks skipped`);

  // keyframer hierarchy: parent names for grouping
  const parentOf = new Map<string, string>();
  const byId = new Map<number, string>(); hier.forEach((h) => byId.set(h.id, h.name));
  hier.forEach((h) => { if (h.parent >= 0 && byId.has(h.parent) && h.name !== '$$$DUMMY') parentOf.set(h.name, byId.get(h.parent)!); });

  const matBucket = (name: string | null): number => {
    if (!name) return gb.bucket('', { name: 'default', color: DEFAULT_GREY, schema: '3DS' });
    const m = mats.get(name);
    return gb.bucket('m:' + name, { name, color: m?.color ?? DEFAULT_GREY, opacity: m && m.opacity < 1 ? m.opacity : undefined, textureName: m?.texture, schema: '3DS material' });
  };

  let tri = 0, mirrored = 0;
  objs.forEach((obj, oi) => {
    if (!obj.verts || !obj.faces) return;
    const F = obj.faces;
    const nv = obj.verts.length / 3, nf = F.length / 4;
    const el = gb.element({ name: obj.name || `object ${oi + 1}`, className: '3dsObject', categoryName: parentOf.get(obj.name) ?? '3DS', typeName: null });
    if (obj.matrix) {
      const m = obj.matrix;
      const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
      if (det < 0) mirrored++;
    }
    // vertices are stored in world space already; MESH_MATRIX only describes the object's local axes.
    const V = obj.verts;
    // per face normals
    const fnrm = new Float32Array(nf * 3);
    for (let f = 0; f < nf; f++) {
      const a = obj.faces[f * 4], b = obj.faces[f * 4 + 1], c = obj.faces[f * 4 + 2];
      if (a >= nv || b >= nv || c >= nv) continue;
      const ux = V[b * 3] - V[a * 3], uy = V[b * 3 + 1] - V[a * 3 + 1], uz = V[b * 3 + 2] - V[a * 3 + 2];
      const vx = V[c * 3] - V[a * 3], vy = V[c * 3 + 1] - V[a * 3 + 1], vz = V[c * 3 + 2] - V[a * 3 + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz) || 1;
      fnrm[f * 3] = nx / l; fnrm[f * 3 + 1] = ny / l; fnrm[f * 3 + 2] = nz / l;
    }
    // vertex -> faces adjacency (for smoothing groups)
    const sg = obj.smooth;
    let adjStart: Uint32Array | null = null, adj: Uint32Array | null = null;
    if (sg) {
      adjStart = new Uint32Array(nv + 1);
      for (let f = 0; f < nf; f++) for (let k = 0; k < 3; k++) { const v = obj.faces[f * 4 + k]; if (v < nv) adjStart[v + 1]++; }
      for (let i = 0; i < nv; i++) adjStart[i + 1] += adjStart[i];
      adj = new Uint32Array(adjStart[nv]); const fill = adjStart.slice(0, nv);
      for (let f = 0; f < nf; f++) for (let k = 0; k < 3; k++) { const v = obj.faces[f * 4 + k]; if (v < nv) adj[fill[v]++] = f; }
    }
    const emit = (faces: ArrayLike<number>, bucket: number) => {
      const pos = new GrowF32(faces.length * 9), nrm = new GrowF32(faces.length * 9);
      for (let j = 0; j < faces.length; j++) {
        const f = faces[j]; if (f >= nf) continue;
        if (F[f * 4] >= nv || F[f * 4 + 1] >= nv || F[f * 4 + 2] >= nv) { gb.skippedFaces++; continue; }
        for (let k = 0; k < 3; k++) {
          const v = F[f * 4 + k];
          pos.push3(V[v * 3], V[v * 3 + 1], V[v * 3 + 2]);
          let nx = fnrm[f * 3], ny = fnrm[f * 3 + 1], nz = fnrm[f * 3 + 2];
          if (sg && sg[f] && adj && adjStart) {
            nx = 0; ny = 0; nz = 0;
            for (let q = adjStart[v]; q < adjStart[v + 1]; q++) { const g = adj[q]; if (g === f || (sg[g] & sg[f])) { nx += fnrm[g * 3]; ny += fnrm[g * 3 + 1]; nz += fnrm[g * 3 + 2]; } }
          }
          nrm.push3(nx, ny, nz);
        }
      }
      gb.addMesh(el, bucket, pos.take(), nrm.take(), null, null);
      tri += pos.n / 9;
    };
    const used = new Uint8Array(nf);
    for (const g of obj.groups) {
      const list: number[] = [];
      for (const f of g.faces) if (f < nf && !used[f]) { used[f] = 1; list.push(f); }
      if (list.length) emit(list, matBucket(g.mat));
    }
    const rest: number[] = []; for (let f = 0; f < nf; f++) if (!used[f]) rest.push(f);
    if (rest.length) emit(rest, matBucket(null));
  });
  if (!objs.length) gb.warn('No mesh objects found');
  const ext = gb.extents();
  const u = guessUnits(ext, null);
  gb.warn(`3DS has no reliable units: ${u.why}, converted to metres`);
  const geometry = gb.finish({ postScale: u.scale });
  geometry.stats.ms = Date.now() - t0;
  const info: Record<string, string | number> = {
    format: '3D Studio (.3ds)', version, meshVersion, objects: objs.length, materials: mats.size,
    lights, cameras, masterScale, units: u.unit, unitAssumption: u.why, upAxis: 'Z', triangles: geometry.stats.triangles,
  };
  if (mirrored) info.mirroredObjects = mirrored;
  return { kind: '3d', geometry, info };
}
