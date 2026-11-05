/**
 * 원본 PDF 안의 글자를 **제자리에서** 고친다.
 *
 * 흔한 방법은 고칠 자리를 바탕색으로 덮고 그 위에 새로 쓰는 것이다. 쉽지만
 * 흰 바탕에서만 통한다. 무늬가 있거나 스캔한 문서에서는 덮은 네모가 그대로
 * 보이고, 글자 너비를 조금만 잘못 재도 원본 글자 꼬리가 삐져나온다.
 *
 * 여기서는 내용 스트림 안에서 그 글자를 그린 명령을 찾아 문자열만 바꾼다.
 * 덮는 네모가 없으니 바탕이 무엇이든 상관없고, 고친 글자도 여전히 한 덩이라
 * 복사·검색이 된다. 원본이 쓰던 글꼴을 그대로 쓰므로 모양도 그대로다.
 *
 * 원본 글꼴로 적을 수 없는 글자가 있다. 서브셋 글꼴은 문서에 실제로 쓰인 자모만
 * 들고 있어서, 한 번도 안 나온 글자는 그림 자체가 없다. 한국어 문서에서는 흔한
 * 일이다. 그때도 덮지 않는다. 대신 글꼴 하나를 이 쪽에 새로 심고, 그 자리에서만
 * 글꼴을 갈아 끼우는 명령을 함께 적어 넣는다. 글자꼴은 옆과 달라지지만 그건
 * 원본에 그 글자가 없으니 어쩔 수 없고, 적어도 덮은 네모는 생기지 않는다.
 *
 * 명령을 아예 못 찾는 경우는 남는다. 드물지만 생성기가 특이하게 쓴 문서가 있다.
 * 그때만 부르는 쪽이 덮어쓰기로 물러난다.
 */
import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  decodePDFRawStream,
  type PDFObject,
  type PDFFont,
  type PDFPage,
} from 'pdf-lib'

import { tokenize, type Token } from './pdfContentTokens'
import {
  applyKnownCodes,
  charFor,
  codeFor,
  encodeWith,
  fontSlots,
  fontSlotsFrom,
  missingIn,
  stripSubsetTag,
  type FontkitLike,
  type FontSlot,
} from './pdfFontReuse'
import { lackingIn, nextFacesFor, scriptFaceOf } from './spareFaces'

/** 새로 심을 글꼴의 종류. 고딕·명조(한·일)와, 그 글꼴에 없는 태국어·베트남어 글꼴. */
export type SpareFace = 'gothic' | 'myeongjo' | 'ud' | 'sc' | 'tc' | 'thai' | 'vi' | 'deva' | `font:${string}`
/** 글자의 말에 맞는 대신 쓸 글꼴 고르기(lib/spareFaces.ts). 원본 글꼴 이름으로 간체·번체·일본어를 가른다 */
const scriptFace = (text: string, named = ''): SpareFace | null => scriptFaceOf(text, named)
const nextFaces = (first: SpareFace, text: string): SpareFace[] => nextFacesFor(first, text)

/** 고칠 자리 하나. 좌표는 편집기와 같은 규칙(왼쪽 위 원점, pt)이다. */
export interface RunEdit {
  x: number
  /** 글자가 앉는 선 */
  baseline: number
  original: string
  text: string
  /** 부르는 쪽이 자기 물건을 알아보라고 달아 두는 표. 여기서는 안 본다. */
  id?: string
  /**
   * 원래 자리에서 옮긴 거리(pt). 0 이면 제자리에서 고친다.
   *
   * 옮길 때는 원래 자리의 글자를 지우고, 같은 글꼴로 새 자리에 다시 그린다.
   * 원본 명령의 좌표를 고치는 방법도 있지만, 그 명령이 앞 글자에서 이어받은
   * 자리에 기대고 있으면 뒤따르는 글자까지 함께 움직인다.
   */
  dx?: number
  dy?: number
  /**
   * 바꿔 쓸 색. 없으면 원본 색 그대로.
   *
   * 옮겨 그릴 때는 색을 알아야 하므로 늘 함께 온다.
   */
  color?: string
  /**
   * 화면에서 잰 **실제** 글자 크기(pt). 늘 함께 온다.
   *
   * 원본의 `Tf` 값과 다를 수 있다. 크기를 `Tf` 가 아니라 그리기 행렬에 반쯤
   * 넣어 두는 문서가 있다(`Tf 20` 에 `cm 0.75` 를 걸어 실제로는 15). 자리를
   * 새로 잡아 다시 그릴 때는 행렬을 원점으로 돌려놓으므로, `Tf` 값을 그대로
   * 가져오면 그 배율만큼 커지거나 작아진다.
   */
  size?: number
  /** 고치기 전의 실제 크기. 사용자가 크기를 바꿨는지 여기서 가린다. */
  homeSize?: number
  /** 글자 꾸밈. 굵게는 테두리를 함께 그려서, 기울임은 글자를 눕혀서 낸다. */
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  /** 원본 자리의 너비(pt). 밑줄과 취소선의 길이를 여기서 가늠한다. */
  w?: number
  /**
   * 원본의 가로 배율. 옮겨 그릴 때 이걸 살려야 장평이 안 풀린다.
   *
   * 제자리에서 고칠 때는 원본의 글자 행렬이 그대로 살아 있으므로 쓸 일이 없다.
   */
  hscale?: number
  /**
   * 일부러 다른 글꼴로 적으라는 요구. 없으면 원본 글꼴을 그대로 쓴다.
   *
   * 원본 글꼴이 가장 잘 어울리므로 기본은 그쪽이다. 사용자가 글꼴을 바꿔
   * 고를 때만 이 값이 온다.
   */
  face?: 'gothic' | 'myeongjo' | `font:${string}`
  /**
   * 원본 글꼴에 없는 글자가 있을 때 어떻게 할지.
   *
   * `swap` 은 줄 전체를 대신 쓸 글꼴로 적는다. 한 줄 안에서 글꼴이 안 섞여서
   * 깔끔하지만 옆 줄과는 달라진다. `mix` 는 없는 글자만 대신 쓸 글꼴로 적고
   * 나머지는 원본 그대로 둔다. 옆 글자와 이어지는 대신 그 글자만 튄다.
   *
   * 어느 쪽이 나은지는 문서와 사람에 달렸다. 그래서 묻는다. 기본은 `swap`.
   */
  fill?: 'swap' | 'mix'
}

type Matrix = [number, number, number, number, number, number]

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

const mul = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
]

/** 내용 스트림 안에서 글자를 그린 명령 하나. */
interface ShowOp {
  /** 이 명령이 들어 있는 스트림 */
  source: Source
  /**
   * 명령 전체의 바이트 범위. 피연산자 첫 글자부터 명령어 끝까지다.
   * `[<가> -600 <나>] TJ` 라면 여는 대괄호부터 `TJ` 까지.
   */
  start: number
  end: number
  /** 명령어 이름. `Tj`·`TJ`·`'`·`"` */
  name: string
  /** 그 자리에서 쓰이던 글꼴 */
  slot: FontSlot | null
  /** 그 자리의 `Tf` 가 가리키던 이름과 크기. 글꼴을 갈아 끼웠다가 되돌릴 때 쓴다. */
  resource: string
  size: number
  /** 글자 그리기 방식(`Tr`). 2 면 칠하고 테두리까지 그린다. 굵어 보인다. */
  render: string
  /** 그때의 선 굵기(`w`). 테두리까지 그리는 방식에서 굵기를 좌우한다. */
  penWidth: string
  /**
   * 그 자리에서 쓰이던 칠하기 색 명령을 적힌 그대로.
   *
   * 색을 바꿔 쓴 뒤에는 원래 색으로 되돌려 놓아야 뒤따르는 글자가 멀쩡하다.
   * 무슨 색인지 해석할 필요는 없고 같은 글자를 다시 적기만 하면 된다.
   */
  fill: string
  /** 화면과 같은 규칙으로 잰 자리 */
  x: number
  baseline: number
  /** 이 명령이 그린 글자. 조각들을 이어 붙인 것이다. */
  text: string
  /**
   * 글자 문자열 조각들.
   *
   * `[<가나> -600 <다라>] TJ` 처럼 한 명령 안에 문자열이 여럿 있고, 사이의
   * 숫자가 자리를 벌린다. 양쪽정렬한 줄이 대개 이 꼴이다. 한 낱말만 고치려면
   * 그 낱말이 든 조각만 바꿔야 나머지 간격이 그대로 남는다.
   */
  pieces: Array<{ start: number; end: number; text: string }>
  /**
   * 피연산자를 적힌 차례 그대로. 문자열과 그 사이의 간격 숫자가 섞여 있다.
   *
   * 명령을 통째로 다시 쓸 때 쓴다. 글꼴을 갈아 끼우려면 `Tf` 를 넣어야 하는데
   * `TJ` 배열 안에는 못 넣으므로, 배열을 끊고 글꼴을 바꾼 뒤 다시 이어야 한다.
   * 그때 간격 숫자를 그대로 옮겨야 줄이 안 흔들린다.
   */
  parts: Array<
    | { kind: 'text'; text: string; start: number; end: number }
    | { kind: 'num'; raw: string; start: number; end: number }
  >
}

/** 글자를 그린 명령이 들어 있는 스트림 하나. */
interface Source {
  /** 이 스트림을 가리키는 이름. 고칠 때 어디를 고칠지 가른다. */
  id: string
  bytes: Uint8Array
  /** 이 스트림이 쓰는 글꼴들 */
  slots: FontSlot[]
  /** 고친 바이트를 도로 넣는다 */
  write: (next: Uint8Array) => void
  /** 대신 쓸 글꼴을 이 스트림의 자원 사전에 올린다 */
  addFont: (key: string, ref: PDFRef) => void
  /** 이 스트림이 `Do` 로 부르는 폼을 찾아 준다 */
  forms: (name: string) => { source: Source; matrix: Matrix } | null
  /** 이 스트림이 쓰는 자원 사전. 글꼴을 새로 올릴 때 쓴다. */
  resources: PDFDict | undefined
}

/**
 * 쪽이 그리는 글자를 모두 모은다. 끼워 넣은 폼(Form XObject) 안까지 들어간다.
 *
 * 자리를 알려면 글자 행렬을 따라가야 한다. BT 가 행렬을 초기화하고, Td·TD·
 * Tm·T* 가 그것을 옮긴다. 거기에 그리기 행렬(cm)을 곱하면 쪽 위의 자리가
 * 나온다. 한 줄 안에서 명령이 여럿으로 쪼개진 경우는 이어 붙여 맞춘다.
 *
 * 폼을 따라 들어가는 것이 중요하다. 한글 워드프로세서나 관공서 양식으로 만든
 * PDF 는 본문을 통째로 폼 하나에 넣는 일이 흔한데, 쪽 본문 스트림만 보면
 * 글자가 하나도 없는 것처럼 보인다. 그러면 제자리 수정이 전부 실패한다.
 */
function collectShowOps(source: Source, base: Matrix, height: number, out: ShowOp[], depth: number) {
  const tokens = tokenize(source.bytes)

  /*
   * `q` 와 `Q` 는 그리기 행렬만 저장하는 것이 아니다. 글꼴과 크기, 칠하기 색,
   * 글자 그리기 방식(`Tr`), 선 굵기까지 통째로 저장했다가 되돌린다.
   *
   * 예전에는 행렬만 쌓아 두고 나머지는 흘려보냈다. 그래서 앞쪽 제목이 걸어
   * 둔 `2 Tr` 이 뒤따르는 본문까지 새어 나와, 고친 글자만 굵게 그려졌다.
   */
  type GState = {
    ctm: Matrix
    slot: FontSlot | null
    resource: string
    size: number
    fill: string
    render: string
    penWidth: string
  }
  let g: GState = {
    ctm: base,
    slot: null,
    resource: '',
    size: 0,
    fill: '0 g',
    render: '0',
    penWidth: '1',
  }
  const stack: GState[] = []
  let tm: Matrix = IDENTITY
  let tlm: Matrix = IDENTITY
  let leading = 0
  let operands: Token[] = []

  /** 조각 하나가 그리는 글자. 하나라도 못 읽으면 null. */
  const decodePiece = (piece: Token): string | null => {
    const slot = g.slot
    if (!slot) return null
    const hex =
      piece.kind === 'hex'
        ? piece.value
        : [...piece.value].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('')
    const width = slot.codeBytes * 2
    let out = ''
    for (let i = 0; i + width <= hex.length; i += width) {
      const code = parseInt(hex.slice(i, i + width), 16)
      const cp = charFor(slot, code)
      if (cp === undefined) return null
      out += String.fromCodePoint(cp)
    }
    return out
  }

  for (const token of tokens) {
    if (token.kind !== 'operator') {
      operands.push(token)
      continue
    }
    const op = token.value
    const nums = operands.filter((t) => t.kind === 'number').map((t) => Number(t.value))

    switch (op) {
      case 'q':
        stack.push({ ...g })
        break
      case 'Q':
        g = stack.pop() ?? { ...g, ctm: base }
        break
      case 'cm':
        if (nums.length >= 6) g = { ...g, ctm: mul(nums.slice(-6) as Matrix, g.ctm) }
        break
      case 'BT':
        tm = IDENTITY
        tlm = IDENTITY
        break
      case 'Tf': {
        const name = operands.find((t) => t.kind === 'name')
        g = {
          ...g,
          resource: name?.value ?? '',
          slot: name ? (source.slots.find((s) => s.resource === name.value) ?? null) : null,
          size: nums.length ? nums[nums.length - 1]! : g.size,
        }
        break
      }
      case 'rg':
      case 'g':
      case 'k':
        // 칠하기 색. 적힌 그대로 들고 있다가 되돌릴 때 다시 적는다.
        g = { ...g, fill: `${nums.map(round).join(' ')} ${op}` }
        break
      case 'Tr':
        if (nums.length) g = { ...g, render: round(nums[nums.length - 1]!) }
        break
      case 'w':
        if (nums.length) g = { ...g, penWidth: round(nums[nums.length - 1]!) }
        break
      case 'TL':
        if (nums.length) leading = nums[nums.length - 1]!
        break
      case 'Td':
        if (nums.length >= 2) {
          tlm = mul([1, 0, 0, 1, nums[nums.length - 2]!, nums[nums.length - 1]!], tlm)
          tm = tlm
        }
        break
      case 'TD':
        if (nums.length >= 2) {
          leading = -nums[nums.length - 1]!
          tlm = mul([1, 0, 0, 1, nums[nums.length - 2]!, nums[nums.length - 1]!], tlm)
          tm = tlm
        }
        break
      case 'Tm':
        if (nums.length >= 6) {
          tlm = nums.slice(-6) as Matrix
          tm = tlm
        }
        break
      case 'T*':
        tlm = mul([1, 0, 0, 1, 0, -leading], tlm)
        tm = tlm
        break
      case 'Do': {
        // 끼워 넣은 폼. 그 안에도 글자가 있다. 지금 그리기 행렬을 물려준다.
        const name = operands.find((t) => t.kind === 'name')
        if (name && depth < 4) {
          const inner = source.forms?.(name.value)
          if (inner) collectShowOps(inner.source, mul(inner.matrix, g.ctm), height, out, depth + 1)
        }
        break
      }
      case 'Tj':
      case 'TJ':
      case "'":
      case '"': {
        if (op === "'" || op === '"') {
          tlm = mul([1, 0, 0, 1, 0, -leading], tlm)
          tm = tlm
        }
        const raw = operands.filter((t) => t.kind === 'hex' || t.kind === 'string')
        const at = mul(tm, g.ctm)
        const first = raw[0]
        const span = operands[0]
        if (first && span && g.size > 0) {
          const pieces: ShowOp['pieces'] = []
          const parts: ShowOp['parts'] = []
          let text = ''
          let readable = true
          for (const token2 of operands) {
            if (token2.kind === 'number') {
              parts.push({ kind: 'num', raw: token2.value, start: token2.start, end: token2.end })
              continue
            }
            if (token2.kind !== 'hex' && token2.kind !== 'string') continue
            const one = decodePiece(token2)
            if (one === null) {
              readable = false
              break
            }
            pieces.push({ start: token2.start, end: token2.end, text: one })
            parts.push({ kind: 'text', text: one, start: token2.start, end: token2.end })
            text += one
          }
          out.push({
            source,
            start: span.start,
            end: token.end,
            name: op,
            slot: g.slot,
            resource: g.resource,
            size: g.size,
            fill: g.fill,
            render: g.render,
            penWidth: g.penWidth,
            x: at[4],
            baseline: height - at[5],
            text: readable ? text : '',
            pieces: readable ? pieces : [],
            parts: readable ? parts : [],
          })
        }
        break
      }
      default:
        break
    }
    operands = []
  }
}

/**
 * 제자리에서 못 고친 까닭.
 *
 * 화면에 그대로 보여 준다. 조용히 덮어쓰기로 물러나면 사용자는 "왜 원본이
 * 남아 있지" 만 보게 되고, 우리도 어느 단계에서 걸렸는지 알 길이 없다.
 */
export type RewriteProblem =
  /** 글자를 그린 명령을 못 찾았다. 자리로도 글자로도 안 맞았다. */
  | 'notFound'
  /** 글꼴에 ToUnicode 표가 없어 무엇이 적혀 있는지 읽지 못한다. */
  | 'unreadable'
  /** 원본 글꼴에 없는 글자인데 대신 쓸 글꼴도 못 받았다. */
  | 'noGlyph'

/** 고침 하나의 결과. */
export type RewriteOutcome =
  | {
      ok: true
      /** 원본 글꼴로 적었는가 */
      original: boolean
      /** 원본 글꼴에 없던 글자들. 사용자에게 무엇이 없는지 짚어 준다. */
      missing?: string
      /** 그 자리에 원래 쓰이던 글꼴 이름. 서브셋 꼬리표는 뗀다. */
      baseFont?: string
    }
  | { ok: false; why: RewriteProblem; /** 원인을 찾을 실마리 */ hint?: string; /** noGlyph 인데 대신 쓸 글꼴에도 없었다(hint 가 그 글자들) */ spare?: boolean }

/**
 * 고칠 자리들을 내용 스트림에 반영한다.
 *
 * 반영한 것만 돌려준다. 못 한 것은 부르는 쪽이 덮어쓰기로 처리한다.
 * 원본 글꼴로 적었는지도 함께 알려 준다. 글자꼴이 옆과 달라지는 일은
 * 사용자에게 말해 줘야 한다.
 */
export async function rewritePageText(
  page: PDFPage,
  edits: RunEdit[],
  /**
   * 원본 글꼴로 못 적는 글자가 나왔을 때 쓸 글꼴. 부를 때마다 심지 않게
   * 부르는 쪽이 하나를 만들어 돌려주면 된다. 안 주면 그런 고침은 건너뛴다.
   */
  fallback?: (which: SpareFace) => Promise<PDFFont>,
  /**
   * pdfjs 가 실제로 쓴 코드표. 있으면 이걸 쓴다. ToUnicode 를 손으로 읽는
   * 것보다 언제나 맞다.
   */
  known?: Map<string, Map<number, number>>,
  /**
   * 그 글꼴에 없는 글자들을 알려 준다(심지 않고 글꼴 파일만 보고). 있으면 대신 쓸 글꼴 후보를 고를 때
   * 후보마다 문서에 심지 않아도 된다(안 쓰는 글꼴이 저장 파일에 들어가 커지지 않게).
   */
  covers?: (which: SpareFace, text: string) => Promise<string>,
): Promise<Map<RunEdit, RewriteOutcome>> {
  const done = new Map<RunEdit, RewriteOutcome>()
  if (edits.length === 0) return done

  const context = page.node.context

  /*
   * 글꼴 파일을 풀 도구를 미리 받아 둔다. 문서에 심긴 글꼴에 직접 물어보려면
   * 필요하다. 못 받아도 일은 되고, 그때는 그 쪽에 쓰인 글자만 쓸 수 있다.
   */
  let fontkit: FontkitLike | undefined
  try {
    fontkit = (await import('@pdf-lib/fontkit')).default as unknown as FontkitLike
  } catch {
    fontkit = undefined
  }

  /** 고친 스트림들. 한 번에 모아 두었다가 마지막에 갈아 끼운다. */
  const dirty = new Map<Source, Array<{ start: number; end: number; bytes: Uint8Array }>>()

  const decodeStream = (one: unknown): Uint8Array | null =>
    one instanceof PDFRawStream ? decodePDFRawStream(one).decode() : null

  /** 이어 붙이기. 여러 토막으로 나뉜 스트림은 한 덩이로 읽어야 한다. 규격이 그렇다. */
  const join = (parts: Uint8Array[]): Uint8Array => {
    const total = parts.reduce((n, p) => n + p.length + 1, 0)
    const bytes = new Uint8Array(total)
    let at = 0
    for (const part of parts) {
      bytes.set(part, at)
      at += part.length
      bytes[at] = 0x0a
      at += 1
    }
    return bytes
  }

  /** 자원 사전에서 글꼴 자리를 얻는다. 없으면 부모 것을 쓴다. */
  const slotsOf = (resources: PDFDict | undefined, parent: FontSlot[]): FontSlot[] => {
    if (!resources) return parent
    const own = fontSlotsFrom(context, resources, fontkit)
    if (own.length === 0) return parent
    if (known) applyKnownCodes(own, known)
    return own
  }

  /** 폼 하나를 읽을거리로 바꾼다. 같은 폼을 두 번 만들지 않는다. */
  const formCache = new Map<string, Source | null>()

  function makeSource(
    id: string,
    bytes: Uint8Array,
    resources: PDFDict | undefined,
    slots: FontSlot[],
    write: (next: Uint8Array) => void,
    addFont: (key: string, ref: PDFRef) => void,
  ): Source {
    const source: Source = {
      id,
      bytes,
      slots,
      write,
      addFont,
      resources,
      forms: (name) => {
        const key = `${id}/${name}`
        if (formCache.has(key)) {
          const found = formCache.get(key)
          return found ? { source: found, matrix: formMatrix.get(found) ?? IDENTITY } : null
        }
        const made = openForm(resources, name, slots, key)
        formCache.set(key, made?.source ?? null)
        return made
      },
    }
    return source
  }

  const formMatrix = new WeakMap<Source, Matrix>()

  function openForm(
    resources: PDFDict | undefined,
    name: string,
    parentSlots: FontSlot[],
    id: string,
  ): { source: Source; matrix: Matrix } | null {
    const xoRaw = resources?.get(PDFName.of('XObject'))
    const xo = xoRaw ? context.lookup(xoRaw) : undefined
    if (!(xo instanceof PDFDict)) return null
    const ref = xo.get(PDFName.of(name))
    if (!(ref instanceof PDFRef)) return null
    const stream = context.lookup(ref)
    if (!(stream instanceof PDFRawStream)) return null

    const dict = stream.dict
    const sub = context.lookup(dict.get(PDFName.of('Subtype')))
    if (!(sub instanceof PDFName) || sub.decodeText() !== 'Form') return null

    const bytes = decodeStream(stream)
    if (!bytes) return null

    const resRaw = dict.get(PDFName.of('Resources'))
    const res = resRaw ? context.lookup(resRaw) : undefined
    const own = res instanceof PDFDict ? res : undefined

    let matrix: Matrix = IDENTITY
    const mRaw = dict.get(PDFName.of('Matrix'))
    const m = mRaw ? context.lookup(mRaw) : undefined
    if (m instanceof PDFArray && m.size() >= 6) {
      const got = Array.from({ length: 6 }, (_, i) => {
        const n = context.lookup(m.get(i))
        return n instanceof PDFNumber ? n.asNumber() : 0
      })
      matrix = got as Matrix
    }

    const source = makeSource(
      id,
      bytes,
      own,
      slotsOf(own, parentSlots),
      (next) => {
        // 폼은 제자리에 갈아 끼운다. 쪽이 이 폼을 이름으로 가리키고 있다.
        /*
         * 원래 사전을 그대로 물려준다. BBox·Matrix·Resources 가 빠지면 폼이
         * 아예 안 그려진다. 길이와 압축 방식만 새로 쓴다.
         */
        const keep: Record<string, PDFObject> = {}
        for (const [k, v] of dict.entries()) {
          const name = k.decodeText()
          if (name === 'Length' || name === 'Filter' || name === 'DecodeParms') continue
          keep[name] = v
        }
        const fresh = context.flateStream(next, keep)
        context.assign(ref, fresh)
      },
      (key, fontRef) => {
        const target = own ?? PDFDict.withContext(context)
        const fontsRaw = target.get(PDFName.of('Font'))
        const fonts = fontsRaw ? context.lookup(fontsRaw) : undefined
        const map = fonts instanceof PDFDict ? fonts : PDFDict.withContext(context)
        map.set(PDFName.of(key), fontRef)
        target.set(PDFName.of('Font'), map)
        if (!own) dict.set(PDFName.of('Resources'), target)
      },
    )
    formMatrix.set(source, matrix)
    return { source, matrix }
  }

  /* ── 쪽 본문 ── */
  const contents = page.node.get(PDFName.of('Contents'))
  if (!contents) return done
  const resolved = context.lookup(contents)
  const parts: Uint8Array[] = []
  if (resolved instanceof PDFRawStream) {
    const one = decodeStream(resolved)
    if (one) parts.push(one)
  } else if (resolved instanceof PDFArray) {
    for (let i = 0; i < resolved.size(); i += 1) {
      const one = decodeStream(resolved.lookup(i))
      if (one) parts.push(one)
    }
  }
  if (parts.length === 0) return done

  const pageRes = page.node.Resources()
  const pageSlots = fontSlots(page, fontkit)
  if (known) applyKnownCodes(pageSlots, known)
  const root = makeSource(
    'page',
    join(parts),
    pageRes,
    pageSlots,
    (next) => {
      /*
       * 배열로 넣는다. 스트림 하나만 넣으면 안 된다(2026-09-24 저장 실패).
       *
       * 글꼴을 대신 심은 고침이면 위에서 `setFontDictionary` 가 먼저 불린다.
       * pdf-lib 는 그때 쪽을 "정리됨" 으로 표시하면서 Contents 를 배열로 바꿔
       * 두고, 그 뒤로는 Contents 가 늘 배열이라고 믿는다. 여기서 스트림 하나로
       * 덮어쓰면, 다음에 이 쪽에 무엇을 그릴 때(새 글자·도형·서명…)
       * `Contents.push is not a function` 으로 저장이 통째로 죽는다.
       *
       * 앞뒤를 q/Q 로 감싼다. 원본 본문이 좌표계를 바꾼 채 끝나도 뒤에 그리는
       * 것이 그 영향을 받지 않는다. pdf-lib 가 정리할 때 하는 일과 같다.
       */
      page.node.set(
        PDFName.of('Contents'),
        context.obj([
          context.getPushGraphicsStateContentStream(),
          context.register(context.flateStream(next)),
          context.getPopGraphicsStateContentStream(),
        ]),
      )
    },
    (key, fontRef) => page.node.setFontDictionary(PDFName.of(key), fontRef),
  )

  const { height } = page.getSize()
  const ops: ShowOp[] = []
  collectShowOps(root, IDENTITY, height, ops, 0)

  /**
   * 그 글꼴을 쪽 본문에서 쓸 수 있는 이름으로 만든다.
   *
   * 쪽이 이미 쓰는 글꼴이면 그 이름을 그대로 쓴다. 폼 안에만 있던 글꼴이면
   * 쪽의 자원 사전에 새 이름으로 올린다. 같은 글꼴을 두 번 올리지 않는다.
   */
  const lifted = new Map<FontSlot, string>()
  function fontOnPage(slot: FontSlot): string | null {
    if (root.slots.includes(slot)) return slot.resource
    const found = lifted.get(slot)
    if (found) return found
    if (!slot.ref) return null
    // 사전이 그대로 박혀 있으면 참조로 만들어 준다. 자원 사전은 참조를 담는다.
    const ref = slot.ref instanceof PDFRef ? slot.ref : context.register(slot.ref)
    const key = `EZ${Math.random().toString(36).slice(2, 8)}`
    root.addFont(key, ref)
    lifted.set(slot, key)
    return key
  }

  /** 대신 쓸 글꼴. 정말 필요할 때 한 번만 심는다. */
  let spare: { font: PDFFont; which: SpareFace; key: string } | null = null
  const spareIn = new Set<Source>()

  /*
   * 읽을 수 있는 글자가 하나라도 있었는지 본다. 하나도 못 읽었다면 글꼴에
   * ToUnicode 표가 없다는 뜻이고, 그건 "못 찾았다" 와는 다른 이야기다.
   */
  const readable = ops.some((o) => o.text.length > 0)

  for (const edit of edits) {
    const target = findTarget(ops, edit)
    if (!target) {
      done.set(edit, { ok: false, why: readable ? 'notFound' : 'unreadable', hint: hintNear(ops, edit) })
      continue
    }

    const head = target.ops[0]!
    /*
     * 새 글자를 적을 글꼴. 명령 하나면 그 글꼴이고, 여럿에 걸쳐 있으면 그중
     * 새 글자를 가장 많이 적을 수 있는 글꼴이다. 첫 명령이 여는 괄호 하나만
     * 든 대체 글꼴이면, 그걸로는 한글을 한 자도 못 적는다.
     */
    const slot = target.ops.length > 1 ? bestSlot(target, edit.text) : head.slot!

    /*
     * 자리를 옮긴 고침. 원래 자리의 글자를 지우고, 같은 글꼴로 새 자리에 다시
     * 그린다. 그리는 명령은 쪽 본문 맨 뒤에 붙인다. 폼 안에 붙이면 폼이 놓인
     * 자리에 따라 좌표가 다시 틀어지므로 쪽 좌표로 한 번에 정한다.
     */
    /*
     * 글자 하나마다 명령이 따로인 문서가 있다. 그때는 글자마다 제 `cm` 으로
     * 장평과 자리를 따로 주므로, 여러 글자를 첫 명령 하나에 몰아넣으면 첫
     * 글자의 장평이 전체에 걸리고 나머지 자리 정보는 버려진다. 늘어나거나
     * 조여 보이는 것이 그래서다.
     *
     * 고칠 글자가 명령 여럿에 걸쳐 있으면, 제자리에 끼워 넣지 않고 그 자리의
     * 글자를 모두 비운 뒤 한 덩이로 다시 그린다. 옮길 때와 같은 길이다.
     */
    const spread = target.ops.length > 1
    const moved = Boolean(edit.dx || edit.dy)
    /*
     * 꾸밈은 제자리 끼워 넣기로는 낼 수 없다. 기울임은 글자 행렬을 눕혀야 하고,
     * 밑줄과 취소선은 자를 따로 그어야 하며, 굵게는 그리기 방식을 바꿔야 한다.
     * 셋 다 `TJ` 배열 안에는 못 들어간다. 그러니 다시 그리는 길로 간다.
     */
    const decorated = Boolean(edit.bold || edit.italic || edit.underline || edit.strike)
    /*
     * 원본 글꼴에 없는 글자들. 글꼴을 일부러 바꾼 경우에는 따질 것이 없다.
     */
    /*
     * 여러 글꼴에 걸친 대상(크롬 PDF)이면 그 글꼴들을 다 모아 둔다. 없는 글자는
     * 그중 **어느 것에도** 없는 글자다. 괄호는 이 글꼴에, 한글은 저 글꼴에
     * 있는 문서가 흔하다.
     */
    const homes = homeSlots(target, slot)
    const gaps = edit.face ? '' : missingAcross(homes, edit.text)
    const named = stripSubsetTag(slot.baseFont || '')
    /*
     * 없는 글자만 갈아 끼우려면 글꼴을 중간에 바꿔 가며 적어야 한다. 그건
     * `TJ` 배열 안에서는 못 하므로 다시 그리는 길로 간다.
     */
    const mixing = gaps.length > 0 && edit.fill === 'mix'
    /*
     * 대신 쓸 글꼴이 필요하면 여기서 먼저 고른다. 글자의 말에 맞는 글꼴부터 해 보고, 그 글꼴에도 없는 글자가
     * 있으면 다음 글꼴을 해 본다. 끝내 없는 글자가 남으면 고치지 않고 그 글자를 알린다(빈칸으로 저장하지 않게).
     */
    let pickedWant: SpareFace | null = null
    if ((edit.face || gaps.length > 0) && fallback) {
      const need = edit.face || !mixing ? edit.text : gaps
      const first: SpareFace = scriptFace(edit.text, named) ?? edit.face ?? recommendFace(named)
      let best: { which: SpareFace; font: PDFFont | null; lacks: string } | null = null
      for (const which of [first, ...nextFaces(first, edit.text)]) {
        let font: PDFFont | null = spare && spare.which === which ? spare.font : null
        let lacks: string
        if (font) lacks = lackingIn(font, need)
        else if (covers) lacks = await covers(which, need)
        else {
          font = await fallback(which)
          lacks = lackingIn(font, need)
        }
        if (!best || lacks.length < best.lacks.length) best = { which, font, lacks }
        if (!lacks) break
      }
      if (best && !best.lacks && !best.font) best.font = await fallback(best.which)
      if (best && best.lacks) {
        done.set(edit, { ok: false, why: 'noGlyph', hint: best.lacks, spare: true })
        continue
      }
      if (best && best.font && (!spare || spare.which !== best.which)) {
        spare = { font: best.font, which: best.which, key: `EZ${Math.random().toString(36).slice(2, 8)}` }
        spareIn.clear()
      }
      pickedWant = best?.which ?? null
    }
    if (moved || spread || decorated || mixing) {
      const wipe = planPatches(target, '', slot)
      if (!wipe) {
        done.set(edit, { ok: false, why: 'notFound', hint: hintNear(ops, edit) })
        continue
      }

      // 글꼴은 원본 그대로가 기본이고, 못 적거나 일부러 바꿀 때만 새로 심는다.
      let key = edit.face ? null : fontOnPage(slot)
      let written = edit.face ? null : encodeWith(slot, edit.text)
      let usedOriginal = true
      if (key === null || written === null) {
        if (!fallback) {
          done.set(edit, { ok: false, why: 'noGlyph' })
          continue
        }
        const want: SpareFace = pickedWant ?? scriptFace(edit.text, named) ?? edit.face ?? recommendFace(named)
        if (!spare || spare.which !== want) {
          const font = await fallback(want)
          spare = { font, which: want, key: `EZ${Math.random().toString(36).slice(2, 8)}` }
          spareIn.clear()
        }
        if (!spareIn.has(root)) {
          root.addFont(spare.key, spare.font.ref)
          spareIn.add(root)
        }
        key = spare.key
        written = spare.font.encodeText(edit.text).toString().slice(1, -1)
        usedOriginal = false
      }

      const list = dirty.get(head.source) ?? []
      for (const patch of wipe) list.push(patch)
      dirty.set(head.source, list)

      const [r, g, b] = rgbOf(edit.color)
      /*
       * 새로 적는 행렬은 배율이 1이다. 그러니 크기도 화면에서 잰 실제 값을
       * 써야 한다. 원본의 `Tf` 값을 그대로 가져오면, 행렬에 배율이 들어 있던
       * 문서에서 글자가 그 배율만큼 커지거나 작아진다.
       */
      const size = edit.size ?? head.size

      /*
       * 원본이 칠하고 테두리까지 그리는 방식(`2 Tr`)이었다면 그대로 따라 한다.
       * 선 굵기도 배율을 따라간다. 원본의 `w` 는 그 자리의 그리기 행렬 아래에서
       * 잰 값인데, 우리는 행렬을 원점으로 돌려놓고 그리므로 그대로 쓰면 그
       * 배율만큼 굵어진다.
       */
      const shrink = head.size > 0 ? size / head.size : 1
      /*
       * 굵게는 글꼴을 바꾸지 않는다. 원본 글꼴에 굵은 짝이 없기 때문이다.
       * 대신 칠하면서 테두리까지 그리게 해서(`2 Tr`) 획을 불린다. 이 문서가
       * 제목에 쓰던 방식과 같다.
       */
      const stroke = edit.bold
        ? Math.max(0.3, size * 0.035)
        : Number(head.penWidth) * shrink
      const paints = edit.bold || head.render !== '0'
      /*
       * 칠하지 않는 경우에도 `0 Tr` 을 적는다. 안 적으면 스트림 끝에 남아 있던
       * 그리기 모드를 물려받는다. 글자를 안 보이게 깔아 두는 문서(스캔본 위에
       * OCR 글자를 `3 Tr` 로 얹은 것)에서는 고친 글자까지 안 보이게 된다.
       */
      const mode = paints
        ? ` ${round(stroke)} w ${edit.bold ? 2 : head.render} Tr ${r} ${g} ${b} RG`
        : ' 0 Tr'
      const left = edit.x + (edit.dx ?? 0)
      const foot = height - (edit.baseline + (edit.dy ?? 0))
      const at = `${round(left)} ${round(foot)}`
      /*
       * 가로 배율.
       *
       * **pdf.js 가 주는 hscale 을 그대로 쓰면 안 된다.** 한 글자씩 따로 찍어
       * 자간을 벌린 문서(한글 문서가 제목을 그렇게 뽑는다)에서 그 값이 크게
       * 어긋난다. 실제로 겪은 문서에서는 제목 한 줄이 이랬다.
       *
       *   「2026년 혁신 소상공인   잰 너비 215.05  ·  hscale 1.424
       *   AI 활용지원 사업」       잰 너비 166.75  ·  hscale 0.802
       *   참여 소상공인 모집 공고   잰 너비 228.80  ·  hscale 1.000
       *
       * 같은 줄, 같은 글꼴, 같은 크기인데 배율이 셋 다 다르다. 스트림에는
       * `Tz` 가 한 개도 없다. 그대로 믿고 1.424 로 그리면 고친 글자만 옆으로
       * 42% 늘어나 뚱뚱해지고, 0.802 쪽을 고치면 찌부러진다.
       *
       * 잰 너비(`edit.w`)는 맞다. 다음 조각의 x 와 정확히 이어진다. 그래서
       * 배율은 **너비에서 되짚는다** — 원본이 한 칸에 실제로 몇 pt 를 썼는지
       * 보고, 새 글자를 그 칸에 맞춘다. 진짜로 장평을 좁힌 문서라면 잰 너비가
       * 그만큼 좁게 나오므로 이 셈이 그대로 좁은 배율을 돌려준다.
       */
      const homeUnits = textUnits(edit.original)
      // 잰 너비는 **고치기 전 크기**에서 잰 값이다. 크기를 바꿨다면 그 크기로 나눈다.
      const homeSize = edit.homeSize ?? size
      const measured = edit.w && homeUnits > 0 && homeSize > 0 ? edit.w / (homeUnits * homeSize) : 0
      // 재지 못했을 때만 pdf.js 값으로 물러난다. 터무니없는 값은 버린다.
      const wide = measured >= 0.2 && measured <= 5 ? measured : (edit.hscale ?? 1)
      const scale = round(wide)
      // 기울임은 글자 행렬의 밀기 자리에 넣는다. 12도쯤이면 이탤릭처럼 보인다.
      const lean = edit.italic ? round(Math.tan((12 * Math.PI) / 180)) : 0
      /*
       * 없는 글자만 갈아 끼우는 길. 원본으로 적을 수 있는 토막과 없는 토막을
       * 번갈아 적으면서 그 사이에 `Tf` 로 글꼴을 바꾼다. `Tj` 는 적은 만큼
       * 자리를 알아서 밀어 주므로 토막을 이어 붙이기만 하면 된다.
       */
      let mixed: string | null = null
      if (mixing && fallback) {
        const homeKey = fontOnPage(slot)
        if (homeKey) {
          const want: SpareFace = pickedWant ?? scriptFace(edit.text, named) ?? edit.face ?? recommendFace(named)
          if (!spare || spare.which !== want) {
            const font = await fallback(want)
            spare = { font, which: want, key: `EZ${Math.random().toString(36).slice(2, 8)}` }
            spareIn.clear()
          }
          if (!spareIn.has(root)) {
            root.addFont(spare.key, spare.font.ref)
            spareIn.add(root)
          }
          const parts: string[] = []
          // 글자마다 그 글자를 가진 원본 글꼴로 적는다. 어디에도 없으면 대신 쓸 글꼴로.
          for (const piece of splitAcross(homes, edit.text)) {
            const home = piece.slot ? fontOnPage(piece.slot) : null
            const hex =
              piece.slot && home
                ? encodeWith(piece.slot, piece.text)
                : spare.font.encodeText(piece.text).toString().slice(1, -1)
            if (hex === null) {
              parts.length = 0
              break
            }
            const which = piece.slot && home ? home : spare.key
            parts.push(`/${which} ${round(size)} Tf <${hex}> Tj`)
          }
          if (parts.length) {
            mixed = parts.join(' ')
            // 첫 토막이 제 글꼴을 들고 있으므로 앞에 붙는 `Tf` 는 필요 없다.
            usedOriginal = false
          }
        }
      }

      /*
       * 쪽 본문 맨 뒤에 붙인다. 그런데 그 앞이 `q` 로 열어 놓고 안 닫은 채로
       * 끝나는 문서가 있다. 그러면 그때 걸어 둔 오려내기나 그리기 행렬이
       * 우리 글자에도 그대로 걸려서, 엉뚱한 자리에 가거나 아예 안 보인다.
       * 남은 만큼 닫아 주고 시작한다.
       */
      const tail = tailState(root.bytes)
      const close = 'Q '.repeat(Math.max(0, tail.depth))
      const reset = invert(tail.ctm).map(round).join(' ')
      /*
       * 밑줄과 취소선은 글자가 아니라 가는 네모다. 길이는 고친 글자의
       * 너비인데, 글꼴의 글자 너비표가 서브셋에는 없을 때가 많다. 글자가
       * 그대로면 원본 자리의 너비를 쓰고, 바뀌었으면 어림해서 잰다.
       */
      const rules: string[] = []
      if (edit.underline || edit.strike) {
        const span = ruleWidth(edit, size)
        const thick = round(Math.max(0.4, size * (edit.bold ? 0.075 : 0.05)))
        const bar = (y: number) =>
          rules.push(`${round(left)} ${round(y)} ${round(span)} ${thick} re f`)
        if (edit.underline) bar(foot - size * 0.14)
        if (edit.strike) bar(foot + size * 0.26)
      }
      const ruled = rules.length ? ` ${rules.join(' ')}` : ''
      const body = mixed ?? `/${key} ${round(size)} Tf <${written}> Tj`
      /*
       * 글자 상태를 기본값으로 되돌리고 시작한다.
       *
       * `Tz`(장평) · `Tc`(자간) · `Tw`(어간) · `Ts`(올림)는 그래픽 상태에 남아
       * 다음 `BT` 로 그대로 넘어간다. `q`/`Q` 는 저장해 둔 값을 되돌릴 뿐이라
       * 기본값으로 만들어 주지 않는다. 우리는 스트림 **맨 뒤**에 붙이므로,
       * 그 쪽이 마지막으로 정해 둔 값을 고스란히 물려받는다.
       *
       * 장평이 특히 나쁘다. pdf.js 는 `Tz` 를 글자 행렬에 이미 곱해서 주므로
       * (pdf.worker.mjs 의 getCurrentTextTransform) 우리가 재는 hscale 에
       * 장평이 들어 있다. 그 hscale 을 `Tm` 에 적는데 `Tz` 까지 살아 있으면
       * 장평이 두 번 걸린다. 90% 짜리 문서에서 81% 가 되어, 고친 글자만
       * 가로로 찌부러진다.
       */
      const fresh = '100 Tz 0 Tc 0 Tw 0 Ts'
      const draw = `\n${close}q ${reset} cm BT ${fresh} ${r} ${g} ${b} rg${mode} ${scale} ${lean ? `0 ${lean}` : '0 0'} 1 ${at} Tm ${body} ET ${r} ${g} ${b} rg${ruled} Q\n`
      const queue = dirty.get(root) ?? []
      queue.push({ start: root.bytes.length, end: root.bytes.length, bytes: ascii(draw) })
      dirty.set(root, queue)

      done.set(edit, {
        ok: true,
        original: usedOriginal,
        missing: gaps || undefined,
        baseFont: named || undefined,
      })
      continue
    }

    /*
     * 꾸밈이 바뀌었는지 본다. 글자만 바뀌었다면 문자열 조각만 갈아 끼우면
     * 되지만, 크기·색·글꼴이 바뀌었다면 `Tf` 와 `rg` 를 함께 적어야 한다.
     * 그건 `TJ` 배열 안에 못 넣으므로 명령을 다시 쓰는 길로 간다.
     */
    /*
     * 꾸밈이 바뀌었는가. 크기는 값이 왔다고 바뀐 것이 아니다. 실제 크기는 늘
     * 오므로, 고치기 전과 견주어 달라졌을 때만 손댄다.
     */
    const resized = edit.size !== undefined && edit.homeSize !== undefined && edit.size !== edit.homeSize
    const styled = Boolean(edit.face || resized || edit.color !== undefined)
    let patches = styled ? null : planPatches(target, edit.text, slot)
    let usedOriginal = true

    if (!patches) {
      /*
       * 제자리에서 고칠 때는 원본의 행렬이 그대로 살아 있다. 그러니 `Tf` 에
       * 적을 값은 실제 크기가 아니라 **원본 `Tf` 를 바뀐 비율만큼 늘린 것**이다.
       */
      const ratio = resized ? edit.size! / edit.homeSize! : 1
      const style: Styling = {
        size: null,
        ratio,
        color: edit.color ?? null,
        spare: null,
      }

      // 먼저 원본 글꼴 그대로 해 본다. 글꼴을 바꿔 달라고 했으면 건너뛴다.
      if (!edit.face) patches = planStyled(target, edit.text, slot, style)

      if (!patches) {
        /*
         * 원본 글꼴에 그 글자가 없거나, 일부러 다른 글꼴을 골랐다.
         *
         * 그래도 덮지 않는다. 글꼴 하나를 새로 심고 그 자리에서만 갈아 끼운다.
         */
        if (!fallback) {
          done.set(edit, { ok: false, why: 'noGlyph' })
          continue
        }
        const want: SpareFace = pickedWant ?? scriptFace(edit.text, named) ?? edit.face ?? recommendFace(named)
        if (!spare || spare.which !== want) {
          const font = await fallback(want)
          spare = { font, which: want, key: `EZ${Math.random().toString(36).slice(2, 8)}` }
          spareIn.clear()
        }
        if (!spareIn.has(head.source)) {
          head.source.addFont(spare.key, spare.font.ref)
          spareIn.add(head.source)
        }
        patches = planStyled(target, edit.text, slot, { ...style, spare })
        usedOriginal = false
      }

      if (!patches) {
        done.set(edit, { ok: false, why: 'noGlyph' })
        continue
      }
    }

    const list = dirty.get(head.source) ?? []
    for (const patch of patches) list.push(patch)
    dirty.set(head.source, list)
    done.set(edit, {
      ok: true,
      original: usedOriginal,
      missing: gaps || undefined,
      baseFont: named || undefined,
    })
  }

  /*
   * 고친 스트림을 갈아 끼운다. pdf-lib 가 이 쪽에 무언가 그리기 전에 해야
   * 한다. 나중에 하면 pdf-lib 가 붙여 둔 내용이 통째로 날아간다.
   */
  for (const [source, patches] of dirty) {
    patches.sort((a, b) => b.start - a.start)
    let out = source.bytes
    for (const patch of patches) {
      const next = new Uint8Array(out.length - (patch.end - patch.start) + patch.bytes.length)
      next.set(out.subarray(0, patch.start), 0)
      next.set(patch.bytes, patch.start)
      next.set(out.subarray(patch.end), patch.start + patch.bytes.length)
      out = next
    }
    source.write(out)
  }
  return done
}

/** 고칠 자리. 명령 몇 개에 걸쳐 있을 수 있고, 명령 안의 한 토막일 수도 있다. */
interface Target {
  /** 이어 붙여 센 명령들 */
  ops: ShowOp[]
  /** 그 글자들을 이어 붙인 문자열에서의 범위 */
  from: number
  to: number
}

/** 대상이 쓰는 글꼴들. 고른 글꼴을 맨 앞에 두고, 나머지는 나온 차례대로 한 번씩. */
function homeSlots(target: Target, first: FontSlot): FontSlot[] {
  const out = [first]
  for (const op of target.ops) if (op.slot && !out.includes(op.slot)) out.push(op.slot)
  return out
}

/** 어느 글꼴로도 못 적는 글자만. 순서대로, 중복 없이. */
function missingAcross(slots: FontSlot[], text: string): string {
  let out = ''
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    if (slots.some((one) => codeFor(one, cp) !== undefined)) continue
    if (!out.includes(ch)) out += ch
  }
  return out
}

/** 글자를 "그 글자를 가진 첫 글꼴" 별 토막으로 가른다. 아무 데도 없으면 slot 이 null. */
function splitAcross(slots: FontSlot[], text: string): Array<{ slot: FontSlot | null; text: string }> {
  const out: Array<{ slot: FontSlot | null; text: string }> = []
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    const slot = slots.find((one) => codeFor(one, cp) !== undefined) ?? null
    const last = out[out.length - 1]
    if (last && last.slot === slot) last.text += ch
    else out.push({ slot, text: ch })
  }
  return out
}

/** 여러 명령에 걸친 대상에서, 새 글자를 가장 많이 적을 수 있는 글꼴. 같으면 앞의 것. */
function bestSlot(target: Target, text: string): FontSlot {
  let best = target.ops[0]!.slot!
  let fewest = Number.POSITIVE_INFINITY
  const seen = new Set<FontSlot>()
  for (const op of target.ops) {
    const one = op.slot
    if (!one || seen.has(one)) continue
    seen.add(one)
    const miss = missingIn(one, text).length
    if (miss < fewest) {
      best = one
      fewest = miss
    }
  }
  return best
}

/** 공백을 뺀 문자열과, 그 글자가 원래 몇 번째였는지의 표. */
function compact(text: string): { plain: string; at: number[] } {
  let plain = ''
  const at: number[] = []
  for (let i = 0; i < text.length; i += 1) {
    if (/\s/.test(text[i]!)) continue
    plain += text[i]
    at.push(i)
  }
  return { plain, at }
}

/**
 * 고칠 글자가 어느 명령의 어디에 있는지 찾는다.
 *
 * 두 가지가 어긋나 있어서 그냥은 안 맞는다.
 *
 * 첫째, pdf.js 는 한 명령을 낱말 단위로 쪼개 알려 준다. 양쪽정렬한 줄은 보통
 * `[<...> -600 <...>] TJ` 한 덩이인데, pdf.js 는 그걸 낱말 셋으로 나눠 준다.
 * 그래서 찾는 글자가 명령 하나의 **일부**인 경우가 흔하다.
 *
 * 둘째, pdf.js 는 벌어진 자리에 **없는 공백을 만들어** 끼운다. 스트림에는 그
 * 공백 글자가 없다. 그래서 견줄 때 공백은 양쪽에서 다 뺀다.
 */
function findTarget(ops: ShowOp[], edit: RunEdit): Target | null {
  /*
   * 먼저 같은 글꼴로 이어진 명령만 본다. 거기서 못 찾으면 글꼴이 바뀌어도
   * 같은 줄에 이어지는 명령을 한 줄로 본다.
   *
   * 크롬(Skia)이 만든 PDF 가 그렇다(2026-09-24). 한 줄을 글꼴마다, 심지어
   * 글자 몇 개마다 따로 끊어 적는다. 한글은 한 글꼴, 괄호·숫자·공백은 대체
   * 글꼴로 가고, 가변 글꼴·OTF(CFF)·가짜 굵게는 Type3 글꼴 여러 개로 쪼개진다.
   * 같은 글꼴만 이으면 "(주)한빛디자인" 같은 한 덩이를 끝내 못 찾는다.
   */
  return findIn(ops, edit, false) ?? findIn(ops, edit, true)
}

function findIn(ops: ShowOp[], edit: RunEdit, acrossFonts: boolean): Target | null {
  const want = compact(edit.original).plain
  if (!want) return null

  const hits: Array<{ target: Target; sure: boolean }> = []

  for (let i = 0; i < ops.length; i += 1) {
    const head = ops[i]!
    if (!head.slot || !head.text) continue

    // 같은 스트림·같은 글꼴로 이어지는 명령들을 한 줄로 본다.
    const chain: ShowOp[] = []
    let joined = ''
    for (let j = i; j < ops.length; j += 1) {
      const one = ops[j]!
      if (one.source !== head.source) break
      if (one.slot !== head.slot) {
        // 글꼴이 바뀐 명령은 같은 줄일 때만 잇는다. 다른 줄로 넘어가면 다른 글이다.
        if (!acrossFonts || !one.slot || Math.abs(one.baseline - head.baseline) > 1.5) break
      }
      chain.push(one)
      joined += one.text
      if (compact(joined).plain.length >= want.length) break
    }

    const { plain, at } = compact(joined)
    const found = plain.indexOf(want)
    if (found < 0) continue

    const from = at[found]!
    const to = at[found + want.length - 1]! + 1

    // 이 자리가 맞는지. 줄(기준선)이 맞고, 명령이 그 자리에서 시작하거나 그 앞이어야 한다.
    const sure = Math.abs(head.baseline - edit.baseline) < 1.5 && head.x <= edit.x + 1.5
    hits.push({ target: { ops: chain, from, to }, sure })
  }

  const sure = hits.filter((h) => h.sure)
  if (sure.length === 1) return sure[0]!.target
  if (sure.length > 1) {
    // 같은 줄에 같은 글이 여럿이면 시작 자리가 가장 가까운 것을 고른다.
    return sure.sort((a, b) => Math.abs(a.target.ops[0]!.x - edit.x) - Math.abs(b.target.ops[0]!.x - edit.x))[0]!.target
  }
  // 자리로는 못 맞췄다. 문서에 딱 하나뿐일 때만 받는다.
  return hits.length === 1 ? hits[0]!.target : null
}

/**
 * 바꿀 바이트 조각을 짠다.
 *
 * 건드린 조각만 다시 쓴다. `[<가나> -600 <다라>] TJ` 에서 앞 낱말만 고치면
 * 앞 조각만 바뀌고 `-600` 과 뒤 낱말은 그대로 남는다. 줄 전체를 다시 쓰면
 * 양쪽정렬 간격이 무너진다.
 *
 * 원본 글꼴로 못 적는 글자가 하나라도 있으면 null 을 낸다.
 */
function planPatches(
  target: Target,
  text: string,
  slot: FontSlot,
): Array<{ start: number; end: number; bytes: Uint8Array }> | null {
  const out: Array<{ start: number; end: number; bytes: Uint8Array }> = []
  const tracking = trackingOf(target)
  let seen = 0
  let inserted = false

  for (const op of target.ops) {
    for (const part of op.parts) {
      if (part.kind === 'num') {
        /*
         * 글자와 글자 사이를 벌리는 숫자다. 그 사이의 글자를 지웠다면 이 숫자도
         * 같이 빠져야 한다. 남겨 두면 없어진 글자만큼의 간격이 그대로 남아
         * 뒷글자를 밀어낸다. 줄이 갑자기 늘어나 보이는 것이 이것 때문이다.
         */
        if (seen > target.from && seen < target.to) {
          out.push({ start: part.start, end: part.end, bytes: ascii('') })
        }
        continue
      }

      const pieceFrom = seen
      const pieceTo = seen + part.text.length
      seen = pieceTo

      const cutFrom = Math.max(target.from, pieceFrom)
      const cutTo = Math.min(target.to, pieceTo)
      if (cutFrom >= cutTo) continue

      const before = part.text.slice(0, cutFrom - pieceFrom)
      const after = part.text.slice(cutTo - pieceFrom)
      /*
       * 새 글자는 맨 처음 걸린 조각에만 넣는다. 나머지 조각은 고칠 구간을
       * 덜어내기만 한다.
       *
       * 한 조각이라도 못 적으면 통째로 물러난다. 문자열 붙이기로 대충 넘기면
       * null 이 그대로 박혀 스트림이 깨진다. 실제로 그런 적이 있다.
       */
      /*
       * 남기는 글자(before·after)는 그 명령 **자기** 글꼴로 적는다. 대상이
       * 여러 글꼴에 걸쳐 있으면(크롬 PDF) 명령마다 글꼴이 다르다. 새 글자만
       * 고른 글꼴(slot)로 적는다.
       */
      const own = op.slot ?? slot
      const bits = inserted
        ? [spell(own, before + after)]
        : [
            spell(own, before),
            spell(slot, text),
            // 덜어낸 간격을 여기서 한 번에 되돌린다. 뒤따르는 글자가 안 밀린다.
            tracking ? ` ${round(tracking)} ` : '',
            spell(own, after),
          ]
      inserted = true
      if (bits.some((one) => one === null)) return null
      /*
       * 다 지워 빈 조각이 되면 `<>` 를 남긴다. 아무것도 안 남기면 `Tj` 가
       * 피연산자 없이 남는다(`/F1 16 Tf  Tj`). pdf.js 는 그 명령만 건너뛰지만
       * poppler(리눅스·일부 안드로이드 뷰어·인쇄)는 **쪽 전체를 빈 종이로**
       * 그렸다(2026-09-24 확인). `<>` 는 빈 글자 한 줄이라 어느 뷰어에서나 무해하고,
       * `TJ` 배열 안에 들어가도 괜찮다.
       */
      out.push({ start: part.start, end: part.end, bytes: ascii(bits.join('') || '<>') })
    }
  }

  return out.length > 0 ? out : null
}

/** 고친 글자를 어떻게 꾸며 쓸지. 값이 없으면 원본 그대로 둔다. */
interface Styling {
  size: number | null
  /** 원본 `Tf` 값에 곱할 비율. 크기를 안 바꿨으면 1이다. */
  ratio: number
  color: string | null
  /** 원본 글꼴로 못 적을 때(또는 일부러 바꿀 때) 대신 심은 글꼴 */
  spare: { font: PDFFont; key: string } | null
}

/**
 * 글자와 함께 크기·색·글꼴까지 바꾸려고 명령을 다시 쓴다.
 *
 * `Tf` 와 `rg` 는 `TJ` 배열 안에 못 넣는다. 그래서 배열을 끊고, 바꿔 쓰고,
 * 원래 값으로 되돌린 뒤 배열을 다시 잇는다.
 *
 *   [<앞의 남는 부분>] TJ
 *   /새글꼴 18 Tf  1 0 0 rg  <새 글자> Tj
 *   /본래글꼴 13 Tf  0.05 0.06 0.13 rg
 *   [-600 <뒤>] TJ
 *
 * 한 글자 상자(BT..ET) 안에서 명령이 이어지면 그리는 자리도 이어지므로, 이렇게
 * 끊어 써도 글자가 앉는 자리는 그대로다. 간격 숫자도 차례대로 옮긴다.
 */
function planStyled(
  target: Target,
  text: string,
  slot: FontSlot,
  style: Styling,
): Array<{ start: number; end: number; bytes: Uint8Array }> | null {
  const out: Array<{ start: number; end: number; bytes: Uint8Array }> = []
  const tracking = trackingOf(target)
  let seen = 0
  let inserted = false

  for (const op of target.ops) {
    const chunks: string[] = []
    let array: string[] = []
    const flush = () => {
      if (array.length === 0) return
      chunks.push(`[${array.join(' ')}]TJ`)
      array = []
    }

    let touched = false
    for (const part of op.parts) {
      if (part.kind === 'num') {
        // 지워진 구간 안의 간격은 함께 뺀다. planPatches 의 설명 참고.
        if (!(seen > target.from && seen < target.to)) array.push(part.raw)
        continue
      }
      const from = seen
      const to = seen + part.text.length
      seen = to

      const cutFrom = Math.max(target.from, from)
      const cutTo = Math.min(target.to, to)
      if (cutFrom >= cutTo) {
        const hex = encodeWith(slot, part.text)
        if (hex === null) return null
        array.push(`<${hex}>`)
        continue
      }
      touched = true

      const before = part.text.slice(0, cutFrom - from)
      const after = part.text.slice(cutTo - from)
      if (before) {
        const hex = encodeWith(slot, before)
        if (hex === null) return null
        array.push(`<${hex}>`)
      }
      if (!inserted) {
        inserted = true
        /*
         * 대신 심은 글꼴로 적을 때는 자간을 못 물려준다. 그 글꼴의 코드로
         * 적어야 해서 여기서 조각을 나눌 수가 없다. 글꼴이 이미 달라진 자리라
         * 자간까지 맞추는 뜻이 크지 않다.
         */
        const written = style.spare
          ? style.spare.font.encodeText(text).toString()
          : spell(slot, text)
        if (written === null) return null

        const key = style.spare?.key ?? op.resource
        const size = style.size ?? op.size * style.ratio
        const paint = style.color ? ` ${rgbOf(style.color).join(' ')} rg` : ''
        const restore = style.color ? ` ${op.fill}` : ''

        flush()
        chunks.push(
          `/${key} ${round(size)} Tf${paint} ${written} Tj /${op.resource} ${round(op.size)} Tf${restore}`,
        )
        // 덜어낸 간격을 한 번에 되돌린다. 배열을 다시 열어 숫자만 넣는다.
        if (tracking) chunks.push(`[${round(tracking)}]TJ`)
      }
      if (after) {
        const hex = encodeWith(slot, after)
        if (hex === null) return null
        array.push(`<${hex}>`)
      }
    }
    flush()
    if (touched) {
      /*
       * `'` 와 `"` 는 줄을 바꾸고 나서 그린다. 명령을 갈아 끼우면서 그 줄바꿈이
       * 사라지면 글자가 윗줄에 겹쳐 앉는다. `T*` 로 살려 둔다.
       */
      const lead = op.name === "'" || op.name === '"' ? 'T* ' : ''
      out.push({ start: op.start, end: op.end, bytes: ascii(lead + chunks.join(' ')) })
    }
  }

  return out.length > 0 ? out : null
}

/**
 * 고칠 구간에 들어 있던 간격 숫자를 모두 더한다.
 *
 * `TJ` 배열 안의 숫자는 그 자리에서 글자를 앞뒤로 민다. 양수면 왼쪽으로
 * (좁아지고) 음수면 오른쪽으로(벌어진다). 양쪽정렬한 줄이나 장평을 손본
 * 제목이 이 숫자로 모양을 잡는다.
 *
 * 고친 글자에는 **한 덩이로 한 번만** 되돌려 준다. 예전에는 평균을 내서 글자
 * 사이마다 끼웠는데, 원본이 낱말 사이에만 큰 값을 몇 개 넣어 둔 문서에서는
 * 그 값이 글자 수만큼 곱해져 글자가 납작해졌다. 숫자가 어느 글자 짝에
 * 붙어 있었는지는 새 글자에 옮길 방법이 없다. 총량만 지키는 편이 맞다.
 */
function trackingOf(target: Target): number {
  let total = 0
  let seen = 0
  for (const op of target.ops) {
    for (const part of op.parts) {
      if (part.kind === 'num') {
        if (seen > target.from && seen < target.to) total += Number(part.raw)
        continue
      }
      seen += part.text.length
    }
  }
  return total
}

/** 글자를 `TJ` 배열 조각으로 적는다. 빈 글자면 아무것도 적지 않는다. */
function spell(slot: FontSlot, text: string): string | null {
  if (!text) return ''
  const hex = encodeWith(slot, text)
  return hex === null ? null : `<${hex}>`
}

/** 못 찾았을 때, 그 줄 언저리에서 읽은 글자를 조금 보여 준다. 원인을 찾는 실마리다. */
function hintNear(ops: ShowOp[], edit: RunEdit): string {
  const near = ops
    .filter((o) => Math.abs(o.baseline - edit.baseline) < 4 && o.text)
    .map((o) => o.text)
    .join('')
  return near.slice(0, 40)
}

/**
 * 스트림 끝에 무언가 덧붙이기 전에 알아야 할 것 두 가지.
 *
 * 하나는 아직 닫지 않은 `q` 의 개수다. 그만큼 닫아 줘야 그때 걸어 둔
 * 오려내기가 우리 글자까지 자르지 않는다.
 *
 * 다른 하나는 그렇게 닫고 난 뒤에 남는 그리기 행렬이다. `q` 밖에서 `cm` 을
 * 거는 문서가 있다. 실제로 쪽 맨 앞에서 `1 0 0 -1 0 841.88 cm` 으로 위아래를
 * 뒤집고 `0.75 0 0 0.75 0 0 cm` 으로 줄여 두는 문서를 봤다. 그건 `Q` 를 아무리
 * 넣어도 안 풀린다. 남는 행렬의 역행렬을 걸어 셈을 원점으로 돌려놔야 한다.
 */
/**
 * 밑줄·취소선의 길이(pt).
 *
 * 글자가 그대로면 원본 자리에서 잰 너비가 가장 정확하다. 글자를 바꿨으면
 * 글꼴 너비표가 없으므로 어림한다. 한중일 글자는 크기만큼, 나머지는 그
 * 절반쯤을 차지한다고 본다. 자가 한두 픽셀 길고 짧은 것은 눈에 띄지 않는다.
 */
/**
 * 글자가 차지하는 칸 수. 한중일 글자는 한 칸, 나머지는 반 칸으로 센다.
 *
 * 글꼴 너비표를 읽지 않고 어림하는 것인데, 이 사이트가 다루는 문서에서는
 * 꽤 잘 맞는다. 실제로 재 보면 한글 여덟 자가 15pt 에서 119.25pt(= 8 × 14.9),
 * `참여 소상공인 모집 공고` 가 20pt 에서 228.8pt(= 11.5 × 19.9)다. 1% 안쪽이다.
 */
function textUnits(text: string): number {
  let sum = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    const full = cp >= 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0x20000 && cp <= 0x3fffd))
    sum += full ? 1 : 0.5
  }
  return sum
}

function ruleWidth(edit: RunEdit, size: number): number {
  if (edit.w && edit.text === edit.original) return edit.w
  // 배율은 그리기 쪽과 같은 잣대로 구한다(위 `measured` 주석 참고).
  const homeUnits = textUnits(edit.original)
  const homeSize = edit.homeSize ?? size
  const measured = edit.w && homeUnits > 0 && homeSize > 0 ? edit.w / (homeUnits * homeSize) : 0
  const wide = measured >= 0.2 && measured <= 5 ? measured : (edit.hscale ?? 1)
  return textUnits(edit.text) * size * wide
}

/**
 * 원본 글꼴 이름을 보고 가장 가까운 대체 글꼴을 고른다.
 *
 * 원본 글꼴에 그 글자의 그림이 아예 없을 때 말고는 부를 일이 없다. 그때라도
 * 계열은 맞춰 줘야 한다. 명조로 짜인 본문에 고딕 한 글자가 끼면 그 글자만
 * 도드라진다. 이름에 바탕·명조·serif 가 들어가면 명조로, 아니면 고딕으로 본다.
 *
 * 한컴·MS 의 상용 글꼴은 심을 수 없으니 계열만 따라간다. 맑은고딕·굴림·돋움은
 * 고딕, 바탕·궁서·함초롬바탕은 명조다.
 */
export function recommendFace(name: string): 'gothic' | 'myeongjo' {
  const n = name.toLowerCase()
  if (/gothic|dotum|gulim|굴림|돋움|고딕|sans|arial|helvetica|verdana|tahoma/.test(n)) {
    return 'gothic'
  }
  if (/myeongjo|batang|명조|바탕|궁서|serif|times|roman|georgia|garamond|minion/.test(n)) {
    return 'myeongjo'
  }
  // 알 수 없으면 고딕이다. 화면과 인쇄 양쪽에서 무난하다.
  return 'gothic'
}

function tailState(bytes: Uint8Array): { depth: number; ctm: Matrix } {
  const stack: Matrix[] = []
  let ctm: Matrix = IDENTITY
  let operands: Token[] = []
  for (const token of tokenize(bytes)) {
    if (token.kind !== 'operator') {
      operands.push(token)
      continue
    }
    if (token.value === 'q') stack.push(ctm)
    else if (token.value === 'Q') ctm = stack.pop() ?? ctm
    else if (token.value === 'cm') {
      const nums = operands.filter((t) => t.kind === 'number').map((t) => Number(t.value))
      if (nums.length >= 6) ctm = mul(nums.slice(-6) as Matrix, ctm)
    }
    operands = []
  }
  // 남은 `q` 를 다 닫으면 맨 아래에 쌓아 둔 행렬로 돌아간다.
  return { depth: stack.length, ctm: stack.length > 0 ? stack[0]! : ctm }
}

/** 어파인 행렬의 역행렬. 못 구하면 항등을 낸다(넓이가 0인 행렬). */
function invert(m: Matrix): Matrix {
  const det = m[0] * m[3] - m[1] * m[2]
  if (!det || !Number.isFinite(det)) return IDENTITY
  return [
    m[3] / det,
    -m[1] / det,
    -m[2] / det,
    m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det,
    (m[1] * m[4] - m[0] * m[5]) / det,
  ]
}

/** `#rrggbb` 를 내용 스트림이 쓰는 0~1 값 셋으로. */
function rgbOf(hex: string | undefined): [string, string, string] {
  const v = (hex ?? '#000000').replace('#', '')
  const n = parseInt(v.length === 3 ? v.replace(/./g, '$&$&') : v, 16)
  if (Number.isNaN(n)) return ['0', '0', '0']
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255].map(round) as [
    string,
    string,
    string,
  ]
}

/** 내용 스트림에 적을 숫자. 소수점이 길면 읽기만 나빠진다. */
const round = (n: number) => String(Math.round(n * 100) / 100)

const ascii = (text: string) => {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i)
  return out
}
