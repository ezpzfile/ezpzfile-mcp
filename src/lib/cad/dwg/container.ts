// File containers: R13-R15 (flat file with section locators), R2004/R2010+ (paged, LZ77 variant),
// R2007 (paged, Reed-Solomon interleaved, R21 LZ variant). ODS chapters 3, 4, 5, 6, 7, 8.
import { DwgError, u16, u32, u64, i64 } from './bits.ts';

export interface Container {
  ver: number;                 // 13,14,15,18,21,24,27,32
  verStr: string;
  maint: number;
  codepage: number;
  header: Uint8Array | null;   // AcDb:Header section data (R2004+: whole section, R13-15: from sentinel)
  classes: Uint8Array | null;
  handles: Uint8Array | null;  // object map
  objects: Uint8Array;         // AcDb:AcDbObjects (R13-15: whole file, offsets absolute)
  warnings: string[];
}

export const VERSIONS: Record<string, number> = {
  AC1012: 13, AC1014: 14, AC1015: 15, AC1018: 18, AC1021: 21, AC1024: 24, AC1027: 27, AC1032: 32,
};

export function versionString(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < 6 && i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return s;
}

// ---------------------------------------------------------------- R13-R15
function readR15(d: Uint8Array, ver: number, verStr: string): Container {
  const warnings: string[] = [];
  const n = u32(d, 0x15);
  if (n > 16) throw new DwgError('corrupt', 'bad section locator count');
  const loc: Record<number, { seek: number; size: number }> = {};
  for (let i = 0; i < n; i++) {
    const p = 0x19 + i * 9;
    loc[d[p]] = { seek: u32(d, p + 1), size: u32(d, p + 5) };
  }
  const sub = (k: number) => {
    const l = loc[k];
    if (!l || l.seek >= d.length) return null;
    return d.subarray(l.seek, Math.min(d.length, l.seek + l.size));
  };
  return {
    ver, verStr, maint: d[0x0b], codepage: u16(d, 0x13),
    header: sub(0), classes: sub(1), handles: sub(2), objects: d, warnings,
  };
}

// ---------------------------------------------------------------- R2004 LZ77 variant (4.7)
// Decompresses into `dst` at `base` (a new array when not given), writing at most outSize bytes.
export function decompressR18(src: Uint8Array, start: number, len: number, outSize: number, dst?: Uint8Array, base = 0): Uint8Array {
  if (!dst) dst = new Uint8Array(outSize);
  const D = dst;
  outSize = Math.min(outSize, dst.length - base);
  let i = start, o = 0;
  const end = Math.min(src.length, start + len);
  const litLen = (): number => {
    const b = src[i];
    if (b === 0) {
      i++;
      let t = 0x0f;
      for (;;) {
        if (i >= end) return t + 3;
        const c = src[i++];
        if (c === 0) t += 0xff; else { t += c; break; }
      }
      return t + 3;
    }
    if (b < 0x10) { i++; return b + 3; }
    return 0;
  };
  const longOff = (): number => {
    let b = src[i++];
    if (b !== 0) return b;
    let t = 0xff;
    for (;;) { b = src[i++]; if (b === 0) t += 0xff; else { t += b; break; } if (i >= end) break; }
    return t;
  };
  const copyLit = (n: number) => {
    if (o + n > outSize) n = outSize - o;
    if (n <= 0) return;
    D.set(src.subarray(i, i + n), base + o); i += n; o += n;
  };
  copyLit(litLen());
  while (i < end && o < outSize) {
    const op1 = src[i++];
    if (op1 === 0x11) break;
    let cb = 0, off = 0, lit = 0;
    if (op1 >= 0x40) {
      cb = (op1 >> 4) - 1;
      const op2 = src[i++];
      off = (op2 << 2) | ((op1 & 0x0c) >> 2);
      lit = op1 & 3;
      if (lit === 0) lit = litLen();
    } else if (op1 >= 0x21) {
      cb = op1 - 0x1e;
      const a = src[i++], b = src[i++];
      off = (a >> 2) | (b << 6); lit = a & 3;
      if (lit === 0) lit = litLen();
    } else if (op1 === 0x20) {
      cb = longOff() + 0x21;
      const a = src[i++], b = src[i++];
      off = (a >> 2) | (b << 6); lit = a & 3;
      if (lit === 0) lit = litLen();
    } else if (op1 >= 0x10) {
      // sample finding (deviates from the ODS text): for 0x10-0x1F bit 3 is the high bit of the offset
      // (+0x4000) and bits 0-2 hold the length - 2 (0 = a long length + 9 follows)
      const L = op1 & 7;
      cb = L ? L + 2 : longOff() + 9;
      const a = src[i++], b = src[i++];
      off = ((a >> 2) | (b << 6)) + 0x3fff + ((op1 & 8) << 11); lit = a & 3;
      if (lit === 0) lit = litLen();
    } else {
      throw new DwgError('corrupt', 'bad R2004 compression opcode');
    }
    // offsets are stored minus one
    let s = o - off - 1;
    if (s < 0) throw new DwgError('corrupt', 'bad R2004 back reference');
    if (o + cb > outSize) cb = outSize - o;
    for (let k = 0; k < cb; k++) D[base + o++] = D[base + s++];
    copyLit(lit);
  }
  return D;
}

// ---------------------------------------------------------------- R2004 / R2010+ container
const MAGIC = (() => {
  const m = new Uint8Array(0x6c); let r = 1;
  for (let i = 0; i < 0x6c; i++) { r = (Math.imul(r, 0x343fd) + 0x269ec3) | 0; m[i] = (r >>> 16) & 0xff; }
  return m;
})();

interface SecDesc { name: string; size: number; maxSize: number; compressed: number; encrypted: number; pages: { num: number; dataSize: number; start: number }[] }

function readR18(d: Uint8Array, ver: number, verStr: string): Container {
  const warnings: string[] = [];
  const security = u32(d, 0x18);
  const h = new Uint8Array(0x6c);
  for (let i = 0; i < 0x6c; i++) h[i] = d[0x80 + i] ^ MAGIC[i];
  let id = ''; for (let i = 0; i < 11; i++) id += String.fromCharCode(h[i]);
  if (id !== 'AcFssFcAJMB') throw new DwgError('corrupt', 'bad R2004 file header id');
  const pageMapAddr = u64(h, 0x54) + 0x100;
  const sectionMapId = u32(h, 0x5c);
  if (pageMapAddr + 0x14 > d.length) throw new DwgError('corrupt', 'page map outside file');
  // system page: section page map
  const sysPage = (addr: number, type: number): Uint8Array => {
    if (addr + 0x14 > d.length) throw new DwgError('corrupt', 'system page outside file');
    if (u32(d, addr) !== type) throw new DwgError('corrupt', 'bad system page type');
    const dsize = u32(d, addr + 4), csize = u32(d, addr + 8), ctype = u32(d, addr + 12);
    if (dsize > 64 * 1024 * 1024) throw new DwgError('corrupt', 'system page too large');
    if (ctype === 2) return decompressR18(d, addr + 0x14, csize, dsize);
    return d.slice(addr + 0x14, addr + 0x14 + dsize);
  };
  const pm = sysPage(pageMapAddr, 0x41630e3b);
  const pageAddr = new Map<number, number>();
  let addr = 0x100;
  for (let p = 0; p + 8 <= pm.length;) {
    const num = u32(pm, p) | 0, size = u32(pm, p + 4); p += 8;
    if (num >= 0) pageAddr.set(num, addr);
    else p += 16;
    addr += size;
  }
  const smAddr = pageAddr.get(sectionMapId);
  if (smAddr === undefined) throw new DwgError('corrupt', 'section map page missing');
  const sm = sysPage(smAddr, 0x4163003b);
  const nDesc = u32(sm, 0);
  const secs: SecDesc[] = [];
  let p = 0x14;
  for (let k = 0; k < nDesc && p + 0x60 <= sm.length; k++) {
    const size = u64(sm, p), pageCount = u32(sm, p + 8), maxSize = u32(sm, p + 12);
    const compressed = u32(sm, p + 0x14), encrypted = u32(sm, p + 0x1c);
    let name = '';
    for (let c = 0; c < 64; c++) { const ch = sm[p + 0x20 + c]; if (!ch) break; name += String.fromCharCode(ch); }
    p += 0x60;
    const pages: SecDesc['pages'] = [];
    for (let j = 0; j < pageCount && p + 16 <= sm.length; j++) {
      pages.push({ num: u32(sm, p), dataSize: u32(sm, p + 4), start: u64(sm, p + 8) }); p += 16;
    }
    secs.push({ name, size, maxSize, compressed, encrypted, pages });
  }
  const byName = new Map(secs.map((s) => [s.name, s]));
  if ((security & 1) || byName.has('AcDb:Security')) {
    const ob = byName.get('AcDb:AcDbObjects');
    if ((security & 1) || (ob && ob.encrypted === 1)) throw new DwgError('encrypted', 'drawing is password protected');
  }
  const load = (name: string): Uint8Array | null => {
    const s = byName.get(name);
    if (!s) return null;
    if (s.encrypted === 1) throw new DwgError('encrypted', 'section ' + name + ' is encrypted');
    if (s.size > 1024 * 1024 * 1024) throw new DwgError('too-large', 'section too large');
    const out = new Uint8Array(s.size);
    for (const pg of s.pages) {
      const a = pageAddr.get(pg.num);
      if (a === undefined || a + 32 > d.length) { warnings.push('missing page in ' + name); continue; }
      const mask = (0x4164536b ^ a) >>> 0;
      const hd = new Uint32Array(8);
      for (let j = 0; j < 8; j++) hd[j] = (u32(d, a + j * 4) ^ mask) >>> 0;
      if (hd[0] !== 0x4163043b) { warnings.push('bad page header in ' + name); continue; }
      const csize = hd[2];
      const start = pg.start;
      const want = Math.min(s.maxSize, s.size - start);
      if (want <= 0) continue;
      try {
        // decompress straight into the section buffer (no temporary page copies)
        if (s.compressed === 2) decompressR18(d, a + 32, csize, Math.min(want, s.maxSize), out, start);
        else { const data = d.subarray(a + 32, a + 32 + s.maxSize); out.set(data.subarray(0, Math.min(want, data.length)), start); }
      } catch (e) {
        warnings.push('page decode failed in ' + name + ': ' + (e as Error).message);
      }
    }
    return out;
  };
  return {
    ver, verStr, maint: d[0x0b], codepage: u16(d, 0x13),
    header: load('AcDb:Header'), classes: load('AcDb:Classes'), handles: load('AcDb:Handles'),
    objects: load('AcDb:AcDbObjects') || new Uint8Array(0), warnings,
  };
}

// ---------------------------------------------------------------- R2007 (AC1021)
// R21 LZ variant (5.10). Literal runs are stored with a byte order shuffle described by the copy table.
function copyShuffled(src: Uint8Array, s: number, n: number, dst: Uint8Array, o: number) {
  // recursive interpretation of the ODS copy table
  const put = (si: number, cnt: number, oi: number): number => {
    for (let k = 0; k < cnt; k++) dst[oi + k] = src[si + k];
    return oi + cnt;
  };
  const blk = (si: number, cnt: number, oi: number): number => {
    switch (cnt) {
      case 0: return oi;
      case 1: return put(si, 1, oi);
      case 2: dst[oi] = src[si + 1]; dst[oi + 1] = src[si]; return oi + 2;
      case 3: dst[oi] = src[si + 2]; dst[oi + 1] = src[si + 1]; dst[oi + 2] = src[si]; return oi + 3;
      case 4: return put(si, 4, oi);
      case 5: oi = put(si + 4, 1, oi); return put(si, 4, oi);
      case 6: oi = put(si + 5, 1, oi); oi = put(si + 1, 4, oi); return put(si, 1, oi);
      case 7: oi = blk(si + 5, 2, oi); oi = put(si + 1, 4, oi); return put(si, 1, oi);
      case 8: oi = put(si, 4, oi); return put(si + 4, 4, oi);
      case 9: oi = put(si + 8, 1, oi); return blk(si, 8, oi);
      case 10: oi = put(si + 9, 1, oi); oi = blk(si + 1, 8, oi); return put(si, 1, oi);
      case 11: oi = blk(si + 9, 2, oi); oi = blk(si + 1, 8, oi); return put(si, 1, oi);
      case 12: oi = put(si + 8, 4, oi); return blk(si, 8, oi);
      case 13: oi = put(si + 12, 1, oi); oi = put(si + 8, 4, oi); return blk(si, 8, oi);
      case 14: oi = put(si + 13, 1, oi); oi = put(si + 9, 4, oi); oi = blk(si + 1, 8, oi); return put(si, 1, oi);
      case 15: oi = blk(si + 13, 2, oi); oi = put(si + 9, 4, oi); oi = blk(si + 1, 8, oi); return put(si, 1, oi);
      case 16: oi = blk(si + 8, 8, oi); return blk(si, 8, oi);
      case 17: oi = blk(si + 9, 8, oi); oi = put(si + 8, 1, oi); return blk(si, 8, oi);
      case 18: oi = put(si + 17, 1, oi); oi = blk(si + 1, 16, oi); return put(si, 1, oi);
      case 19: oi = blk(si + 16, 3, oi); return blk(si, 16, oi);
      case 20: oi = put(si + 16, 4, oi); return blk(si, 16, oi);
      case 21: oi = put(si + 20, 1, oi); oi = put(si + 16, 4, oi); return blk(si, 16, oi);
      case 22: oi = blk(si + 20, 2, oi); oi = put(si + 16, 4, oi); return blk(si, 16, oi);
      case 23: oi = blk(si + 20, 3, oi); oi = put(si + 16, 4, oi); return blk(si, 16, oi);
      case 24: oi = blk(si + 16, 8, oi); return blk(si, 16, oi);
      case 25: oi = blk(si + 17, 8, oi); oi = put(si + 16, 1, oi); return blk(si, 16, oi);
      case 26: oi = put(si + 25, 1, oi); oi = blk(si + 17, 8, oi); oi = put(si + 16, 1, oi); return blk(si, 16, oi);
      case 27: oi = blk(si + 25, 2, oi); oi = blk(si + 17, 8, oi); oi = put(si + 16, 1, oi); return blk(si, 16, oi);
      case 28: oi = put(si + 24, 4, oi); oi = blk(si + 16, 8, oi); return blk(si, 16, oi);
      case 29: oi = put(si + 28, 1, oi); oi = put(si + 24, 4, oi); oi = blk(si + 16, 8, oi); return blk(si, 16, oi);
      case 30: oi = blk(si + 28, 2, oi); oi = put(si + 24, 4, oi); oi = blk(si + 16, 8, oi); return blk(si, 16, oi);
      case 31: oi = put(si + 30, 1, oi); oi = put(si + 26, 4, oi); oi = blk(si + 18, 8, oi); oi = blk(si + 2, 16, oi); return blk(si, 2, oi);
      default: oi = blk(si + 16, 16, oi); return blk(si, 16, oi); // 32
    }
  };
  while (n >= 32) { o = blk(s, 32, o); s += 32; n -= 32; }
  blk(s, n, o);
}

export function decompressR21(src: Uint8Array, start: number, len: number, outSize: number): Uint8Array {
  const dst = new Uint8Array(outSize);
  let i = start, o = 0;
  const end = Math.min(src.length, start + len);
  let length = 0;
  let op = src[i++];
  if ((op >> 4) === 2) { i = start + 4; length = src[start + 3] & 7; }
  const litLen = (op0: number): number => {
    let l = op0 + 8;
    if (l === 0x17) {
      let n = src[i++]; l += n;
      if (n === 0xff) {
        do { n = src[i] | (src[i + 1] << 8); i += 2; l += n; } while (n === 0xffff && i < end);
      }
    }
    return l;
  };
  let offset = 0;
  const instr = (): void => {
    switch (op >> 4) {
      case 0: {
        length = (op & 0xf) + 0x13;
        offset = src[i++];
        op = src[i++];
        length = ((op >> 3) & 0x10) + length;
        offset = ((op & 0x78) << 5) + 1 + offset;
        break;
      }
      case 1: {
        length = (op & 0xf) + 3;
        offset = src[i++];
        op = src[i++];
        offset = ((op & 0xf8) << 5) + 1 + offset;
        break;
      }
      case 2: {
        offset = src[i++];
        offset = ((src[i++] << 8) & 0xff00) | offset;
        length = op & 7;
        if ((op & 8) === 0) {
          op = src[i++];
          length = (op & 0xf8) + length;
        } else {
          offset++;
          length = (src[i++] << 3) + length;
          op = src[i++];
          length = (((op & 0xf8) << 8) + length) + 0x100;
        }
        break;
      }
      default: {
        length = op >> 4;
        offset = op & 15;
        op = src[i++];
        offset = (((op & 0xf8) << 1) + offset) + 1;
        break;
      }
    }
  };
  let guard = 0;
  const maxIter = outSize * 4 + 1000;
  for (;;) {
    if (++guard > maxIter) throw new DwgError('corrupt', 'R2007 decompression does not terminate');
    if (length === 0) { length = litLen(op); }
    if (o + length > outSize) length = outSize - o;
    if (length > 0) { copyShuffled(src, i, length, dst, o); i += length; o += length; }
    length = 0;
    if (i >= end || o >= outSize) break;
    // compressed chunks
    op = src[i++];
    instr();
    for (;;) {
      if (++guard > maxIter) throw new DwgError('corrupt', 'R2007 decompression does not terminate');
      let s = o - offset;
      if (s < 0) throw new DwgError('corrupt', 'bad R2007 back reference');
      let n = length;
      if (o + n > outSize) n = outSize - o;
      for (let k = 0; k < n; k++) dst[o++] = dst[s++];
      length = op & 7;
      if (length !== 0 || i >= end) break;
      op = src[i++];
      if ((op >> 4) === 0) break;
      if ((op >> 4) === 15) op &= 15;
      instr();
    }
    if (i >= end || o >= outSize) break;
  }
  return dst;
}

// Reed-Solomon de-interleave (data bytes only, no error correction)
function rsData(d: Uint8Array, start: number, blocks: number, k: number, want: number): Uint8Array {
  const out = new Uint8Array(blocks * k);
  let q = 0;
  for (let b = 0; b < blocks; b++) {
    for (let j = 0; j < k; j++) {
      const p = start + b + j * blocks;
      out[q++] = p < d.length ? d[p] : 0;
    }
  }
  return out.subarray(0, Math.min(want, out.length));
}

function readR21(d: Uint8Array, ver: number, verStr: string): Container {
  const warnings: string[] = [];
  const security = u32(d, 0x18);
  if (security & 1) throw new DwgError('encrypted', 'drawing is password protected');
  // file header page at 0x80: RS(255,239) interleaved factor 3
  const fh = rsData(d, 0x80, 3, 239, 3 * 239);
  const comprLen = i64(fh, 0x18) ;
  let hdr: Uint8Array;
  if (comprLen < 0) hdr = fh.slice(0x20, 0x20 - comprLen);
  else hdr = decompressR21(fh, 0x20, comprLen, 0x110);
  const pagesMapCorr = u64(hdr, 0x18);
  const pagesMapOffset = u64(hdr, 0x38);
  const pagesMapSizeComp = u64(hdr, 0x50);
  const pagesMapSizeUncomp = u64(hdr, 0x58);
  const secMapSizeComp = u64(hdr, 0xb0);
  const secMapId = u64(hdr, 0xc0);
  const secMapSizeUncomp = u64(hdr, 0xc8);
  const secMapCorr = u64(hdr, 0xd8);
  if (pagesMapSizeUncomp > 256 * 1024 * 1024 || secMapSizeUncomp > 256 * 1024 * 1024) throw new DwgError('corrupt', 'bad R2007 header');
  const sysPage = (pos: number, sizeComp: number, sizeUncomp: number, corr: number): Uint8Array => {
    const aligned = (sizeComp + 7) & ~7;
    const total = aligned * Math.max(1, corr);
    const blocks = Math.ceil(total / 239);
    const raw = rsData(d, pos, blocks, 239, total);
    if (sizeComp < sizeUncomp) return decompressR21(raw, 0, sizeComp, sizeUncomp);
    return raw.slice(0, sizeUncomp);
  };
  const pm = sysPage(0x480 + pagesMapOffset, pagesMapSizeComp, pagesMapSizeUncomp, pagesMapCorr);
  const pages = new Map<number, { off: number; size: number }>();
  let off = 0;
  for (let p = 0; p + 16 <= pm.length; p += 16) {
    const size = i64(pm, p), id = i64(pm, p + 8);
    pages.set(Math.abs(id), { off, size });
    off += size;
  }
  const smp = pages.get(secMapId);
  if (!smp) throw new DwgError('corrupt', 'R2007 section map page missing');
  const sm = sysPage(0x480 + smp.off, secMapSizeComp, secMapSizeUncomp, secMapCorr);
  interface S21 { name: string; size: number; maxSize: number; enc: number; encoding: number; pages: { off: number; size: number; id: number; usize: number; csize: number }[] }
  const secs: S21[] = [];
  for (let p = 0; p + 0x40 <= sm.length;) {
    const size = u64(sm, p), maxSize = u64(sm, p + 8), enc = u64(sm, p + 0x10);
    const nameLen = u64(sm, p + 0x20), encoding = u64(sm, p + 0x30), numPages = u64(sm, p + 0x38);
    p += 0x40;
    // SectionNameLength is a byte count that includes the two terminating zero bytes
    let name = '';
    if (nameLen > 4096 || p + nameLen > sm.length) break;
    for (let c = 0; c + 1 < nameLen; c += 2) { const ch = u16(sm, p + c); if (!ch) break; name += String.fromCharCode(ch); }
    p += nameLen;
    const pg: S21['pages'] = [];
    for (let j = 0; j < numPages && p + 56 <= sm.length; j++) {
      pg.push({ off: u64(sm, p), size: u64(sm, p + 8), id: u64(sm, p + 16), usize: u64(sm, p + 24), csize: u64(sm, p + 32) });
      p += 56;
    }
    if (numPages > 100000) break;
    secs.push({ name, size, maxSize, enc, encoding, pages: pg });
  }
  const byName = new Map(secs.map((s) => [s.name, s]));
  const load = (name: string): Uint8Array | null => {
    const s = byName.get(name);
    if (!s) return null;
    if (s.enc === 1) throw new DwgError('encrypted', 'section ' + name + ' is encrypted');
    if (s.size > 1024 * 1024 * 1024) throw new DwgError('too-large', 'section too large');
    const out = new Uint8Array(s.size);
    for (const pg of s.pages) {
      const pp = pages.get(pg.id);
      if (!pp) { warnings.push('missing page in ' + name); continue; }
      try {
        const pos = 0x480 + pp.off;
        let raw: Uint8Array;
        const aligned = (pg.csize + 7) & ~7;
        if (s.encoding === 4) {
          const blocks = Math.ceil(aligned / 251);
          raw = rsData(d, pos, blocks, 251, pg.csize);
        } else {
          // non interleaved: data blocks follow each other, parity at the end
          raw = d.subarray(pos, pos + pg.csize);
        }
        let data: Uint8Array;
        if (pg.csize < pg.usize) data = decompressR21(raw, 0, pg.csize, pg.usize);
        else data = raw.subarray(0, pg.usize);
        const n = Math.min(data.length, s.size - pg.off);
        if (n > 0) out.set(data.subarray(0, n), pg.off);
      } catch (e) {
        warnings.push('page decode failed in ' + name + ': ' + (e as Error).message);
      }
    }
    return out;
  };
  if (byName.has('AcDb:Security')) {
    const ob = byName.get('AcDb:AcDbObjects');
    if (ob && ob.enc === 1) throw new DwgError('encrypted', 'drawing is password protected');
  }
  return {
    ver, verStr, maint: d[0x0b], codepage: u16(d, 0x13),
    header: load('AcDb:Header'), classes: load('AcDb:Classes'), handles: load('AcDb:Handles'),
    objects: load('AcDb:AcDbObjects') || new Uint8Array(0), warnings,
  };
}

export function openContainer(d: Uint8Array): Container {
  if (d.length < 0x100) throw new DwgError('corrupt', 'file too small');
  const vs = versionString(d);
  const ver = VERSIONS[vs];
  if (!ver) throw new DwgError('unsupported-version', 'unsupported DWG version ' + vs);
  if (ver <= 15) return readR15(d, ver, vs);
  if (ver === 21) return readR21(d, ver, vs);
  return readR18(d, ver, vs);
}
