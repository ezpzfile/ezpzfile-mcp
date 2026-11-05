/**
 * PDF 편집기의 속. 화면(PdfEditWorkspace)이 쓰는 문서 모형과 내보내기다.
 *
 * 원본을 고치지 않는다. 원본 쪽은 그림으로 깔아 두고, 사용자가 만든 것만
 * "얹는 물건"으로 따로 들고 있다가 저장할 때 원본 위에 그린다. 그래서
 * 되돌리기가 공짜이고(물건 목록만 되돌리면 된다), 저장 전에는 원본 바이트가
 * 한 글자도 바뀌지 않는다.
 *
 * 좌표는 PDF 포인트로 재되 원점을 왼쪽 **위**로 둔다. PDF 자체는 왼쪽 아래가
 * 원점이지만, 화면과 마우스는 위에서 아래로 세므로 편집 중에 매번 뒤집으면
 * 실수가 난다. 뒤집기는 내보낼 때 한 곳에서만 한다.
 */
import { lackingIn, nextFacesFor, scriptFaceOf } from './spareFaces'
import { customFamily, ezpzFonts, isCustomFace } from './ezpzFonts'
import { PDFJS_ASSETS, getPdfjs } from './pdfOps'
import { loadFont } from './rhwp'
import type { RatioReport } from './fetchProgress'
import type { RewriteProblem, RunEdit } from './pdfTextRewrite'
import type { PDFDocument, PDFFont, PDFPage } from 'pdf-lib'

/* ── 문서 ──────────────────────────────────────────────────────── */

export interface PageInfo {
  /** 원본에서의 쪽 번호(0부터) */
  index: number
  /** 회전을 적용한 뒤의 크기(pt) */
  width: number
  height: number
  /** 원본에 이미 들어 있던 회전 */
  rotation: number
}

/**
 * 원본에 이미 들어 있는 글자 한 덩이.
 *
 * 좌표는 편집기의 규칙대로 왼쪽 위가 원점인 pt 다. baseline 은 글자가 앉는
 * 선이고, y 는 그 위 ascent 만큼 올라간 자리다. 덮어 그릴 때 이 둘이 다
 * 필요하다.
 */
export interface TextRun {
  page: number
  x: number
  y: number
  w: number
  h: number
  /** 글자가 앉는 선(위 원점) */
  baseline: number
  text: string
  size: number
  /**
   * 가로 배율.
   *
   * 글자 행렬의 가로와 세로가 같지 않은 문서가 있다. 장평을 좁혀 한 줄에 더
   * 넣은 것이다(`Tz` 를 쓰거나 `Tm` 의 가로를 줄인다). 이 값을 안 들고 있으면
   * 화면에 얹는 글자만 장평이 풀려 원본보다 넓어 보인다.
   */
  hscale: number
  /** 원본이 쓰던 글꼴 이름. 'Helvetica-Bold' 처럼 나온다. 없으면 빈 문자열. */
  baseFont: string
  /**
   * 화면에서 이 글자를 그릴 때 쓸 CSS 글꼴 이름.
   *
   * pdf.js 는 쪽을 그리면서 문서에 심긴 글꼴을 `@font-face` 로 등록한다.
   * 그 이름을 그대로 쓰면 고치는 중에도 원문과 **같은 글꼴**로 보인다.
   * 이게 없으면 세리프 문서를 고치는데 상자 안만 산세리프로 떠서, 글자를
   * 고치는 게 아니라 뭔가 붙이는 것처럼 보인다.
   */
  cssFont: string
}

/** 쪽을 그린 결과. 어느 고침이 쪽 안에 들어갔는지 알려 준다. */
export interface RenderReport {
  /** 쪽 안에 직접 반영된 고침. 이것들은 위에 따로 그릴 필요가 없다. */
  applied: Set<string>
  /** 그중 원본 글꼴로는 못 적어 다른 글꼴을 심은 것. */
  substituted: Set<string>
  /**
   * 그 고침에서 원본 글꼴에 없던 글자와 원본 글꼴 이름.
   *
   * 무엇이 없어서 글꼴이 달라졌는지 짚어 줘야 사용자가 고를 수 있다.
   */
  gaps: Map<string, { missing: string; baseFont: string }>
  /** 제자리에서 못 고친 것과 그 까닭. 실마리 글자가 붙기도 한다. */
  problems: Map<string, { why: RewriteProblem; hint?: string }>
}

/**
 * 파일 하나를 읽는 사람. 쪽을 그리고, 글자를 읽어 준다.
 *
 * 편집기는 이것을 여럿 들고 있을 수 있다. 처음 연 문서가 하나, 사용자가
 * 쪽을 가져다 붙인 문서가 그때마다 하나씩이다.
 */
interface Reader {
  pages: PageInfo[]
  render(
    index: number,
    scale: number,
    canvas: HTMLCanvasElement,
    edits?: RunEdit[],
  ): Promise<RenderReport>
  textRuns(index: number): Promise<TextRun[]>
  glyphCodes(index: number): Promise<Map<string, Map<number, number>>>
  destroy(): Promise<void>
}

export interface EditDoc {
  /** 처음 연 문서의 쪽들 */
  pages: PageInfo[]
  /**
   * 쪽 하나를 캔버스에 그린다. 확대할 때마다 다시 부른다.
   *
   * edits 를 주면 그 고침을 **원본 안에 반영한 쪽**을 그린다. 화면에 원본
   * 글자가 남아 있으면 안 되기 때문이다. 제자리에서 못 고친 것은 돌려주는
   * 목록에 안 들어가고, 부르는 쪽이 덮어쓰기로 처리한다.
   *
   * `from` 은 어느 문서의 쪽인지다. 비어 있으면 처음 연 문서다.
   */
  render(
    index: number,
    scale: number,
    canvas: HTMLCanvasElement,
    edits?: RunEdit[],
    from?: string,
  ): Promise<RenderReport>
  /** 그 쪽에 이미 있는 글자들. 한 번 읽고 들고 있는다. */
  textRuns(index: number, from?: string): Promise<TextRun[]>
  /**
   * 그 쪽이 실제로 쓴 코드표. 글꼴 이름 → (스트림 안의 코드 → 유니코드).
   *
   * ToUnicode 를 손으로 읽는 것보다 이쪽이 언제나 맞다. pdfjs 가 화면에 그릴
   * 때 쓴 표 그대로라, 사용자가 보는 글자와 우리가 고치는 글자가 어긋나지
   * 않는다.
   */
  glyphCodes(index: number, from?: string): Promise<Map<string, Map<number, number>>>
  /**
   * 다른 파일을 열어 쪽을 가져다 쓸 수 있게 한다.
   *
   * 붙여 온 문서도 그냥 연다. 그림으로 찍어 붙이면 글자가 죽고 파일이 불어난다.
   * 열어 두면 화면에서는 그 문서가 제 쪽을 그리고, 저장할 때는 쪽을 통째로
   * 복사해 오므로 글꼴도 서식도 원본 그대로 남는다.
   */
  attach(file: File): Promise<{ id: string; pages: PageInfo[] }>
  /** 그 문서의 쪽들. 비어 있으면 처음 연 문서다. */
  pagesOf(from?: string): PageInfo[]
  /** 붙여 온 문서들. 저장할 때 여기서 쪽을 복사한다. */
  attached(): Array<{ id: string; file: File }>
  destroy(): Promise<void>
}

/**
 * 편집용으로 문서를 연다.
 *
 * pdfOps 의 renderPdfPages 를 쓰지 않는 이유는 그쪽이 쪽을 다 굽고 문서를
 * 닫아 버리기 때문이다. 편집기는 확대·스크롤마다 다시 그려야 해서 문서를
 * 열어 둔 채로 들고 있어야 한다.
 */
export async function openForEdit(file: File): Promise<EditDoc> {
  const base = await readFile(file)
  /** 사용자가 쪽을 가져다 붙인 문서들. 이름표 → 파일과 읽는 사람. */
  const extra = new Map<string, { file: File; reader: Reader }>()
  const pick = (from?: string) => (from && extra.get(from)?.reader) || base

  return {
    get pages() {
      return base.pages
    },
    render: (index, scale, canvas, edits, from) => pick(from).render(index, scale, canvas, edits),
    textRuns: (index, from) => pick(from).textRuns(index),
    glyphCodes: (index, from) => pick(from).glyphCodes(index),
    async attach(one) {
      const reader = await readFile(one)
      const id = newId()
      extra.set(id, { file: one, reader })
      return { id, pages: reader.pages }
    },
    pagesOf: (from) => pick(from).pages,
    attached: () => [...extra].map(([id, one]) => ({ id, file: one.file })),
    async destroy() {
      await base.destroy()
      for (const one of extra.values()) await one.reader.destroy()
      extra.clear()
    },
  }
}

/** 파일 하나를 열어 두고 쪽을 그린다. 문서 하나에 하나씩 있다. */
async function readFile(file: File): Promise<Reader> {
  const pdfjs = await getPdfjs()
  // 고친 쪽을 다시 구우려면 원본 바이트가 계속 필요하다. 한 번만 읽어 둔다.
  const source = new Uint8Array(await file.arrayBuffer())
  const task = pdfjs.getDocument({ data: source.slice(), ...PDFJS_ASSETS })
  const doc = await task.promise
  type PdfjsDocument = typeof doc

  const pages: PageInfo[] = []
  for (let i = 0; i < doc.numPages; i += 1) {
    const page = await doc.getPage(i + 1)
    const view = page.getViewport({ scale: 1 })
    pages.push({ index: i, width: view.width, height: view.height, rotation: page.rotate })
    page.cleanup()
  }

  /*
   * 캔버스 하나에 두 번 그리면 pdfjs 가 거부한다. 확대는 이전 그리기가 끝나기
   * 전에 다음 그리기를 부르므로 실제로 난다. 캔버스마다 진행 중인 작업을
   * 들고 있다가 새로 그리기 전에 취소한다. 부르는 쪽이 신경 쓰지 않아도 되게
   * 여기서 처리한다.
   */
  const running = new WeakMap<
    HTMLCanvasElement,
    { cancel: () => void; done: Promise<RenderReport> }
  >()

  /** 쪽마다 한 번만 읽는다. getTextContent 는 싸지 않다. */
  const runCache = new Map<number, TextRun[]>()
  /** 코드표도 마찬가지. 연산 목록을 뽑는 일이 가볍지 않다. */
  const codeCache = new Map<number, Map<string, Map<number, number>>>()

  /*
   * pdfjs 가 쓴 코드표를 그대로 받아쓴다.
   *
   * 연산 목록을 훑으면 글자마다 스트림 안의 코드(originalCharCode)와 그것이
   * 무슨 글자인지(unicode)가 함께 들어 있다. 글꼴 이름은 commonObjs 가
   * 알려 준다. 폼 안에 든 글자도 연산 목록에는 펼쳐져 나오므로 함께 잡힌다.
   *
   * ToUnicode 를 손으로 읽는 것보다 이쪽이 언제나 맞다. 화면에 보이는 글자가
   * 곧 pdfjs 가 읽은 결과이므로, 고칠 때도 같은 표를 써야 어긋나지 않는다.
   */
  async function readGlyphCodes(index: number): Promise<Map<string, Map<number, number>>> {
    const cached = codeCache.get(index)
    if (cached) return cached

    const out = new Map<string, Map<number, number>>()
    try {
      const page = await doc.getPage(index + 1)
      const list = await page.getOperatorList()
      const { OPS } = pdfjs
      let table: Map<number, number> | null = null

      for (let i = 0; i < list.fnArray.length; i += 1) {
        if (list.fnArray[i] === OPS.setFont) {
          const handle = list.argsArray[i]?.[0]
          const font = handle && page.commonObjs.has(handle) ? page.commonObjs.get(handle) : null
          const name = String(font?.name ?? '')
          if (!name) {
            table = null
            continue
          }
          table = out.get(name) ?? new Map<number, number>()
          out.set(name, table)
        } else if (list.fnArray[i] === OPS.showText && table) {
          for (const glyph of list.argsArray[i]?.[0] ?? []) {
            if (typeof glyph === 'number' || !glyph) continue
            const code = glyph.originalCharCode
            const text = glyph.unicode
            if (typeof code !== 'number' || typeof text !== 'string' || !text) continue
            // 한 코드가 여러 글자로 풀리는 합자는 되돌릴 수 없어 건너뛴다.
            if ([...text].length !== 1) continue
            const cp = text.codePointAt(0)!
            if (!table.has(code)) table.set(code, cp)
          }
        }
      }
      page.cleanup()
    } catch {
      // 못 읽어도 ToUnicode 를 손으로 읽는 길이 남아 있다.
    }

    codeCache.set(index, out)
    return out
  }

  /*
   * 고친 쪽을 미리 구워 둔다.
   *
   * 원본 글자를 고치면 화면의 그림도 달라져야 한다. 고친 글자를 그림 위에
   * 얹는 것으로는 부족하다. 밑에 원본 글자가 그대로 남아 있어서, 상자를
   * 옮기거나 바탕이 흰색이 아니면 곧바로 드러난다.
   *
   * 그래서 그 쪽만 뽑아 고침을 반영한 한 쪽짜리 PDF 를 만들고, 그것을 그린다.
   * 고칠 때마다 한 번씩 굽는 셈인데, 한 쪽뿐이라 눈에 띄게 느리지 않다.
   * 같은 고침이면 다시 굽지 않는다.
   */
  const patched = new Map<string, { doc: PdfjsDocument; report: RenderReport }>()

  async function patchedPage(index: number, edits: RunEdit[]) {
    const key = `${index}:${JSON.stringify(
      edits.map((e) => [e.id, e.text, e.dx, e.dy, e.size, e.color, e.face, e.fill, e.bold, e.italic, e.underline, e.strike]),
    )}`
    const found = patched.get(key)
    if (found) return found

    const { PDFDocument } = await import('pdf-lib')
    const { rewritePageText } = await import('./pdfTextRewrite')
    const src = await PDFDocument.load(source, { ignoreEncryption: true })
    const one = await PDFDocument.create()
    const [copy] = await one.copyPages(src, [index])
    one.addPage(copy!)
    const done = await rewritePageText(
      copy!,
      edits,
      (which) => spareFont(one, which),
      await readGlyphCodes(index),
      (which, text) => spareLacks(which, text),
    )
    const applied = new Set<string>()
    const substituted = new Set<string>()
    const gaps = new Map<string, { missing: string; baseFont: string }>()
    const problems = new Map<string, { why: RewriteProblem; hint?: string; spare?: boolean }>()
    for (const [edit, how] of done) {
      const id = edit.id ?? ''
      if (!how.ok) {
        problems.set(id, { why: how.why, hint: how.hint, spare: how.spare })
        continue
      }
      applied.add(id)
      if (!how.original) substituted.add(id)
      if (how.missing) gaps.set(id, { missing: how.missing, baseFont: how.baseFont ?? '' })
    }
    const bytes = await one.save({ useObjectStreams: false })

    const task = pdfjs.getDocument({ data: bytes, ...PDFJS_ASSETS })
    const made = { doc: await task.promise, report: { applied, substituted, gaps, problems } }

    // 오래된 것부터 버린다. 스무 쪽을 앞뒤로 오가도 메모리가 불어나지 않게.
    if (patched.size >= 8) {
      const oldest = patched.keys().next().value
      if (oldest) {
        void patched.get(oldest)?.doc.cleanup()
        patched.delete(oldest)
      }
    }
    patched.set(key, made)
    return made
  }

  return {
    pages,
    render(index, scale, canvas, edits = []) {
      /*
       * 캔버스 하나를 두 번 그리면 pdfjs 가 거부한다. 확대·고침이 겹치면
       * 실제로 난다.
       *
       * 자리를 **먼저** 잡는 것이 중요하다. 이전 것을 확인하고 나서 await 를
       * 하나라도 거치면, 그 사이에 들어온 다음 호출도 "진행 중인 것이 없다" 고
       * 보고 같이 시작해 버린다. 그래서 여기서는 동기적으로 자리를 잡아 두고,
       * 실제 일은 그 안에서 줄을 세워 한다.
       */
      const prev = running.get(canvas)
      let stop: (() => void) | null = null
      let cancelled = false

      const done = (async (): Promise<RenderReport> => {
        if (prev) {
          prev.cancel()
          await prev.done.catch(() => {})
        }
        if (cancelled) return { applied: new Set(), substituted: new Set(), gaps: new Map(), problems: new Map() }

        let from = doc
        let report: RenderReport = {
          applied: new Set(),
          substituted: new Set(),
          gaps: new Map(),
          problems: new Map(),
        }
        let at = index
        if (edits.length > 0) {
          try {
            const made = await patchedPage(index, edits)
            from = made.doc
            report = made.report
            at = 0
          } catch {
            // 못 구우면 원본을 그린다. 고친 글자는 덮어쓰기로 보인다.
          }
        }
        if (cancelled) return report

        const page = await from.getPage(at + 1)
        const viewport = page.getViewport({ scale })
        canvas.width = Math.max(1, Math.floor(viewport.width))
        canvas.height = Math.max(1, Math.floor(viewport.height))
        const ctx = canvas.getContext('2d')
        if (!ctx) throw new Error('CANVAS_UNAVAILABLE')
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, canvas.width, canvas.height)

        const task = page.render({ canvas, canvasContext: ctx, viewport })
        stop = () => task.cancel()
        try {
          await task.promise
        } catch (err) {
          // 접힌 것은 잘못이 아니다. 뒤따라 오는 그리기가 마무리한다.
          if (!cancelled) throw err
        } finally {
          page.cleanup()
        }
        return report
      })()

      const entry = {
        cancel: () => {
          cancelled = true
          stop?.()
        },
        done,
      }
      running.set(canvas, entry)
      void done.catch(() => {}).then(() => {
        if (running.get(canvas) === entry) running.delete(canvas)
      })
      return done
    },

    /*
     * pdfjs 가 쓴 코드표를 그대로 받아쓴다.
     *
     * 연산 목록을 훑으면 글자마다 스트림 안의 코드(originalCharCode)와 그것이
     * 무슨 글자인지(unicode)가 함께 들어 있다. 글꼴 이름은 commonObjs 가
     * 알려 준다. 폼 안에 든 글자도 연산 목록에는 펼쳐져 나오므로 함께 잡힌다.
     */
    glyphCodes: readGlyphCodes,
    /*
     * 원본 글자 읽기.
     *
     * getTextContent 는 글자마다 문자열·행렬·너비를 준다. 행렬에 뷰포트를
     * 곱하면 화면과 같은(위가 원점인) 좌표가 나오고, 거기서 크기와 앉는 선을
     * 얻는다. 글꼴 이름은 commonObjs 에 있는데, getTextContent 를 부른 뒤라야
     * 채워져 있어서 순서를 지켜야 한다.
     *
     * 색은 여기서 얻지 못한다. getTextContent 는 색을 주지 않는다. 그린 그림에서
     * 뽑는 편이 확실해서 sampleRunColors 가 따로 한다.
     */
    async textRuns(index) {
      const cached = runCache.get(index)
      if (cached) return cached

      /*
       * 어느 걸음에서 넘어졌는지 이름을 붙여 둔다.
       *
       * 아이폰에서만 여기가 통째로 실패하는데, 밖에서는 `TypeError` 한 줄만
       * 보여 어디서 난 것인지 알 수가 없었다. 걸음마다 이름을 얹어 두면
       * 오류 문구만으로도 자리가 드러난다. 비용은 0 이다.
       */
      const step = async <T,>(name: string, run: () => Promise<T> | T): Promise<T> => {
        try {
          return await run()
        } catch (err) {
          throw new Error(`${name} — ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      const page = await step('getPage', () => doc.getPage(index + 1))
      const viewport = await step('getViewport', () => page.getViewport({ scale: 1 }))
      const content = await step('getTextContent', () => page.getTextContent())
      const runs: TextRun[] = []

      /*
       * 배열이 아닐 수도 있다고 보고 한 번 걸러 낸다. 그냥 for...of 로 돌면
       * 여기서 나는 오류가 "undefined is not a function" 한 줄로만 남아,
       * 글자를 못 읽은 것인지 다른 곳이 깨진 것인지 구분이 안 된다.
       */
      const items = content?.items
      if (!Array.isArray(items)) {
        throw new Error(`items 아님(${Object.prototype.toString.call(items)})`)
      }

      for (const item of items) {
        if (!('str' in item) || !item.str.trim()) continue
        const m = pdfjs.Util.transform(viewport.transform, item.transform)
        const size = Math.hypot(m[2], m[3]) || Math.abs(m[3]) || item.height
        if (size < 0.5) continue
        // 가로와 세로의 비. 장평을 좁힌 글자는 1보다 작다.
        const hscale = (Math.hypot(m[0], m[1]) || size) / size

        let baseFont = ''
        let cssFont = ''
        let ascent = 0.8
        try {
          const font = page.commonObjs.has(item.fontName)
            ? page.commonObjs.get(item.fontName)
            : null
          if (font) {
            // 서브셋 글꼴은 'ABCDEF+Helvetica' 처럼 앞에 여섯 글자가 붙는다.
            baseFont = String(font.name ?? '').replace(/^[A-Z]{6}\+/, '')
            cssFont = String(font.loadedName ?? '')
            if (typeof font.ascent === 'number' && font.ascent > 0) ascent = font.ascent
          }
        } catch {
          // 글꼴을 못 읽어도 글자는 고칠 수 있다. 기본값으로 간다.
        }

        const baseline = m[5]
        runs.push({
          page: index,
          x: m[4],
          y: baseline - size * ascent,
          w: item.width || size * item.str.length * 0.5,
          h: size * 1.2,
          baseline,
          text: item.str,
          size,
          hscale,
          baseFont,
          cssFont,
        })
      }

      page.cleanup()
      const joined = joinClusterRuns(runs)
      runCache.set(index, joined)
      return joined
    },
    async destroy() {
      for (const one of patched.values()) one.doc.cleanup()
      patched.clear()
      await task.destroy()
    },
  }
}

/**
 * 글자 덩이마다 따로 적힌 태국어 줄을 한 덩이로 잇는다.
 *
 * 크롬(Skia)이 만든 PDF 는 태국어를 낱자 묶음(자음+모음+성조)마다 따로 적는다.
 * pdf.js 도 그대로 쪼개 주므로 "ยินดีต้อนรับ" 이 "ต้", "อน", "รั" 처럼 조각난다.
 * 두 번 눌러 고치면 그 조각 하나만 잡혀, 조각 자리에 새 글이 끼어들어 줄이 겹친다
 * (2026-10-14 시험). 같은 줄·같은 글꼴·같은 크기로 바로 붙어 있는 태국어 조각만 잇는다.
 * 라틴 문서의 낱말 단위 조각은 지금처럼 따로 둔다(낱말만 고치는 쪽이 더 흔하다).
 * 고쳐 쓸 때는 pdfTextRewrite 의 findTarget 이 같은 줄의 여러 명령을 이어서 찾는다.
 */
const CLUSTERED_SCRIPT = /[\u0e00-\u0eff\u1000-\u109f\u1780-\u17ff]/
export function joinClusterRuns(runs: TextRun[]): TextRun[] {
  const out: TextRun[] = []
  for (const r of runs) {
    const last = out[out.length - 1]
    if (
      last &&
      (CLUSTERED_SCRIPT.test(last.text) || CLUSTERED_SCRIPT.test(r.text)) &&
      last.page === r.page &&
      last.cssFont === r.cssFont &&
      Math.abs(last.baseline - r.baseline) < 0.5 &&
      Math.abs(last.size - r.size) < 0.1 &&
      r.x - (last.x + last.w) > -0.3 * r.size &&
      r.x - (last.x + last.w) < 0.35 * r.size
    ) {
      const right = Math.max(last.x + last.w, r.x + r.w)
      // 사이가 벌어져 있으면 그건 띄어쓰기다(pdf.js 는 공백만 든 조각을 따로 주고, 위에서 그걸 건너뛴다).
      const space = r.x - (last.x + last.w) > 0.2 * r.size ? ' ' : ''
      out[out.length - 1] = { ...last, text: last.text + space + r.text, w: right - last.x }
      continue
    }
    out.push(r)
  }
  return out
}

/**
 * 쪽에서 찍은 자리 아래에 있는 글자를 찾는다. 겹치면 작은 쪽이 이긴다.
 *
 * `near` 는 손끝 굵기다(쪽 좌표 pt). 마우스는 점이라 거의 0 이면 되지만,
 * 손가락은 글자 한 줄보다 훨씬 굵다. 폰에서 A4 를 한 화면에 놓으면 본문 한
 * 줄이 4~5px 이라, 획 위를 정확히 짚었는지로 따지면 원본 글자는 영영 안
 * 잡히고 매번 새 글자 상자만 생긴다.
 *
 * 그래서 그만큼 넓혀 찾되 **정확히 안에 든 것이 언제나 먼저**다. 안에 든
 * 것이 하나도 없을 때에만 가장 가까운 글자를 준다. 이렇게 해야 빽빽한 곳은
 * 지금까지와 똑같이 집히고, 줄 사이를 살짝 빗나간 손가락만 구제된다.
 */
export function runAt(runs: TextRun[], x: number, y: number, near = 1): TextRun | null {
  /** 점에서 글자 네모까지의 거리. 안에 들어 있으면 0. */
  const gap = (r: TextRun) =>
    Math.hypot(Math.max(r.x - x, 0, x - (r.x + r.w)), Math.max(r.y - y, 0, y - (r.y + r.h)))

  const inside = runs.filter((r) => gap(r) === 0)
  if (inside.length > 0) return inside.reduce((a, b) => (a.w * a.h <= b.w * b.h ? a : b))

  const reach = Math.max(near, 1)
  let best: TextRun | null = null
  let bestGap = Infinity
  for (const r of runs) {
    const d = gap(r)
    if (d > reach) continue
    // 같은 거리면 작은 글자가 이긴다. 안에 들었을 때와 같은 규칙이다.
    if (d < bestGap - 0.01 || (best !== null && d < bestGap + 0.01 && r.w * r.h < best.w * best.h)) {
      best = r
      bestGap = d
    }
  }
  return best
}

/**
 * 글자 색과 바탕색을 그려 놓은 그림에서 뽑는다.
 *
 * PDF 연산 목록을 뒤져 색을 따라가는 방법도 있지만, 그림자·투명도·패턴까지
 * 따라가야 정확해진다. 이미 화면에 그려 둔 것이 정답이므로 거기서 읽는다.
 * 가장 어두운 점이 잉크, 가장 자주 나오는 점이 바탕이다.
 */
export function sampleRunColors(
  canvas: HTMLCanvasElement,
  pxPerPt: number,
  run: TextRun,
): { color: string; bg: string } {
  const fallback = { color: '#1a1a1a', bg: '#ffffff' }
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return fallback

  const x = Math.max(0, Math.floor(run.x * pxPerPt))
  const y = Math.max(0, Math.floor(run.y * pxPerPt))
  const w = Math.min(canvas.width - x, Math.ceil(run.w * pxPerPt))
  const h = Math.min(canvas.height - y, Math.ceil(run.h * pxPerPt))
  if (w <= 0 || h <= 0) return fallback

  let data: Uint8ClampedArray
  try {
    data = ctx.getImageData(x, y, w, h).data
  } catch {
    return fallback
  }

  let dark = 0
  let darkSum = [0, 0, 0]
  let darkest = 256 * 3
  const tally = new Map<number, number>()
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]!
    const g = data[i + 1]!
    const b = data[i + 2]!
    const sum = r + g + b
    const key = (r >> 3) * 1024 + (g >> 3) * 32 + (b >> 3)
    tally.set(key, (tally.get(key) ?? 0) + 1)
    if (sum < darkest) {
      darkest = sum
      darkSum = [r, g, b]
      dark = 1
    }
  }

  let top = 0
  let topKey = -1
  for (const [key, n] of tally) {
    if (n > top) {
      top = n
      topKey = key
    }
  }
  const bg =
    topKey < 0
      ? fallback.bg
      : hex(((topKey / 1024) | 0) << 3, (((topKey / 32) | 0) % 32) << 3, (topKey % 32) << 3)

  return { color: dark ? hex(darkSum[0]!, darkSum[1]!, darkSum[2]!) : fallback.color, bg }
}

const hex = (r: number, g: number, b: number) =>
  '#' + [r, g, b].map((v) => Math.min(255, v).toString(16).padStart(2, '0')).join('')

/**
 * 원본 글꼴에 없는 글자를 적을 때 대신 쓸 글꼴.
 *
 * 문서마다 한 번만 심는다. 바이트는 한 번 받아 두고 계속 쓴다. 2MB 라
 * 같은 창에서 여러 번 받게 두면 안 된다.
 */
const spareBytes = new Map<SpareKey, Uint8Array>()

export type SpareKey = 'gothic' | 'myeongjo' | 'ud' | 'sc' | 'tc' | 'vi' | 'thai' | 'deva' | `font:${string}`

/**
 * 새로 쓴 글에 심을 글꼴.
 *
 * 한때는 라틴 문자 밖이면 무조건 나눔고딕을 심었다. 나눔고딕에는 가나도,
 * 키릴 문자도, 폴란드어·튀르키예어 글자도 없어서 일본어·러시아어로 쓴 글이
 * 저장한 PDF 에서 빈칸이 됐다(화면은 브라우저 글꼴로 그려 멀쩡해 보인다).
 * 한글이 있으면 그대로 나눔고딕, 없으면 BIZ UDPゴシック 이다. 간체자 일부,
 * 베트남어 성조 글자, 태국어·아랍어·페르시아어·힌디어는 둘 다 없다.
 */
/** 베트남어에만 쓰는 글자. 이게 있으면 BIZ UDPゴシック·나눔 글꼴로는 빈 상자가 된다. */
const VIETNAMESE = /[ăâđêôơưĂÂĐÊÔƠƯ\u1ea0-\u1ef9]|[\u0300\u0301\u0303\u0309\u0323]/

export function needsVietnamese(text: string): boolean {
  return VIETNAMESE.test(text) && !/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7a3]/.test(text)
}

/** 태국 글자가 있는가. 한글·가나·한자가 함께 있으면 그쪽 글꼴이 먼저다. */
export function needsThai(text: string): boolean {
  return /[\u0e00-\u0e7f]/.test(text) && !/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7a3]/.test(text)
}

export function spareFor(text: string): SpareKey {
  const by = scriptFaceOf(text)
  if (by) return by
  if (/[\u1100-\u11ff\u3131-\u318e\uac00-\ud7a3]/.test(text)) return 'gothic'
  if (needsThai(text)) return 'thai'
  if (/[\u0900-\u097f]/.test(text) && !/[\u3040-\u30ff\u3400-\u9fff]/.test(text)) return 'deva'
  return needsVietnamese(text) ? 'vi' : 'ud'
}

/**
 * PDF 에 심을 수 있게 다듬는다. 심는 도구(@pdf-lib/fontkit 1.1.1)는 새 글꼴의 글자 배치 표(GSUB·GPOS·GDEF)를
 * 읽다가 멈추는 일이 있다(구글의 Nanum Pen Script 등). 그래서 그 표를 뺀 글꼴로 심는다. 글자 모양과 폭은 그대로고,
 * 합자·커닝만 빠진다(고른 글꼴로 쓰는 새 글자에만 해당).
 */
async function embeddableFont(bytes: Uint8Array): Promise<Uint8Array> {
  // 읽다 멈추는 일이 글자마다 달라서(공백·받침 조합에서만 나기도 한다) 미리 시험하지 않고 늘 뺀다
  return withoutTables(bytes, ['GSUB', 'GPOS', 'GDEF', 'BASE', 'JSTF', 'kern', 'morx', 'mort']) ?? bytes
}

/** sfnt(TTF·OTF) 한 벌에서 표 몇 개를 뺀 새 파일. 모양을 바꾸지 않는 표만 뺀다. */
function withoutTables(b: Uint8Array, drop: string[]): Uint8Array | null {
  if (b.byteLength < 12) return null
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const n = v.getUint16(4)
  const keep: Array<{ tag: string; check: number; off: number; len: number }> = []
  for (let i = 0; i < n; i++) {
    const at = 12 + i * 16
    if (at + 16 > b.byteLength) return null
    const tag = String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3])
    if (drop.includes(tag)) continue
    keep.push({ tag, check: v.getUint32(at + 4), off: v.getUint32(at + 8), len: v.getUint32(at + 12) })
  }
  const head = 12 + keep.length * 16
  let size = head
  for (const t of keep) size += (t.len + 3) & ~3
  const out = new Uint8Array(size)
  const o = new DataView(out.buffer)
  o.setUint32(0, v.getUint32(0))
  o.setUint16(4, keep.length)
  let pow = 1
  let log = 0
  while (pow * 2 <= keep.length) {
    pow *= 2
    log++
  }
  o.setUint16(6, pow * 16)
  o.setUint16(8, log)
  o.setUint16(10, keep.length * 16 - pow * 16)
  let at = head
  keep.forEach((t, i) => {
    const rec = 12 + i * 16
    for (let k = 0; k < 4; k++) out[rec + k] = t.tag.charCodeAt(k)
    o.setUint32(rec + 4, t.check)
    o.setUint32(rec + 8, at)
    o.setUint32(rec + 12, t.len)
    out.set(b.subarray(t.off, t.off + t.len), at)
    at += (t.len + 3) & ~3
  })
  return out
}

/**
 * 사용자가 고른 글꼴의 파일: 이 컴퓨터에 있으면 그것, 아니면 구글 서버에서(이 브라우저에 보관).
 * 받지 못하면 고딕으로 대신한다(글자가 빈칸이 되지 않게).
 */
async function chosenFontBytes(which: `font:${string}`, report: RatioReport): Promise<Uint8Array> {
  try {
    const api = await ezpzFonts()
    const buf = await api.bytes(customFamily(which), { weight: 400 })
    if (buf && buf.byteLength > 0) return await embeddableFont(new Uint8Array(buf))
  } catch {
    /* 아래에서 고딕으로 */
  }
  return loadFont('gothic', report)
}

export async function spareFont(
  doc: PDFDocument,
  which: SpareKey = 'gothic',
  report: RatioReport = () => {},
): Promise<PDFFont> {
  const pocket = spareCache.get(doc) ?? new Map<SpareKey, PDFFont>()
  spareCache.set(doc, pocket)
  const cached = pocket.get(which)
  if (cached) return cached
  const [{ default: fontkit }, bytes] = await Promise.all([
    import('@pdf-lib/fontkit'),
    spareBytes.get(which) ?? (isCustomFace(which) ? chosenFontBytes(which, report) : loadFont(which as Exclude<SpareKey, `font:${string}`>, report)),
  ])
  spareBytes.set(which, bytes)
  doc.registerFontkit(fontkit)
  /*
   * 서브셋을 쓰지 않는다.
   *
   * pdf-lib 가 딸려 오는 서브셋 만들기(@pdf-lib/fontkit 1.1.1)가 글리프를
   * 빠뜨린다. `한글 서브셋 시험 ABC 123` 을 심어 보면 실제 뷰어에서
   * `한글 ␣␣셋 시험 ␣C` 로 나온다. 합성 글리프 문제도 아니고 글꼴 탓도
   * 아니다. 미리보기용 pdfjs 는 너그러워서 글자를 읽어 내지만, 애크로뱃과
   * 맥 미리보기는 빈칸으로 그린다. 파일을 받아 갔더니 글자가 없더라는 것은
   * 있을 수 없는 일이라, 무게를 더 내는 쪽을 고른다.
   *
   * 글꼴을 통째로 심으면 파일이 0.7MB 쯤 는다. 새 글자를 넣었을 때만 그렇다.
   * 원본에 있던 글자만 고치면 글꼴을 아예 심지 않는다.
   */
  /*
   * 태국어는 글자 조합(ccmp)을 끈다. pdf-lib 는 글자 위치 조정(GPOS)을 버리고 폭만 쓰므로, 조합이 켜져 있으면
   * 사라 암(ำ)이 둘로 쪼개지며 사이가 벌어진다. 끄면 미리 합쳐 둔 글리프를 그대로 쓴다.
   */
  const font = await doc.embedFont(bytes, which === 'thai' ? { subset: false, features: { ccmp: false } } : { subset: false })
  pocket.set(which, font)
  return font
}

/** 대신 쓸 글꼴 파일에 그 글자들이 있는지(문서에 심지 않고 파일만 본다). 없는 글자들을 돌려준다. */
const faceCmaps = new Map<SpareKey, Promise<{ hasGlyphForCodePoint: (cp: number) => boolean } | null>>()
export async function spareLacks(which: SpareKey, text: string, report: RatioReport = () => {}): Promise<string> {
  let pending = faceCmaps.get(which)
  if (!pending) {
    pending = (async () => {
      try {
        const bytes = spareBytes.get(which) ?? (isCustomFace(which) ? await chosenFontBytes(which, report) : await loadFont(which as Exclude<SpareKey, `font:${string}`>, report))
        spareBytes.set(which, bytes)
        const { default: fontkit } = await import('@pdf-lib/fontkit')
        return fontkit.create(bytes) as unknown as { hasGlyphForCodePoint: (cp: number) => boolean }
      } catch {
        return null
      }
    })()
    faceCmaps.set(which, pending)
  }
  const f = await pending
  if (!f) return ''
  let out = ''
  for (const ch of new Set([...text])) if (!/\s/.test(ch) && !f.hasGlyphForCodePoint(ch.codePointAt(0)!)) out += ch
  return out
}

/** 말에 맞는 글꼴부터 해 보고, 없는 글자가 가장 적은 글꼴을 고른다(새 글자·덮어쓰기용) */
export async function bestSpareFor(text: string, first: SpareKey, report: RatioReport = () => {}): Promise<SpareKey> {
  let best: { which: SpareKey; n: number } | null = null
  for (const which of [first, ...nextFacesFor(first, text)] as SpareKey[]) {
    const n = (await spareLacks(which, text, report)).length
    if (!best || n < best.n) best = { which, n }
    if (n === 0) break
  }
  return best?.which ?? first
}

/** 문서 하나에 글꼴 종류마다 한 벌. 같은 것을 두 번 심으면 파일만 커진다. */
const spareCache = new WeakMap<PDFDocument, Map<SpareKey, PDFFont>>()

/* ── 얹는 물건 ─────────────────────────────────────────────────── */

export interface Box {
  /** 쪽 왼쪽 위에서 잰 위치(pt) */
  x: number
  y: number
  w: number
  h: number
}

/**
 * 글자를 어느 글꼴로 그릴지.
 *
 * `origin` 은 원본 문서가 쓰던 글꼴 그대로다. 원본 글자를 고칠 때 기본이고,
 * 옆 글자와 같은 모양으로 앉으므로 대개 이게 맞다. 일부러 바꾸고 싶을 때만
 * 고딕·명조를 고른다.
 */
/** `font:<이름>`: 사용자가 고른 웹 글꼴(구글) 또는 이 컴퓨터의 글꼴(lib/ezpzFonts.ts) */
export type FaceKey = 'origin' | 'gothic' | 'myeongjo' | `font:${string}`

export interface TextObject extends Box {
  kind: 'text'
  id: string
  /** 어느 쪽 자리에 붙었는지. Slot 의 이름표다. */
  slot: string
  text: string
  size: number
  color: string
  /** 새로 놓은 글자에는 원본 글꼴이 없다. 기본은 고딕. */
  face?: Exclude<FaceKey, 'origin'>
  /** 굵게. 글꼴을 바꾸는 것이 아니라 글자 테두리를 함께 그려 굵어 보이게 한다. */
  bold?: boolean
  /** 기울임. 글자를 오른쪽으로 눕힌다. */
  italic?: boolean
  underline?: boolean
  strike?: boolean
}

export interface ImageObject extends Box {
  kind: 'image'
  id: string
  slot: string
  /** 화면에 그릴 주소. 저장할 때는 bytes 를 쓴다. */
  url: string
  bytes: Uint8Array
  mime: 'image/png' | 'image/jpeg'
  /**
   * 시계 방향으로 돌린 각(도). 상자 한가운데를 축으로 돈다.
   *
   * 자리를 차지하는 상자는 안 돌린다. 돌린 만큼 상자를 다시 재면 끌어서
   * 크기를 바꿀 때 축이 매번 옮겨 다녀서 잡기가 어렵다. 화면에서는 CSS 로,
   * 저장할 때는 좌표를 직접 돌려서 낸다.
   */
  turn?: number
}

export interface InkObject {
  kind: 'ink'
  id: string
  slot: string
  /** [x, y] 의 나열(pt). 펜과 형광펜이 같은 모양을 쓴다. */
  points: Array<[number, number]>
  color: string
  width: number
  /** 형광펜은 반투명하게 겹쳐 칠한다. */
  highlight: boolean
  /**
   * 시계 방향으로 돌린 각(도). 상자 한가운데를 축으로 돈다.
   *
   * 자리를 차지하는 상자는 안 돌린다. 돌린 만큼 상자를 다시 재면 끌어서
   * 크기를 바꿀 때 축이 매번 옮겨 다녀서 잡기가 어렵다. 화면에서는 CSS 로,
   * 저장할 때는 좌표를 직접 돌려서 낸다.
   */
  turn?: number
}

/** 그릴 수 있는 도형. 네모만으로는 표시할 것을 다 못 한다. */
export type ShapeKind = 'rect' | 'ellipse' | 'line'

export interface ShapeObject extends Box {
  kind: 'shape'
  id: string
  slot: string
  shape: ShapeKind
  /** 테두리 색. 선 도형에서는 이게 곧 선 색이다. */
  color: string
  /** 선 굵기(pt). 0 이면 테두리를 안 그린다. 선 도형에서는 0 이 될 수 없다. */
  width: number
  /**
   * 선을 왼쪽 아래에서 오른쪽 위로 긋는다는 표시.
   *
   * 도형은 네모로 자리를 잡는데, 선만은 네모의 어느 대각선인지가 남는다.
   * 이게 없으면 오른쪽 아래로 가는 선만 그릴 수 있다.
   */
  flipped?: boolean
  /**
   * 속을 채울 색. 없으면 안 채운다. 선에는 뜻이 없다.
   *
   * 테두리 색과 따로 둔다. 빨간 테두리에 노란 속처럼, 둘을 같이 묶어 두면
   * 못 만드는 조합이 대부분이다.
   *
   * 기본은 안 채우기다. 문서 위에 표시를 하려고 그리는 것이지 가리려고
   * 그리는 것이 아니다. 채우기는 일부러 고를 때만 한다.
   */
  fill?: string
  /**
   * 시계 방향으로 돌린 각(도). 상자 한가운데를 축으로 돈다.
   *
   * 자리를 차지하는 상자는 안 돌린다. 돌린 만큼 상자를 다시 재면 끌어서
   * 크기를 바꿀 때 축이 매번 옮겨 다녀서 잡기가 어렵다. 화면에서는 CSS 로,
   * 저장할 때는 좌표를 직접 돌려서 낸다.
   */
  turn?: number
  /**
   * 영구 가리기(2026-11-04). 저장할 때 이 상자가 있는 쪽은 그림으로 다시 그려(pdfRedact.ts)
   * 아래 글자·그림을 파일에서 지운다. 화면에서는 채운 네모와 같다.
   */
  redact?: boolean
}

/**
 * 원본에 이미 있던 글자를 고친 것.
 *
 * PDF 안의 글자를 제자리에서 바꿔 쓰는 방법은 없다. 글자는 글꼴 자원과
 * 자리 잡기 연산에 묶여 있어서, 한 글자를 늘리면 그 줄 전체가 어긋난다.
 * 그래서 고친 자리만 바탕색으로 덮고 그 위에 새로 쓴다. 손대지 않은 곳은
 * 원본 바이트 그대로 남는다.
 *
 * 색·바탕색은 그려 둔 그림에서 뽑고(sampleRunColors), 글꼴은 이름이 기본
 * 14종에 들면 그대로 쓴다. 오타 고치기가 이 도구의 첫째 쓸모라, 흔한
 * 문서에서 고친 티가 나지 않는 것이 중요하다.
 */
export interface RunEditObject extends Box {
  kind: 'edit'
  id: string
  slot: string
  text: string
  /** 고치기 전 글자. 되돌리기와 "여기를 고쳤다" 표시에 쓴다. */
  original: string
  size: number
  color: string
  /** 원본 글자를 덮을 색 */
  bg: string
  /** 글자가 앉는 선(위 원점) */
  baseline: number
  /**
   * 원본이 있던 자리. 옮겨 놓아도 이건 안 바뀐다.
   *
   * 고칠 자리를 찾을 때는 이 자리를 쓰고, 그릴 때는 지금 자리(x, y)를 쓴다.
   * 둘을 갈라 두지 않으면 한 번 옮긴 뒤에는 원본을 다시 찾지 못한다.
   */
  homeX: number
  homeY: number
  /** 처음의 크기와 색. 바뀌었는지 견주어 볼 기준이다. */
  homeSize: number
  homeColor: string
  /** 원본이 쓰던 글꼴 이름 */
  baseFont: string
  /** 화면에서 쓸 CSS 글꼴 이름. pdf.js 가 등록해 둔 것. */
  cssFont: string
  /** 원본의 가로 배율. 장평을 좁힌 글자를 그대로 보이게 한다. */
  hscale: number
  /** 어느 글꼴로 그릴지. 기본은 원본 그대로. */
  face?: FaceKey
  /**
   * 원본 글꼴에 없는 글자가 있을 때. `swap` 은 줄 전체를 대신 쓸 글꼴로,
   * `mix` 는 없는 글자만 대신 쓸 글꼴로 적는다. 물어보고 정한다.
   */
  fill?: 'swap' | 'mix'
  /** 굵게. 글꼴을 바꾸는 것이 아니라 글자 테두리를 함께 그려 굵어 보이게 한다. */
  bold?: boolean
  /** 기울임. 글자를 오른쪽으로 눕힌다. */
  italic?: boolean
  underline?: boolean
  strike?: boolean
}

/**
 * 메모. 종이 위에 붙이는 쪽지다.
 *
 * 저장할 때 PDF 주석(`/Text`)으로 나간다. 그림으로 찍어 넣지 않는다. 주석으로
 * 두면 애크로뱃이나 미리보기에서도 접었다 펼 수 있고, 종이를 인쇄할 때는
 * 딸려 나오지 않는다. 메모는 문서의 일부가 아니라 문서에 붙인 말이다.
 */
export interface NoteObject extends Box {
  kind: 'note'
  id: string
  slot: string
  text: string
  color: string
}

export type EditObject =
  | TextObject
  | ImageObject
  | InkObject
  | ShapeObject
  | RunEditObject
  | NoteObject

/**
 * 고침 하나를 엔진이 쓰는 꼴로 옮긴다.
 *
 * 화면과 저장이 **같은 함수**를 써야 한다. 예전에 저장 쪽이 자기 나름대로
 * 값을 추려 담다가 크기·색·글꼴 변경을 통째로 빠뜨린 적이 있다.
 *
 * 크기와 색은 바뀌었을 때만 보낸다. 안 바꿨는데 보내면 원본 명령을 통째로
 * 다시 쓰게 되고, 그러면 원본이 쥐고 있던 자잘한 설정을 잃는다. 옮길 때는
 * 새로 그리는 것이라 색이 늘 필요하다.
 */
export function runEditOf(o: RunEditObject): RunEdit {
  const moved = o.x !== o.homeX || o.y !== o.homeY
  return {
    id: o.id,
    x: o.homeX,
    baseline: o.baseline,
    original: o.original,
    text: o.text,
    face: o.face && o.face !== 'origin' ? o.face : undefined,
    dx: o.x - o.homeX,
    dy: o.y - o.homeY,
    /*
     * 크기는 늘 보낸다. 지금 크기와 처음 크기를 함께 준다.
     *
     * 제자리에서 고칠 때는 원본의 행렬이 살아 있으니 둘을 견주어 바뀐 비율만
     * 원본 `Tf` 에 곱하면 된다. 자리를 새로 잡아 다시 그릴 때는 행렬을 원점으로
     * 돌려놓으므로 화면에서 잰 실제 크기를 그대로 쓴다.
     *
     * 크기를 `Tf` 가 아니라 행렬에 넣어 두는 문서가 있어서(`Tf 20` 에 `cm 0.75`
     * 를 걸어 실제로는 15) 둘을 갈라 두지 않으면 그 배율만큼 커지거나 작아진다.
     */
    size: o.size,
    homeSize: o.homeSize,
    hscale: o.hscale,
    w: o.w,
    fill: o.fill,
    bold: o.bold,
    italic: o.italic,
    underline: o.underline,
    strike: o.strike,
    color: moved || o.color !== o.homeColor ? o.color : undefined,
  }
}

/** 물건이 차지하는 네모. 붓질은 점에서 구한다. */
export function boundsOf(o: EditObject): Box {
  if (o.kind !== 'ink') return { x: o.x, y: o.y, w: o.w, h: o.h }
  const xs = o.points.map((p) => p[0])
  const ys = o.points.map((p) => p[1])
  const pad = o.width / 2
  const x = Math.min(...xs) - pad
  const y = Math.min(...ys) - pad
  return { x, y, w: Math.max(...xs) - x + pad, h: Math.max(...ys) - y + pad }
}

/* ── 문서 상태와 되돌리기 ──────────────────────────────────────── */

/**
 * 쪽 하나가 보이는 자리.
 *
 * 이름표(id)를 따로 둔다. 원본 쪽 번호로만 가리키면 같은 쪽을 복제했을 때
 * 둘을 구별할 수 없어서, 하나를 지우면 둘 다 지워지고 하나를 돌리면 둘 다
 * 돌아간다. 얹은 물건도 어느 쪽에 붙은 것인지 가릴 수 없다.
 */
export interface Slot {
  /** 이 자리의 이름표. 옮기고 복제해도 따라다닌다. */
  id: string
  /** 원본에서의 쪽 번호. 빈 쪽은 -1 이다. */
  src: number
  /** 사용자가 더한 회전(도). 원본 회전과는 별개로 센다. */
  turn: number
  /**
   * 어느 문서에서 온 쪽인지. 비어 있으면 처음 연 문서다.
   *
   * 다른 파일에서 쪽을 가져다 붙일 수 있으므로 쪽 번호만으로는 모자란다.
   * 붙여 온 문서는 EditDoc 이 열어 둔 채로 들고 있고, 저장할 때 그 문서에서
   * 쪽을 그대로 복사해 온다. 그림으로 찍어 붙이는 것이 아니라서 글자도
   * 글꼴도 살아 있다.
   */
  from?: string
  /**
   * 빈 쪽의 크기(pt). src 가 -1 일 때만 뜻이 있다.
   *
   * 원본 어디에도 없는 쪽이라 크기를 들고 있을 데가 여기뿐이다. 대개 지금
   * 보고 있는 쪽과 같은 크기로 만든다. 한 문서 안에서 쪽 크기가 들쭉날쭉하면
   * 인쇄할 때 곤란하다.
   */
  size?: { width: number; height: number }
}

export interface EditState {
  /** 보여 줄 차례대로 늘어놓은 쪽들. 순서 변경·삭제·복제가 여기에 담긴다. */
  order: Slot[]
  objects: EditObject[]
}

export function initialState(pageCount: number): EditState {
  return {
    order: Array.from({ length: pageCount }, (_, i) => ({ id: newId(), src: i, turn: 0 })),
    objects: [],
  }
}

/**
 * 되돌리기.
 *
 * 무엇이 바뀌었는지 적어 두는 대신 상태를 통째로 쌓는다. 물건은 좌표 몇 개가
 * 전부라 한 벌이 작고, 그림 바이트는 참조만 복사되므로 실제로 불어나는 양은
 * 미미하다. 이렇게 하면 "모든 작업에서 Ctrl+Z 가 된다" 를 규칙 하나로 지킬 수
 * 있다. 작업마다 되돌리는 법을 따로 쓰면 언젠가 하나를 빠뜨린다.
 */
export class History {
  private past: EditState[] = []
  private future: EditState[] = []

  constructor(private state: EditState) {}

  get current(): EditState {
    return this.state
  }

  get changes(): number {
    return this.past.length
  }

  get canUndo(): boolean {
    return this.past.length > 0
  }

  get canRedo(): boolean {
    return this.future.length > 0
  }

  /** 한 동작이 끝났을 때 부른다. 끄는 중간에는 부르지 않는다. */
  commit(next: EditState): EditState {
    this.past.push(this.state)
    this.future = []
    this.state = next
    return next
  }

  undo(): EditState {
    const prev = this.past.pop()
    if (!prev) return this.state
    this.future.push(this.state)
    this.state = prev
    return prev
  }

  redo(): EditState {
    const next = this.future.pop()
    if (!next) return this.state
    this.past.push(this.state)
    this.state = next
    return next
  }

  /** 원본으로. 되돌리기 기록도 함께 지운다. */
  reset(base: EditState): EditState {
    this.past = []
    this.future = []
    this.state = base
    return base
  }
}

/* ── 내보내기 ──────────────────────────────────────────────────── */

const RGB = (hex: string): [number, number, number] => {
  const v = hex.replace('#', '')
  const n = parseInt(v.length === 3 ? v.replace(/./g, '$&$&') : v, 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

/** 한글이 한 글자라도 있으면 글꼴을 심어야 한다. 아니면 내장 글꼴로 끝난다. */
// 정규식에 제어 문자를 직접 넣지 않는다. 코드값으로 세는 편이 읽기도 쉽다.
const beyondLatin1 = (text: string) => [...text].some((ch) => (ch.codePointAt(0) ?? 0) > 0xff)


/**
 * 원본 글꼴 이름을 PDF 기본 14종에 맞춘다.
 *
 * 세상 문서의 상당수가 Helvetica·Arial·Times 계열이라, 이름만 맞춰 줘도
 * 고친 글자가 옆 글자와 같은 모양으로 앉는다. 못 맞추면 Helvetica 로 간다.
 * 원본에 심긴 글꼴을 그대로 다시 쓰는 것이 이상적이지만, 서브셋이면 새로
 * 쓴 글자의 자모가 애초에 들어 있지 않다.
 */
function standardFontFor(name: string): string {
  const n = name.toLowerCase()
  const bold = /bold|black|heavy|semibold/.test(n)
  const italic = /italic|oblique/.test(n)
  if (/times|serif|roman|georgia|garamond|minion|cambria/.test(n) && !/sans/.test(n)) {
    if (bold && italic) return 'Times-BoldItalic'
    if (bold) return 'Times-Bold'
    if (italic) return 'Times-Italic'
    return 'Times-Roman'
  }
  if (/courier|mono|consolas|menlo/.test(n)) {
    if (bold && italic) return 'Courier-BoldOblique'
    if (bold) return 'Courier-Bold'
    if (italic) return 'Courier-Oblique'
    return 'Courier'
  }
  if (bold && italic) return 'Helvetica-BoldOblique'
  if (bold) return 'Helvetica-Bold'
  if (italic) return 'Helvetica-Oblique'
  return 'Helvetica'
}

/* ── 그림을 PDF 가 받는 꼴로 ─────────────────────────────────── */

/**
 * 바이트를 보고 그림 종류를 가린다. PDF 에 바로 넣을 수 있는 것은 PNG 와 JPEG 뿐이다.
 *
 * 파일의 이름표(확장자·mime)는 믿지 않는다. 웹에서 받은 사진은 이름이 `.jpg`
 * 여도 속은 WebP 인 경우가 흔하다. 이름만 보고 JPEG 로 넣으면 화면에는 멀쩡히
 * 보이다가 저장에서 `SOI not found in JPEG` 로 통째로 실패한다(2026-09-24 재현).
 */
export function sniffImage(bytes: Uint8Array): 'png' | 'jpeg' | null {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
    return 'png'
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  return null
}

/** 브라우저가 그릴 수 있는 그림(WebP·GIF·AVIF·BMP·SVG…)을 PNG 로 다시 찍는다. */
export async function repaintPng(bytes: Uint8Array, type = ''): Promise<Uint8Array> {
  const url = URL.createObjectURL(new Blob([bytes.slice().buffer as ArrayBuffer], type ? { type } : {}))
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const el = new Image()
      el.onload = () => res(el)
      el.onerror = () => rej(new Error('IMAGE_UNREADABLE'))
      el.src = url
    })
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, img.naturalWidth || img.width)
    canvas.height = Math.max(1, img.naturalHeight || img.height)
    canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height)
    const png = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'))
    if (!png) throw new Error('IMAGE_UNREADABLE')
    return new Uint8Array(await png.arrayBuffer())
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** 넣을 그림을 PNG·JPEG 로 맞춘다. 이미 그 꼴이면 그대로 둔다(다시 찍으면 커지기만 한다). */
export async function embeddable(
  bytes: Uint8Array,
  type = '',
): Promise<{ bytes: Uint8Array; mime: 'image/png' | 'image/jpeg' }> {
  const kind = sniffImage(bytes)
  if (kind === 'png') return { bytes, mime: 'image/png' }
  if (kind === 'jpeg') return { bytes, mime: 'image/jpeg' }
  return { bytes: await repaintPng(bytes, type), mime: 'image/png' }
}

/* ── 저장이 어디서 멈췄나 ──────────────────────────────────────── */

/** 오류에 저장 단계를 적어 둔다. 측정에서 "어디서" 를 알려면 이것뿐이다. */
function withStage(err: unknown, stage: string): unknown {
  if (err && typeof err === 'object') {
    try {
      const e = err as { stage?: string }
      if (!e.stage) e.stage = stage
    } catch {
      // 얼어 있는 오류는 그냥 둔다.
    }
    return err
  }
  return Object.assign(new Error(String(err)), { stage })
}

/** 오류에 적힌 저장 단계. 없으면 unknown. */
export function stageOf(err: unknown): string {
  const stage = err && typeof err === 'object' ? (err as { stage?: unknown }).stage : undefined
  return typeof stage === 'string' ? stage : 'unknown'
}

export interface ExportProgress {
  phase: 'font' | 'writing'
  ratio: number | null
}

/**
 * 저장.
 *
 * 원본을 그대로 열어 쪽을 복사하고 그 위에 물건을 그린다. 원본 쪽의 내용은
 * 손대지 않으므로 글꼴·이미지·서식이 그대로 남는다.
 */
export async function exportPdf(
  file: File,
  state: EditState,
  onProgress?: (p: ExportProgress) => void,
  /**
   * 쪽마다 pdfjs 가 쓴 코드표를 얻는 길. 편집기가 이미 열어 둔 문서에서
   * 가져온다. 없으면 ToUnicode 를 손으로 읽지만, 그쪽은 틀리는 문서가 있다.
   */
  glyphCodes?: (page: number, from?: string) => Promise<Map<string, Map<number, number>>>,
  /**
   * 쪽을 가져다 붙인 다른 파일들. 이름표는 Slot.from 과 같은 것이다.
   *
   * 붙여 온 쪽은 그 문서에서 통째로 복사해 온다. 글꼴도 서식도 원본 그대로
   * 남는다는 뜻이다.
   */
  attached?: Array<{ id: string; file: File }>,
): Promise<Blob> {
  /** 어디까지 갔나. 실패하면 오류에 붙여 내보낸다(측정에서 "단계" 로 쓴다). */
  let stage = 'load'
  try {
    const { PDFDocument, PDFHexString, StandardFonts, rgb, degrees } = await import('pdf-lib')
    const { rewritePageText } = await import('./pdfTextRewrite')
    type StandardFonts = (typeof StandardFonts)[keyof typeof StandardFonts]

    const src = await PDFDocument.load(await file.arrayBuffer(), { ignoreEncryption: true })
    const out = await PDFDocument.create()

    /*
     * 라틴 문자 밖의 글자가 있을 때만 글꼴(2~4.5MB)을 받는다(spareFor 가 고른다).
     * 영어만 쓰면 PDF 내장 글꼴로 끝나므로 아무것도 내려받지 않는다.
     *
     * fontkit 은 반드시 @pdf-lib/fontkit 이어야 한다. 저장소에 이미 있는
     * fontkit@2 는 pdfkit 이 데려온 것인데, 2.0 에서 subset.encodeStream 이
     * 없어져 pdf-lib 의 서브셋이 깨진다. 서브셋을 끄면 되기는 하지만 글꼴이
     * 통째로 들어가 저장할 때마다 PDF 가 0.7MB 씩 불어난다. 서브셋을 쓰면
     * 한글 스물넉 자에 6KB 다.
     */
    const report: RatioReport = (ratio) => onProgress?.({ phase: 'font', ratio })

    /*
     * 기본 14종은 쓰는 것만 심는다. 원본 글꼴 이름을 따라가면 고친 글자가
     * 옆 글자와 같은 모양으로 앉아서, 고쳤다는 티가 나지 않는다.
     */
    const stock = new Map<string, Awaited<ReturnType<typeof out.embedFont>>>()
    async function fontFor(o: EditObject) {
      if (o.kind === 'text' || o.kind === 'edit') {
        // 사용자가 글꼴을 골랐으면 그대로 따른다. 아니면 한글일 때만 심는다.
        const face = o.face && o.face !== 'origin' ? o.face : null
        // 고딕·명조(나눔)에는 베트남어·태국어 글자가 없다. 고른 글꼴로는 빈 상자가 되니 그 말 글꼴로 받는다.
        if (face) {
          // 나눔(고딕·명조)에는 가나·일본 한자 일부·키릴·태국·베트남·힌디 글자가 없다. 그 글자가 있으면 그 말 글꼴로 받는다
          const sf = beyondLatin1(o.text) ? spareFor(o.text) : null
          const nanum = face === 'gothic' || face === 'myeongjo'
          const first = sf && sf !== 'gothic' && (nanum || sf !== 'ud') ? sf : face
          return spareFont(out, beyondLatin1(o.text) ? await bestSpareFor(o.text, first, report) : first, report)
        }
        if (beyondLatin1(o.text)) return spareFont(out, await bestSpareFor(o.text, spareFor(o.text), report), report)
      }
      const want = o.kind === 'edit' ? standardFontFor(o.baseFont) : 'Helvetica'
      const found = stock.get(want)
      if (found) return found
      // StandardFonts 의 값이 곧 PDF 안의 글꼴 이름이다. standardFontFor 가 그 이름을 낸다.
      const made = await out.embedFont(want as StandardFonts)
      stock.set(want, made)
      return made
    }

    /**
     * 돌린 물건의 좌표를 옮겨 주는 자.
     *
     * 화면에서는 CSS 가 상자 한가운데를 축으로 돌려 준다. PDF 에는 그런 것이
     * 없으니 좌표를 직접 돌린다. 화면은 y 가 아래로, PDF 는 위로 자라므로 도는
     * 방향도 뒤집힌다. 그래서 각에 음수를 붙인다.
     */
    function spinner(o: { x: number; y: number; w: number; h: number; turn?: number }, down: (y: number, h?: number) => number) {
      const deg = -(o.turn ?? 0)
      const rad = (deg * Math.PI) / 180
      const cos = Math.cos(rad)
      const sin = Math.sin(rad)
      const cx = o.x + o.w / 2
      const cy = down(o.y + o.h / 2)
      return {
        deg,
        /** 편집기 좌표(왼쪽 위 원점) 한 점을 PDF 좌표로, 돌린 만큼 옮겨서. */
        at(x: number, y: number) {
          const py = down(y)
          if (!deg) return { x, y: py }
          const dx = x - cx
          const dy = py - cy
          return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos }
        },
      }
    }

    /**
     * 꾸밈을 얹어 한 줄을 그린다.
     *
     * 굵게는 글꼴을 바꾸지 않고 같은 글자를 살짝 어긋나게 두 번 그려서 낸다.
     * 심어 둔 원본 글꼴에는 굵은 짝이 없기 때문이다. 기울임은 pdf-lib 가 주는
     * 밀기(xSkew)로, 밑줄과 취소선은 글자 너비를 재서 자로 긋는다.
     */
    type Styled = { bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean }
    function writeText(
      page: PDFPage,
      line: string,
      style: Styled,
      at: { x: number; y: number; size: number; font: PDFFont; color: ReturnType<typeof rgb> },
    ) {
      // 붙여 넣은 글에 섞여 오는 탭·CR 은 기본 글꼴(WinAnsi)이 적지 못해 저장이 통째로 실패한다.
      line = line.replace(/\r/g, '').replace(/\t/g, '    ')
      if (!line) return
      const lean = style.italic ? { xSkew: degrees(12) } : {}
      const put = (dx: number) =>
        page.drawText(line, {
          x: at.x + dx,
          y: at.y,
          size: at.size,
          font: at.font,
          color: at.color,
          ...lean,
        })
      put(0)
      if (style.bold) put(Math.max(0.3, at.size * 0.03))
      if (!style.underline && !style.strike) return
      let wide = at.size * line.length * 0.5
      try {
        wide = at.font.widthOfTextAtSize(line, at.size)
      } catch {
        // 심은 글꼴에 없는 글자가 섞이면 너비를 못 잰다. 어림값으로 긋는다.
      }
      const thick = Math.max(0.5, at.size * (style.bold ? 0.075 : 0.05))
      const rule = (y: number) =>
        page.drawRectangle({ x: at.x, y, width: wide, height: thick, color: at.color })
      if (style.underline) rule(at.y - at.size * 0.14)
      if (style.strike) rule(at.y + at.size * 0.26)
    }

    onProgress?.({ phase: 'writing', ratio: 0 })

    /*
     * 쪽을 온 문서별로 묶어서 한 번에 복사한다.
     *
     * copyPages 는 한 번 부를 때마다 글꼴·그림 같은 자원을 새로 들고 온다.
     * 쪽마다 따로 부르면 같은 글꼴이 쪽 수만큼 들어가 파일이 몇 배로 불어난다.
     * 그래서 문서마다 한 번씩만 부르고, 늘어놓는 것은 그다음에 한다.
     */
    stage = 'copy'
    const sources = new Map<string, typeof src>([['', src]])
    for (const one of attached ?? []) {
      // 실제로 쓰는 문서만 연다. 붙였다가 도로 지운 파일은 열 이유가 없다.
      if (!state.order.some((slot) => slot.from === one.id)) continue
      sources.set(
        one.id,
        await PDFDocument.load(await one.file.arrayBuffer(), { ignoreEncryption: true }),
      )
    }

    const queue = new Map<string, number[]>()
    for (const slot of state.order) {
      if (slot.src < 0) continue
      const key = slot.from ?? ''
      const list = queue.get(key) ?? []
      list.push(slot.src)
      queue.set(key, list)
    }
    const ready = new Map<string, PDFPage[]>()
    for (const [key, list] of queue) {
      const doc = sources.get(key)
      if (doc) ready.set(key, await out.copyPages(doc, list))
    }

    /*
     * 복사해 온 쪽을 자리 차례대로 늘어놓는다. 빈 쪽은 그 자리에서 새로 만든다.
     * 같은 쪽을 복제해 두었으면 복사본도 그만큼 줄을 서 있으므로, 문서마다
     * 어디까지 썼는지만 세면 된다.
     */
    const taken = new Map<string, number>()
    const placed: Array<{ slot: Slot; page: PDFPage }> = []
    for (const slot of state.order) {
      if (slot.src < 0) {
        const size = slot.size ?? { width: BLANK_PAGE.width, height: BLANK_PAGE.height }
        placed.push({ slot, page: out.addPage([size.width, size.height]) })
        continue
      }
      const key = slot.from ?? ''
      const at = taken.get(key) ?? 0
      taken.set(key, at + 1)
      const page = ready.get(key)?.[at]
      // 못 가져온 쪽은 건너뛴다. 빈 자리를 남기느니 없는 편이 낫다.
      if (!page) continue
      out.addPage(page)
      placed.push({ slot, page })
    }

    for (const { slot, page } of placed) {
      const mine = state.objects.filter((x) => x.slot === slot.id)

      /*
       * 원본 글자를 고친 것은 먼저 내용 스트림 안에서 직접 바꿔 본다.
       * 덮어쓰기보다 언제나 낫다. 바탕이 무엇이든 상관없고 글꼴도 원본 그대로다.
       *
       * 반드시 pdf-lib 로 이 쪽에 무엇을 그리기 **전에** 해야 한다. 스트림을
       * 통째로 갈아 끼우기 때문에, 나중에 하면 그려 둔 것이 날아간다.
       */
      stage = 'rewrite'
      const runEdits = mine.filter((x): x is RunEditObject => x.kind === 'edit')
      const rewritten = new Set<string>()
      if (runEdits.length > 0) {
        try {
          const asked = runEdits.map(runEditOf)
          const done = await rewritePageText(
            page,
            asked,
            (which) => spareFont(out, which, report),
            await glyphCodes?.(slot.src, slot.from),
            (which, text) => spareLacks(which, text, report),
          )
          for (const [edit, how] of done) if (how.ok) rewritten.add(edit.id!)
        } catch {
          // 특이하게 쓰인 문서일 수 있다. 덮어쓰기로 물러난다.
        }
      }

      if (slot.turn) page.setRotation(degrees((page.getRotation().angle + slot.turn) % 360))

      const { height } = page.getSize()
      // 편집 중에는 왼쪽 위가 원점이었다. PDF 는 왼쪽 아래다. 여기서 한 번만 뒤집는다.
      const flip = (y: number, h = 0) => height - y - h

      for (const o of mine) {
        stage = `draw:${o.kind}`
        if (o.kind === 'edit') {
          // 스트림에서 직접 고쳤으면 더 할 일이 없다.
          if (rewritten.has(o.id)) continue
          // 대신 쓸 글꼴에도 없는 글자가 있으면(아랍어 등) 덮어쓰지 않고 원본을 그대로 둔다. 빈칸으로 저장하지 않게
          if (o.text && beyondLatin1(o.text) && lackingIn(await fontFor(o), o.text)) continue
          const [br, bg, bb] = RGB(o.bg)
          // 먼저 원본 글자를 바탕색으로 덮는다. 조금 넉넉하게 덮어야 삐침이 남지 않는다.
          page.drawRectangle({
            x: o.x - 0.6,
            y: flip(o.y + o.h + 0.6),
            width: o.w + 1.2,
            height: o.h + 1.2,
            color: rgb(br, bg, bb),
          })
          if (o.text) {
            const [r, g, b] = RGB(o.color)
            writeText(page, o.text, o, {
              x: o.x,
              y: flip(o.baseline),
              size: o.size,
              font: await fontFor(o),
              color: rgb(r, g, b),
            })
          }
        } else if (o.kind === 'text') {
          const [r, g, b] = RGB(o.color)
          const font = await fontFor(o)
          // 줄바꿈은 사용자가 넣은 그대로 지킨다. 자동 줄바꿈은 2차에서 다룬다.
          const lines = o.text.split('\n')
          lines.forEach((line, i) => {
            writeText(page, line, o, {
              x: o.x,
              y: flip(o.y + (i + 1) * o.size * 1.25),
              size: o.size,
              font,
              color: rgb(r, g, b),
            })
          })
        } else if (o.kind === 'image') {
          // 이름표가 아니라 바이트를 보고 넣는다. PNG·JPEG 가 아니면 PNG 로 다시 찍는다.
          const kind = sniffImage(o.bytes)
          const img =
            kind === 'png'
              ? await out.embedPng(o.bytes)
              : kind === 'jpeg'
                ? await out.embedJpg(o.bytes)
                : await out.embedPng(await repaintPng(o.bytes, o.mime))
          const spun = spinner(o, flip)
          const corner = spun.at(o.x, o.y + o.h)
          page.drawImage(img, {
            x: corner.x,
            y: corner.y,
            width: o.w,
            height: o.h,
            rotate: degrees(spun.deg),
          })
        } else if (o.kind === 'note') {
          /*
           * 메모는 그리지 않고 주석으로 단다. `/Text` 주석은 뷰어가 접힌 쪽지
           * 아이콘으로 보여 주고, 눌러야 내용이 열린다. 인쇄물에는 안 찍힌다.
           *
           * 글자는 UTF-16 으로 적어야 한다. 한글을 그냥 넣으면 라틴 한 바이트로
           * 읽혀 깨진다.
           */
          const [r, g, b] = RGB(o.color)
          const annot = out.context.obj({
            Type: 'Annot',
            Subtype: 'Text',
            Name: 'Comment',
            Rect: [o.x, flip(o.y, NOTE_SIZE), o.x + NOTE_SIZE, flip(o.y)],
            Contents: PDFHexString.fromText(o.text),
            C: [r, g, b],
            // 열어 두지 않는다. 종이를 가리지 않게.
            Open: false,
          })
          page.node.addAnnot(out.context.register(annot))
        } else if (o.kind === 'shape') {
          const [r, g, b] = RGB(o.color)
          /*
           * 테두리와 속을 따로 얹는다. 둘 다 없으면 아무것도 안 그린다.
           *
           * pdf-lib 는 색도 테두리색도 안 주면 **검정으로 채운다**. 굵기 0 에
           * 테두리색만 주면 장치가 그릴 수 있는 가장 가는 선을 긋는다. 둘 다
           * "안 그린다" 는 뜻으로 읽히지 않으므로 아예 넘기지 않는다.
           */
          type Paint = ReturnType<typeof rgb>
          const paint: { color?: Paint; borderColor?: Paint; borderWidth?: number } = {}
          if (o.fill) {
            const [fr, fg, fb] = RGB(o.fill)
            paint.color = rgb(fr, fg, fb)
          }
          if (o.width > 0) {
            paint.borderColor = rgb(r, g, b)
            paint.borderWidth = o.width
          }
          if (o.shape !== 'line' && !paint.color && !paint.borderColor) continue
          const spun = spinner(o, flip)
          if (o.shape === 'rect') {
            /*
             * pdf-lib 의 `rotate` 는 왼쪽 아래 모서리를 축으로 돈다. 우리는 상자
             * 한가운데를 축으로 도는 것이라, 모서리를 미리 돌린 자리에 놓고
             * 같은 각을 넘긴다.
             */
            const corner = spun.at(o.x, o.y + o.h)
            page.drawRectangle({
              x: corner.x,
              y: corner.y,
              width: o.w,
              height: o.h,
              rotate: degrees(spun.deg),
              ...paint,
            })
          } else if (o.shape === 'ellipse') {
            // 타원은 x·y 가 곧 한가운데다. 축이 이미 맞아서 각만 넘기면 된다.
            page.drawEllipse({
              x: o.x + o.w / 2,
              y: flip(o.y + o.h / 2),
              xScale: o.w / 2,
              yScale: o.h / 2,
              rotate: degrees(spun.deg),
              ...paint,
            })
          } else {
            // 끌어 그린 대각선 방향 그대로 긋는다.
            const a = spun.at(o.x, o.flipped ? o.y + o.h : o.y)
            const c = spun.at(o.x + o.w, o.flipped ? o.y : o.y + o.h)
            page.drawLine({
              start: a,
              end: c,
              thickness: o.width,
              color: rgb(r, g, b),
              lineCap: 1,
            })
          }
        } else {
          const [r, g, b] = RGB(o.color)
          // 붓질은 자리를 차지하는 상자를 점에서 거꾸로 잰다.
          const spun = spinner({ ...boundsOf(o), turn: o.turn }, flip)
          // 붓질은 점을 이어 선분으로 그린다. 형광펜은 반투명으로 겹쳐 칠한다.
          for (let i = 1; i < o.points.length; i += 1) {
            const a = o.points[i - 1]!
            const c = o.points[i]!
            page.drawLine({
              start: spun.at(a[0], a[1]),
              end: spun.at(c[0], c[1]),
              thickness: o.width,
              color: rgb(r, g, b),
              opacity: o.highlight ? 0.38 : 1,
              lineCap: 1,
            })
          }
        }
      }
    }

    stage = 'serialize'
    const bytes = await out.save({ useObjectStreams: true })
    return new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'application/pdf' })
  } catch (err) {
    throw withStage(err, stage)
  }
}

/** 메모 쪽지가 종이에서 차지하는 크기(pt). 뷰어마다 아이콘 크기는 제각각이다. */
export const NOTE_SIZE = 20

/**
 * 빈 쪽의 기본 크기(pt). A4 다.
 *
 * 대개는 보고 있던 쪽과 같은 크기로 만든다. 문서가 아예 없거나 크기를 못
 * 알아낼 때만 이것을 쓴다. 미국 밖에서는 A4 가 기본이고, 이 사이트를 쓰는
 * 사람은 대부분 미국 밖에 있다.
 */
export const BLANK_PAGE = { width: 595.28, height: 841.89 }

/** 레터(8.5 × 11 인치)를 쓰는 나라. 북미와 중남미 일부, 필리핀. */
const LETTER_REGIONS = new Set(['US', 'CA', 'MX', 'PH', 'CL', 'CO', 'VE', 'CR', 'GT', 'PA', 'DO', 'PR', 'SV', 'NI', 'HN'])

/**
 * 새 문서의 종이 크기(pt).
 *
 * 빈 쪽 하나를 더할 때와 달리 새 문서는 기준 삼을 쪽이 없다. 그대로 인쇄할
 * 종이이니 브라우저가 알려 주는 지역을 본다. 레터를 쓰는 곳이면 레터, 그
 * 밖은 A4(BLANK_PAGE).
 */
export function newDocPaper(lang = typeof navigator === 'undefined' ? '' : navigator.language): {
  width: number
  height: number
} {
  const region = /[-_]([A-Za-z]{2})(?:$|[-_])/.exec(lang)?.[1]?.toUpperCase()
  return region && LETTER_REGIONS.has(region) ? { width: 612, height: 792 } : { ...BLANK_PAGE }
}

/**
 * 빈 쪽 하나짜리 PDF.
 *
 * 편집기는 PDF 하나를 열어 두고 그 위에서 일한다. 새 문서도 이것을 만들어
 * 열면 여는 길, 저장하는 길을 그대로 쓴다. 이 브라우저 안에서 만들 뿐 어디에도
 * 보내지 않는다.
 */
export async function blankPdf(name: string, size = newDocPaper()): Promise<File> {
  const { PDFDocument } = await import('pdf-lib')
  const doc = await PDFDocument.create()
  doc.addPage([size.width, size.height])
  const bytes = await doc.save()
  return new File([bytes as BlobPart], name, { type: 'application/pdf' })
}

/** 화면에서 쓰는 짧은 식별자. crypto 가 없는 환경은 없다고 봐도 된다. */
export function newId(): string {
  return Math.random().toString(36).slice(2, 10)
}

export type { RatioReport }
