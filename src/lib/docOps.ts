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
      const runs = [...p.getElementsByTagName('*')].filter(
        (el) => el.localName === 't',
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

export async function readSheets(
  file: File,
  opts: { encoding?: TextEncoding | 'auto'; localeHint?: string } = {},
): Promise<SheetsResult> {
  const XLSX = await import('xlsx')
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
    wb = XLSX.read(buffer, { type: 'array' })
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
  const XLSX = await import('xlsx')
  if (format === 'json') {
    const [header, ...body] = sheet.rows
    const keys = (header ?? []).map((h, i) => String(h || `col${i + 1}`))
    const objects = body.map((row) =>
      Object.fromEntries(keys.map((k, i) => [k, row[i] ?? null])),
    )
    return new Blob([JSON.stringify(objects, null, 2)], {
      type: 'application/json',
    })
  }

  const ws = XLSX.utils.aoa_to_sheet(sheet.rows as unknown[][])
  if (format === 'csv') {
    // 엑셀이 UTF-8 CSV 를 깨뜨리지 않도록 BOM 을 붙인다.
    return new Blob(['﻿' + XLSX.utils.sheet_to_csv(ws)], {
      type: 'text/csv;charset=utf-8',
    })
  }

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
