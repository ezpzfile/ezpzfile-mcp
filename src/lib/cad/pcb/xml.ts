// Minimal non-validating XML parser (own code): elements, attributes, text, CDATA, comments and entity references.
// Enough for OPC relationships, XPS FixedDocument / FixedPage markup and DWF descriptors. No DOM needed (Web Worker).

export interface XEl { name: string; local: string; attrs: Record<string, string>; children: XEl[]; text: string }

const ENT: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
export function unescapeXml(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    return ENT[e] ?? m;
  });
}

export function parseXml(src: string): XEl {
  const root: XEl = { name: '#root', local: '#root', attrs: {}, children: [], text: '' };
  const stack: XEl[] = [root];
  let i = 0;
  const n = src.length;
  const attrRe = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { stack[stack.length - 1].text += unescapeXml(src.slice(i)); break; }
    if (lt > i) {
      const t = src.slice(i, lt);
      if (t.trim()) stack[stack.length - 1].text += unescapeXml(t);
    }
    if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt + 4); i = e < 0 ? n : e + 3; continue; }
    if (src.startsWith('<![CDATA[', lt)) { const e = src.indexOf(']]>', lt + 9); stack[stack.length - 1].text += src.slice(lt + 9, e < 0 ? n : e); i = e < 0 ? n : e + 3; continue; }
    if (src[lt + 1] === '?') { const e = src.indexOf('?>', lt + 2); i = e < 0 ? n : e + 2; continue; }
    if (src[lt + 1] === '!') { const e = src.indexOf('>', lt + 2); i = e < 0 ? n : e + 1; continue; }
    // find tag end respecting quotes
    let j = lt + 1;
    let q = 0;
    while (j < n) {
      const c = src.charCodeAt(j);
      if (q) { if (c === q) q = 0; }
      else if (c === 34 || c === 39) q = c;
      else if (c === 62) break;
      j++;
    }
    const tag = src.slice(lt + 1, j);
    i = j + 1;
    if (tag[0] === '/') {
      const name = tag.slice(1).trim();
      // pop to the matching element (tolerant)
      for (let k = stack.length - 1; k > 0; k--) if (stack[k].name === name) { stack.length = k; break; }
      continue;
    }
    const selfClose = tag.endsWith('/');
    const body = selfClose ? tag.slice(0, -1) : tag;
    const sp = body.search(/[\s]/);
    const name = sp < 0 ? body : body.slice(0, sp);
    const el: XEl = { name, local: name.includes(':') ? name.slice(name.indexOf(':') + 1) : name, attrs: {}, children: [], text: '' };
    if (sp >= 0) {
      attrRe.lastIndex = 0;
      const a = body.slice(sp);
      let m: RegExpExecArray | null;
      while ((m = attrRe.exec(a))) el.attrs[m[1]] = unescapeXml(m[3] ?? m[4] ?? '');
    }
    stack[stack.length - 1].children.push(el);
    if (!selfClose) stack.push(el);
  }
  return root;
}

export function firstEl(e: XEl, local: string): XEl | undefined {
  for (const c of e.children) if (c.local === local) return c;
  for (const c of e.children) { const r = firstEl(c, local); if (r) return r; }
  return undefined;
}
export function allEls(e: XEl, local: string, out: XEl[] = []): XEl[] {
  for (const c of e.children) { if (c.local === local) out.push(c); allEls(c, local, out); }
  return out;
}
