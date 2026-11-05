// zlib (RFC 1950) / raw deflate (RFC 1951) decoder, synchronous. Written from the public RFCs.
// Used for the per-solid streams inside iCAD files: the exact compressed length is not stored, so a
// synchronous decoder that stops at the end of the deflate stream is simpler than DecompressionStream.

export class InflateError extends Error { constructor(m: string) { super(m); this.name = 'InflateError'; } }

const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLORD = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

interface Huff { count: Uint16Array; sym: Uint16Array }
function build(lens: ArrayLike<number>, n: number): Huff {
  const count = new Uint16Array(16), offs = new Uint16Array(16), sym = new Uint16Array(n);
  for (let i = 0; i < n; i++) count[lens[i]]++;
  count[0] = 0;
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + count[i - 1];
  for (let i = 0; i < n; i++) if (lens[i]) sym[offs[lens[i]]++] = i;
  return { count, sym };
}

/** inflate; returns the output and the number of input bytes consumed (from `start`) */
export function inflate(src: Uint8Array, start = 0, zlib = true, maxOut = 256 * 1024 * 1024): { out: Uint8Array; used: number } {
  let pos = start, bit = 0, bits = 0;
  if (zlib) {
    if (src.length < start + 2) throw new InflateError('truncated zlib header');
    const cmf = src[pos], flg = src[pos + 1];
    if ((cmf & 15) !== 8 || ((cmf << 8) | flg) % 31 !== 0) throw new InflateError('bad zlib header');
    if (flg & 32) throw new InflateError('preset dictionary not supported');
    pos += 2;
  }
  let out = new Uint8Array(Math.max(1024, (src.length - start) * 4));
  let n = 0;
  const ensure = (k: number) => {
    if (n + k <= out.length) return;
    if (n + k > maxOut) throw new InflateError('inflated data too large');
    let c = out.length * 2; while (c < n + k) c *= 2;
    const t = new Uint8Array(Math.min(c, maxOut)); t.set(out.subarray(0, n)); out = t;
  };
  const need = (k: number): number => {
    while (bits < k) {
      if (pos >= src.length) throw new InflateError('truncated deflate stream');
      bit |= src[pos++] << bits; bits += 8;
    }
    const v = bit & ((1 << k) - 1);
    bit >>>= k; bits -= k;
    return v;
  };
  const decode = (h: Huff): number => {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 16; len++) {
      code |= need(1);
      const c = h.count[len];
      if (code - c < first) return h.sym[index + (code - first)];
      index += c; first += c; first <<= 1; code <<= 1;
    }
    throw new InflateError('bad huffman code');
  };
  let fixedL: Huff | null = null, fixedD: Huff | null = null;
  for (;;) {
    const last = need(1);
    const type = need(2);
    if (type === 0) {
      bit = 0; bits = 0;
      if (pos + 4 > src.length) throw new InflateError('truncated stored block');
      const len = src[pos] | (src[pos + 1] << 8), nlen = src[pos + 2] | (src[pos + 3] << 8);
      if ((len ^ 0xffff) !== nlen) throw new InflateError('bad stored block length');
      pos += 4;
      if (pos + len > src.length) throw new InflateError('truncated stored block');
      ensure(len); out.set(src.subarray(pos, pos + len), n); n += len; pos += len;
    } else if (type === 1 || type === 2) {
      let L: Huff, D: Huff;
      if (type === 1) {
        if (!fixedL) {
          const l = new Uint8Array(288);
          for (let i = 0; i < 144; i++) l[i] = 8; for (let i = 144; i < 256; i++) l[i] = 9;
          for (let i = 256; i < 280; i++) l[i] = 7; for (let i = 280; i < 288; i++) l[i] = 8;
          fixedL = build(l, 288);
          const d = new Uint8Array(30).fill(5); fixedD = build(d, 30);
        }
        L = fixedL; D = fixedD!;
      } else {
        const hlit = need(5) + 257, hdist = need(5) + 1, hclen = need(4) + 4;
        const cl = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) cl[CLORD[i]] = need(3);
        const ch = build(cl, 19);
        const lens = new Uint8Array(hlit + hdist);
        for (let i = 0; i < hlit + hdist;) {
          const s = decode(ch);
          if (s < 16) lens[i++] = s;
          else {
            let rep = 0, val = 0;
            if (s === 16) { if (!i) throw new InflateError('bad code lengths'); val = lens[i - 1]; rep = 3 + need(2); }
            else if (s === 17) rep = 3 + need(3);
            else rep = 11 + need(7);
            if (i + rep > hlit + hdist) throw new InflateError('bad code lengths');
            while (rep--) lens[i++] = val;
          }
        }
        L = build(lens.subarray(0, hlit), hlit);
        D = build(lens.subarray(hlit), hdist);
      }
      for (;;) {
        const s = decode(L);
        if (s < 256) { ensure(1); out[n++] = s; }
        else if (s === 256) break;
        else {
          const li = s - 257;
          if (li >= 29) throw new InflateError('bad length symbol');
          const len = LBASE[li] + need(LEXT[li]);
          const di = decode(D);
          if (di >= 30) throw new InflateError('bad distance symbol');
          const dist = DBASE[di] + need(DEXT[di]);
          if (dist > n) throw new InflateError('distance too far back');
          ensure(len);
          for (let k = 0; k < len; k++) { out[n] = out[n - dist]; n++; }
        }
      }
    } else throw new InflateError('bad block type');
    if (last) break;
  }
  if (zlib) pos = Math.min(src.length, pos + 4); // adler32 (not checked)
  return { out: out.slice(0, n), used: pos - start };
}
