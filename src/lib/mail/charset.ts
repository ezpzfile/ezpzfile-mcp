/**
 * 메일 글자 인코딩 손보기(.eml·.mbox·.emlx 같은 MIME 원문).
 *
 * postal-mime 은 본문은 메일이 밝힌 charset 으로 잘 풀지만, 머리글(제목·보낸 사람)은 늘 UTF-8 로 읽는다.
 * 옛 한국·일본 메일은 머리글을 인코딩 표시 없이 EUC-KR·Shift_JIS 바이트 그대로 적은 것이 많아 제목이 깨진다.
 * 그래서 넘기기 전에 맨 위 머리글 묶음만 UTF-8 로 바꿔 둔다.
 *
 * 사용자가 인코딩을 직접 고르면(인코딩 메뉴) 머리글을 그 인코딩으로 다시 풀고, 글 부분의 charset 표시도
 * 모두 그 인코딩으로 바꿔 끼운다. 메일이 엉뚱한 charset 을 밝혔을 때 바로잡는 길이다.
 */

/** 인코딩 메뉴. value 는 TextDecoder 가 아는 이름 */
export const ENCODINGS: { value: string; label: string }[] = [
  { value: 'utf-8', label: 'UTF-8' },
  { value: 'euc-kr', label: 'EUC-KR (CP949)' },
  { value: 'shift_jis', label: 'Shift_JIS' },
  { value: 'iso-2022-jp', label: 'ISO-2022-JP' },
  { value: 'euc-jp', label: 'EUC-JP' },
  { value: 'gb18030', label: 'GB18030 (GBK)' },
  { value: 'big5', label: 'Big5' },
  { value: 'windows-1252', label: 'Windows-1252' },
  { value: 'iso-8859-2', label: 'ISO-8859-2' },
  { value: 'windows-1251', label: 'Windows-1251' },
  { value: 'koi8-r', label: 'KOI8-R' },
  { value: 'windows-1256', label: 'Windows-1256' },
  { value: 'windows-874', label: 'Windows-874' },
  { value: 'windows-1258', label: 'Windows-1258' },
]

const latin1 = new TextDecoder('latin1')

function binToBytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff
  return out
}

/** 맨 위 머리글이 끝나는 곳(빈 줄 앞). 없으면 -1 */
export function headerEnd(b: Uint8Array, limit = b.length): number {
  const n = Math.min(b.length, limit)
  for (let i = 0; i < n - 1; i++) {
    if (b[i] === 0x0a) {
      if (b[i + 1] === 0x0a) return i + 1
      if (b[i + 1] === 0x0d && b[i + 2] === 0x0a) return i + 1
    }
  }
  return -1
}

function has8bit(b: Uint8Array): boolean {
  for (let i = 0; i < b.length; i++) if (b[i]! >= 0x80) return true
  return false
}

function isUtf8(b: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(b)
    return true
  } catch {
    return false
  }
}

function decoderFor(label: string): TextDecoder | null {
  try {
    return new TextDecoder(label)
  } catch {
    return null
  }
}

/** chardet 이 돌려주는 이름을 TextDecoder 이름으로 */
function normLabel(name: string | null | undefined): string | null {
  if (!name) return null
  const n = name.toLowerCase()
  if (n === 'utf-8' || n === 'ascii') return 'utf-8'
  if (n.startsWith('iso-8859-1')) return 'windows-1252'
  return decoderFor(n) ? n : null
}

/** 풀어 본 글이 그럴듯한가(점수). 한글·가나·한자는 높게, 깨진 글자·제어 문자는 낮게 */
function plausibility(text: string): number {
  let score = 0
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    if (c < 0x80) continue
    if (c === 0xfffd) score -= 5
    else if (c >= 0xac00 && c <= 0xd7a3) score += 2
    else if ((c >= 0x3040 && c <= 0x30ff) || (c >= 0x4e00 && c <= 0x9fff)) score += 1.5
    else if (c >= 0x0400 && c <= 0x04ff) score += 1
    else if (/\p{L}/u.test(ch)) score += c < 0x250 ? 0.2 : 0.5
    else score -= 1
  }
  return score
}

/** 8비트 머리글의 인코딩을 짐작한다. 메일이 밝힌 charset 이 먼저, 없으면 후보들로 풀어 보고 가장 그럴듯한 것 */
async function guess(head: Uint8Array, declared: string | null): Promise<string> {
  if (declared && decoderFor(declared) && !/^(us-ascii|utf-?8)$/i.test(declared)) return declared
  const cands = new Set<string>()
  try {
    const chardet = await import('chardet')
    for (const m of (chardet.default ?? chardet).analyse(head).slice(0, 4)) {
      const l = normLabel(m.name)
      if (l && l !== 'utf-8') cands.add(l)
    }
  } catch {
    /* 짐작 못 하면 아래 후보 */
  }
  for (const l of ['euc-kr', 'shift_jis', 'gb18030', 'big5', 'windows-1251', 'windows-1252']) cands.add(l)
  let best = 'euc-kr'
  let bestScore = -Infinity
  for (const l of cands) {
    try {
      const sc = plausibility(new TextDecoder(l, { fatal: true }).decode(head))
      if (sc > bestScore) {
        best = l
        bestScore = sc
      }
    } catch {
      /* 이 인코딩으로는 안 풀린다 */
    }
  }
  return best
}

/** 머리글 안에서 맨 처음 보이는 charset= 값 */
function declaredCharset(text: string): string | null {
  const m = text.match(/charset\s*=\s*"?([A-Za-z0-9_.:-]+)"?/i)
  return m ? m[1]!.toLowerCase() : null
}

/**
 * postal-mime 에 넘기기 전에 바이트를 손본다.
 * @param override 사용자가 고른 인코딩(없으면 자동)
 */
export async function fixCharset(bytes: Uint8Array, override?: string | null): Promise<Uint8Array> {
  const end = headerEnd(bytes, 256 * 1024)
  const head = end > 0 ? bytes.subarray(0, end) : bytes.subarray(0, 0)
  const rest = end > 0 ? bytes.subarray(end) : bytes
  let headOut: Uint8Array = head
  let restOut: Uint8Array = rest

  if (override) {
    // 머리글: 8비트면 고른 인코딩으로 풀어 UTF-8 로
    if (has8bit(head)) {
      const dec = decoderFor(override)
      if (dec) headOut = new TextEncoder().encode(dec.decode(head))
    }
    // 모든 charset 표시를 고른 인코딩으로. 글 부분에 charset 이 없으면 넣는다
    const swap = (s: string) =>
      s
        .replace(/(charset\s*=\s*)"?[A-Za-z0-9_.:-]+"?/gi, `$1"${override}"`)
        .replace(/(content-type:\s*text\/[a-z]+)(?![^\r\n]*charset)/gi, `$1; charset="${override}"`)
    headOut = new TextEncoder().encode(swap(new TextDecoder('utf-8').decode(headOut)))
    if (!/^content-type:/im.test(new TextDecoder('utf-8').decode(headOut))) {
      const add = new TextEncoder().encode(`Content-Type: text/plain; charset="${override}"\r\n`)
      const merged = new Uint8Array(add.length + headOut.length)
      merged.set(add)
      merged.set(headOut, add.length)
      headOut = merged
    }
    // 몸통 안 부분 머리글(Content-Type 줄)만 바꾼다. 몸통 바이트는 그대로 둔다(latin1 은 1바이트 = 1글자라 안전하다)
    restOut = binToBytes(swap(latin1.decode(rest)))
  } else if (has8bit(head) && !isUtf8(head)) {
    const cs = await guess(head, declaredCharset(latin1.decode(head)))
    const dec = decoderFor(cs)
    if (dec) {
      headOut = new TextEncoder().encode(dec.decode(head))
      // 머리글이 UTF-8 이라고 밝혔는데 실제로는 아니면, 몸통도 같은 옛 인코딩으로 본다(맨 위가 글 한 덩어리일 때)
      let text = new TextDecoder('utf-8').decode(headOut)
      if (/^content-type:\s*text\//im.test(text)) text = text.replace(/(charset\s*=\s*)"?(utf-?8|us-ascii)"?/i, `$1"${cs}"`)
      headOut = new TextEncoder().encode(text)
      if (!/charset\s*=/i.test(text) && (!/^content-type:/im.test(text) || /^content-type:\s*text\//im.test(text))) {
        const fixed = /^content-type:/im.test(text)
          ? text.replace(/^(content-type:\s*text\/[a-z]+)/im, `$1; charset="${cs}"`)
          : `Content-Type: text/plain; charset="${cs}"\r\n${text}`
        headOut = new TextEncoder().encode(fixed)
      }
    }
  } else if (!has8bit(head) && has8bit(rest.subarray(0, 65536)) && !/charset\s*=/i.test(latin1.decode(head)) && !/^content-type:\s*multipart/im.test(latin1.decode(head))) {
    // 머리글은 깨끗한데 몸통이 charset 없이 8비트 글이면 짐작해서 표시를 넣는다
    const sample = rest.subarray(0, 65536)
    if (!isUtf8(sample)) {
      const cs = await guess(sample, null)
      const text = latin1.decode(head)
      const fixed = /^content-type:/im.test(text)
        ? text.replace(/^(content-type:\s*text\/[a-z]+)/im, `$1; charset="${cs}"`)
        : `Content-Type: text/plain; charset="${cs}"\r\n${text}`
      headOut = binToBytes(fixed)
    }
  }

  if (headOut === head && restOut === rest) return bytes
  const out = new Uint8Array(headOut.length + restOut.length)
  out.set(headOut)
  out.set(restOut, headOut.length)
  return out
}

/** 맨 위 머리글을 글로(8비트면 짐작한 인코딩으로) */
export async function headerText(bytes: Uint8Array): Promise<string> {
  const end = headerEnd(bytes, 256 * 1024)
  const head = end > 0 ? bytes.subarray(0, end) : bytes.subarray(0, Math.min(bytes.length, 16384))
  if (!has8bit(head) || isUtf8(head)) return new TextDecoder('utf-8').decode(head)
  const cs = await guess(head, declaredCharset(latin1.decode(head)))
  return (decoderFor(cs) ?? new TextDecoder('utf-8')).decode(head)
}

/** 같은 일을 기다리지 않고(목록용, 수만 통). 8비트 머리글은 hint 인코딩으로 */
export function headerTextSync(head: Uint8Array, hint: string | null): string {
  if (!has8bit(head) || isUtf8(head)) return new TextDecoder('utf-8').decode(head)
  const cs = declaredCharset(latin1.decode(head)) ?? hint ?? 'euc-kr'
  return (decoderFor(cs) ?? decoderFor('euc-kr')!).decode(head)
}
