/** 문서·표·압축 파일 처리. 전부 브라우저 안에서 파싱한다. */
import { decodeText, fixArchiveName, loadDetector, type TextEncoding } from './encoding'

export interface ExtractedEntry {
  path: string
  size: number
  bytes: Uint8Array
}

/** ZIP 을 푼다. 디렉터리 항목은 건너뛴다. */
export async function unzip(file: File, localeHint = 'ko'): Promise<ExtractedEntry[]> {
  const [{ unzipSync }] = await Promise.all([import('fflate'), loadDetector()])
  const data = new Uint8Array(await file.arrayBuffer())
  const files = unzipSync(data)
  return Object.entries(files)
    .filter(([path]) => !path.endsWith('/'))
    .map(([path, bytes]) => ({
      // 한국·일본 윈도우의 기본 압축은 파일명을 UTF-8 로 넣지 않는다.
      // 그대로 두면 이름이 깨져 어떤 파일인지 알 수 없다.
      path: fixArchiveName(path, localeHint),
      size: bytes.length,
      bytes,
    }))
}

export async function zip(entries: Array<{ path: string; bytes: Uint8Array }>) {
  const { zipSync } = await import('fflate')
  const map: Record<string, Uint8Array> = {}
  for (const e of entries) map[e.path] = e.bytes
  return new Blob([zipSync(map).slice().buffer as ArrayBuffer], {
    type: 'application/zip',
  })
}

/** DOCX → 일반 텍스트 / 마크다운 / HTML */
export async function docxTo(
  file: File,
  format: 'text' | 'markdown' | 'html',
): Promise<string> {
  const mammoth = await import('mammoth')
  const arrayBuffer = await file.arrayBuffer()
  /*
   * docx 는 zip 이다. 옛 .doc 과 암호 걸린 .docx 는 둘 다 OLE 복합 문서(D0 CF 11 E0)라
   * zip 이 아니다. mammoth 에 넘기면 "파일이 잘렸거나 형식이 다르다"로 끝나 엉뚱하게
   * 들린다. 먼저 알아보고 제대로 말한다.
   */
  const head = new Uint8Array(arrayBuffer, 0, Math.min(4, arrayBuffer.byteLength))
  if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) {
    throw new Error('DOC_LEGACY_OR_LOCKED')
  }
  if (format === 'html') {
    return (await mammoth.convertToHtml({ arrayBuffer })).value
  }
  if (format === 'markdown') {
    // mammoth 의 마크다운 출력은 폐기 예정이고 결과도 거칠어서,
    // HTML 을 받아 필요한 태그만 직접 옮긴다.
    return htmlToMarkdown((await mammoth.convertToHtml({ arrayBuffer })).value)
  }
  return (await mammoth.extractRawText({ arrayBuffer })).value
}

/** mammoth 가 내는 정도의 단순한 HTML 만 다룬다. */
export function htmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')

  const inline = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
    if (!(node instanceof Element)) return ''
    const inner = [...node.childNodes].map(inline).join('')
    switch (node.tagName.toLowerCase()) {
      case 'strong':
      case 'b':
        return inner.trim() ? `**${inner}**` : ''
      case 'em':
      case 'i':
        return inner.trim() ? `*${inner}*` : ''
      case 'code':
        return `\`${inner}\``
      case 'a': {
        const href = node.getAttribute('href')
        return href ? `[${inner}](${href})` : inner
      }
      case 'br':
        return '  \n'
      case 'img':
        return `![${node.getAttribute('alt') ?? ''}](${node.getAttribute('src') ?? ''})`
      default:
        return inner
    }
  }

  const blocks: string[] = []
  const walk = (parent: ParentNode, listPrefix?: (i: number) => string) => {
    let index = 0
    for (const child of [...parent.children]) {
      const tag = child.tagName.toLowerCase()
      if (/^h[1-6]$/.test(tag)) {
        blocks.push(`${'#'.repeat(Number(tag[1]))} ${inline(child).trim()}`)
      } else if (tag === 'p') {
        const text = inline(child).trim()
        if (text) blocks.push(text)
      } else if (tag === 'ul' || tag === 'ol') {
        walk(child, (i) => (tag === 'ol' ? `${i + 1}. ` : '- '))
      } else if (tag === 'li') {
        blocks.push(`${listPrefix ? listPrefix(index) : '- '}${inline(child).trim()}`)
        index++
      } else if (tag === 'blockquote') {
        blocks.push(`> ${inline(child).trim()}`)
      } else if (tag === 'table') {
        // 표를 문단으로 풀면 칸의 관계가 사라진다. 파이프 표로 옮겨야
        // 모델이 행과 열을 그대로 읽는다.
        const rows = [...child.getElementsByTagName('tr')].map((tr) =>
          [...tr.children]
            .filter((c) => /^t[dh]$/i.test(c.tagName))
            .map((c) => inline(c).replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim()),
        )
        if (rows.length > 0) {
          const width = Math.max(...rows.map((r) => r.length))
          const pad = (r: string[]) => [...r, ...Array(width - r.length).fill('')]
          const line = (r: string[]) => `| ${pad(r).join(' | ')} |`
          blocks.push(
            [line(rows[0]!), `| ${Array(width).fill('---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n'),
          )
        }
      } else if (child.children.length > 0) {
        walk(child, listPrefix)
      } else {
        const text = inline(child).trim()
        if (text) blocks.push(text)
      }
    }
  }
  walk(doc.body)
  return blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** 가장 가까운 문단(<*:p>) 조상 */
function nearestParagraph(el: Element): Element | null {
  let n = el.parentElement
  while (n && n.localName !== 'p') n = n.parentElement
  return n
}

/**
 * HWPX 는 OWPML(XML) 을 담은 ZIP 이다. Contents/section*.xml 안의
 * <hp:t> 가 본문 조각이고, <hp:p> 가 문단 경계다.
 */
export async function hwpxToText(file: File): Promise<string> {
  const entries = await unzip(file)
  const sections = entries
    .filter((e) => /^Contents\/section\d+\.xml$/i.test(e.path))
    .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }))

  if (sections.length === 0) throw new Error('NOT_HWPX')

  const decoder = new TextDecoder('utf-8')
  const parser = new DOMParser()
  const out: string[] = []

  for (const section of sections) {
    const doc = parser.parseFromString(decoder.decode(section.bytes), 'text/xml')
    // 네임스페이스 접두사가 문서마다 달라 localName 으로 훑는다.
    const paragraphs = [...doc.getElementsByTagName('*')].filter(
      (el) => el.localName === 'p',
    )
    for (const p of paragraphs) {
      /*
       * 표는 문단 안에 들어 있고, 표의 칸마다 또 문단이 있다. 문단 아래의 <t> 를 전부
       * 모으면 바깥 문단이 표 글자를 한 줄로 이어 붙이고("성명홍길동"), 칸 문단이 그것을
       * 한 번 더 낸다. 이 문단에 곧바로 딸린 <t> 만 모은다.
       */
      const runs = [...p.getElementsByTagName('*')].filter(
        (el) => el.localName === 't' && nearestParagraph(el) === p,
      )
      out.push(runs.map((r) => r.textContent ?? '').join(''))
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

export type TableFormat = 'csv' | 'json' | 'xlsx'

export interface SheetData {
  name: string
  rows: unknown[][]
}

export interface SheetsResult {
  sheets: SheetData[]
  /** CSV·TXT 처럼 글자로 이루어진 파일이었는지 */
  isText: boolean
  /** 그때 어떤 인코딩으로 읽었는지 */
  encoding: TextEncoding | null
  /** 인코딩을 확신할 수 있었는지 (BOM·UTF-8 검증) */
  confident: boolean
}

const TEXT_TABLE = /\.(csv|tsv|txt|psv)$/i

/**
 * 엑셀의 날짜 칸.
 *
 * 엑셀 파일 안에서 날짜는 숫자다(1900-01-01 부터 센 날 수, 2026-01-02 = 46024).
 * 그 숫자에 "날짜로 보여라" 는 서식이 붙어 있을 뿐이다. 서식을 버리고 값만 꺼내면
 * CSV·JSON 에 46024 가 찍힌다. 그래서 날짜 칸은 이 모양으로 들고 다닌다.
 *
 *   text    CSV·JSON·화면에 쓸 글자. 엑셀이 화면에 보여 주는 모양을 따른다.
 *   serial  원래 숫자. 다시 엑셀로 쓸 때는 이것과 format 을 그대로 돌려놓는다 —
 *           Date 로 바꿨다 되돌리면 시간대(특히 1899년 서울의 지방시)에 따라 어긋난다.
 */
export class SheetDate {
  constructor(
    readonly serial: number,
    readonly format: string,
    readonly text: string,
  ) {}
  toString(): string {
    return this.text
  }
  toJSON(): string {
    return this.text
  }
}

/**
 * 엑셀의 "기본 날짜" 서식(번호 14·22). 엑셀은 이것을 컴퓨터 지역 설정대로 보여
 * 준다(한국: 2026-01-02). 라이브러리는 미국식(1/2/26)으로 풀어 버리므로, 이 둘은
 * 어느 나라에서 읽어도 헷갈리지 않는 2026-01-02 꼴로 쓴다. 사용자가 직접 고른
 * 서식(예: 2026년 1월 2일)은 그 모양을 그대로 따른다.
 */
const LOCALE_DATE_FORMATS = new Set(['m/d/yy', 'm/d/yy h:mm', 'm/d/yy;@', 'm/d/yy h:mm;@'])

const pad2 = (n: number) => String(n).padStart(2, '0')

type Xlsx = typeof import('xlsx')
type Worksheet = import('xlsx').WorkSheet

/**
 * SheetJS 를 받는다. Node(MCP 서버)에서 import('xlsx') 를 하면 CommonJS 꾸러미라 이름 붙은
 * 내보내기 일부가 빠진다(SSF 가 없어 markDates 가 멈췄다). 그때는 default 쪽에 다 있다.
 * 브라우저 번들에서는 둘이 같다.
 */
async function loadXlsx(): Promise<Xlsx> {
  const mod = await import('xlsx')
  return ((mod as { SSF?: unknown }).SSF ? mod : ((mod as { default?: Xlsx }).default ?? mod)) as Xlsx
}

/** 날짜 서식이 붙은 숫자 칸을 SheetDate 로 바꿔 둔다. 그 밖의 칸은 건드리지 않는다. */
export function markDates(XLSX: Xlsx, ws: Worksheet): void {
  for (const key of Object.keys(ws)) {
    if (key[0] === '!') continue
    const cell = ws[key] as { t?: string; v?: unknown; z?: unknown; w?: string } | undefined
    if (!cell || cell.t !== 'n' || typeof cell.v !== 'number' || typeof cell.z !== 'string') continue
    const format = cell.z
    if (!XLSX.SSF.is_date(format)) continue
    const serial = cell.v
    const p = XLSX.SSF.parse_date_code(serial)
    if (!p) continue

    let text: string
    if (LOCALE_DATE_FORMATS.has(format) || !cell.w) {
      const date = `${p.y}-${pad2(p.m)}-${pad2(p.d)}`
      const withTime = /h/i.test(format.replace(/"[^"]*"/g, ''))
      const time = `${pad2(p.H)}:${pad2(p.M)}${p.S ? `:${pad2(p.S)}` : ''}`
      text = serial < 1 ? time : withTime ? `${date} ${time}` : date
    } else {
      text = cell.w
    }
    const marked = new SheetDate(serial, format, text)
    cell.t = 's'
    cell.v = marked
    cell.w = text
  }
}

export async function readSheets(
  file: File,
  opts: { encoding?: TextEncoding | 'auto'; localeHint?: string } = {},
): Promise<SheetsResult> {
  const XLSX = await loadXlsx()
  const buffer = await file.arrayBuffer()

  // XLSX·ODS 는 내부가 UTF-8 이라 문제가 없다.
  // 반면 CSV 는 인코딩 정보가 파일 안에 없어서 직접 알아내야 한다.
  const isText = TEXT_TABLE.test(file.name) || file.type.startsWith('text/')

  let wb
  let encoding: TextEncoding | null = null
  let confident = true

  if (isText) {
    // 통계 감지기는 텍스트 파일일 때만 필요하다.
    await loadDetector()
    const detected = decodeText(
      new Uint8Array(buffer),
      opts.encoding,
      opts.localeHint ?? 'ko',
    )
    encoding = detected.encoding
    confident = detected.confident
    wb = XLSX.read(detected.text, { type: 'string', raw: false })
  } else {
    // cellNF: 칸마다 서식 문자열을 남긴다. 날짜인지는 서식을 봐야 안다.
    wb = XLSX.read(buffer, { type: 'array', cellNF: true })
    for (const name of wb.SheetNames) markDates(XLSX, wb.Sheets[name]!)
  }

  return {
    sheets: wb.SheetNames.map((name) => ({
      name,
      rows: XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], {
        header: 1,
        blankrows: false,
        defval: '',
      }),
    })),
    isText,
    encoding,
    confident,
  }
}

export async function sheetToBlob(
  sheet: SheetData,
  format: TableFormat,
): Promise<Blob> {
  const XLSX = await loadXlsx()
  // 날짜 칸은 글자로 쓸 때 화면에 보이는 모양으로(46024 가 아니라 2026-01-02).
  const asText = (v: unknown) => (v instanceof SheetDate ? v.text : v)

  if (format === 'json') {
    const [header, ...body] = sheet.rows
    const keys = (header ?? []).map((h, i) => String(asText(h) || `col${i + 1}`))
    const objects = body.map((row) =>
      Object.fromEntries(keys.map((k, i) => [k, asText(row[i]) ?? null])),
    )
    return new Blob([JSON.stringify(objects, null, 2)], {
      type: 'application/json',
    })
  }

  if (format === 'csv') {
    const ws = XLSX.utils.aoa_to_sheet(sheet.rows.map((row) => row.map(asText)))
    // 엑셀이 UTF-8 CSV 를 깨뜨리지 않도록 BOM 을 붙인다.
    return new Blob(['\ufeff' + XLSX.utils.sheet_to_csv(ws)], {
      type: 'text/csv;charset=utf-8',
    })
  }

  // 엑셀로 다시 쓸 때는 날짜를 원래 숫자와 서식 그대로 돌려놓는다. 여전히 날짜로 열린다.
  const ws = XLSX.utils.aoa_to_sheet(
    sheet.rows.map((row) => row.map((v) => (v instanceof SheetDate ? v.serial : v))),
  )
  sheet.rows.forEach((row, r) =>
    row.forEach((v, c) => {
      if (!(v instanceof SheetDate)) return
      const cell = ws[XLSX.utils.encode_cell({ r, c })]
      if (cell) cell.z = v.format
    }),
  )

  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, sheet.name.slice(0, 31) || 'Sheet1')
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer
  return new Blob([out], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })
}

export function textBlob(text: string, mime = 'text/plain;charset=utf-8') {
  return new Blob([text], { type: mime })
}
