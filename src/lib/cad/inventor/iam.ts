// Inventor assembly (.iam): referenced documents and component occurrences.
import type { InvDoc } from './inventor.ts';
export interface Occurrence { name: string; path: string; candidates: string[]; matrix: number[] }

function docPaths(d: InvDoc): string[] {
  const b = d.cfb.read('UFRxDoc');
  const out: string[] = [];
  for (const start of [0, 1]) {
    let cur = '';
    for (let i = start; i + 1 < b.length; i += 2) {
      const c = b[i] | (b[i + 1] << 8);
      if (c >= 0x20 && c < 0xfffe) cur += String.fromCharCode(c);
      else { const m = /^((?:[A-Za-z]:|\\\\|\.\.?)[\\/][^<>|"]*?\.(?:ipt|iam))/i.exec(cur); if (m) out.push(m[1]); cur = ''; }
    }
  }
  return [...new Set(out)];
}

function asciiStrings(b: Uint8Array): string[] {
  const out: { at: number; s: string }[] = [];
  for (const start of [0, 1]) {
    let cur = '';
    for (let i = start; i + 1 < b.length; i += 2) {
      const c = b[i] | (b[i + 1] << 8);
      if (c >= 0x20 && c < 0xfffe && !(c >= 0xd800 && c < 0xe000)) cur += String.fromCharCode(c);
      else { if (cur.length >= 3) out.push({ at: i - cur.length * 2, s: cur }); cur = ''; }
    }
  }
  return out.sort((a, b) => a.at - b.at).map((x) => x.s);
}

/**
 * Placement matrices: objects in the assembly relationship segment that carry a 4x4 row-major matrix in a sparse
 * form. A u32 mask gives two bits per element (bit k and bit 16 + k for element k): 00 = stored float64 follows,
 * 01 = 1, 10 = 0, 11 = -1. Worked out from the samples (NOTEBOOK.md); the bottom row always reads 0 0 0 1.
 */
export function placements(seg: Uint8Array): { id: number; m: number[] }[] {
  const dv = new DataView(seg.buffer, seg.byteOffset, seg.byteLength);
  const out: { id: number; m: number[] }[] = [];
  const sig = [0, 0, 0, 0, 2, 1, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i + 22 <= seg.length; i++) {
    let ok = true;
    for (let k = 0; k < sig.length; k++) if (seg[i + k] !== sig[k]) { ok = false; break; }
    if (!ok) continue;
    const id = dv.getUint32(i + 14, true), mask = dv.getUint32(i + 18, true);
    if (!(id & 0x80000000) || (mask & 0x70008000) !== 0x70008000) continue;
    const m: number[] = [];
    let o = i + 22;
    let bad = false;
    for (let e = 0; e < 16; e++) {
      const code = ((mask >>> e) & 1) | (((mask >>> (16 + e)) & 1) << 1);
      if (code === 0) { if (o + 8 > seg.length) { bad = true; break; } m.push(dv.getFloat64(o, true)); o += 8; }
      else m.push(code === 1 ? 1 : code === 2 ? 0 : -1);
    }
    if (bad || m.some((x) => !Number.isFinite(x))) continue;
    if (Math.abs(m[12]) + Math.abs(m[13]) + Math.abs(m[14]) > 1e-9 || Math.abs(m[15] - 1) > 1e-9) continue;
    out.push({ id: id & 0x7fffffff, m: m.slice(0, 12) });
    i = o - 1;
  }
  return out;
}

/** decode one sparse 4x4 at offset o (mask u32 then values); null when it is not a placement */
function sparseAt(dv: DataView, o: number): { m: number[]; end: number } | null {
  if (o + 4 > dv.byteLength) return null;
  const mask = dv.getUint32(o, true);
  if ((mask & 0x70008000) !== 0x70008000) return null;
  o += 4;
  const m: number[] = [];
  for (let e = 0; e < 16; e++) {
    const code = ((mask >>> e) & 1) | (((mask >>> (16 + e)) & 1) << 1);
    if (code === 0) { if (o + 8 > dv.byteLength) return null; m.push(dv.getFloat64(o, true)); o += 8; }
    else m.push(code === 1 ? 1 : code === 2 ? 0 : -1);
  }
  if (m.some((x) => !Number.isFinite(x)) || Math.abs(m[12]) + Math.abs(m[13]) + Math.abs(m[14]) > 1e-9 || Math.abs(m[15] - 1) > 1e-9) return null;
  return { m: m.slice(0, 12), end: o };
}

/** per-occurrence placements kept with the occurrence list: header 02 00 00 30 01 00 00 00 07 00 00 00 08 00 00 00, u32 key, sparse matrix */
export function occurrencePlacements(seg: Uint8Array): { key: number; m: number[] }[] {
  const dv = new DataView(seg.buffer, seg.byteOffset, seg.byteLength);
  const sig = [2, 0, 0, 0x30, 1, 0, 0, 0, 7, 0, 0, 0, 8, 0, 0, 0];
  const out: { key: number; m: number[] }[] = [];
  const seen = new Set<number>();
  for (let i = 0; i + 24 <= seg.length; i++) {
    let ok = true;
    for (let k = 0; k < sig.length; k++) if (seg[i + k] !== sig[k]) { ok = false; break; }
    if (!ok) continue;
    const key = dv.getUint32(i + 16, true);
    const r = sparseAt(dv, i + 20);
    if (!r) continue;
    if (!seen.has(key)) { seen.add(key); out.push({ key, m: r.m }); }
    i = r.end - 1;
  }
  return out;
}

export function readAssembly(d: InvDoc): { documents: string[]; occurrences: Occurrence[]; warnings: string[] } {
  const paths = docPaths(d);
  const self = paths.find((p) => /\.iam$/i.test(p)) ?? null;
  const base = self ? self.replace(/[\\/][^\\/]*$/, '') : '';
  const docs = paths.filter((p) => p !== self);
  const warnings: string[] = [];
  const byName = new Map<string, string>();
  for (const p of docs) byName.set(p.split(/[\\/]/).pop()!.replace(/\.(ipt|iam)$/i, '').toLowerCase(), p);
  // occurrence names "<document name>:<n>" in browser order
  const names: string[] = [];
  const br = d.segments.get('AmBrowserSegment');
  if (br) for (const s of asciiStrings(br)) {
    const m = /^(.+):(\d+)$/.exec(s);
    if (m && byName.has(m[1].toLowerCase()) && !names.includes(s)) names.push(s);
  }
  if (!names.length) for (const p of docs) names.push(p.split(/[\\/]/).pop()!.replace(/\.(ipt|iam)$/i, '') + ':1');
  const rx = d.segments.get('AmRxSegment');
  const dc = d.segments.get('AmDcSegment');
  const own = dc ? occurrencePlacements(dc) : [];
  // 1) one placement per occurrence next to the occurrence list: take them in order
  // 2) otherwise the relationship segment: the first (grounded) occurrence at the origin, the others in order
  let mats: { m: number[] }[] = own.length === names.length ? own : rx ? placements(rx) : [];
  let offset = mats.length === names.length ? 0 : mats.length === names.length - 1 ? 1 : -1;
  if (offset < 0 && own.length === names.length - 1) { mats = own; offset = 1; }
  if (offset < 0) warnings.push(`assembly placements: ${mats.length} matrices for ${names.length} occurrences, components may be misplaced`);
  const occ: Occurrence[] = names.map((n, k) => {
    const p = byName.get(n.replace(/:\d+$/, '').toLowerCase())!;
    const rel = base && p.toLowerCase().startsWith(base.toLowerCase() + '\\') ? p.slice(base.length + 1) : p.split(/[\\/]/).pop()!;
    const mi = k - Math.max(0, offset);
    const src = mi >= 0 && mi < mats.length ? mats[mi].m : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
    // translations are stored in centimetres
    const matrix = [src[0], src[1], src[2], src[3] * 0.01, src[4], src[5], src[6], src[7] * 0.01, src[8], src[9], src[10], src[11] * 0.01];
    return { name: n, path: p, candidates: [rel.replace(/\\/g, '/'), p.split(/[\\/]/).pop()!], matrix };
  });
  return { documents: docs, occurrences: occ, warnings };
}
