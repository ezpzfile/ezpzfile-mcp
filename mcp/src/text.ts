/**
 * 쪽 SVG 에서 본문을 글자로 되살린다.
 *
 * rhwp 의 getPageText 는 표·머리말 안의 글자를 빠뜨린다(내용이 전부 표 안에
 * 있는 문서는 빈 문자열이 나온다). 반면 렌더된 SVG 에는 화면에 찍히는 글자가
 * 모두 들어 있다. 대신 글자마다 좌표만 있고 줄이라는 개념이 없어서, 여기서
 * 다시 줄로 묶는다.
 */
const TEXT_TAG = /<text\b([^>]*)>([^<]*)<\/text>/g
const ATTR = /([a-zA-Z-]+)="([^"]*)"/g

/** 폭이 글자 크기와 같은 글자(한중일·한글). 나머지는 대략 절반으로 본다. */
const WIDE = /[ᄀ-ᇿ⺀-鿿가-퟿豈-﫿＀-｠]/

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, '&')
}

interface Glyph {
  x: number
  y: number
  size: number
  /** rhwp 가 알려 준 실제 폭. 있으면 그걸 믿는다 */
  length: number | null
  text: string
}

export function pageToText(svg: string): string {
  const glyphs: Glyph[] = []
  for (const match of svg.matchAll(TEXT_TAG)) {
    const text = unescapeXml(match[2] ?? '')
    if (text === '') continue
    const attrs = Object.fromEntries(
      [...(match[1] ?? '').matchAll(ATTR)].map((m) => [m[1]!, m[2]!]),
    )
    glyphs.push({
      x: Number.parseFloat(attrs.x ?? '0') || 0,
      y: Number.parseFloat(attrs.y ?? '0') || 0,
      size: Number.parseFloat(attrs['font-size'] ?? '12') || 12,
      length: attrs.textLength ? Number.parseFloat(attrs.textLength) : null,
      text,
    })
  }
  if (glyphs.length === 0) return ''

  // 같은 기준선에 있는 글자를 한 줄로 본다. 4px 은 같은 줄로 묶일 만한 흔들림.
  const lines = new Map<number, Glyph[]>()
  for (const glyph of glyphs) {
    const key = Math.round(glyph.y / 4) * 4
    const line = lines.get(key)
    if (line) line.push(glyph)
    else lines.set(key, [glyph])
  }

  const rows: string[] = []
  for (const [, line] of [...lines.entries()].sort((a, b) => a[0] - b[0])) {
    line.sort((a, b) => a.x - b.x)
    let row = ''
    let end: number | null = null
    for (const glyph of line) {
      // 앞 글자가 끝난 자리와 이 글자가 시작하는 자리가 벌어져 있으면 띄어쓰기다.
      if (end !== null && glyph.x - end > glyph.size * 0.25) row += ' '
      row += glyph.text
      const width =
        glyph.length ??
        [...glyph.text].reduce((n, c) => n + (WIDE.test(c) ? 1 : 0.5) * glyph.size, 0)
      end = glyph.x + width
    }
    const trimmed = row.trim()
    if (trimmed !== '') rows.push(trimmed)
  }
  return rows.join('\n')
}
