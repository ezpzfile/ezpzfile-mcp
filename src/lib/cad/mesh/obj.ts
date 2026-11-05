// Wavefront OBJ reader. Clean-room, written from the public OBJ format description
// (Wavefront "Advanced Visualizer" manual, Appendix B1 "Object Files (.obj)") and sample analysis.
// A single .obj cannot bring its .mtl, so materials are grey buckets named after `usemtl`.
// OBJ is unitless and most exporters write Y-up: we convert Y-up to Z-up and guess the units.

import { GeomBuilder, MeshError, Y_UP_TO_Z_UP, decodeText, guessUnits, DEFAULT_GREY, type MeshResult, type Progress } from './common.ts';

export function sniffObj(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 65536);
  for (let i = 0; i < Math.min(n, 4096); i++) { const c = bytes[i]; if (c === 0 || (c < 9) || (c > 13 && c < 32 && c !== 27)) return false; }
  const s = new TextDecoder('latin1').decode(bytes.subarray(0, n));
  // need vertex lines and (face or line or point) lines, all non-comment lines starting with OBJ keywords
  let v = 0, f = 0, other = 0;
  for (const raw of s.split(/\r?\n/).slice(0, 400)) {
    const l = raw.trim();
    if (!l || l[0] === '#') continue;
    const k = l.split(/\s+/, 1)[0];
    if (k === 'v') v++;
    else if (k === 'f' || k === 'l' || k === 'p') f++;
    else if (!/^(vn|vt|vp|g|o|s|usemtl|mtllib|usemap|maplib|cstype|deg|curv|curv2|surf|parm|trim|hole|scrv|sp|end|con|mg|bevel|c_interp|d_interp|lod|shadow_obj|trace_obj|ctech|stech|bmat|step|call|csh)$/.test(k)) other++;
  }
  return v >= 3 && other <= 2 && (f > 0 || v > 50);
}

interface Chunk {
  bucket: number;
  pos: number[]; nrm: number[]; idx: number[]; map: Map<number, number>;
  flatPos: number[]; // faces without normals, already triangulated, flat
}

export async function readObj(bytes: Uint8Array, onProgress?: Progress): Promise<MeshResult> {
  const t0 = Date.now();
  if (!sniffObj(bytes)) throw new MeshError('not-format', 'Not a Wavefront OBJ text file');
  const gb = new GeomBuilder();
  const text = decodeText(bytes);
  const V: number[] = [];     // positions
  const C: number[] = [];     // vertex colours (r g b after xyz), parallel to V when present
  let hasColors = false, colorVaries = false;
  const N: number[] = [];
  let vtCount = 0;
  let objName: string | null = null, grpName: string | null = null;
  let mtl = '(default)';
  const mtllibs: string[] = [];
  const materialsSeen = new Set<string>();
  let el = -1;
  let chunks = new Map<string, Chunk>();
  const elByKey = new Map<string, number>();
  let faces = 0, ngons = 0, badRefs = 0, lineSegs = 0, curves = 0;
  const lines: number[] = [];

  const ensureElement = () => {
    if (el > 0) return;
    const key = `${objName ?? ''}\u0000${grpName ?? ''}`;
    const ex = elByKey.get(key);
    if (ex) { el = ex; return; }
    const name = grpName ?? objName ?? 'OBJ mesh';
    el = gb.element({ name, className: grpName ? 'ObjGroup' : objName ? 'ObjObject' : 'ObjMesh', categoryName: objName ?? 'OBJ', typeName: objName && grpName && objName !== grpName ? objName : null });
    elByKey.set(key, el);
  };
  const flush = () => {
    for (const c of chunks.values()) {
      if (c.idx.length) gb.addMesh(el, c.bucket, c.pos, c.nrm, c.idx, Y_UP_TO_Z_UP);
      if (c.flatPos.length) gb.addMesh(el, c.bucket, c.flatPos, null, null, Y_UP_TO_Z_UP);
    }
    chunks = new Map();
  };
  const chunkFor = (colKey: string, col: [number, number, number] | null): Chunk => {
    const key = mtl + '\u0000' + colKey;
    let c = chunks.get(key);
    if (!c) {
      const bucket = gb.bucket(key, { name: col ? `${mtl} ${colKey}` : mtl, color: col ?? DEFAULT_GREY, schema: 'OBJ usemtl' });
      c = { bucket, pos: [], nrm: [], idx: [], map: new Map(), flatPos: [] };
      chunks.set(key, c);
    }
    return c;
  };

  const len = text.length;
  let p = 0;
  let lineNo = 0;
  const cv: number[] = [], cn: number[] = [];
  while (p < len) {
    let e = text.indexOf('\n', p);
    if (e < 0) e = len;
    let line = text.slice(p, e);
    p = e + 1;
    lineNo++;
    // line continuation with a backslash
    while (line.endsWith('\\') && p < len) { let e2 = text.indexOf('\n', p); if (e2 < 0) e2 = len; line = line.slice(0, -1) + ' ' + text.slice(p, e2); p = e2 + 1; }
    const c0 = line.charCodeAt(0);
    if (c0 === 35 /* # */ || line.length < 2) continue;
    if (c0 === 118 /* v */) {
      const c1 = line.charCodeAt(1);
      if (c1 === 32 || c1 === 9) {
        const t = line.trim().split(/\s+/);
        V.push(+t[1] || 0, +t[2] || 0, +t[3] || 0);
        if (t.length >= 7) {
          const r = +t[4], g = +t[5], b = +t[6];
          if (!hasColors && V.length > 3) { for (let i = 0; i < V.length / 3 - 1; i++) C.push(1, 1, 1); }
          hasColors = true;
          C.push(r, g, b);
          if (!colorVaries && C.length > 3 && (r !== C[0] || g !== C[1] || b !== C[2])) colorVaries = true;
        } else if (hasColors) C.push(1, 1, 1);
      } else if (c1 === 110 /* n */) { const t = line.trim().split(/\s+/); N.push(+t[1] || 0, +t[2] || 0, +t[3] || 0); }
      else if (c1 === 116 /* t */) vtCount++;
      continue;
    }
    if (c0 === 102 /* f */ && (line.charCodeAt(1) === 32 || line.charCodeAt(1) === 9)) {
      ensureElement();
      const t = line.trim().split(/\s+/);
      cv.length = 0; cn.length = 0;
      const nV = V.length / 3, nN = N.length / 3;
      let ok = true;
      for (let i = 1; i < t.length; i++) {
        const tok = t[i];
        const s1 = tok.indexOf('/');
        let vi = parseInt(s1 < 0 ? tok : tok.slice(0, s1), 10);
        let ni = -1;
        if (s1 >= 0) { const s2 = tok.indexOf('/', s1 + 1); if (s2 >= 0 && s2 + 1 < tok.length) { ni = parseInt(tok.slice(s2 + 1), 10); ni = ni < 0 ? nN + ni : ni - 1; } }
        if (!isFinite(vi)) { ok = false; break; }
        vi = vi < 0 ? nV + vi : vi - 1;
        if (vi < 0 || vi >= nV) { ok = false; break; }
        if (ni >= nN || ni < -1) ni = -1;
        cv.push(vi); cn.push(ni);
      }
      if (!ok || cv.length < 3) { badRefs++; continue; }
      faces++;
      if (cv.length > 4) ngons++;
      let colKey = '', col: [number, number, number] | null = null;
      if (hasColors && colorVaries) {
        let r = 0, g = 0, b = 0;
        for (const vi of cv) { r += C[vi * 3]; g += C[vi * 3 + 1]; b += C[vi * 3 + 2]; }
        const q = (x: number) => Math.round(Math.min(1, Math.max(0, x / cv.length)) * 15) / 15;
        col = [q(r), q(g), q(b)];
        colKey = `rgb(${col.map((x) => Math.round(x * 255)).join(',')})`;
      }
      const ch = chunkFor(colKey, col);
      const allN = cn.every((x) => x >= 0);
      if (allN) {
        const ids: number[] = [];
        for (let i = 0; i < cv.length; i++) {
          const key = cn[i] * 67108864 + cv[i];
          let id = ch.map.get(key);
          if (id === undefined) {
            id = ch.pos.length / 3; ch.map.set(key, id);
            ch.pos.push(V[cv[i] * 3], V[cv[i] * 3 + 1], V[cv[i] * 3 + 2]);
            ch.nrm.push(N[cn[i] * 3], N[cn[i] * 3 + 1], N[cn[i] * 3 + 2]);
          }
          ids.push(id);
        }
        for (let i = 1; i + 1 < ids.length; i++) ch.idx.push(ids[0], ids[i], ids[i + 1]);
      } else {
        for (let i = 1; i + 1 < cv.length; i++) for (const vi of [cv[0], cv[i], cv[i + 1]]) ch.flatPos.push(V[vi * 3], V[vi * 3 + 1], V[vi * 3 + 2]);
      }
      if ((faces & 0xffff) === 0 && onProgress) onProgress('faces', p / len);
      continue;
    }
    const t = line.trim().split(/\s+/);
    const k = t[0];
    if (k === 'o') { flush(); objName = t.slice(1).join(' ') || null; grpName = null; el = -1; }
    else if (k === 'g') { flush(); grpName = t.slice(1).join(' ') || null; el = -1; }
    else if (k === 'usemtl') { mtl = t.slice(1).join(' ') || '(default)'; materialsSeen.add(mtl); }
    else if (k === 'mtllib') mtllibs.push(t.slice(1).join(' '));
    else if (k === 'l') {
      const nV = V.length / 3;
      const ids = t.slice(1).map((x) => { const v = parseInt(x, 10); return v < 0 ? nV + v : v - 1; }).filter((v) => v >= 0 && v < nV);
      for (let i = 0; i + 1 < ids.length; i++) { lines.push(V[ids[i] * 3], V[ids[i] * 3 + 1], V[ids[i] * 3 + 2], V[ids[i + 1] * 3], V[ids[i + 1] * 3 + 1], V[ids[i + 1] * 3 + 2]); lineSegs++; }
    } else if (k === 'curv' || k === 'surf' || k === 'curv2') curves++;
  }
  flush();
  if (lines.length) gb.addLines(lines, Y_UP_TO_Z_UP);
  if (V.length === 0) throw new MeshError('corrupt', 'OBJ file has no vertices');

  const ext = gb.extents();
  const u = guessUnits(ext, null);
  gb.warn(`OBJ has no units: ${u.why}, converted to metres; Y-up converted to Z-up`);
  if (mtllibs.length) gb.warn(`Material library ${mtllibs.join(', ')} is a separate file and cannot be read from a single .obj: materials shown grey, grouped by usemtl name`);
  if (badRefs) gb.warn(`${badRefs} faces with invalid vertex references skipped`);
  if (curves) gb.warn(`${curves} free-form curves/surfaces are not supported`);
  if (faces === 0 && lineSegs === 0) gb.warn('OBJ has vertices but no faces');
  const geometry = gb.finish({ postScale: u.scale });
  geometry.stats.ms = Date.now() - t0;
  const info: Record<string, string | number> = {
    format: 'Wavefront OBJ', vertices: V.length / 3, normals: N.length / 3, texcoords: vtCount, faces, ngons,
    lineSegments: lineSegs, groups: elByKey.size, materials: materialsSeen.size,
    units: u.unit, unitAssumption: u.why, upAxis: 'Y (assumed, converted to Z-up)', triangles: geometry.stats.triangles,
  };
  if (mtllibs.length) info.mtllib = mtllibs.join(', ');
  if (hasColors) info.vertexColors = colorVaries ? 'yes (faces bucketed by average colour)' : 'yes (uniform, ignored)';
  const m = /^#\s*(.+)$/m.exec(text.slice(0, 500));
  if (m) info.comment = m[1].trim().slice(0, 120);
  return { kind: '3d', geometry, info };
}
