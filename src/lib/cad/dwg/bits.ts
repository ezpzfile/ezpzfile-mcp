// Bit level reader for DWG data streams (ODS chapter 2).
// Bits are read MSB first inside each byte. Multi byte raw values are little endian.

export class DwgError extends Error {
  code: string;
  versionTag?: string;   // file version id (e.g. 'AC1009'), set by readDwg on every error it throws
  constructor(code: string, msg: string) { super(msg); this.code = code; }
}

const f64 = new Float64Array(1);
const f64b = new Uint8Array(f64.buffer);

export interface Handle { code: number; value: number }

export class BitReader {
  d: Uint8Array;
  bit: number;       // absolute bit position
  end: number;       // bit limit (exclusive)
  ver: number;       // numeric version (13,14,15,18,21,24,27,32)
  decoder: TextDecoder;
  constructor(d: Uint8Array, startBit = 0, endBit = d.length * 8, ver = 15, decoder?: TextDecoder) {
    this.d = d; this.bit = startBit; this.end = endBit; this.ver = ver;
    this.decoder = decoder || new TextDecoder('windows-1252');
  }
  clone(bit: number, end = this.end): BitReader { return new BitReader(this.d, bit, end, this.ver, this.decoder); }
  get eof(): boolean { return this.bit >= this.end; }
  check(n: number) { if (this.bit + n > this.end || this.bit < 0) throw new DwgError('corrupt', 'read past end of stream'); }

  B(): number {
    if (this.bit >= this.end || this.bit < 0) throw new DwgError('corrupt', 'read past end of stream');
    const b = (this.d[this.bit >> 3] >> (7 - (this.bit & 7))) & 1;
    this.bit++;
    return b;
  }
  BB(): number { return (this.B() << 1) | this.B(); }
  B3(): number { // 3B: up to 3 bits, stop at first zero
    let v = 0;
    for (let i = 0; i < 3; i++) { const b = this.B(); v = (v << 1) | b; if (!b) break; }
    return v;
  }
  RC(): number {
    this.check(8);
    const p = this.bit >> 3, o = this.bit & 7;
    let v: number;
    if (o === 0) v = this.d[p];
    else v = ((this.d[p] << o) | (this.d[p + 1] >> (8 - o))) & 0xff;
    this.bit += 8;
    return v;
  }
  RS(): number { const a = this.RC(); const b = this.RC(); return (a | (b << 8)); }
  RSs(): number { const v = this.RS(); return v & 0x8000 ? v - 0x10000 : v; }
  RL(): number { const a = this.RS(); const b = this.RS(); return (a | (b << 16)) | 0; }
  RLu(): number { return this.RL() >>> 0; }
  RD(): number {
    this.check(64);
    if ((this.bit & 7) === 0) { const p = this.bit >> 3; for (let i = 0; i < 8; i++) f64b[i] = this.d[p + i]; this.bit += 64; }
    else for (let i = 0; i < 8; i++) f64b[i] = this.RC();
    return f64[0];
  }
  BS(): number {
    switch (this.BB()) {
      case 0: return this.RSs();
      case 1: return this.RC();
      case 2: return 0;
      default: return 256;
    }
  }
  BL(): number {
    switch (this.BB()) {
      case 0: return this.RL();
      case 1: return this.RC();
      default: return 0;
    }
  }
  BLL(): number {
    // sample finding: the length prefix of BLL is always 3 bits (not the 1-3 bit 3B code)
    const n = (this.B() << 2) | (this.B() << 1) | this.B();
    let v = 0, m = 1;
    for (let i = 0; i < n; i++) { v += this.RC() * m; m *= 256; }
    return v;
  }
  BD(): number {
    switch (this.BB()) {
      case 0: return this.RD();
      case 1: return 1.0;
      case 2: return 0.0;
      default: return 0.0;   // not used by the format
    }
  }
  DD(def: number): number {
    const c = this.BB();
    if (c === 0) return def;
    if (c === 3) return this.RD();
    f64[0] = def;
    if (c === 1) { for (let i = 0; i < 4; i++) f64b[i] = this.RC(); }
    else { f64b[4] = this.RC(); f64b[5] = this.RC(); for (let i = 0; i < 4; i++) f64b[i] = this.RC(); }
    return f64[0];
  }
  BT(): number { if (this.ver >= 15) return this.B() ? 0 : this.BD(); return this.BD(); }
  BE(): [number, number, number] {
    if (this.ver >= 15) { if (this.B()) return [0, 0, 1]; }
    return [this.BD(), this.BD(), this.BD()];
  }
  P2RD(): [number, number] { return [this.RD(), this.RD()]; }
  P2BD(): [number, number] { return [this.BD(), this.BD()]; }
  P3BD(): [number, number, number] { return [this.BD(), this.BD(), this.BD()]; }
  P3RD(): [number, number, number] { return [this.RD(), this.RD(), this.RD()]; }
  // modular char (signed form), works on unaligned streams too
  MC(): number {
    let v = 0, shift = 0;
    for (let i = 0; i < 8; i++) {
      const b = this.RC();
      if (b & 0x80) { v += (b & 0x7f) * Math.pow(2, shift); shift += 7; continue; }
      const neg = (b & 0x40) !== 0;
      v += (b & 0x3f) * Math.pow(2, shift);
      return neg ? -v : v;
    }
    throw new DwgError('corrupt', 'bad modular char');
  }
  MCu(): number { // unsigned form (handle stream size, object map handle deltas)
    let v = 0, shift = 0;
    for (let i = 0; i < 10; i++) {
      const b = this.RC();
      v += (b & 0x7f) * Math.pow(2, shift); shift += 7;
      if (!(b & 0x80)) return v;
    }
    throw new DwgError('corrupt', 'bad modular char');
  }
  MS(): number {
    let v = 0, shift = 0;
    for (let i = 0; i < 4; i++) {
      const w = this.RS();
      v += (w & 0x7fff) * Math.pow(2, shift); shift += 15;
      if (!(w & 0x8000)) return v;
    }
    throw new DwgError('corrupt', 'bad modular short');
  }
  // object type (2.12)
  OT(): number {
    if (this.ver >= 24) {
      const c = this.BB();
      if (c === 0) return this.RC();
      if (c === 1) return this.RC() + 0x1f0;
      return this.RS();
    }
    return this.BS();
  }
  H(): Handle {
    const b = this.RC();
    const code = b >> 4, n = b & 15;
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + this.RC();
    return { code, value: v };
  }
  // handle resolved against a reference handle (2.13)
  HR(ref: number): number {
    const h = this.H();
    switch (h.code) {
      case 6: return ref + 1;
      case 8: return ref - 1;
      case 0xa: return ref + h.value;
      case 0xc: return ref - h.value;
      default: return h.value;
    }
  }
  // 8-bit code page text (T): BS length then bytes
  T(): string {
    const n = this.BS();
    if (n <= 0) return '';
    this.check(n * 8);
    let bytes: Uint8Array;
    if ((this.bit & 7) === 0) { const p = this.bit >> 3; bytes = this.d.subarray(p, p + n); this.bit += n * 8; }
    else { bytes = new Uint8Array(n); for (let i = 0; i < n; i++) bytes[i] = this.RC(); }
    let e = bytes.length; while (e > 0 && bytes[e - 1] === 0) e--;
    return this.decoder.decode(bytes.subarray(0, e));
  }
  // unicode text (TU): BS char count then UTF-16LE
  TU(): string {
    const n = this.BS();
    if (n <= 0) return '';
    this.check(n * 16);
    let s = '';
    const parts: string[] = [];
    for (let i = 0; i < n; i++) {
      const c = this.RS();
      if (c === 0) { continue; }
      s += String.fromCharCode(c);
      if (s.length > 4096) { parts.push(s); s = ''; }
    }
    parts.push(s);
    return parts.join('');
  }
  align() { this.bit = (this.bit + 7) & ~7; }
  bytes(n: number): Uint8Array {
    this.check(n * 8);
    if ((this.bit & 7) === 0) { const p = this.bit >> 3; this.bit += n * 8; return this.d.subarray(p, p + n); }
    const out = new Uint8Array(n); for (let i = 0; i < n; i++) out[i] = this.RC(); return out;
  }
  skipBits(n: number) { this.check(n); this.bit += n; }
}

// Little endian helpers on byte arrays
export function u16(d: Uint8Array, p: number) { return d[p] | (d[p + 1] << 8); }
export function u32(d: Uint8Array, p: number) { return (d[p] | (d[p + 1] << 8) | (d[p + 2] << 16) | (d[p + 3] << 24)) >>> 0; }
export function u64(d: Uint8Array, p: number) { return u32(d, p) + u32(d, p + 4) * 4294967296; }
export function i64(d: Uint8Array, p: number) {
  const lo = u32(d, p), hi = u32(d, p + 4) | 0;
  return hi * 4294967296 + lo;
}
