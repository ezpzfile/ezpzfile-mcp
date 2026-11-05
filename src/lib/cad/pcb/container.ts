// Archive helpers (own code): ZIP (zip.ts), gzip (browser DecompressionStream), POSIX/ustar tar and the Unix
// "compress" .Z format (LZW, used for ODB++ feature files). Everything runs in a Web Worker.
import { Zip } from './zip.ts';
import { CadError } from './types.ts';

export interface InFile { name: string; bytes: Uint8Array }

export async function gunzip(b: Uint8Array): Promise<Uint8Array> {
  try {
    const ds = new DecompressionStream('gzip');
    const stream = new Blob([b as BlobPart]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch (e) {
    throw new CadError('corrupt', `gzip data is damaged (${(e as Error).message})`);
  }
}

export function isZip(b: Uint8Array) { return b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5) ; }
export function isGzip(b: Uint8Array) { return b.length > 2 && b[0] === 0x1f && b[1] === 0x8b; }
export function isCompressZ(b: Uint8Array) { return b.length > 3 && b[0] === 0x1f && b[1] === 0x9d; }
export function isTar(b: Uint8Array) {
  if (b.length < 512) return false;
  const magic = String.fromCharCode(...b.subarray(257, 262));
  if (magic === 'ustar') return true;
  // old tar: checksum field is octal digits
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : b[i];
  const ck = parseInt(String.fromCharCode(...b.subarray(148, 156)).replace(/[^0-7]/g, ''), 8);
  return ck === sum && b[0] !== 0;
}

export function untar(b: Uint8Array): InFile[] {
  const out: InFile[] = [];
  const str = (a: number, n: number) => { let s = ''; for (let i = a; i < a + n && b[i]; i++) s += String.fromCharCode(b[i]); return s; };
  let p = 0;
  let longName: string | null = null;
  let paxPath: string | null = null;
  while (p + 512 <= b.length) {
    if (b[p] === 0) { p += 512; continue; }
    let name = str(p, 100);
    const size = parseInt(str(p + 124, 12).trim() || '0', 8) || 0;
    const type = String.fromCharCode(b[p + 156] || 48);
    const prefix = str(p + 257, 6) === 'ustar' ? str(p + 345, 155) : '';
    if (prefix) name = prefix + '/' + name;
    const data = b.subarray(p + 512, p + 512 + size);
    p += 512 + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = new TextDecoder().decode(data).replace(/\0+$/, ''); continue; }
    if (type === 'x') { const m = /\d+ path=([^\n]*)\n/.exec(new TextDecoder().decode(data)); if (m) paxPath = m[1]; continue; }
    if (type === 'g') continue;
    if (longName) { name = longName; longName = null; }
    if (paxPath) { name = paxPath; paxPath = null; }
    if (type === '0' || type === '\0' || type === '7') out.push({ name, bytes: data });
  }
  return out;
}

/** Unix compress (.Z): LZW with growing code width, clear code 256 in block mode */
export function uncompressZ(b: Uint8Array): Uint8Array {
  if (!isCompressZ(b)) throw new CadError('corrupt', 'not a .Z stream');
  const maxBits = b[2] & 0x1f;
  const block = (b[2] & 0x80) !== 0;
  if (maxBits < 9 || maxBits > 16) throw new CadError('corrupt', '.Z stream with a bad code width');
  const data = b.subarray(3);
  const totalBits = data.length * 8;
  const prefix = new Int32Array(1 << maxBits);
  const suffix = new Uint8Array(1 << maxBits);
  for (let i = 0; i < 256; i++) { prefix[i] = -1; suffix[i] = i; }
  let out = new Uint8Array(Math.max(1024, b.length * 4));
  let o = 0;
  const push = (v: number) => { if (o >= out.length) { const n = new Uint8Array(out.length * 2); n.set(out); out = n; } out[o++] = v; };
  const stackBuf = new Uint8Array(1 << maxBits);
  let nBits = 9;
  let maxCode = (1 << nBits) - 1;
  let freeEnt = block ? 257 : 256;
  let pos = 0; // bit position
  let old = -1;
  let fin = 0;
  const readCode = () => {
    if (pos + nBits > totalBits) return -1;
    let v = 0;
    for (let k = 0; k < nBits; k++) {
      const bit = (data[(pos + k) >> 3] >> ((pos + k) & 7)) & 1;
      v |= bit << k;
    }
    pos += nBits;
    return v;
  };
  // codes are written in groups of 8: when the width changes the rest of the current group is skipped
  const align = () => { const g = nBits * 8; const r = pos % g; if (r) pos += g - r; };
  let groupStart = 0;
  for (;;) {
    if (freeEnt > maxCode && nBits < maxBits) {
      pos = groupStart + Math.ceil((pos - groupStart) / (nBits * 8)) * nBits * 8;
      nBits++; maxCode = nBits === maxBits ? (1 << maxBits) : (1 << nBits) - 1; groupStart = pos;
    }
    const code = readCode();
    if (code < 0) break;
    if (old === -1) { if (code > 255) break; fin = code; push(code); old = code; continue; }
    if (code === 256 && block) {
      for (let i = 256; i < prefix.length; i++) prefix[i] = 0;
      freeEnt = 257;
      pos = groupStart + Math.ceil((pos - groupStart) / (nBits * 8)) * nBits * 8;
      nBits = 9; maxCode = (1 << nBits) - 1; groupStart = pos;
      old = -1;
      continue;
    }
    let c = code;
    let sp = 0;
    if (c >= freeEnt) { if (c > freeEnt) break; stackBuf[sp++] = fin; c = old; }
    while (c >= 256) { stackBuf[sp++] = suffix[c]; c = prefix[c]; if (sp >= stackBuf.length) break; }
    fin = suffix[c];
    stackBuf[sp++] = fin;
    while (sp > 0) push(stackBuf[--sp]);
    if (freeEnt < (1 << maxBits)) { prefix[freeEnt] = old; suffix[freeEnt] = fin; freeEnt++; }
    old = code;
  }
  void align;
  return out.subarray(0, o);
}

/** flatten zip / tgz / tar / gz inputs into plain files (paths keep their folders) */
export async function expand(files: InFile[], onProgress?: (s: string, r: number) => void, depth = 0): Promise<InFile[]> {
  const out: InFile[] = [];
  let total = 0;
  for (const f of files) {
    const b = f.bytes;
    total += b.length;
    if (total > 1.5e9) throw new CadError('too-large', 'The files are too large to open (over 1.5 GB unpacked)');
    const lower = f.name.toLowerCase();
    if (depth < 3 && isZip(b)) {
      onProgress?.('unzip', 0);
      let z: Zip;
      try { z = new Zip(b); } catch (e) { if ((e as CadError).code) throw e; throw new CadError('corrupt', `${f.name}: damaged ZIP (${(e as Error).message})`); }
      const inner: InFile[] = [];
      for (const e of z.list) {
        if (e.name.endsWith('/') || /(^|\/)__MACOSX\//.test(e.name) || /(^|\/)\._/.test(e.name)) continue;
        if (e.usize > 400e6) throw new CadError('too-large', `${e.name} is too large`);
        let d: Uint8Array | null = null;
        try { d = await z.read(e); } catch (err) { if ((err as CadError).code === 'encrypted') throw err; continue; }
        if (d) inner.push({ name: joinName(f.name, e.name), bytes: d });
      }
      if (!inner.length) throw new CadError('corrupt', `${f.name}: no readable files in the ZIP`);
      out.push(...(await expand(inner, onProgress, depth + 1)));
      continue;
    }
    if (depth < 3 && isGzip(b)) {
      let d: Uint8Array;
      try { d = await gunzip(b); } catch (e) { throw new CadError('corrupt', `${f.name}: damaged gzip data`); }
      const nm = f.name.replace(/\.(tgz)$/i, '.tar').replace(/\.gz$/i, '');
      out.push(...(await expand([{ name: nm, bytes: d }], onProgress, depth + 1)));
      continue;
    }
    if (depth < 3 && (isTar(b) || /\.tar$/.test(lower))) {
      if (isTar(b)) { let t: InFile[]; try { t = untar(b); } catch { throw new CadError('corrupt', `${f.name}: damaged tar`); } out.push(...(await expand(t.map((x) => ({ name: joinName(f.name, x.name), bytes: x.bytes })), onProgress, depth + 1))); continue; }
    }
    out.push(f);
  }
  return out;
}

function joinName(archive: string, inner: string) {
  const a = archive.replace(/\\/g, '/');
  const stem = a.replace(/\.(zip|tgz|tar\.gz|tar|gz)$/i, '');
  return stem + '/' + inner.replace(/\\/g, '/').replace(/^\.?\//, '');
}

export function latin1(b: Uint8Array): string {
  // fast byte to string (Gerber, Excellon and ODB++ text are ASCII; other bytes kept as Latin-1)
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < b.length; i += CH) s += String.fromCharCode.apply(null, b.subarray(i, i + CH) as unknown as number[]);
  return s;
}
export function utf8(b: Uint8Array): string {
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.subarray(3);
  return new TextDecoder('utf-8').decode(b);
}
