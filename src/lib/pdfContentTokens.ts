/**
 * PDF 내용 스트림을 토막으로 끊는다.
 *
 * 내용 스트림은 그리기 명령을 늘어놓은 것이다. `BT /F1 24 Tf 1 0 0 1 60 760 Tm
 * <00410042> Tj ET` 처럼 생겼다. 글자를 제자리에서 고치려면 이 안에서 글자
 * 문자열이 있는 **바이트 자리**를 정확히 집어야 해서, 글자로 대충 찾지 않고
 * 제대로 끊는다.
 *
 * 조심할 곳이 몇 군데 있다.
 *   - `(...)` 문자열 안에는 괄호가 짝을 맞춰 들어갈 수 있고 `\` 로 벗어난다.
 *   - `<<` 는 사전의 시작이고 `<` 하나는 16진 문자열이다.
 *   - `BI ... ID <그림 바이트> EI` 는 그림을 그대로 끼워 넣은 것이라
 *     그 안을 명령으로 읽으면 안 된다.
 *   - `%` 뒤는 줄 끝까지 주석이다.
 */

export type TokenKind =
  | 'number'
  | 'name'
  | 'string'
  | 'hex'
  | 'arrayOpen'
  | 'arrayClose'
  | 'dictOpen'
  | 'dictClose'
  | 'operator'

export interface Token {
  kind: TokenKind
  /** 스트림 안에서의 바이트 범위. 끝은 열린 구간이다. */
  start: number
  end: number
  /** number 는 값, name 과 operator 는 글자, hex 는 16진 본문 */
  value: string
}

const WHITE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20])
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25])
const isWhite = (c: number) => WHITE.has(c)
const isDelim = (c: number) => DELIM.has(c)
const isRegular = (c: number) => !isWhite(c) && !isDelim(c)

const latin1 = (bytes: Uint8Array, start: number, end: number) => {
  let out = ''
  for (let i = start; i < end; i += 1) out += String.fromCharCode(bytes[i]!)
  return out
}

export function tokenize(bytes: Uint8Array): Token[] {
  const out: Token[] = []
  let i = 0

  while (i < bytes.length) {
    const c = bytes[i]!

    if (isWhite(c)) {
      i += 1
      continue
    }

    // 주석
    if (c === 0x25) {
      while (i < bytes.length && bytes[i] !== 0x0a && bytes[i] !== 0x0d) i += 1
      continue
    }

    // 이름
    if (c === 0x2f) {
      const start = i
      i += 1
      while (i < bytes.length && isRegular(bytes[i]!)) i += 1
      out.push({ kind: 'name', start, end: i, value: decodeName(latin1(bytes, start + 1, i)) })
      continue
    }

    // 문자열
    if (c === 0x28) {
      const start = i
      i += 1
      let depth = 1
      while (i < bytes.length && depth > 0) {
        const b = bytes[i]!
        if (b === 0x5c) i += 2
        else {
          if (b === 0x28) depth += 1
          else if (b === 0x29) depth -= 1
          i += 1
        }
      }
      out.push({ kind: 'string', start, end: i, value: latin1(bytes, start + 1, i - 1) })
      continue
    }

    // 사전 또는 16진 문자열
    if (c === 0x3c) {
      if (bytes[i + 1] === 0x3c) {
        out.push({ kind: 'dictOpen', start: i, end: i + 2, value: '<<' })
        i += 2
        continue
      }
      const start = i
      i += 1
      while (i < bytes.length && bytes[i] !== 0x3e) i += 1
      const value = latin1(bytes, start + 1, i).replace(/[^0-9a-fA-F]/g, '')
      i += 1
      out.push({ kind: 'hex', start, end: i, value })
      continue
    }
    if (c === 0x3e && bytes[i + 1] === 0x3e) {
      out.push({ kind: 'dictClose', start: i, end: i + 2, value: '>>' })
      i += 2
      continue
    }

    if (c === 0x5b) {
      out.push({ kind: 'arrayOpen', start: i, end: i + 1, value: '[' })
      i += 1
      continue
    }
    if (c === 0x5d) {
      out.push({ kind: 'arrayClose', start: i, end: i + 1, value: ']' })
      i += 1
      continue
    }

    // 숫자이거나 명령어
    const start = i
    while (i < bytes.length && isRegular(bytes[i]!)) i += 1
    if (i === start) {
      // 짝 없는 구분자. 건너뛴다.
      i += 1
      continue
    }
    const text = latin1(bytes, start, i)
    if (/^[-+.\d]/.test(text) && !Number.isNaN(Number(text))) {
      out.push({ kind: 'number', start, end: i, value: text })
      continue
    }
    out.push({ kind: 'operator', start, end: i, value: text })

    /*
     * 끼워 넣은 그림. ID 다음은 그림 바이트라 명령으로 읽으면 안 된다.
     * EI 앞뒤로 공백이 오는 것을 표지 삼아 건너뛴다.
     */
    if (text === 'ID') {
      i += 1
      while (i < bytes.length - 1) {
        if (
          bytes[i] === 0x45 &&
          bytes[i + 1] === 0x49 &&
          (i + 2 >= bytes.length || isWhite(bytes[i + 2]!) || isDelim(bytes[i + 2]!)) &&
          isWhite(bytes[i - 1]!)
        ) {
          out.push({ kind: 'operator', start: i, end: i + 2, value: 'EI' })
          i += 2
          break
        }
        i += 1
      }
    }
  }

  return out
}

/** 이름 안의 `#20` 같은 표기를 푼다. */
function decodeName(raw: string): string {
  return raw.replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
}
