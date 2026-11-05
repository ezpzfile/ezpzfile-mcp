// STL reader (ASCII and binary). Clean-room, written from the public description of the format
// (3D Systems "StereoLithography Interface Specification", 1989/1995, widely published) and sample analysis.
// STL has no units and no up axis: Z-up is assumed (3D printing convention) and units are guessed (see guessUnits).

import { GeomBuilder, MeshError, decodeText, guessUnits, latin1, DEFAULT_GREY, type MeshResult, type Progress } from './common.ts';

function isBinaryShape(b: Uint8Array): boolean {
  if (b.length < 84) return false;
  const n = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(80, true);
  return n > 0 && 84 + n * 50 === b.length;
}
function looksAscii(b: Uint8Array): boolean {
  const head = latin1(b, 0, Math.min(b.length, 2048));
  if (!/^\s*solid/i.test(head)) return false;
  // the "solid" header trap: binary files from some exporters also start with "solid".
  // An ASCII file has the keyword facet (or is an empty solid) and no control bytes in its first kilobytes.
  for (let i = 0; i < Math.min(b.length, 2048); i++) { const c = b[i]; if (c < 9 || (c > 13 && c < 32)) return false; }
  return /facet|endsolid/i.test(head);
}

export function sniffStl(bytes: Uint8Array): boolean {
  if (looksAscii(bytes)) return true;
  if (isBinaryShape(bytes)) return true;
  return false;
}

export async function readStl(bytes: Uint8Array, onProgress?: Progress): Promise<MeshResult> {
  const t0 = Date.now();
  const gb = new GeomBuilder();
  let info: Record<string, string | number> = { format: 'STL' };
  if (bytes.length === 0) throw new MeshError('not-format', 'Empty file');
  const ascii = looksAscii(bytes);
  const binary = !ascii && isBinaryShape(bytes);
  let unitHint: 'mm' | 'm' | 'cm' | 'in' | null = null;
  if (ascii || (!binary && /^\s*solid/i.test(latin1(bytes, 0, Math.min(bytes.length, 256))) && !/[\x00-\x08]/.test(latin1(bytes, 0, Math.min(bytes.length, 256))))) {
    info.variant = 'ascii';
    readAscii(bytes, gb, onProgress, info);
  } else {
    if (bytes.length < 84) throw new MeshError('not-format', 'File too small for a binary STL');
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let n = dv.getUint32(80, true);
    const fit = Math.floor((bytes.length - 84) / 50);
    if (!binary) {
      if (n === 0 || n > fit) {
        if (fit === 0 || n === 0) throw new MeshError('not-format', 'Not an STL file (no ASCII solid and the binary triangle count does not match the file size)');
        gb.warn(`Binary STL header says ${n} triangles but the file holds ${fit}: reading ${fit}`);
        n = fit;
      } else gb.warn(`Binary STL has ${bytes.length - 84 - n * 50} extra bytes after the triangles (ignored)`);
    }
    info.variant = 'binary';
    const header = latin1(bytes, 0, 80).replace(/\0.*$/s, '').trim();
    if (header) info.header = header.replace(/[^\x20-\x7e]/g, '');
    if (/^solid/i.test(header)) info.headerTrap = 'binary file whose header starts with "solid"';
    const um = /UNITS\s*=\s*(mm|cm|m|in|inch)\b/i.exec(header);
    if (um) unitHint = um[1].toLowerCase().startsWith('in') ? 'in' : (um[1].toLowerCase() as 'mm' | 'cm' | 'm');
    readBinary(bytes, dv, n, header, gb, onProgress);
  }
  const ext = gb.extents();
  const u = guessUnits(ext, unitHint, 20);
  info.units = u.unit;
  info.unitAssumption = u.why;
  info.upAxis = 'Z (assumed; STL has no axis information)';
  if (!unitHint) gb.warn(`STL has no units: ${u.why}, converted to metres`);
  const geometry = gb.finish({ postScale: u.scale });
  geometry.stats.ms = Date.now() - t0;
  info.triangles = geometry.stats.triangles;
  if (geometry.stats.triangles === 0) geometry.warnings.push('No triangles found');
  return { kind: '3d', geometry, info };
}

function readBinary(bytes: Uint8Array, dv: DataView, n: number, header: string, gb: GeomBuilder, onProgress?: Progress) {
  // colours: SolidView style (bit 15 set = colour valid, 5:5:5 BGR) or Materialise style (header COLOR=, bit 15 clear = valid, RGB)
  const materialise = /COLOR=/.test(header);
  const colors = new Map<number, number>();
  let anyColor = false;
  for (let t = 0; t < n; t++) {
    const a = dv.getUint16(84 + t * 50 + 48, true);
    if (materialise ? (a & 0x8000) === 0 : (a & 0x8000) !== 0) { anyColor = true; colors.set(a & 0x7fff, (colors.get(a & 0x7fff) ?? 0) + 1); if (colors.size > 64) break; }
  }
  const useColors = anyColor && colors.size <= 64 && colors.size > 1;
  const el = gb.element({ name: header && /^[\x20-\x7e]+$/.test(header) ? header.slice(0, 80) : 'STL solid', className: 'StlSolid', categoryName: 'STL' });
  if (!useColors) {
    const pos = new Float32Array(n * 9);
    for (let t = 0; t < n; t++) {
      const o = 84 + t * 50 + 12;
      for (let k = 0; k < 9; k++) pos[t * 9 + k] = dv.getFloat32(o + k * 4, true);
      if (onProgress && (t & 0x3ffff) === 0) onProgress('triangles', t / n);
    }
    const bi = gb.bucket('default', { name: 'STL', color: DEFAULT_GREY, schema: 'STL' });
    gb.addMesh(el, bi, pos, null, null, null);
    return;
  }
  const groups = new Map<number, number[]>();
  for (let t = 0; t < n; t++) {
    const a = dv.getUint16(84 + t * 50 + 48, true);
    const valid = materialise ? (a & 0x8000) === 0 : (a & 0x8000) !== 0;
    const key = valid ? a & 0x7fff : -1;
    let g = groups.get(key); if (!g) groups.set(key, (g = [])); g.push(t);
  }
  for (const [key, tris] of groups) {
    let color = DEFAULT_GREY;
    if (key >= 0) {
      const c0 = (key & 31) / 31, c1 = ((key >> 5) & 31) / 31, c2 = ((key >> 10) & 31) / 31;
      color = materialise ? [c0, c1, c2] : [c2, c1, c0];
    }
    const bi = gb.bucket('c' + key, { name: key >= 0 ? `STL colour ${key}` : 'STL', color, schema: 'STL face colour' });
    const pos = new Float32Array(tris.length * 9);
    tris.forEach((t, j) => { const o = 84 + t * 50 + 12; for (let k = 0; k < 9; k++) pos[j * 9 + k] = dv.getFloat32(o + k * 4, true); });
    gb.addMesh(el, bi, pos, null, null, null);
  }
}

function readAscii(bytes: Uint8Array, gb: GeomBuilder, onProgress: Progress | undefined, info: Record<string, string | number>) {
  const text = decodeText(bytes);
  const bi = gb.bucket('default', { name: 'STL', color: DEFAULT_GREY, schema: 'STL' });
  const re = /\b(solid|vertex|endsolid|endloop|facet|outer)\b([^\n\r]*)/g;
  let el = -1;
  let pos: number[] = [];
  let loop: number[] = [];
  let solids = 0;
  let bad = 0;
  const flush = () => { if (el > 0 && pos.length) gb.addMesh(el, bi, pos, null, null, null); pos = []; };
  let m: RegExpExecArray | null;
  let lastTick = 0;
  while ((m = re.exec(text))) {
    const kw = m[1];
    if (kw === 'vertex') {
      const p = m[2].trim().split(/\s+/).map(Number);
      if (p.length < 3 || !p.slice(0, 3).every(isFinite)) { bad++; continue; }
      loop.push(p[0], p[1], p[2]);
    } else if (kw === 'endloop') {
      // a loop should hold 3 vertices; fan polygons with more
      const nv = loop.length / 3;
      if (nv >= 3) for (let i = 1; i + 1 < nv; i++) pos.push(loop[0], loop[1], loop[2], loop[i * 3], loop[i * 3 + 1], loop[i * 3 + 2], loop[i * 3 + 3], loop[i * 3 + 4], loop[i * 3 + 5]);
      else if (nv > 0) bad++;
      loop = [];
    } else if (kw === 'solid') {
      flush();
      solids++;
      el = gb.element({ name: m[2].trim() || `solid ${solids}`, className: 'StlSolid', categoryName: 'STL' });
    } else if (kw === 'endsolid') {
      flush();
    }
    if (onProgress && m.index - lastTick > 1 << 20) { lastTick = m.index; onProgress('facets', m.index / text.length); }
  }
  if (el < 0) el = gb.element({ name: 'STL solid', className: 'StlSolid', categoryName: 'STL' });
  flush();
  info.solids = solids;
  if (bad) gb.warn(`${bad} malformed vertex or facet lines skipped`);
}
