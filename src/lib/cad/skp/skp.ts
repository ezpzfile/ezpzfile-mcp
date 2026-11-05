// SketchUp .skp reader for ezpzfile.com. Clean-room: written from analysis of sample files only (see NOTEBOOK.md).
// Entry points: readSkp(bytes, onProgress) and sniffSkp(bytes). Output: RvtGeometry (metres, Z-up).
// Runs in a Web Worker: browser built-ins only (DataView, TextDecoder, DecompressionStream).

import { SkpError, LOOP_STATS } from './geom.ts';
import { buildGeometry } from './build.ts';
import { readVff } from './vff.ts';
import { readLegacy } from './legacy.ts';
import type { SkpModel } from './model.ts';
import type { RvtGeometry } from './types.ts';

export { SkpError } from './geom.ts';

export interface SkpTexture { name: string; mime: string; bytes: Uint8Array }
/** RvtGeometry plus the optional SketchUp extra: embedded texture images (material.appearance.textureName = name) */
export type SkpGeometry = RvtGeometry & { textures?: SkpTexture[] };
export interface SkpResult { kind: '3d'; geometry: SkpGeometry; info: Record<string, string | number> }

const MAGIC = 'SketchUp Model';

/** read one length prefixed UTF-16LE string (MFC CString style: ff fe ff, u8 length, or ff ff + u16 / ffff ffff + u32) */
export function readUtf16(b: Uint8Array, p: number): { s: string; end: number } | null {
  if (p + 4 > b.length || b[p] !== 0xff || b[p + 1] !== 0xfe || b[p + 2] !== 0xff) return null;
  let n = b[p + 3], q = p + 4;
  if (n === 0xff) {
    n = b[q] | (b[q + 1] << 8); q += 2;
    if (n === 0xffff) { n = (b[q] | (b[q + 1] << 8) | (b[q + 2] << 16) | (b[q + 3] << 24)) >>> 0; q += 4; }
  }
  if (q + n * 2 > b.length) return null;
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(b[q + i * 2] | (b[q + i * 2 + 1] << 8));
  return { s, end: q + n * 2 };
}

export function sniffSkp(bytes: Uint8Array): boolean {
  const h = readUtf16(bytes, 0);
  return !!h && h.s === MAGIC;
}

function header(bytes: Uint8Array): { version: string; next: number } {
  const h = readUtf16(bytes, 0);
  if (!h || h.s !== MAGIC) throw new SkpError('not-format', 'Not a SketchUp file (no "SketchUp Model" header)');
  const v = readUtf16(bytes, h.end);
  if (!v || !/^\{\d+\.\d+(\.\d+)?\}$/.test(v.s)) throw new SkpError('corrupt', 'SketchUp header without a version string');
  return { version: v.s, next: v.end };
}

export function skpVersion(bytes: Uint8Array): string | null { try { return header(bytes).version; } catch { return null; } }

export async function readSkp(bytes: Uint8Array, onProgress?: (stage: string, ratio: number) => void): Promise<SkpResult> {
  try {
    return await readSkpInner(bytes, onProgress);
  } catch (e) {
    const err = e as Error & { code?: string };
    if (err && typeof err.code === 'string' && ['unsupported-version', 'corrupt', 'encrypted', 'too-large', 'not-format'].includes(err.code)) throw err;
    // anything else (out of range reads on damaged data and the like) is reported as a damaged file
    throw new SkpError('corrupt', `The SketchUp file could not be read: ${err?.message ?? String(e)}`);
  }
}

async function readSkpInner(bytes: Uint8Array, onProgress?: (stage: string, ratio: number) => void): Promise<SkpResult> {
  const t0 = Date.now();
  LOOP_STATS.loops = 0; LOOP_STATS.open = 0; LOOP_STATS.broken = 0;
  const { version, next } = header(bytes);
  const major = parseInt(version.slice(1), 10);
  onProgress?.('header', 0.01);
  let model: SkpModel;
  const isVff = bytes[next] === 0x56 && bytes[next + 1] === 0x46 && bytes[next + 2] === 0x46; // "VFF"
  if (isVff) {
    // VFF block: "VFF" + 10 bytes, then a ZIP archive (local file header PK\3\4)
    let z = -1;
    for (let i = next; i < Math.min(bytes.length - 4, next + 256); i++) if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 3 && bytes[i + 3] === 4) { z = i; break; }
    if (z < 0) throw new SkpError('corrupt', 'SketchUp 2021+ file without its ZIP part');
    model = await readVff(bytes, z, version, onProgress);
  } else {
    model = await readLegacy(bytes, next, version, onProgress);
  }
  // texture names: file base name, made unique; materials point to them by name
  const texNames: string[] = [];
  const used = new Set<string>();
  model.textures.forEach((t, i) => {
    const base = (t.name.split(/[\\/]/).pop() || `texture${i}`).trim() || `texture${i}`;
    let nm = base, k = 2;
    while (used.has(nm.toLowerCase())) { const dot = base.lastIndexOf('.'); nm = dot > 0 ? `${base.slice(0, dot)}~${k}${base.slice(dot)}` : `${base}~${k}`; k++; }
    used.add(nm.toLowerCase()); texNames[i] = nm; t.name = nm;
  });
  for (const m of model.materials.values()) {
    if (m.textureIndex !== undefined && texNames[m.textureIndex]) m.textureName = texNames[m.textureIndex];
    else if (m.textureName) m.textureName = m.textureName.split(/[\\/]/).pop() || m.textureName;
  }
  onProgress?.('geometry', 0.65);
  const { geometry, stats } = buildGeometry(model, { onProgress: (r) => onProgress?.('geometry', 0.65 + 0.33 * r) });
  const g = geometry as SkpGeometry;
  // only the images of materials that ended up in the output
  const wanted = new Set((g.materials ?? []).map((m) => m.appearance.textureName).filter(Boolean) as string[]);
  const tex = model.textures.filter((t) => wanted.has(t.name));
  if (tex.length) g.textures = tex;
  // texture names on materials: buckets carry SketchUp materials by name, appearance.textureName already set
  let defsFaces = 0, defsEdges = 0, soft = 0;
  for (const d of model.defs.values()) { defsFaces += d.ents.faces.length; defsEdges += d.ents.counts.edges; soft += d.ents.counts.softEdges; }
  const info: Record<string, string | number> = {
    format: 'SketchUp',
    version: version.slice(1, -1),
    sketchupVersion: major >= 13 ? `20${major}` : String(major),
    container: model.container === 'vff' ? 'VFF + ZIP (2021+)' : 'legacy object stream',
    units: 'inch (internal), output m',
    upAxis: 'Z',
    definitions: model.defs.size,
    materials: model.materials.size,
    tags: model.layers.size,
    rootFaces: model.root.faces.length,
    rootInstances: model.root.instances.length,
    definitionFaces: defsFaces,
    definitionEdges: defsEdges,
    softEdges: soft + model.root.counts.softEdges,
    instancesPlaced: stats.instancesPlaced,
    triangles: geometry.stats.triangles,
    textures: tex.length,
    faceLoops: LOOP_STATS.loops,
    openLoops: LOOP_STATS.open + LOOP_STATS.broken,
    ...model.info,
  };
  geometry.stats.ms = Date.now() - t0;
  onProgress?.('done', 1);
  return { kind: '3d', geometry: g, info };
}
