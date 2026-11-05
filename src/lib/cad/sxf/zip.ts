// Minimal ZIP reader (own code, from the PKWARE APPNOTE structure: end of central directory, central directory,
// local headers, ZIP64 extra fields). Deflate is decoded with the browser built-in DecompressionStream('deflate-raw').
// Handles data before the archive (classic DWF files start with a 12 byte "(DWF V06.00)" header).

import { CadError } from './types.ts';

export interface ZipEntry { name: string; key: string; method: number; flags: number; csize: number; usize: number; local: number }

export function normName(n: string): string {
  let s = n.replace(/\\/g, '/').replace(/^\/+/, '');
  try { s = decodeURIComponent(s); } catch { /* keep */ }
  return s.toLowerCase();
}

export class Zip {
  bytes: Uint8Array;
  dv: DataView;
  entries = new Map<string, ZipEntry>();
  list: ZipEntry[] = [];

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const b = bytes, dv = this.dv;
    let eocd = -1;
    for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
      if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 5 && b[i + 3] === 6) { eocd = i; break; }
    }
    if (eocd < 0) throw new CadError('corrupt', 'ZIP end of central directory not found');
    let count = dv.getUint16(eocd + 10, true);
    let cdSize = dv.getUint32(eocd + 12, true);
    let cdOff = dv.getUint32(eocd + 16, true);
    let endOfCd = eocd;
    if (count === 0xffff || cdOff === 0xffffffff) {
      const loc = eocd - 20;
      if (loc >= 0 && dv.getUint32(loc, true) === 0x07064b50) {
        const z = Number(dv.getBigUint64(loc + 8, true));
        const zz = z + (eocd - 20 - 56 - z >= 0 ? 0 : 0);
        if (dv.getUint32(zz, true) === 0x06064b50) {
          count = Number(dv.getBigUint64(zz + 32, true));
          cdSize = Number(dv.getBigUint64(zz + 40, true));
          cdOff = Number(dv.getBigUint64(zz + 48, true));
          endOfCd = zz;
        }
      }
    }
    // prefix data (self-extractor style): actual offsets are shifted by this delta
    const delta = endOfCd - (cdOff + cdSize);
    let p = cdOff + delta;
    for (let k = 0; k < count && p + 46 <= b.length; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const flags = dv.getUint16(p + 8, true);
      const method = dv.getUint16(p + 10, true);
      let csize = dv.getUint32(p + 20, true);
      let usize = dv.getUint32(p + 24, true);
      const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
      let local = dv.getUint32(p + 42, true);
      const nameBytes = b.subarray(p + 46, p + 46 + nl);
      const name = (flags & 0x800) ? new TextDecoder('utf-8').decode(nameBytes) : latin(nameBytes);
      // zip64 extra
      let x = p + 46 + nl;
      const xe = x + xl;
      while (x + 4 <= xe) {
        const id = dv.getUint16(x, true), sz = dv.getUint16(x + 2, true);
        if (id === 1) {
          let q = x + 4;
          if (usize === 0xffffffff) { usize = Number(dv.getBigUint64(q, true)); q += 8; }
          if (csize === 0xffffffff) { csize = Number(dv.getBigUint64(q, true)); q += 8; }
          if (local === 0xffffffff) { local = Number(dv.getBigUint64(q, true)); q += 8; }
        }
        x += 4 + sz;
      }
      const e: ZipEntry = { name, key: normName(name), method, flags, csize, usize, local: local + delta };
      this.entries.set(e.key, e);
      this.list.push(e);
      p += 46 + nl + xl + cl;
    }
    if (!this.list.length) throw new CadError('corrupt', 'ZIP has no entries');
  }

  has(name: string): boolean { return this.entries.has(normName(name)); }
  find(name: string): ZipEntry | undefined {
    const k = normName(name);
    return this.entries.get(k);
  }

  async read(name: string | ZipEntry): Promise<Uint8Array | null> {
    const e = typeof name === 'string' ? this.find(name) : name;
    if (!e) {
      // interleaved OPC parts: name/[0].piece ... [n].last.piece
      if (typeof name === 'string') {
        const k = normName(name);
        const pieces = this.list.filter((x) => x.key.startsWith(k + '/[') && x.key.endsWith('.piece'));
        if (pieces.length) {
          pieces.sort((a, b) => parseInt(a.key.slice(k.length + 2), 10) - parseInt(b.key.slice(k.length + 2), 10));
          const parts = await Promise.all(pieces.map((x) => this.read(x)));
          const tot = parts.reduce((a, b2) => a + (b2?.length ?? 0), 0);
          const out = new Uint8Array(tot);
          let o = 0;
          for (const pp of parts) if (pp) { out.set(pp, o); o += pp.length; }
          return out;
        }
      }
      return null;
    }
    if (e.flags & 1) throw new CadError('encrypted', `ZIP entry ${e.name} is encrypted`);
    const dv = this.dv;
    if (dv.getUint32(e.local, true) !== 0x04034b50) throw new CadError('corrupt', `ZIP local header of ${e.name} not found`);
    const nl = dv.getUint16(e.local + 26, true), xl = dv.getUint16(e.local + 28, true);
    const start = e.local + 30 + nl + xl;
    const data = this.bytes.subarray(start, start + e.csize);
    if (e.method === 0) return data;
    if (e.method === 8) return inflateRaw(data);
    throw new CadError('unsupported-version', `ZIP compression method ${e.method} not supported (${e.name})`);
  }

  async text(name: string): Promise<string | null> {
    const b = await this.read(name);
    if (!b) return null;
    return decodeXmlBytes(b);
  }
}

function latin(b: Uint8Array): string { let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s; }

export async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  try {
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch (e) {
    throw new CadError('corrupt', `deflate data is damaged (${(e as Error).message})`);
  }
}

/** XML bytes to string: BOM / UTF-16 aware */
export function decodeXmlBytes(b: Uint8Array): string {
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder('utf-8').decode(b.subarray(3));
  return new TextDecoder('utf-8').decode(b);
}
