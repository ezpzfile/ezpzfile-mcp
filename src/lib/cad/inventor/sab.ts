// Tokenizer for the binary solid-model stream stored in Inventor parts ("ASM BinaryFile4" segments).
// Format worked out from the sample bytes (see NOTEBOOK.md): a tagged little-endian token stream.
// Tags: 0x04 int32, 0x06 float64, 0x07 string (u8 length), 0x08 string (u16 length), 0x0a / 0x0b two-state
// flags (no payload), 0x0c entity index (int32, -1 = none), 0x0d type name / last part of a name,
// 0x0e leading part of a compound name, 0x0f / 0x10 sub-block open / close, 0x11 end of record,
// 0x12 binary blob (u32 length), 0x13 position (3 x float64), 0x14 direction (3 x float64), 0x15 enum (int32).
// Runs in a Web Worker: no DOM, no Node APIs.

export interface Tok { t: number; v: number | string | number[] | null }
export interface SabRec { idx: number; type: string; toks: Tok[] }
export interface SabFile {
  version: number; product: string; asmVersion: string; date: string; mmPerUnit: number; resabs: number; resnor: number;
  recs: SabRec[];
  /** sub-blocks in order of appearance (for "ref n" back references): [record index, token start, token end) */
  subs: { rec: number; start: number; end: number }[];
  complete: boolean; error: string | null;
}

export class SabError extends Error { constructor(m: string) { super(m); this.name = 'SabError'; } }

const MAGIC = 'ASM BinaryFile';

export function findSab(b: Uint8Array): number {
  const m = MAGIC;
  outer: for (let i = 0; i + 16 <= b.length; i++) {
    if (b[i] !== 0x41) continue;
    for (let k = 0; k < m.length; k++) if (b[i + k] !== m.charCodeAt(k)) continue outer;
    return i;
  }
  return -1;
}

export function readSab(b: Uint8Array, start: number, maxRecs = 5_000_000): SabFile {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = start + MAGIC.length + 1; // "ASM BinaryFile4"
  if (o + 16 > b.length) throw new SabError('solid stream truncated');
  const version = dv.getUint32(o, true);
  o += 16;
  const str = (n: number) => { let s = ''; for (let i = 0; i < n && o + i < b.length; i++) s += String.fromCharCode(b[o + i]); return s; };
  let error: string | null = null;
  const next = (): Tok | null => {
    if (o >= b.length) return null;
    const t = b[o++];
    switch (t) {
      case 0x04: case 0x0c: case 0x15: { if (o + 4 > b.length) return null; const v = dv.getInt32(o, true); o += 4; return { t, v }; }
      case 0x06: { if (o + 8 > b.length) return null; const v = dv.getFloat64(o, true); o += 8; return { t, v }; }
      case 0x07: case 0x0d: case 0x0e: { if (o + 1 > b.length) return null; const n = b[o++]; if (o + n > b.length) return null; const v = str(n); o += n; return { t, v }; }
      case 0x08: { if (o + 2 > b.length) return null; const n = dv.getUint16(o, true); o += 2; if (o + n > b.length) return null; const v = str(n); o += n; return { t, v }; }
      case 0x12: { if (o + 4 > b.length) return null; const n = dv.getUint32(o, true); o += 4; if (o + n > b.length) return null; o += n; return { t, v: n }; }
      case 0x13: case 0x14: { if (o + 24 > b.length) return null; const v = [dv.getFloat64(o, true), dv.getFloat64(o + 8, true), dv.getFloat64(o + 16, true)]; o += 24; return { t, v }; }
      case 0x0a: case 0x0b: case 0x0f: case 0x10: case 0x11: return { t, v: null };
      default: error = `unknown token 0x${t.toString(16)} at ${o - 1}`; return null;
    }
  };
  // header: strings and doubles up to the first name token
  const head: Tok[] = [];
  for (;;) {
    const save = o;
    const k = next();
    if (!k) throw new SabError('solid stream header truncated');
    if (k.t === 0x0d || k.t === 0x0e) { o = save; break; }
    head.push(k);
    if (head.length > 64) throw new SabError('solid stream header not understood');
  }
  const hs = head.filter((x) => x.t === 0x07 || x.t === 0x08).map((x) => x.v as string);
  const hd = head.filter((x) => x.t === 0x06).map((x) => x.v as number);
  const recs: SabRec[] = [];
  const subs: SabFile['subs'] = [];
  let complete = false;
  while (recs.length < maxRecs) {
    // record type name
    const names: string[] = [];
    let k = next();
    while (k && k.t === 0x0e) { names.push(k.v as string); k = next(); }
    if (!k) break;
    if (k.t !== 0x0d) { error = error ?? `record start expected at ${o}`; break; }
    names.push(k.v as string);
    const type = names.join('-');
    if (type.startsWith('End-of-ASM')) { complete = true; break; }
    const toks: Tok[] = [];
    const ri = recs.length;
    const open: number[] = [];
    let ok = false;
    for (;;) {
      const x = next();
      if (!x) break;
      if (x.t === 0x11 && !open.length) { ok = true; break; }
      if (x.t === 0x0f) { open.push(toks.length); toks.push(x); continue; }
      if (x.t === 0x10) {
        const s = open.pop();
        toks.push(x);
        if (s !== undefined) {
          const nm = toks[s + 1];
          if (nm && (nm.t === 0x0d) && nm.v !== 'ref') subs.push({ rec: ri, start: s, end: toks.length });
        }
        continue;
      }
      toks.push(x);
      if (toks.length > 2_000_000) break;
    }
    // sub-blocks are numbered in the order they open; re-sort the ones of this record by start
    if (!ok) { error = error ?? 'record not terminated (truncated stream)'; break; }
    recs.push({ idx: ri, type, toks });
  }
  // keep sub-block numbering in opening order
  subs.sort((a, b) => (a.rec - b.rec) || (a.start - b.start));
  return {
    version, product: hs[0] ?? '', asmVersion: hs[1] ?? '', date: hs[2] ?? '', mmPerUnit: hd[0] ?? 1, resabs: hd[1] ?? 1e-6, resnor: hd[2] ?? 1e-10,
    recs, subs, complete, error,
  };
}
