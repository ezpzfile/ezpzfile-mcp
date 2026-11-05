// SXF feature comment reader (own code).
// Written from the OCF "SXF Ver.3.1 レベル2 対応 共通ライブラリ機能仕様書 SFC編" (header rules, section 8-3)
// and from looking at sample files: an SFC file is an ISO 10303-21 file whose DATA section holds comments
//   /*SXF
//   #10 = pre_defined_colour_feature(\'red\')
//   SXF*/
// Every parameter is quoted: numbers and arrays as '...' and strings as \'...\'.
// The same comments also appear in P21 files written in "ambi_mode" (feature comments next to AP202 entities).
//
// Text is Shift_JIS (cp932) in all known files; a file that is valid UTF-8 is read as UTF-8.
// The lexer works on bytes and skips the trail byte of a Shift_JIS double byte character, so a trail byte
// 0x5C ('\') or 0x27 (') never ends a string by mistake.

export interface SfcArg { q: 'n' | 's'; v: string }
export interface SfcRecord { id: number; name: string; args: SfcArg[]; pos: number }

export interface SfcScan { records: SfcRecord[]; bad: number; badAt: number[]; encoding: 'shift_jis' | 'utf-8' }

const SJIS_LEAD = (c: number) => (c >= 0x81 && c <= 0x9f) || (c >= 0xe0 && c <= 0xfc);

let sjisDec: TextDecoder | null = null;
function sjis(): TextDecoder {
  if (!sjisDec) {
    try { sjisDec = new TextDecoder('shift_jis'); } catch { sjisDec = new TextDecoder('latin1'); }
  }
  return sjisDec;
}
const utf8Fatal = new TextDecoder('utf-8', { fatal: true });
const utf8 = new TextDecoder('utf-8');
const latin1 = new TextDecoder('latin1');

/** true when the bytes are valid UTF-8 and contain at least one multi byte character */
export function looksUtf8(b: Uint8Array): boolean {
  let hi = false;
  for (let i = 0; i < b.length; i++) if (b[i] >= 0x80) { hi = true; break; }
  if (!hi) return false;
  try { utf8Fatal.decode(b); return true; } catch { return false; }
}

export function makeDecoder(enc: 'shift_jis' | 'utf-8'): (b: Uint8Array, s: number, e: number) => string {
  return (b, s, e) => {
    let ascii = true;
    for (let i = s; i < e; i++) if (b[i] >= 0x80) { ascii = false; break; }
    const sub = b.subarray(s, e);
    if (ascii) return latin1.decode(sub);
    return enc === 'utf-8' ? utf8.decode(sub) : sjis().decode(sub);
  };
}

function isWs(c: number) { return c === 32 || c === 10 || c === 13 || c === 9 || c === 12; }

/** Find all SXF feature comment records. `start` is where the DATA section starts (0 = whole file). */
export function scanSfc(b: Uint8Array, start = 0, maxRecords = 5e6): SfcScan {
  const enc: 'shift_jis' | 'utf-8' = looksUtf8(b) ? 'utf-8' : 'shift_jis';
  const mb = enc === 'shift_jis';
  const dec = makeDecoder(enc);
  const n = b.length;
  const records: SfcRecord[] = [];
  let bad = 0;
  const badAt: number[] = [];
  let i = start;
  while (i < n - 1) {
    const c = b[i];
    if (mb && SJIS_LEAD(c)) { i += 2; continue; }
    if (c === 39 /* ' */) {
      // P21 string literal outside comments (ambi_mode files): skip it
      i++;
      while (i < n) {
        const d = b[i];
        if (mb && SJIS_LEAD(d)) { i += 2; continue; }
        if (d === 39) { if (b[i + 1] === 39) { i += 2; continue; } i++; break; }
        i++;
      }
      continue;
    }
    if (c !== 47 /* / */ || b[i + 1] !== 42 /* * */) { i++; continue; }
    // comment start
    const cs = i;
    let j = i + 2;
    while (j < n && isWs(b[j])) j++;
    if (b[j] === 83 && b[j + 1] === 88 && b[j + 2] === 70 /* SXF */ && !(b[j + 3] === 42 && b[j + 4] === 47)) {
      // "/*SXF" or "/*SXF3" (Ver.3 features such as drawing_attribute_feature)
      let q = j + 3;
      while (q < n && b[q] >= 48 && b[q] <= 57) q++;
      const r = parseRecord(b, q, n, mb, dec);
      if (r) {
        r.rec.pos = cs;
        records.push(r.rec);
        i = r.end;
        if (records.length >= maxRecords) break;
        continue;
      }
      bad++;
      if (badAt.length < 8) badAt.push(cs);
    }
    // ordinary comment or a damaged record: skip to the end of the comment ("*/" can not hold a trail byte)
    let k = i + 2;
    while (k < n - 1 && !(b[k] === 42 && b[k + 1] === 47)) k++;
    i = k + 2;
  }
  return { records, bad, badAt, encoding: enc };
}

function parseRecord(b: Uint8Array, i: number, n: number, mb: boolean, dec: (b: Uint8Array, s: number, e: number) => string): { rec: SfcRecord; end: number } | null {
  while (i < n && isWs(b[i])) i++;
  if (b[i] !== 35 /* # */) return null;
  i++;
  let id = 0, nd = 0;
  while (i < n && b[i] >= 48 && b[i] <= 57) { id = id * 10 + (b[i] - 48); i++; nd++; }
  if (!nd) return null;
  while (i < n && isWs(b[i])) i++;
  if (b[i] !== 61 /* = */) return null;
  i++;
  while (i < n && isWs(b[i])) i++;
  const ns = i;
  while (i < n && ((b[i] >= 97 && b[i] <= 122) || (b[i] >= 65 && b[i] <= 90) || (b[i] >= 48 && b[i] <= 57) || b[i] === 95)) i++;
  if (i === ns) return null;
  const name = latin1.decode(b.subarray(ns, i)).toLowerCase();
  while (i < n && isWs(b[i])) i++;
  if (b[i] !== 40 /* ( */) return null;
  i++;
  const args: SfcArg[] = [];
  for (;;) {
    while (i < n && isWs(b[i])) i++;
    if (i >= n) return null;
    const c = b[i];
    if (c === 41 /* ) */) { i++; break; }
    if (c === 92 && b[i + 1] === 39) {
      // \'string\' : ends at \' followed by , or )
      let k = i + 2;
      const s = k;
      let e = -1;
      while (k < n) {
        const d = b[k];
        if (mb && SJIS_LEAD(d)) { k += 2; continue; }
        if (d === 92 && b[k + 1] === 39) {
          let m = k + 2;
          while (m < n && isWs(b[m])) m++;
          if (b[m] === 44 || b[m] === 41) { e = k; k += 2; break; }
          k += 2;
          continue;
        }
        if (d === 42 && b[k + 1] === 47 && k > s && b[k - 1] === 70) break; // "SXF*/" reached: unterminated
        k++;
      }
      if (e < 0) return null;
      let v = dec(b, s, e);
      if (v.includes("\\'")) v = v.replace(/\\'/g, "'");
      args.push({ q: 's', v });
      i = k;
    } else if (c === 39) {
      let k = i + 1;
      const s = k;
      while (k < n && b[k] !== 39) { if (mb && SJIS_LEAD(b[k])) k += 2; else k++; }
      if (k >= n) return null;
      args.push({ q: 'n', v: dec(b, s, k) });
      i = k + 1;
    } else {
      // bare token (not used by known writers, accepted anyway)
      let k = i;
      while (k < n && b[k] !== 44 && b[k] !== 41) { if (mb && SJIS_LEAD(b[k])) k += 2; else k++; }
      args.push({ q: 'n', v: dec(b, i, k).trim() });
      i = k;
    }
    while (i < n && isWs(b[i])) i++;
    if (b[i] === 44) { i++; continue; }
    if (b[i] === 41) { i++; break; }
    return null;
  }
  while (i < n && isWs(b[i])) i++;
  // expect SXF*/ (or SXF3*/)
  if (b[i] === 83 && b[i + 1] === 88 && b[i + 2] === 70) {
    let k = i + 3;
    while (k < n && b[k] >= 48 && b[k] <= 57) k++;
    while (k < n && isWs(b[k])) k++;
    if (b[k] === 42 && b[k + 1] === 47) return { rec: { id, name, args, pos: 0 }, end: k + 2 };
  }
  if (b[i] === 42 && b[i + 1] === 47) return { rec: { id, name, args, pos: 0 }, end: i + 2 };
  return null;
}

/** number value of an argument; NaN when not a number */
export function argNum(a: SfcArg | undefined): number {
  if (!a) return NaN;
  const s = a.v.trim();
  if (!s) return NaN;
  return Number(s);
}
export function argInt(a: SfcArg | undefined, d = 0): number {
  const v = argNum(a);
  return Number.isFinite(v) ? Math.round(v) : d;
}
export function argStr(a: SfcArg | undefined): string {
  return a ? a.v : '';
}
/** '(1,2,3)' -> [1,2,3]; '()' -> [] */
export function argArr(a: SfcArg | undefined): number[] {
  if (!a) return [];
  let s = a.v.trim();
  if (s.startsWith('(')) s = s.slice(1);
  if (s.endsWith(')')) s = s.slice(0, -1);
  s = s.replace(/[()]/g, ',');
  const out: number[] = [];
  for (const p of s.split(',')) { const t = p.trim(); if (t) out.push(Number(t)); }
  return out;
}
