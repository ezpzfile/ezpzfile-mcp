// glTF 2.0 reader (.gltf JSON with embedded data URIs, and .glb). Clean-room, written from the
// Khronos glTF 2.0 specification (https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html) and the
// extension specifications in https://github.com/KhronosGroup/glTF/tree/main/extensions (text only).
// glTF is Y-up, metres: converted to Z-up.

import {
  GeomBuilder, MeshError, Y_UP_TO_Z_UP, fromQuat, identity, linearToSrgb, mul, scaling, translation, utf8,
  DEFAULT_GREY, type Mat4, type MatSpec, type MeshResult, type Progress,
} from './common.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
type J = any;

export function sniffGltf(bytes: Uint8Array): boolean {
  if (bytes.length >= 12 && bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46) return true; // 'glTF'
  // JSON: starts with { and mentions "asset" with a version
  let i = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) i = 3;
  while (i < bytes.length && (bytes[i] === 32 || bytes[i] === 9 || bytes[i] === 10 || bytes[i] === 13)) i++;
  if (bytes[i] !== 0x7b) return false;
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 1 << 20)));
  return /"asset"\s*:/.test(head) && /"version"\s*:\s*"2/.test(head);
}

const COMP: Record<number, { size: number; get: (dv: DataView, o: number) => number; norm: number }> = {
  5120: { size: 1, get: (d, o) => d.getInt8(o), norm: 127 },
  5121: { size: 1, get: (d, o) => d.getUint8(o), norm: 255 },
  5122: { size: 2, get: (d, o) => d.getInt16(o, true), norm: 32767 },
  5123: { size: 2, get: (d, o) => d.getUint16(o, true), norm: 65535 },
  5125: { size: 4, get: (d, o) => d.getUint32(o, true), norm: 4294967295 },
  5126: { size: 4, get: (d, o) => d.getFloat32(o, true), norm: 1 },
};
const NCOMP: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };

class Unreadable extends Error { why: string; constructor(why: string) { super(why); this.why = why; } }

export async function readGltf(bytes: Uint8Array, onProgress?: Progress): Promise<MeshResult> {
  const t0 = Date.now();
  const gb = new GeomBuilder();
  let json: J;
  let bin: Uint8Array | null = null;
  let container = 'gltf';
  if (bytes.length >= 12 && bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46) {
    container = 'glb';
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const version = dv.getUint32(4, true);
    if (version !== 2) throw new MeshError('unsupported-version', `GLB container version ${version} (only glTF 2.0 is supported)`);
    const total = Math.min(dv.getUint32(8, true), bytes.length);
    if (dv.getUint32(8, true) > bytes.length) gb.warn('GLB file is truncated');
    let o = 12;
    while (o + 8 <= total) {
      const clen = dv.getUint32(o, true), ctype = dv.getUint32(o + 4, true);
      const data = bytes.subarray(o + 8, Math.min(total, o + 8 + clen));
      if (ctype === 0x4e4f534a && !json) { try { json = JSON.parse(utf8(data)); } catch { throw new MeshError('corrupt', 'GLB JSON chunk is not valid JSON'); } }
      else if (ctype === 0x004e4942 && !bin) bin = data;
      o += 8 + clen + ((4 - (clen % 4)) % 4);
    }
    if (!json) throw new MeshError('corrupt', 'GLB has no JSON chunk');
  } else {
    try { json = JSON.parse(utf8(bytes)); } catch { throw new MeshError('not-format', 'Not a glTF JSON file'); }
  }
  const ver = String(json?.asset?.version ?? '');
  if (!ver.startsWith('2')) throw new MeshError('unsupported-version', `glTF version "${ver || 'unknown'}" (only 2.0 is supported; 1.0 files differ)`);
  onProgress?.('json', 0.05);

  const used: string[] = json.extensionsUsed ?? [];
  const required: string[] = json.extensionsRequired ?? [];
  const SUPPORTED = new Set(['KHR_mesh_quantization', 'KHR_materials_unlit', 'KHR_materials_emissive_strength', 'KHR_texture_transform', 'KHR_materials_pbrSpecularGlossiness', 'KHR_materials_transmission', 'KHR_materials_volume', 'KHR_materials_ior', 'KHR_materials_specular', 'KHR_materials_clearcoat', 'KHR_materials_sheen', 'KHR_materials_iridescence', 'KHR_materials_anisotropy', 'KHR_materials_dispersion', 'KHR_materials_diffuse_transmission', 'KHR_materials_variants', 'KHR_lights_punctual', 'KHR_texture_basisu', 'EXT_texture_webp', 'EXT_texture_avif', 'EXT_mesh_gpu_instancing', 'KHR_xmp_json_ld', 'KHR_animation_pointer', 'KHR_node_visibility']);
  for (const r of required) if (!SUPPORTED.has(r) && !/draco|meshopt/i.test(r)) gb.warn(`Required extension ${r} is not supported: geometry may be wrong`);

  // ---- buffers
  const buffers: Array<Uint8Array | null> = [];
  const bufWhy: string[] = [];
  (json.buffers ?? []).forEach((b: J, i: number) => {
    if (b.uri === undefined) {
      if (container === 'glb' && i === 0 && bin) { buffers.push(bin); bufWhy.push(''); }
      else { buffers.push(null); bufWhy.push(b.extensions?.EXT_meshopt_compression?.fallback || b.extensions?.KHR_meshopt_compression?.fallback ? 'meshopt fallback buffer (no data)' : 'buffer has no data'); }
      return;
    }
    const uri: string = b.uri;
    const m = /^data:([^,]*?)(;base64)?,(.*)$/s.exec(uri);
    if (m) {
      try {
        if (m[2]) { const s = atob(m[3]); const a = new Uint8Array(s.length); for (let k = 0; k < s.length; k++) a[k] = s.charCodeAt(k); buffers.push(a); }
        else buffers.push(new TextEncoder().encode(decodeURIComponent(m[3])));
        bufWhy.push('');
      } catch { buffers.push(null); bufWhy.push('data URI could not be decoded'); }
    } else {
      buffers.push(null);
      bufWhy.push(`external file "${decodeURIComponent(uri)}"`);
      gb.warn(`Buffer ${i} is an external file "${decodeURIComponent(uri)}", which cannot be loaded when opening a single file: meshes using it are skipped (use .glb or embedded .gltf)`);
    }
  });
  const views: J[] = json.bufferViews ?? [];
  const accessors: J[] = json.accessors ?? [];
  const viewBytes = (vi: number): { data: Uint8Array; stride: number } => {
    const v = views[vi];
    if (!v) throw new Unreadable(`bufferView ${vi} missing`);
    if (v.extensions?.EXT_meshopt_compression || v.extensions?.KHR_meshopt_compression) throw new Unreadable('meshopt');
    const b = buffers[v.buffer];
    if (!b) throw new Unreadable(bufWhy[v.buffer] || `buffer ${v.buffer} missing`);
    const off = v.byteOffset ?? 0, len = v.byteLength ?? 0;
    if (off + len > b.length) throw new Unreadable('bufferView outside its buffer (truncated file)');
    return { data: b.subarray(off, off + len), stride: v.byteStride ?? 0 };
  };
  const accCache = new Map<number, Float32Array | Uint32Array>();
  /** read an accessor as floats (or uint32 for indices) honouring normalized and sparse */
  const readAcc = (ai: number, asIndex = false): Float32Array | Uint32Array => {
    const key = asIndex ? -1 - ai : ai;
    const c = accCache.get(key); if (c) return c;
    const a = accessors[ai];
    if (!a) throw new Unreadable(`accessor ${ai} missing`);
    const nc = NCOMP[a.type]; const ct = COMP[a.componentType];
    if (!nc || !ct) throw new Unreadable(`accessor ${ai} has an unknown type`);
    const count = a.count | 0;
    const out = asIndex ? new Uint32Array(count * nc) : new Float32Array(count * nc);
    const norm = !!a.normalized && a.componentType !== 5126;
    if (a.bufferView !== undefined) {
      const { data, stride } = viewBytes(a.bufferView);
      const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const es = ct.size * nc;
      const st = stride || es;
      const base = a.byteOffset ?? 0;
      if (base + st * (count - 1) + es > data.length) throw new Unreadable(`accessor ${ai} reads past its bufferView`);
      if (a.componentType === 5126 && !asIndex && (st === es) && ((data.byteOffset + base) % 4 === 0)) {
        out.set(new Float32Array(data.buffer, data.byteOffset + base, count * nc));
      } else {
        for (let i = 0; i < count; i++) for (let k = 0; k < nc; k++) {
          let v = ct.get(dv, base + i * st + k * ct.size);
          if (norm) v = Math.max(v / ct.norm, -1);
          out[i * nc + k] = v;
        }
      }
    }
    if (a.sparse) {
      const sp = a.sparse, n = sp.count | 0;
      const iv = viewBytes(sp.indices.bufferView), vv = viewBytes(sp.values.bufferView);
      const ict = COMP[sp.indices.componentType];
      const idv = new DataView(iv.data.buffer, iv.data.byteOffset, iv.data.byteLength);
      const vdv = new DataView(vv.data.buffer, vv.data.byteOffset, vv.data.byteLength);
      const io = sp.indices.byteOffset ?? 0, vo = sp.values.byteOffset ?? 0;
      for (let j = 0; j < n; j++) {
        const target = ict.get(idv, io + j * ict.size);
        if (target >= count) continue;
        for (let k = 0; k < nc; k++) {
          let v = ct.get(vdv, vo + (j * nc + k) * ct.size);
          if (norm) v = Math.max(v / ct.norm, -1);
          out[target * nc + k] = v;
        }
      }
    }
    accCache.set(key, out);
    return out;
  };

  // ---- materials
  const images: J[] = json.images ?? [], textures: J[] = json.textures ?? [];
  const texName = (ti: J): string | undefined => {
    if (!ti) return undefined;
    const t = textures[ti.index]; if (!t) return undefined;
    const src = t.source ?? t.extensions?.KHR_texture_basisu?.source ?? t.extensions?.EXT_texture_webp?.source ?? t.extensions?.EXT_texture_avif?.source;
    const im = images[src]; if (!im) return undefined;
    if (im.uri && !im.uri.startsWith('data:')) return decodeURIComponent(im.uri);
    return im.name ?? (im.mimeType ? `embedded image ${src} (${im.mimeType})` : `embedded image ${src}`);
  };
  const matSpecs: MatSpec[] = (json.materials ?? []).map((m: J, i: number) => {
    const pbr = m.pbrMetallicRoughness ?? {};
    const sg = m.extensions?.KHR_materials_pbrSpecularGlossiness;
    const f: number[] = sg?.diffuseFactor ?? pbr.baseColorFactor ?? [1, 1, 1, 1];
    let opacity = m.alphaMode === 'BLEND' ? (f[3] ?? 1) : 1;
    const tr = m.extensions?.KHR_materials_transmission?.transmissionFactor;
    if (tr && tr > 0.2) opacity = Math.min(opacity, 1 - 0.65 * Math.min(1, tr));
    const spec: MatSpec = {
      name: m.name || `material ${i}`,
      color: [linearToSrgb(f[0] ?? 1), linearToSrgb(f[1] ?? 1), linearToSrgb(f[2] ?? 1)],
      schema: sg ? 'glTF KHR_materials_pbrSpecularGlossiness' : 'glTF pbrMetallicRoughness',
      textureName: texName(sg?.diffuseTexture ?? pbr.baseColorTexture),
    };
    if (opacity < 1) spec.opacity = Math.max(0.05, opacity);
    if (typeof pbr.roughnessFactor === 'number') spec.roughness = pbr.roughnessFactor;
    if (typeof pbr.metallicFactor === 'number') spec.metallic = pbr.metallicFactor > 0.5;
    return spec;
  });
  const bucketFor = (mi: number | undefined, vcolor: [number, number, number] | null): number => {
    if (mi === undefined || !matSpecs[mi]) {
      if (vcolor) return gb.bucket(`vc${vcolor.join(',')}`, { name: 'vertex colours', color: vcolor, schema: 'glTF COLOR_0 (average)' });
      return gb.bucket('default', { name: 'default', color: DEFAULT_GREY, schema: 'glTF default material' });
    }
    const s = matSpecs[mi];
    if (vcolor && s.color.every((c) => c > 0.98)) return gb.bucket(`m${mi}vc${vcolor.join(',')}`, { ...s, color: vcolor, name: `${s.name} (vertex colours)` });
    return gb.bucket(`m${mi}`, s);
  };

  // ---- nodes
  const nodes: J[] = json.nodes ?? [];
  const meshes: J[] = json.meshes ?? [];
  const nodeMatrix = (n: J): Mat4 => {
    if (Array.isArray(n.matrix) && n.matrix.length === 16) return Float64Array.from(n.matrix);
    let m = identity();
    if (n.translation) m = mul(m, translation(n.translation[0], n.translation[1], n.translation[2]));
    if (n.rotation) m = mul(m, fromQuat(n.rotation[0], n.rotation[1], n.rotation[2], n.rotation[3]));
    if (n.scale) m = mul(m, scaling(n.scale[0], n.scale[1], n.scale[2]));
    return m;
  };
  let roots: number[];
  const sceneIdx = json.scene ?? 0;
  if (json.scenes?.[sceneIdx]?.nodes) roots = json.scenes[sceneIdx].nodes;
  else {
    const child = new Set<number>(); nodes.forEach((n) => (n.children ?? []).forEach((c: number) => child.add(c)));
    roots = nodes.map((_, i) => i).filter((i) => !child.has(i));
    if (!json.scenes) gb.warn('File has no scenes: all root nodes shown');
  }
  if ((json.scenes?.length ?? 0) > 1) gb.warn(`File has ${json.scenes.length} scenes: showing scene ${sceneIdx}`);
  if (json.skins?.length) gb.warn('Skinned meshes are shown in their bind (rest) pose; animation is ignored');
  if (meshes.some((m) => m.primitives?.some((p: J) => p.targets?.length))) gb.warn('Morph targets ignored (base shape shown)');

  let primDone = 0;
  const primTotal = meshes.reduce((s, m) => s + (m.primitives?.length ?? 0), 0) || 1;
  const visited = new Set<number>();
  const meshNamesSkipped = new Set<string>();
  let instancesDrawn = 0;

  const drawMesh = (mi: number, world: Mat4, el: number) => {
    const mesh = meshes[mi]; if (!mesh) return;
    const mname = mesh.name ?? `mesh ${mi}`;
    for (const prim of mesh.primitives ?? []) {
      primDone++;
      const mode = prim.mode ?? 4;
      if (prim.extensions?.KHR_draco_mesh_compression) {
        if (!meshNamesSkipped.has(mname)) gb.warn(`Mesh "${mname}" is Draco compressed (KHR_draco_mesh_compression): unsupported, skipped`, 'draco:' + mname);
        meshNamesSkipped.add(mname);
        continue;
      }
      try {
        if (prim.attributes?.POSITION === undefined) continue;
        const P = readAcc(prim.attributes.POSITION) as Float32Array;
        const nv = P.length / 3;
        let Nrm: Float32Array | null = prim.attributes.NORMAL !== undefined ? (readAcc(prim.attributes.NORMAL) as Float32Array) : null;
        if (Nrm && Nrm.length !== P.length) Nrm = null;
        let idx: Uint32Array | null = prim.indices !== undefined ? (readAcc(prim.indices, true) as Uint32Array) : null;
        let vcolor: [number, number, number] | null = null;
        if (prim.attributes.COLOR_0 !== undefined) {
          const a = accessors[prim.attributes.COLOR_0];
          const C = readAcc(prim.attributes.COLOR_0) as Float32Array;
          const nc = NCOMP[a.type] ?? 4;
          let r = 0, g = 0, b = 0; const n = C.length / nc;
          for (let i = 0; i < n; i++) { r += C[i * nc]; g += C[i * nc + 1]; b += C[i * nc + 2]; }
          if (n) { const q = (x: number) => Math.round(linearToSrgb(x / n) * 32) / 32; vcolor = [q(r), q(g), q(b)]; }
        }
        if (mode === 4 || mode === 5 || mode === 6) {
          const seq = idx ?? (() => { const s = new Uint32Array(nv); for (let i = 0; i < nv; i++) s[i] = i; return s; })();
          let tri: Uint32Array;
          if (mode === 4) tri = idx ?? seq.subarray(0, nv - (nv % 3));
          else {
            const n = Math.max(0, seq.length - 2); tri = new Uint32Array(n * 3);
            for (let i = 0; i < n; i++) {
              if (mode === 5) { if (i % 2 === 0) { tri[i * 3] = seq[i]; tri[i * 3 + 1] = seq[i + 1]; tri[i * 3 + 2] = seq[i + 2]; } else { tri[i * 3] = seq[i + 1]; tri[i * 3 + 1] = seq[i]; tri[i * 3 + 2] = seq[i + 2]; } }
              else { tri[i * 3] = seq[0]; tri[i * 3 + 1] = seq[i + 1]; tri[i * 3 + 2] = seq[i + 2]; }
            }
          }
          idx = tri;
          gb.addMesh(el, bucketFor(prim.material, vcolor), P, Nrm, idx, world);
        } else if (mode === 1 || mode === 2 || mode === 3) {
          const seq = idx ?? Uint32Array.from({ length: nv }, (_, i) => i);
          const seg: number[] = [];
          const push = (a: number, b: number) => { seg.push(P[a * 3], P[a * 3 + 1], P[a * 3 + 2], P[b * 3], P[b * 3 + 1], P[b * 3 + 2]); };
          if (mode === 1) for (let i = 0; i + 1 < seq.length; i += 2) push(seq[i], seq[i + 1]);
          else { for (let i = 0; i + 1 < seq.length; i++) push(seq[i], seq[i + 1]); if (mode === 2 && seq.length > 2) push(seq[seq.length - 1], seq[0]); }
          gb.addLines(seg, world);
        } else if (mode === 0) gb.warn('Point primitives are not shown');
      } catch (e) {
        if (e instanceof Unreadable) {
          if (e.why === 'meshopt') gb.warn(`Mesh "${mname}" uses meshopt compression (EXT_meshopt_compression): unsupported, skipped`, 'meshopt:' + mname);
          else gb.warn(`Mesh "${mname}" skipped: ${e.why}`, 'skip:' + mname + e.why);
        } else throw e;
      }
      if (onProgress && primDone % 16 === 0) onProgress('meshes', 0.1 + 0.85 * (primDone / primTotal));
    }
  };

  const walk = (ni: number, parent: Mat4, path: string[], depth: number) => {
    const n = nodes[ni];
    if (!n || depth > 256) return;
    if (visited.has(ni)) { gb.warn('Node graph has a cycle or a shared node: repeated node skipped'); return; }
    visited.add(ni);
    const world = mul(parent, nodeMatrix(n));
    const name = n.name ?? (n.mesh !== undefined ? meshes[n.mesh]?.name : null) ?? `node ${ni}`;
    const here = [...path, name];
    if (n.mesh !== undefined) {
      const inst = n.extensions?.EXT_mesh_gpu_instancing?.attributes;
      const el = gb.element({
        name, className: 'GltfNode', categoryName: path[0] ?? name,
        typeName: meshes[n.mesh]?.name ?? null, familyName: here.join(' / '),
      });
      if (inst) {
        try {
          const T = inst.TRANSLATION !== undefined ? readAcc(inst.TRANSLATION) : null;
          const R = inst.ROTATION !== undefined ? readAcc(inst.ROTATION) : null;
          const S = inst.SCALE !== undefined ? readAcc(inst.SCALE) : null;
          const count = (T?.length ?? 0) / 3 || (R?.length ?? 0) / 4 || (S?.length ?? 0) / 3;
          for (let i = 0; i < count; i++) {
            let m = identity();
            if (T) m = mul(m, translation(T[i * 3], T[i * 3 + 1], T[i * 3 + 2]));
            if (R) m = mul(m, fromQuat(R[i * 4], R[i * 4 + 1], R[i * 4 + 2], R[i * 4 + 3]));
            if (S) m = mul(m, scaling(S[i * 3], S[i * 3 + 1], S[i * 3 + 2]));
            drawMesh(n.mesh, mul(world, m), el);
            instancesDrawn++;
          }
        } catch (e) { if (e instanceof Unreadable) gb.warn(`Instancing data unreadable (${e.why})`); else throw e; }
      } else drawMesh(n.mesh, world, el);
    }
    for (const c of n.children ?? []) walk(c, world, here, depth + 1);
  };
  for (const r of roots) walk(r, Y_UP_TO_Z_UP, [], 0);
  if (!nodes.length && meshes.length) {
    gb.warn('File has meshes but no nodes: meshes shown at the origin');
    meshes.forEach((m, i) => drawMesh(i, Y_UP_TO_Z_UP, gb.element({ name: m.name ?? `mesh ${i}`, className: 'GltfMesh', categoryName: 'glTF' })));
  }
  if (meshNamesSkipped.size && gb.triangles === 0) gb.warn('All meshes are Draco compressed: nothing to show. Re-export without Draco compression to view this file.');

  const geometry = gb.finish({});
  geometry.stats.ms = Date.now() - t0;
  const info: Record<string, string | number> = {
    format: container === 'glb' ? 'glTF 2.0 binary (.glb)' : 'glTF 2.0 (.gltf)',
    generator: json.asset?.generator ?? '', version: ver,
    nodes: nodes.length, meshes: meshes.length, materials: (json.materials ?? []).length,
    triangles: geometry.stats.triangles, units: 'm', upAxis: 'Y (converted to Z-up)',
  };
  if (used.length) info.extensionsUsed = used.join(', ');
  if (instancesDrawn) info.gpuInstances = instancesDrawn;
  if (json.asset?.copyright) info.copyright = String(json.asset.copyright);
  return { kind: '3d', geometry, info };
}
