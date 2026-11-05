// Autodesk Inventor part (.ipt) / assembly (.iam) / drawing (.idw) reader: 3D solids from the embedded solid model
// stream, assemblies by placing the referenced parts, PNG preview as a fallback.
// Clean-room: built from the sample bytes and the public OLE compound file layout only (see NOTEBOOK.md).
// Runs in a Web Worker: no DOM, no Node APIs, no dependencies.

import { Cfb, CfbError, isCfb } from './cfb.ts';
import { inflate } from './inflate.ts';
import { findSab, readSab } from './sab.ts';
import type { SabFile } from './sab.ts';
import { buildAsm } from './asm.ts';
import { FaceMesher, nmesh } from './facemesh.ts';
import { GeomBuilder } from './out.ts';
import type { RvtGeometry, RvtSheet2D } from './types.ts';
import { readAssembly } from './iam.ts';
import type { Occurrence } from './iam.ts';

export type InventorErrorCode = 'unsupported-version' | 'corrupt' | 'encrypted' | 'too-large' | 'not-format';
export class InventorError extends Error {
  code: InventorErrorCode;
  constructor(code: InventorErrorCode, message: string) { super(message); this.name = 'InventorError'; this.code = code; }
}
export type InventorInfo = Record<string, string | number>;
export type InventorResult =
  | { kind: '3d'; geometry: RvtGeometry; info: InventorInfo }
  | { kind: '2d'; sheets: RvtSheet2D[]; layers: { name: string; color: string; visible: boolean }[]; info: InventorInfo };
export interface ReadInventorOptions {
  /** fetch a referenced component by the path stored in the assembly (relative to the assembly when possible) */
  resolve?: (relPath: string) => Uint8Array | null;
  maxTriangles?: number;
  edges?: boolean;
  curveSegments?: number;
}

const MAX_BYTES = 1024 * 1024 * 1024;

// ------------------------------------------------------------------ container helpers
export interface InvDoc { cfb: Cfb; kind: 'part' | 'assembly' | 'drawing' | 'unknown'; segments: Map<string, Uint8Array>; segNames: string[]; warnings: string[] }

function asciiUtf16(b: Uint8Array, min: number): string[] {
  const out: string[] = [];
  for (const start of [0, 1]) {
    let cur = '';
    for (let i = start; i + 1 < b.length; i += 2) {
      const c = b[i] | (b[i + 1] << 8);
      if (c >= 0x20 && c < 0x7f) cur += String.fromCharCode(c);
      else { if (cur.length >= min) out.push(cur); cur = ''; }
    }
    if (cur.length >= min) out.push(cur);
  }
  return out;
}
function utf16Strings(b: Uint8Array, min = 4): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i + 1 < b.length; i += 2) {
    const c = b[i] | (b[i + 1] << 8);
    if ((c >= 0x20 && c < 0x7f) || (c >= 0xa0 && c < 0x250) || (c >= 0x3000 && c < 0xa000) || (c >= 0xff00 && c < 0xffa0)) cur += String.fromCharCode(c);
    else { if (cur.length >= min) out.push(cur); cur = ''; }
  }
  if (cur.length >= min) out.push(cur);
  return out;
}
function allUtf16(b: Uint8Array, min = 4): string[] {
  // strings may start at odd offsets
  const a = utf16Strings(b, min), c = utf16Strings(b.subarray(1), min);
  return [...a, ...c];
}

/** Inventor's own storages: RSeStorage with a segment table, plus UFRxDoc */
export function sniffInventor(bytes: Uint8Array): boolean {
  if (!bytes || !isCfb(bytes)) return false;
  try {
    const c = new Cfb(bytes, 20000);
    const names = c.allNames();
    return names.includes('RSeStorage/RSeSegInfo') || (names.includes('UFRxDoc') && names.some((n) => n.startsWith('RSeStorage/')));
  } catch {
    // truncated or partial header: look for the storage names in UTF-16
    const s = String.fromCharCode(...bytes.subarray(0, Math.min(bytes.length, 1 << 16)).filter((_, i) => i % 2 === 0));
    return s.includes('RSeStorage') && s.includes('RSeSegInfo');
  }
}

export function openInventor(bytes: Uint8Array): InvDoc {
  let cfb: Cfb;
  try { cfb = new Cfb(bytes); }
  catch (e) { throw new InventorError(e instanceof CfbError ? e.code : 'corrupt', (e as Error).message); }
  const names = cfb.allNames();
  if (!names.includes('RSeStorage/RSeSegInfo') && !names.includes('UFRxDoc')) throw new InventorError('not-format', 'OLE file without Inventor storages');
  const warnings: string[] = [];
  const segments = new Map<string, Uint8Array>();
  const segNames: string[] = [];
  for (const st of cfb.streams()) {
    if (!st.name.startsWith('RSeStorage/M')) continue;
    const id = st.name.slice('RSeStorage/M'.length);
    let label = '';
    try {
      const m = cfb.read(st.name);
      const strs = asciiUtf16(m, 6);
      label = strs.find((x) => /Segment$/.test(x)) ?? strs[0] ?? '';
    } catch { /* ignore */ }
    const bname = 'RSeStorage/B' + id;
    if (!label || !cfb.has(bname)) continue;
    try {
      const raw = cfb.read(bname);
      let z = -1;
      for (let i = 0; i < Math.min(64, raw.length - 1); i++) if (raw[i] === 0x78 && ((raw[i] << 8) | raw[i + 1]) % 31 === 0) { z = i; break; }
      if (z < 0) { warnings.push(`segment ${label}: no compressed data`); continue; }
      const out = inflate(raw, z, true, 512 * 1024 * 1024).out;
      let key = label, n = 2;
      while (segments.has(key)) key = label + '#' + n++;
      segments.set(key, out);
      segNames.push(key);
    } catch (e) { warnings.push(`segment ${label} not readable (${(e as Error).message})`); }
  }
  const kind = segNames.some((s) => s.startsWith('Pm')) ? 'part' : segNames.some((s) => s.startsWith('Am')) ? 'assembly' : segNames.some((s) => s.startsWith('Dl') || s.startsWith('Dw') || s.startsWith('Dr')) ? 'drawing' : 'unknown';
  return { cfb, kind, segments, segNames, warnings };
}

function docInfo(d: InvDoc): InventorInfo {
  const info: InventorInfo = { format: 'Autodesk Inventor', document: d.kind };
  try {
    for (const s of allUtf16(d.cfb.read('UFRxDoc'), 6)) {
      const m = /^((?:[A-Za-z]:|\\\\)[\\/][^<>|"]*?\.(?:ipt|iam|idw|ipn))/i.exec(s);
      if (m) { info.savedPath = m[1]; info.documentName = m[1].split(/[\\/]/).pop()!; break; }
    }
  } catch { /* no UFRxDoc */ }
  for (const st of d.cfb.streams()) {
    if (!st.name.startsWith('\u0005') || st.size > 1 << 22) continue;
    let b: Uint8Array;
    try { b = d.cfb.read(st.name); } catch { continue; }
    const strs = allUtf16(b, 4);
    for (const s of strs) {
      const m = /^(\d{4}) \(Build (\d+), (\d+)\)/.exec(s);
      if (m && !info.inventorVersion) { info.inventorVersion = m[1]; info.build = `${m[2]}, ${m[3]}`; }
      const sm = /<StyleName>([^<]+)<\/StyleName>/.exec(s);
      if (sm && !info.appearance) info.appearance = sm[1];
    }
    if (strs.includes('Design Tracking Properties')) {
      const lib = strs.findIndex((x) => /\.adsklib#/.test(x));
      if (lib >= 0 && strs[lib + 2]) info.material = strs[lib + 2];
    }
  }
  return info;
}

/** embedded preview: a PNG inside the summary property stream */
export function inventorThumbnail(d: InvDoc): Uint8Array | null {
  for (const st of d.cfb.streams()) {
    if (!st.name.startsWith('\u0005')) continue;
    const b = d.cfb.read(st.name);
    for (let i = 0; i + 8 < b.length; i++) {
      if (b[i] === 0x89 && b[i + 1] === 0x50 && b[i + 2] === 0x4e && b[i + 3] === 0x47) {
        for (let j = i + 8; j + 8 <= b.length; j++) {
          if (b[j] === 0x49 && b[j + 1] === 0x45 && b[j + 2] === 0x4e && b[j + 3] === 0x44) return b.slice(i, j + 8);
        }
      }
    }
  }
  return null;
}

function pngSize(p: Uint8Array): [number, number] {
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  return p.length > 24 ? [dv.getUint32(16, false), dv.getUint32(20, false)] : [0, 0];
}

// ------------------------------------------------------------------ parts
export interface PartMesh { bodies: { pos: Float64Array; nrm: Float64Array; idx: number[]; edges: number[][] }[]; info: InventorInfo; warnings: string[] }

function sabOf(d: InvDoc): SabFile | null {
  const seg = d.segments.get('PmBRepSegment');
  if (!seg) return null;
  const at = findSab(seg);
  if (at < 0) return null;
  return readSab(seg, at);
}

/** tessellate a part document; positions in metres, Inventor model axes (Z up) */
export function meshPart(d: InvDoc, opts: ReadInventorOptions = {}): PartMesh {
  const warnings: string[] = [];
  const info: InventorInfo = {};
  let f: SabFile | null = null;
  try { f = sabOf(d); } catch (e) { warnings.push(`solid model not readable (${(e as Error).message})`); }
  if (!f) { if (!warnings.length) warnings.push('no solid model stream in this part'); return { bodies: [], info, warnings }; }
  info.solidModel = `${f.product} ${f.asmVersion}`.trim();
  info.solidRecords = f.recs.length;
  if (f.error) warnings.push(`solid model stream: ${f.error}`);
  const scale = f.mmPerUnit / 1000;
  const asm = buildAsm(f, { curveSegments: opts.curveSegments });
  warnings.push(...asm.warnings);
  info.bodies = asm.bodies.length;
  info.faces = asm.faces;
  info.surfaces = Object.entries(asm.surfaceKinds).map(([k, n]) => `${k} ${n}`).join(', ');
  const fm = new FaceMesher(f.resabs || 1e-6, (m) => { if (!warnings.includes(m)) warnings.push(m); });
  fm.auto = true;
  const bodies: PartMesh['bodies'] = [];
  const flatKinds: Record<string, number> = {};
  let skippedCurved = 0;
  for (const b of asm.bodies) {
    const m = nmesh();
    for (const face of b.faces) {
      if (!face.surf && face.kind !== 'plane-surface' && !nearlyPlanar(face.loops)) { skippedCurved++; continue; }
      const fb = fm.faceFallback;
      try { fm.face(face.surf, face.loops, m, face.sense); if (fm.faceFallback > fb) flatKinds[face.kind] = (flatKinds[face.kind] ?? 0) + 1; }
      catch (e) { const w = `face not tessellated (${(e as Error).message})`; if (!warnings.includes(w)) warnings.push(w); }
    }
    const pos = new Float64Array(m.pos.length), nrm = new Float64Array(m.nrm.length);
    const X = b.xform;
    for (let i = 0; i < m.pos.length; i += 3) {
      let x = m.pos[i], y = m.pos[i + 1], z = m.pos[i + 2];
      let nx = m.nrm[i], ny = m.nrm[i + 1], nz = m.nrm[i + 2];
      if (X) {
        const s = X[12] || 1;
        const tx = x * X[0] + y * X[3] + z * X[6], ty = x * X[1] + y * X[4] + z * X[7], tz = x * X[2] + y * X[5] + z * X[8];
        x = tx * s + X[9]; y = ty * s + X[10]; z = tz * s + X[11];
        const ux = nx * X[0] + ny * X[3] + nz * X[6], uy = nx * X[1] + ny * X[4] + nz * X[7], uz = nx * X[2] + ny * X[5] + nz * X[8];
        nx = ux; ny = uy; nz = uz;
      }
      pos[i] = x * scale; pos[i + 1] = y * scale; pos[i + 2] = z * scale;
      nrm[i] = nx; nrm[i + 1] = ny; nrm[i + 2] = nz;
    }
    const edges = b.edges.map((e) => e.map((v) => v * scale));
    bodies.push({ pos, nrm, idx: m.idx, edges });
  }
  if (skippedCurved) warnings.push(`${skippedCurved} faces on undecoded procedural surfaces left open (their edges are drawn)`);
  info.facesSkipped = skippedCurved;
  if (fm.faceFallback) warnings.push(`${fm.faceFallback} curved faces filled flat (${Object.entries(flatKinds).map(([k, n]) => `${k} ${n}`).join(', ')})`);
  return { bodies, info, warnings };
}

/** boundary points within 3% of the loop size from their best plane */
function nearlyPlanar(loops: { pts: number[][] }[]): boolean {
  const P = loops.flatMap((l) => l.pts);
  if (P.length < 4) return true;
  const c = [0, 0, 0];
  for (const p of P) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
  c[0] /= P.length; c[1] /= P.length; c[2] /= P.length;
  // Newell normal of the outer loop
  const L = loops[0].pts, n = [0, 0, 0];
  for (let i = 0; i < L.length; i++) { const a = L[i], b = L[(i + 1) % L.length]; n[0] += (a[1] - b[1]) * (a[2] + b[2]); n[1] += (a[2] - b[2]) * (a[0] + b[0]); n[2] += (a[0] - b[0]) * (a[1] + b[1]); }
  const nl = Math.hypot(n[0], n[1], n[2]);
  if (!(nl > 0)) return false;
  let size = 0, dev = 0;
  for (const p of P) { const d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]]; size = Math.max(size, Math.hypot(d[0], d[1], d[2])); dev = Math.max(dev, Math.abs((d[0] * n[0] + d[1] * n[1] + d[2] * n[2]) / nl)); }
  return dev <= size * 0.03;
}

// ------------------------------------------------------------------ output
type M34 = number[]; // row-major 3x4 (metres)
const IDENT: M34 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

/** display colour guessed from the appearance / material name (the appearance colour values are not decoded) */
function appearanceColor(name: string | null): [number, number, number] | null {
  if (!name) return null;
  const n = name.toLowerCase();
  const table: [RegExp, [number, number, number]][] = [
    [/blue/, [0.42, 0.52, 0.78]], [/black|rubber|carbon/, [0.16, 0.16, 0.18]], [/red/, [0.72, 0.16, 0.14]], [/yellow|gold/, [0.86, 0.74, 0.22]],
    [/copper/, [0.74, 0.46, 0.32]], [/brass|bronze/, [0.78, 0.66, 0.36]], [/oxid|rust/, [0.48, 0.42, 0.38]], [/chrome|polish|nickel|silver/, [0.82, 0.84, 0.87]],
    [/alumin/, [0.77, 0.78, 0.81]], [/steel|iron|metal/, [0.62, 0.64, 0.68]], [/white/, [0.92, 0.92, 0.92]], [/green/, [0.30, 0.60, 0.32]],
  ];
  for (const [re, c] of table) if (re.test(n)) return c;
  return null;
}

function emitPart(gb: GeomBuilder, pm: PartMesh, M: M34, name: string, typeName: string | null, colorIdx: number, edges: boolean, appearance: string | null = null) {
  const colors: [number, number, number][] = [[0.70, 0.72, 0.76], [0.80, 0.74, 0.60], [0.60, 0.68, 0.78], [0.74, 0.64, 0.66], [0.64, 0.74, 0.64], [0.78, 0.70, 0.78]];
  const ac = appearanceColor(appearance);
  const col = ac ?? colors[colorIdx % colors.length];
  const bi = ac ? gb.bucket('Parts', { key: `a:${appearance}`, name: appearance!, color: col }) : gb.bucket('Parts', { key: `c${colorIdx % colors.length}`, name: `Inventor part colour ${colorIdx % colors.length + 1}`, color: col });
  const el = gb.element({ name, className: 'Part', categoryName: 'Parts', typeName, familyName: null });
  // Inventor model axes are used as is (Z up): this matched the stored previews of the samples
  const tp = (x: number, y: number, z: number, out: number[]) => {
    const a = M[0] * x + M[1] * y + M[2] * z + M[3], b = M[4] * x + M[5] * y + M[6] * z + M[7], c = M[8] * x + M[9] * y + M[10] * z + M[11];
    out[0] = a; out[1] = b; out[2] = c;
  };
  const tn = (x: number, y: number, z: number, out: number[]) => {
    const a = M[0] * x + M[1] * y + M[2] * z, b = M[4] * x + M[5] * y + M[6] * z, c = M[8] * x + M[9] * y + M[10] * z;
    out[0] = a; out[1] = b; out[2] = c;
  };
  const t = [0, 0, 0];
  for (const b of pm.bodies) {
    const P = new Float64Array(b.pos.length), N = new Float64Array(b.nrm.length);
    for (let i = 0; i < P.length; i += 3) { tp(b.pos[i], b.pos[i + 1], b.pos[i + 2], t); P[i] = t[0]; P[i + 1] = t[1]; P[i + 2] = t[2]; tn(b.nrm[i], b.nrm[i + 1], b.nrm[i + 2], t); N[i] = t[0]; N[i + 1] = t[1]; N[i + 2] = t[2]; }
    gb.addMesh(el, bi, P, N, b.idx);
    if (edges) for (const e of b.edges) {
      const pos: number[] = [], pairs: number[] = [];
      for (let i = 0; i < e.length; i += 3) { tp(e[i], e[i + 1], e[i + 2], t); pos.push(t[0], t[1], t[2]); if (i) pairs.push(i / 3 - 1, i / 3); }
      gb.addSegments('Parts', el, pos, pairs, null);
    }
  }
  return el;
}

function previewSheet(d: InvDoc, title: string): RvtSheet2D | null {
  const png = inventorThumbnail(d);
  if (!png) return null;
  const [w, h] = pngSize(png);
  if (!w || !h) return null;
  const W = 200, H = (200 * h) / w;
  return {
    id: 1, number: '1', name: `${title} (preview image)`, size: { w: W, h: H },
    items: [{ kind: 'image', x: 0, y: 0, w: W, h: H, png }],
    viewports: [], completeness: 'outline', warnings: ['Only the preview image stored in the file is shown.'],
  };
}

// ------------------------------------------------------------------ entry
export async function readInventor(bytes: Uint8Array, onProgress?: (stage: string, ratio: number) => void, opts: ReadInventorOptions = {}): Promise<InventorResult> {
  const t0 = Date.now();
  if (!bytes || !isCfb(bytes)) throw new InventorError('not-format', 'not an OLE compound file');
  if (bytes.length > MAX_BYTES) throw new InventorError('too-large', 'file larger than 1 GB');
  onProgress?.('container', 0);
  const d = openInventor(bytes);
  const info = docInfo(d);
  const warnings = [...d.warnings];
  const gb = new GeomBuilder(opts.maxTriangles ?? 20_000_000);
  const title = info.documentName as string || (d.kind === 'assembly' ? 'Assembly' : 'Part');
  if (d.kind === 'part') {
    onProgress?.('solids', 0.2);
    const pm = meshPart(d, opts);
    warnings.push(...pm.warnings);
    Object.assign(info, pm.info);
    emitPart(gb, pm, IDENT, (info.documentName as string) ?? 'Part', (info.material as string) ?? null, 0, opts.edges !== false, (info.appearance as string) ?? (info.material as string) ?? null);
  } else if (d.kind === 'assembly') {
    onProgress?.('assembly', 0.1);
    let occ: Occurrence[] = [];
    try { const a = readAssembly(d); occ = a.occurrences; warnings.push(...a.warnings); info.components = a.documents.length; }
    catch (e) { warnings.push(`assembly structure not decoded (${(e as Error).message})`); }
    info.occurrences = occ.length;
    if (!occ.length) warnings.push('the assembly lists no components');
    const cache = new Map<string, PartMesh | null>();
    const missing = new Set<string>();
    let placed = 0;
    occ.forEach((o, k) => {
      onProgress?.('components', k / Math.max(1, occ.length));
      let pm = cache.get(o.path);
      if (pm === undefined) {
        pm = null;
        const data = opts.resolve ? (o.candidates.map((c) => opts.resolve!(c)).find((x) => x) ?? null) : null;
        if (data) {
          try {
            const sd = openInventor(data);
            if (sd.kind === 'part') { pm = meshPart(sd, opts); const ci = docInfo(sd); pm.info.appearance = (ci.appearance ?? ci.material ?? '') as string; }
            else warnings.push(`component ${o.path}: sub-assemblies are not expanded yet`);
          } catch (e) { warnings.push(`component ${o.path} not readable (${(e as Error).message})`); }
        }
        cache.set(o.path, pm);
      }
      if (!pm) { missing.add(o.path); return; }
      for (const w of pm.warnings) if (!warnings.includes(`${o.name}: ${w}`)) warnings.push(`${o.name}: ${w}`);
      emitPart(gb, pm, o.matrix, o.name, o.path.split(/[\\/]/).pop() ?? null, k, opts.edges !== false, (pm.info.appearance as string) || null);
      placed++;
    });
    info.placed = placed;
    if (missing.size) { info.missingComponents = [...missing].join('; '); warnings.push(`${missing.size} referenced component file(s) not available: ${[...missing].map((p) => p.split(/[\\/]/).pop()).join(', ')}`); }
  } else {
    warnings.push(d.kind === 'drawing' ? 'Inventor drawings (.idw) are not decoded: preview image only' : 'Inventor document type not recognised');
  }
  const geometry = gb.finish(1);
  onProgress?.('done', 1);
  info.ms = Date.now() - t0;
  if (geometry.stats.triangles > 0) {
    geometry.warnings.push(...warnings);
    return { kind: '3d', geometry, info };
  }
  const sheet = previewSheet(d, title);
  if (sheet) {
    sheet.warnings.push(...warnings);
    return { kind: '2d', sheets: [sheet], layers: [], info };
  }
  if (d.kind === 'part' && warnings.some((w) => w.startsWith('no solid'))) throw new InventorError('corrupt', 'part without a solid model and without a preview');
  throw new InventorError('corrupt', warnings[0] ?? 'nothing to display');
}
