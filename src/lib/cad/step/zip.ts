// Minimal ZIP reader (PKWARE APPNOTE: end of central directory, central directory headers,
// local file headers, methods 0 stored and 8 deflate, ZIP64 sizes). Inflate uses the browser
// built-in DecompressionStream('deflate-raw').

export interface ZipEntry { name: string; method: number; compSize: number; size: number; localOffset: number; flags: number }

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u64 = (b: Uint8Array, o: number) => u32(b, o) + u32(b, o + 4) * 4294967296;

export function isZip(b: Uint8Array) { return b.length > 22 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4; }

export function zipEntries(b: Uint8Array): ZipEntry[] {
  // find EOCD (signature 0x06054b50) scanning back over the comment
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 65535); i--) {
    if (b[i] === 0x50 && b[i + 1] === 0x4b && b[i + 2] === 5 && b[i + 3] === 6) { eocd = i; break; }
  }
  if (eocd < 0) return localScan(b);
  let count = u16(b, eocd + 10);
  let cdOff = u32(b, eocd + 16);
  // ZIP64 end of central directory locator
  if ((cdOff === 0xffffffff || count === 0xffff) && eocd >= 20 && u32(b, eocd - 20) === 0x07064b50) {
    const z64 = u64(b, eocd - 12);
    if (u32(b, z64) === 0x06064b50) { count = u64(b, z64 + 32); cdOff = u64(b, z64 + 48); }
  }
  const out: ZipEntry[] = [];
  let p = cdOff;
  const dec = new TextDecoder();
  for (let k = 0; k < count && p + 46 <= b.length; k++) {
    if (u32(b, p) !== 0x02014b50) break;
    const flags = u16(b, p + 8), method = u16(b, p + 10);
    let compSize = u32(b, p + 20), size = u32(b, p + 24);
    const nl = u16(b, p + 28), xl = u16(b, p + 30), cl = u16(b, p + 32);
    let localOffset = u32(b, p + 42);
    const name = dec.decode(b.subarray(p + 46, p + 46 + nl));
    // zip64 extra field
    let x = p + 46 + nl;
    const xe = x + xl;
    while (x + 4 <= xe) {
      const id = u16(b, x), sz = u16(b, x + 2);
      if (id === 1) {
        let q = x + 4;
        if (size === 0xffffffff) { size = u64(b, q); q += 8; }
        if (compSize === 0xffffffff) { compSize = u64(b, q); q += 8; }
        if (localOffset === 0xffffffff) { localOffset = u64(b, q); q += 8; }
      }
      x += 4 + sz;
    }
    out.push({ name, method, compSize, size, localOffset, flags });
    p += 46 + nl + xl + cl;
  }
  return out.length ? out : localScan(b);
}

/** fallback for archives without a readable central directory */
function localScan(b: Uint8Array): ZipEntry[] {
  const out: ZipEntry[] = [];
  const dec = new TextDecoder();
  let p = 0;
  while (p + 30 <= b.length && u32(b, p) === 0x04034b50) {
    const flags = u16(b, p + 6), method = u16(b, p + 8);
    const compSize = u32(b, p + 18), size = u32(b, p + 22);
    const nl = u16(b, p + 26), xl = u16(b, p + 28);
    out.push({ name: dec.decode(b.subarray(p + 30, p + 30 + nl)), method, compSize, size, localOffset: p, flags });
    if (flags & 8 || !compSize) break; // sizes unknown here
    p += 30 + nl + xl + compSize;
  }
  return out;
}

export async function zipRead(b: Uint8Array, e: ZipEntry): Promise<Uint8Array> {
  const p = e.localOffset;
  if (u32(b, p) !== 0x04034b50) throw Object.assign(new Error('zip: bad local header'), { code: 'corrupt' });
  if (e.flags & 1) throw Object.assign(new Error('zip entry is encrypted'), { code: 'encrypted' });
  const nl = u16(b, p + 26), xl = u16(b, p + 28);
  const start = p + 30 + nl + xl;
  let comp = e.compSize;
  if (!comp && e.flags & 8) comp = b.length - start; // streamed entry without central directory
  const data = b.subarray(start, Math.min(b.length, start + comp));
  if (e.method === 0) return data;
  if (e.method !== 8) throw Object.assign(new Error('zip: unsupported compression method ' + e.method), { code: 'unsupported-version' });
  const ds = new DecompressionStream('deflate-raw');
  const writer = ds.writable.getWriter();
  writer.write(data as unknown as BufferSource).catch(() => {});
  writer.close().catch(() => {});
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value); total += value.length;
    }
  } catch (err) {
    if (!total) throw Object.assign(new Error('zip: inflate failed: ' + (err as Error).message), { code: 'corrupt' });
  }
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
