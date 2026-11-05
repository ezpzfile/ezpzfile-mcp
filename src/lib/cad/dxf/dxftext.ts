// DXF text helpers: control codes in TEXT (%%c, %%d, ...), Unicode escapes (\U+XXXX, \M+nXXXX) and
// MTEXT inline formatting codes (\P, \S, \f...; {...}). Own implementation from the DXF / AutoCAD documentation.

const MBCS: Record<string, string> = { '1': 'shift_jis', '2': 'big5', '3': 'euc-kr', '4': 'euc-kr', '5': 'gbk' };
const decoders = new Map<string, TextDecoder | null>();
function dec(label: string): TextDecoder | null {
  if (!decoders.has(label)) { try { decoders.set(label, new TextDecoder(label)); } catch { decoders.set(label, null); } }
  return decoders.get(label)!;
}

export function unicodeEscapes(s: string): string {
  if (s.indexOf('\\') < 0) return s;
  s = s.replace(/\\U\+([0-9A-Fa-f]{4})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));
  s = s.replace(/\\M\+([1-5])([0-9A-Fa-f]{4})/g, (m, k, h) => {
    const d = dec(MBCS[k]);
    if (!d) return m;
    const v = parseInt(h, 16);
    return d.decode(new Uint8Array([v >> 8, v & 255]));
  });
  return s;
}

/** TEXT / ATTRIB value: %% control codes */
export function plainText(raw: string): string {
  let s = unicodeEscapes(raw);
  if (s.indexOf('%%') < 0) return s;
  s = s.replace(/%%(\d{3})/g, (_m, d) => String.fromCharCode(parseInt(d, 10)));
  s = s.replace(/%%([cCdDpPuUoOkK%])/g, (_m, c: string) => {
    switch (c.toLowerCase()) {
      case 'c': return '⌀';
      case 'd': return '°';
      case 'p': return '±';
      case '%': return '%';
      default: return '';
    }
  });
  return s;
}

/** MTEXT contents to plain lines */
export function mtextLines(raw: string): string[] {
  const s = unicodeEscapes(raw);
  const lines: string[] = [];
  let cur = '';
  const n = s.length;
  const readTo = (i: number, ch: string) => { const j = s.indexOf(ch, i); return j < 0 ? n : j; };
  for (let i = 0; i < n; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < n) {
      const k = s[i + 1];
      switch (k) {
        case 'P': case 'N': case 'X': lines.push(cur); cur = ''; i++; break;
        case '~': cur += ' '; i++; break;
        case '\\': case '{': case '}': cur += k; i++; break;
        case 'L': case 'l': case 'O': case 'o': case 'K': case 'k': i++; break;
        case 'S': {
          const j = readTo(i + 2, ';');
          const body = s.slice(i + 2, j).replace(/\\(.)/g, '$1');
          const m = body.match(/^(.*?)([\^/#])(.*)$/);
          cur += m ? (m[1].trim() && m[3].trim() ? `${m[1].trim()}/${m[3].trim()}` : (m[1] + m[3]).trim()) : body;
          i = j;
          break;
        }
        case 'f': case 'F': case 'H': case 'W': case 'Q': case 'T': case 'A': case 'C': case 'c': case 'p':
          i = readTo(i + 2, ';');
          break;
        default:
          cur += k; i++;
      }
      continue;
    }
    if (c === '{' || c === '}') continue;
    if (c === '\n') { lines.push(cur); cur = ''; continue; }
    if (c === '\r') continue;
    if (c === '\t') { cur += '    '; continue; }
    cur += c;
  }
  lines.push(cur);
  // %% codes also work inside MTEXT for compatibility
  return lines.map((l) => (l.indexOf('%%') >= 0 ? plainText(l) : l));
}

/** first explicit \H height factor or absolute height at the start of the mtext, if any */
export function mtextHeightOverride(raw: string, h: number): number {
  const m = raw.match(/^\{?\\H([0-9.]+)(x?);/);
  if (!m) return h;
  const v = parseFloat(m[1]);
  if (!(v > 0)) return h;
  return m[2] ? h * v : v;
}

function isWide(code: number): boolean {
  return (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6);
}

/** rough text advance in units of the text height (cap height) */
export function textWidth(s: string, h: number): number {
  let w = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    w += isWide(c) ? 1.4 : c === 32 ? 0.42 : (c >= 65 && c <= 90) ? 0.9 : 0.75;
  }
  return w * h;
}

/** greedy word wrap to a reference width (approximate, font metrics unknown) */
export function wrapLine(s: string, h: number, width: number): string[] {
  if (!(width > 0) || textWidth(s, h) <= width * 1.02) return [s];
  const out: string[] = [];
  let line = '';
  // tokens: words with trailing space, or single wide characters
  const toks = s.match(/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿＀-｠]|[^\sᄀ-ᅟ⺀-꓏가-힣豈-﫿＀-｠]+\s*|\s+/g) ?? [s];
  for (const tk of toks) {
    const cand = line + tk;
    if (line && textWidth(cand.trimEnd(), h) > width * 1.02) { out.push(line.trimEnd()); line = tk.trimStart(); }
    else line = cand;
  }
  if (line) out.push(line.trimEnd());
  return out;
}
