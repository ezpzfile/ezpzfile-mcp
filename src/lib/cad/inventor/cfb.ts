// OLE / Compound File Binary reader (public MS-CFB layout), adapted from our own RVT engine
// (/tmp/rvt/engine/rvt.ts, class Cfb). Runs in a Web Worker: no DOM, no Node APIs.

export class CfbError extends Error {
  code: 'not-format' | 'corrupt';
  constructor(code: 'not-format' | 'corrupt', m: string) { super(m); this.name = 'CfbError'; this.code = code; }
}
interface DirEntry { name: string; type: number; left: number; right: number; child: number; start: number; size: number }
const END = 0xfffffffa;

function utf16(b: Uint8Array, o: number, n: number): string {
  let s = '';
  for (let i = 0; i < n; i++) s += String.fromCharCode(b[o + 2 * i] | (b[o + 2 * i + 1] << 8));
  return s;
}

export function isCfb(b: Uint8Array): boolean {
  const sig = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  return b.length >= 512 && sig.every((v, i) => b[i] === v);
}

/** directory entry names only, from the first directory sector chain (cheap, for sniffing) */
export function cfbNames(b: Uint8Array, limit = 4096): string[] {
  try { return new Cfb(b, limit).allNames(); } catch { return []; }
}

export class Cfb {
  buf: Uint8Array; dv: DataView; ss: number; mss: number; cutoff: number;
  fat: Uint32Array; miniFat: Uint32Array = new Uint32Array(0); entries: DirEntry[] = []; paths = new Map<string, number>();
  private miniStream: Uint8Array | null = null;
  private miniFatStart: number;

  constructor(buf: Uint8Array, maxEntries = 1_000_000) {
    if (!isCfb(buf)) throw new CfbError('not-format', 'missing OLE signature');
    this.buf = buf; this.dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const dv = this.dv;
    const shift = dv.getUint16(0x1e, true), mshift = dv.getUint16(0x20, true);
    if (shift !== 9 && shift !== 12) throw new CfbError('corrupt', 'bad sector size');
    this.ss = 1 << shift; this.mss = 1 << mshift;
    const nFat = dv.getUint32(0x2c, true);
    const dirStart = dv.getUint32(0x30, true);
    this.cutoff = dv.getUint32(0x38, true);
    this.miniFatStart = dv.getUint32(0x3c, true);
    let difat = dv.getUint32(0x44, true);
    const per = this.ss / 4;
    if (nFat > (buf.length / this.ss) + 1) throw new CfbError('corrupt', 'bad FAT count');
    const fatSects: number[] = [];
    for (let i = 0; i < 109 && fatSects.length < nFat; i++) fatSects.push(dv.getUint32(0x4c + 4 * i, true));
    let guard = 0;
    while (fatSects.length < nFat && difat < END && guard++ < 100000) {
      const o = this.off(difat);
      if (o + this.ss > buf.length) throw new CfbError('corrupt', 'DIFAT sector out of range');
      for (let i = 0; i < per - 1 && fatSects.length < nFat; i++) fatSects.push(dv.getUint32(o + 4 * i, true));
      difat = dv.getUint32(o + 4 * (per - 1), true);
    }
    this.fat = new Uint32Array(fatSects.length * per).fill(0xfffffffe);
    fatSects.forEach((s, k) => {
      const o = this.off(s);
      if (s >= END || o + this.ss > buf.length) return; // truncated: leave chain ends
      for (let i = 0; i < per; i++) this.fat[k * per + i] = dv.getUint32(o + 4 * i, true);
    });
    for (const s of this.chain(dirStart)) {
      const o = this.off(s);
      if (o + this.ss > buf.length) break;
      for (let k = 0; k < this.ss / 128; k++) {
        const e = o + 128 * k;
        const nl = Math.min(64, dv.getUint16(e + 0x40, true));
        this.entries.push({
          name: utf16(buf, e, Math.max(0, nl / 2 - 1)), type: buf[e + 0x42],
          left: dv.getUint32(e + 0x44, true), right: dv.getUint32(e + 0x48, true), child: dv.getUint32(e + 0x4c, true),
          start: dv.getUint32(e + 0x74, true), size: dv.getUint32(e + 0x78, true),
        });
        if (this.entries.length >= maxEntries) break;
      }
      if (this.entries.length >= maxEntries) break;
    }
    if (!this.entries.length || this.entries[0].type !== 5) throw new CfbError('corrupt', 'OLE root entry missing');
    const seen = new Uint8Array(this.entries.length);
    const walk = (idx: number, prefix: string, depth: number) => {
      if (depth > 32) return;
      const stack = [idx];
      while (stack.length) {
        const i = stack.pop()!;
        if (i >= this.entries.length || seen[i]) continue;
        seen[i] = 1;
        const e = this.entries[i];
        const path = prefix + e.name;
        this.paths.set(path, i);
        if (e.type === 1 && e.child < END) walk(e.child, path + '/', depth + 1);
        if (e.left < END) stack.push(e.left);
        if (e.right < END) stack.push(e.right);
      }
    };
    if (this.entries[0].child < END) walk(this.entries[0].child, '', 0);
  }
  off(s: number) { return (s + 1) * this.ss; }
  chain(start: number, fat: Uint32Array = this.fat): number[] {
    const out: number[] = [];
    let s = start;
    while (s < END && s < fat.length) {
      out.push(s);
      if (out.length > fat.length) throw new CfbError('corrupt', 'sector chain loop');
      s = fat[s];
    }
    return out;
  }
  private readChain(ch: number[], size: number): Uint8Array {
    const n = Math.min(size, ch.length * this.ss);
    const out = new Uint8Array(n);
    let p = 0;
    for (const s of ch) {
      const o = this.off(s), len = Math.min(this.ss, n - p, Math.max(0, this.buf.length - o));
      if (len <= 0) break;
      out.set(this.buf.subarray(o, o + len), p); p += len;
    }
    return p === n ? out : out.subarray(0, p);
  }
  allNames(): string[] { return [...this.paths.keys()]; }
  streams(): { name: string; size: number }[] {
    const r: { name: string; size: number }[] = [];
    for (const [k, i] of this.paths) if (this.entries[i].type === 2) r.push({ name: k, size: this.entries[i].size });
    return r.sort((a, b) => (a.name < b.name ? -1 : 1));
  }
  has(path: string) { return this.paths.has(path); }
  read(path: string): Uint8Array {
    const i = this.paths.get(path);
    if (i === undefined) throw new CfbError('corrupt', 'missing stream ' + path);
    const e = this.entries[i];
    if (e.size < this.cutoff) {
      if (!this.miniStream) {
        const r = this.entries[0];
        this.miniStream = this.readChain(this.chain(r.start), r.size);
        const mf = this.miniFatStart < END ? this.readChain(this.chain(this.miniFatStart), Infinity) : new Uint8Array(0);
        this.miniFat = new Uint32Array(mf.length >> 2);
        const mdv = new DataView(mf.buffer, mf.byteOffset, mf.byteLength);
        for (let k = 0; k < this.miniFat.length; k++) this.miniFat[k] = mdv.getUint32(4 * k, true);
      }
      const out = new Uint8Array(e.size);
      let p = 0;
      for (const s of this.chain(e.start, this.miniFat)) {
        const len = Math.min(this.mss, e.size - p);
        if (len <= 0) break;
        out.set(this.miniStream.subarray(s * this.mss, s * this.mss + len), p); p += len;
      }
      return p === e.size ? out : out.subarray(0, p);
    }
    return this.readChain(this.chain(e.start), e.size);
  }
}
