/**
 * 원본 PDF 에 이미 심겨 있는 글꼴을 그대로 다시 쓴다.
 *
 * 왜 이렇게까지 하는가. 원본 글자를 고칠 때 우리 글꼴(프리텐다드 같은)로 다시
 * 쓰면 그 줄만 모양이 달라진다. 오타 하나 고치려고 들어왔는데 문단 하나가
 * 눈에 띄게 뜨는 셈이다. 원본이 쓰던 글꼴로 써야 고친 티가 안 난다.
 *
 * 방법은 이렇다. pdf-lib 의 copyPages 는 쪽의 자원 사전을 통째로 들고 오므로,
 * 복사된 쪽 안에는 원본 글꼴이 원래 이름 그대로(`/F1`, `/C2_0`) 이미 들어 있다.
 * 그 이름을 가리키는 연산을 손으로 적어 넣으면 글꼴을 새로 심을 필요가 없다.
 *
 * 남는 문제는 "무슨 바이트를 적을 것인가" 다. PDF 의 글자는 유니코드가 아니라
 * 글꼴마다 다른 코드다. 다행히 대부분의 글꼴이 ToUnicode 표를 달고 있는데,
 * 그건 코드에서 유니코드로 가는 표다. 그걸 뒤집으면 우리가 원하는 방향이 된다.
 *
 * 뒤집어도 못 찾는 글자가 있다. 서브셋 글꼴은 그 문서에 실제로 쓰인 자모만
 * 들고 있어서, 문서에 한 번도 안 나온 글자는 애초에 그림이 없다. 그때는
 * 이 파일이 null 을 내고, 부르는 쪽이 대체 글꼴로 넘어간다.
 */
import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRawStream,
  decodePDFRawStream,
  type PDFContext,
  type PDFObject,
  type PDFPage,
} from 'pdf-lib'

export interface FontSlot {
  /** 쪽의 자원 사전에서 이 글꼴을 가리키는 이름. `/F1` 의 F1. */
  resource: string
  /** 서브셋 접두사를 뗀 글꼴 이름. pdfjs 가 알려 주는 이름과 맞춰 본다. */
  baseFont: string
  /**
   * 접두사까지 붙은 그대로의 이름. `ABCDEF+NanumGothic` 처럼.
   *
   * 한 쪽에 같은 글꼴의 서브셋이 둘 있을 수 있고, 그 둘은 코드가 서로 다르다.
   * 접두사를 떼면 구별이 안 되므로 맞출 때는 이쪽을 먼저 본다.
   */
  rawFont: string
  /**
   * 글꼴 사전을 가리키는 참조.
   *
   * 글자를 다른 자리로 옮겨 그릴 때, 그 글꼴을 쪽의 자원 사전에도 올려야 한다.
   * 폼 안에 있던 글꼴은 쪽에서 이름만으로는 찾을 수 없다.
   */
  ref: PDFObject | undefined
  /** 한 글자를 몇 바이트로 적는가. 한중일 글꼴은 보통 2다. */
  codeBytes: number
  /** 유니코드 코드값 → 이 글꼴이 쓰는 코드 */
  map: Map<number, number>
  /** 그 반대. 스트림 안의 글자를 읽어 무엇이 적혀 있는지 알 때 쓴다. */
  reverse: Map<number, number>
  /**
   * 표가 없는 단순 글꼴. 바이트가 곧 아스키다.
   * WinAnsi·MacRoman·Standard 는 0x20~0x7e 구간이 모두 아스키와 같아서,
   * 그 구간에 한해 표 없이도 맞다.
   */
  ascii: boolean
  /**
   * 코드가 곧 유니코드인 글꼴.
   *
   * 한중일 문서가 쓰는 미리 정해진 인코딩 가운데 `UniKS-UCS2-H` 같은 것들은
   * 두 바이트 코드가 UCS-2 값 그대로다. 그래서 ToUnicode 표가 없어도 읽고 쓸
   * 수 있다. 한국 관공서 문서에서 드물지 않다.
   */
  ucs2: boolean
  /**
   * 문서에 심긴 글꼴 파일에서 글리프 번호를 찾아 준다. 없으면 null.
   *
   * pdfjs 가 알려 주는 표에는 **그 쪽에 실제로 쓰인 글자만** 들어 있다. 29쪽
   * 짜리 문서에서 3쪽을 고치는데 그 글자가 7쪽에만 나왔다면, 글꼴에 그림이
   * 멀쩡히 들어 있어도 못 쓰게 된다.
   *
   * 그래서 글꼴 파일 자체를 읽는다. Identity 인코딩에서는 코드가 곧 글리프
   * 번호라, 글꼴의 문자표에 물어보면 바로 답이 나온다. 2MB 짜리를 헛되이
   * 풀지 않도록 정말 필요할 때 한 번만 읽는다.
   */
  glyphId: ((cp: number) => number | undefined) | null
}

/** `ABCDEF+NanumGothic` 처럼 붙는 서브셋 접두사를 뗀다. */
export function stripSubsetTag(name: string): string {
  return name.replace(/^[A-Z]{6}\+/, '')
}

/**
 * 쪽이 쓰는 글꼴을 모두 훑어 코드표를 만든다.
 *
 * 쪽마다 한 번만 부른다. ToUnicode 를 푸는 일이 공짜는 아니다.
 */
/** 글꼴 파일을 푸는 도구. 부르는 쪽이 미리 받아 넘긴다. */
export interface FontkitLike {
  create(bytes: Uint8Array): { glyphForCodePoint(cp: number): { id: number } | undefined }
}

export function fontSlots(page: PDFPage, fontkit?: FontkitLike): FontSlot[] {
  const resources = page.node.Resources()
  return resources ? fontSlotsFrom(page.node.context, resources, fontkit) : []
}

/** 자원 사전 하나에서 글꼴 표를 만든다. 폼(Form XObject)도 자기 것을 갖는다. */
export function fontSlotsFrom(
  context: PDFContext,
  resources: PDFDict,
  fontkit?: FontkitLike,
): FontSlot[] {
  const out: FontSlot[] = []
  const fontsRaw = resources.get(PDFName.of('Font'))
  const fonts = fontsRaw ? context.lookup(fontsRaw) : undefined
  if (!(fonts instanceof PDFDict)) return out

  for (const [key, value] of fonts.entries()) {
    /*
     * lookupMaybe 는 타입이 다르면 던진다. PDF 안의 값은 늘 기대한 타입이
     * 아니어서(`/Encoding` 이 이름일 때도 사전일 때도 있다) 여기서는 그냥
     * 꺼내 보고 직접 확인한다. 글꼴 하나를 못 읽는다고 쪽 전체를 포기할 일이
     * 아니다.
     */
    const dict = context.lookup(value)
    if (!(dict instanceof PDFDict)) continue

    const nameAt = (field: string) => {
      const got = dict.get(PDFName.of(field))
      const one = got ? context.lookup(got) : undefined
      return one instanceof PDFName ? one.decodeText() : ''
    }

    const rawFont = nameAt('BaseFont')
    const ref = fonts.get(key)
    const baseFont = stripSubsetTag(rawFont)
    const subtype = nameAt('Subtype')

    let map = new Map<number, number>()
    let reverse = new Map<number, number>()
    let codeBytes = subtype === 'Type0' ? 2 : 1
    let hasTable = false
    const raw = dict.get(PDFName.of('ToUnicode'))
    const resolved = raw ? context.lookup(raw) : undefined
    const stream = resolved instanceof PDFRawStream ? resolved : undefined
    if (stream) {
      try {
        const text = new TextDecoder('latin1').decode(decodePDFRawStream(stream).decode())
        const parsed = parseToUnicode(text)
        map = parsed.map
        reverse = parsed.reverse
        hasTable = parsed.map.size > 0
        if (parsed.codeBytes) codeBytes = parsed.codeBytes
      } catch {
        // 표를 못 읽어도 글꼴 자체는 멀쩡하다. 아스키 구간이라도 건진다.
      }
    }

    /*
     * 인코딩. 이름 하나일 때도 있고, 기본 인코딩에 낱글자를 덮어쓰는 사전일
     * 때도 있다(`/Differences`). 사전 쪽이 실제 문서에서 아주 흔하다.
     */
    const encRaw = dict.get(PDFName.of('Encoding'))
    const enc = encRaw ? context.lookup(encRaw) : undefined
    const encName =
      enc instanceof PDFName
        ? enc.decodeText()
        : enc instanceof PDFDict
          ? (() => {
              const base = enc.get(PDFName.of('BaseEncoding'))
              const one = base ? context.lookup(base) : undefined
              return one instanceof PDFName ? one.decodeText() : ''
            })()
          : ''

    /*
     * `UniKS-UCS2-H`, `UniJIS-UCS2-V` 같은 미리 정해진 인코딩. 두 바이트 코드가
     * UCS-2 값 그대로라 표 없이도 읽고 쓸 수 있다. Identity-H 는 코드가 글리프
     * 번호라 이 규칙이 안 통한다.
     */
    const ucs2 = subtype === 'Type0' && /^Uni[A-Za-z]+-(UCS2|UTF16)-[HV]$/.test(encName)
    if (ucs2) codeBytes = 2

    /*
     * Type3 는 빼야 한다. 인코딩 이름이 비어 있어 아스키처럼 보이지만, 코드는
     * 그 글꼴이 멋대로 붙인 번호다. 크롬 PDF 의 Type3 글꼴에서 `(` 를 0x28 로
     * 적었더니 빈 글리프가 찍혀 괄호가 사라졌다(2026-09-24).
     */
    const ascii =
      subtype !== 'Type0' &&
      subtype !== 'Type3' &&
      (encName === '' ||
        encName === 'WinAnsiEncoding' ||
        encName === 'MacRomanEncoding' ||
        encName === 'StandardEncoding')

    if (enc instanceof PDFDict) {
      const diffRaw = enc.get(PDFName.of('Differences'))
      const diff = diffRaw ? context.lookup(diffRaw) : undefined
      if (diff instanceof PDFArray) {
        let code = 0
        for (let i = 0; i < diff.size(); i += 1) {
          const item = context.lookup(diff.get(i))
          if (item instanceof PDFNumber) {
            code = item.asNumber()
          } else if (item instanceof PDFName) {
            const cp = codePointForGlyphName(item.decodeText())
            if (cp !== null) {
              if (!map.has(cp)) map.set(cp, code)
              if (!reverse.has(code)) reverse.set(code, cp)
            }
            code += 1
          }
        }
      }
    }

    if (ascii && !hasTable) {
      /*
       * ToUnicode 가 없는 단순 글꼴. WinAnsi·MacRoman·Standard 는 0x20~0x7e
       * 구간이 모두 아스키와 같으므로 그만큼은 표 없이도 맞다. 위에서 읽은
       * Differences 가 먼저이고, 거기서 안 정해진 자리만 채운다.
       */
      for (let cp = 0x20; cp <= 0x7e; cp += 1) {
        if (!map.has(cp)) map.set(cp, cp)
        if (!reverse.has(cp)) reverse.set(cp, cp)
      }
    }
    out.push({
      resource: key.decodeText(),
      baseFont,
      rawFont,
      ref,
      codeBytes,
      map,
      reverse,
      ascii,
      ucs2,
      glyphId: fontkit ? embeddedLookup(context, dict, subtype, encName, fontkit) : null,
    })
  }
  return out
}

/**
 * pdfjs 가 실제로 쓴 코드표로 글꼴 자리를 바로잡는다.
 *
 * ToUnicode 를 손으로 읽는 것보다 pdfjs 쪽이 언제나 맞다. 화면에 보이는 글자가
 * 곧 pdfjs 가 읽은 결과이므로, 고칠 때도 같은 표를 써야 어긋나지 않는다.
 * 실제로 손으로 읽은 표가 틀려 원본 글자가 엉뚱한 자모로 읽히는 문서가 있었다.
 *
 * 다만 pdfjs 표에는 **그 쪽에 실제로 쓰인 글자만** 들어 있다. 그것만 쓰면
 * 문서에 한 번도 안 나온 글자를 못 넣게 된다. 글꼴이 통째로 심긴 문서에서는
 * 아쉬운 일이다.
 *
 * 그래서 겹치는 코드끼리 맞춰 본다. 한 군데도 안 어긋나면 손으로 읽은 표를
 * 믿고 빈 곳을 메운다. 한 군데라도 어긋나면 그 표는 통째로 버린다. 반쯤 맞는
 * 표는 없느니만 못하다.
 */
export function applyKnownCodes(
  slots: FontSlot[],
  known: Map<string, Map<number, number>>,
): void {
  if (known.size === 0) return
  /*
   * pdfjs 표는 글꼴 **이름**으로 묶여 온다. 그런데 크롬 PDF 는 서로 다른 글꼴
   * 여럿에 같은 이름(`AAAAAA+NanumGothic`)을 붙인다. 그 표는 여러 글꼴의 코드가
   * 섞인 것이라, 한 글꼴에 입히면 남의 코드로 적게 되어 글자가 빈칸으로
   * 찍혔다(2026-09-24). 이름이 겹치는 글꼴은 표를 입히지 않고 제 ToUnicode 를 믿는다.
   */
  const named = new Map<string, number>()
  for (const slot of slots) named.set(slot.rawFont, (named.get(slot.rawFont) ?? 0) + 1)
  const baseNamed = new Map<string, number>()
  for (const slot of slots) baseNamed.set(slot.baseFont, (baseNamed.get(slot.baseFont) ?? 0) + 1)
  for (const slot of slots) {
    // 표를 찾은 그 이름을 이 쪽의 다른 글꼴도 쓰면 건너뛴다.
    const byRaw = known.has(slot.rawFont)
    const shared = byRaw ? (named.get(slot.rawFont) ?? 0) > 1 : (baseNamed.get(slot.baseFont) ?? 0) > 1
    if (shared) continue
    const table = known.get(slot.rawFont) ?? known.get(slot.baseFont)
    if (!table || table.size === 0) continue

    let clash = false
    for (const [code, cp] of table) {
      const mine = charFor(slot, code)
      if (mine !== undefined && mine !== cp) {
        clash = true
        break
      }
    }

    const reverse = new Map(clash ? [] : slot.reverse)
    for (const [code, cp] of table) reverse.set(code, cp)
    const map = new Map<number, number>()
    // pdfjs 가 본 것을 먼저 넣어 같은 글자에 코드가 여럿일 때 이기게 한다.
    for (const [code, cp] of table) if (!map.has(cp)) map.set(cp, code)
    if (!clash) for (const [cp, code] of slot.map) if (!map.has(cp)) map.set(cp, code)

    slot.reverse = reverse
    slot.map = map
    if (clash) {
      // 어림짐작도 함께 틀렸을 수 있다. 확인된 표만 남긴다.
      slot.ascii = false
      slot.ucs2 = false
    }
  }
}

/** pdfjs 가 알려 준 글꼴 이름으로 자리를 고른다. 못 찾으면 null. */
export function slotFor(slots: FontSlot[], baseFont: string): FontSlot | null {
  if (!baseFont) return null
  const want = stripSubsetTag(baseFont)
  return (
    slots.find((s) => s.baseFont === want) ??
    // 이름이 조금 다른 경우가 있다 (Arial vs ArialMT). 앞부분만 맞아도 받아 준다.
    slots.find((s) => s.baseFont.startsWith(want) || want.startsWith(s.baseFont)) ??
    null
  )
}

/**
 * 글자를 이 글꼴의 코드로 적는다. 한 글자라도 못 적으면 null 을 낸다.
 *
 * 반쯤 적고 나머지를 대체 글꼴로 채우면 한 줄 안에서 글꼴이 섞여 더 흉하다.
 * 안 되면 통째로 물러나는 편이 낫다.
 */
export function encodeWith(slot: FontSlot, text: string): string | null {
  const width = slot.codeBytes * 2
  let hex = ''
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    const code = codeFor(slot, cp)
    if (code === undefined) return null
    hex += code.toString(16).padStart(width, '0')
  }
  return hex
}

/**
 * 이 글꼴로 못 적는 글자만 모은다. 순서대로, 중복 없이.
 *
 * 사용자에게 "무엇이 없어서 글꼴을 바꾸는지" 를 보여 주려고 쓴다. 없는 글자를
 * 짚어 주지 않으면 왜 글자꼴이 달라졌는지 알 길이 없다.
 */
export function missingIn(slot: FontSlot, text: string): string {
  let out = ''
  for (const ch of text) {
    if (codeFor(slot, ch.codePointAt(0)!) !== undefined) continue
    if (!out.includes(ch)) out += ch
  }
  return out
}

/**
 * 글자를 "원본 글꼴로 적을 수 있는 토막" 과 "없는 토막" 으로 가른다.
 *
 * 한 줄 안에서 글꼴이 섞이는 것은 보기 좋지 않다. 그래서 기본은 통째로
 * 물러나는 쪽(`encodeWith` 가 null 을 내는 것)이다. 다만 원본 글꼴을 지키고
 * 싶은 사람에게는 이쪽이 낫다. 없는 글자만 다른 글꼴로 나가고 나머지는 옆
 * 글자와 똑같이 남는다. 무엇을 택할지는 사용자가 정한다.
 */
export function splitByFont(slot: FontSlot, text: string): { origin: boolean; text: string }[] {
  const out: { origin: boolean; text: string }[] = []
  for (const ch of text) {
    const origin = codeFor(slot, ch.codePointAt(0)!) !== undefined
    const last = out[out.length - 1]
    if (last && last.origin === origin) last.text += ch
    else out.push({ origin, text: ch })
  }
  return out
}

/** 유니코드 한 글자를 이 글꼴이 쓰는 코드로. 없으면 undefined. */
export function codeFor(slot: FontSlot, cp: number): number | undefined {
  const found = slot.map.get(cp)
  if (found !== undefined) return found
  if (slot.ucs2 && cp <= 0xffff) return cp
  if (slot.ascii && cp >= 0x20 && cp <= 0x7e) return cp
  // 마지막으로 글꼴 파일에 직접 물어본다. 문서에 안 쓰인 글자도 여기서 나온다.
  return slot.glyphId?.(cp)
}

/**
 * 문서에 심긴 글꼴 파일을 읽어 글리프 번호를 찾는 길을 만든다.
 *
 * Identity 인코딩에서만 통한다. 그 경우 문자열에 적는 코드가 곧 글리프
 * 번호이기 때문이다. 다른 인코딩은 코드에서 글리프로 가는 길에 표가 한 겹
 * 더 있어서 글꼴만 봐서는 알 수 없다.
 *
 * 글꼴 파일을 푸는 일이 가볍지 않아서, 정말 물어볼 때 한 번만 읽는다.
 */
function embeddedLookup(
  context: PDFContext,
  dict: PDFDict,
  subtype: string,
  encName: string,
  fontkit: FontkitLike,
): ((cp: number) => number | undefined) | null {
  if (subtype !== 'Type0' || !/^Identity-[HV]$/.test(encName)) return null

  const kids = context.lookup(dict.get(PDFName.of('DescendantFonts')))
  if (!(kids instanceof PDFArray) || kids.size() === 0) return null
  const kid = context.lookup(kids.get(0))
  if (!(kid instanceof PDFDict)) return null

  const desc = context.lookup(kid.get(PDFName.of('FontDescriptor')))
  if (!(desc instanceof PDFDict)) return null

  /*
   * 글꼴 파일. TrueType 은 FontFile2, OpenType 은 FontFile3 에 들어간다.
   * FontFile3 가운데 맨 CFF(`CIDFontType0C`)는 그 자체로 온전한 글꼴 파일이
   * 아니라 fontkit 이 못 읽는다. 그런 문서는 손대지 않는다.
   */
  let file = context.lookup(desc.get(PDFName.of('FontFile2')))
  if (!(file instanceof PDFRawStream)) {
    const three = context.lookup(desc.get(PDFName.of('FontFile3')))
    const kind =
      three instanceof PDFRawStream
        ? context.lookup(three.dict.get(PDFName.of('Subtype')))
        : undefined
    file =
      three instanceof PDFRawStream &&
      kind instanceof PDFName &&
      kind.decodeText() === 'OpenType'
        ? three
        : undefined
  }
  if (!(file instanceof PDFRawStream)) return null

  /*
   * CID 에서 글리프 번호로 가는 표.
   *
   * Identity 면 둘이 같아서 글꼴이 알려 준 번호를 그대로 쓰면 된다. 표가
   * 스트림으로 들어 있으면 두 바이트씩 CID 차례대로 글리프 번호가 적혀
   * 있으므로, 거꾸로 훑어 글리프 번호에 맞는 CID 를 찾는다.
   */
  const cid2gid = context.lookup(kid.get(PDFName.of('CIDToGIDMap')))
  let toCid: Map<number, number> | null = null
  if (cid2gid instanceof PDFRawStream) {
    try {
      const bytes = decodePDFRawStream(cid2gid).decode()
      toCid = new Map()
      for (let cid = 0; cid * 2 + 1 < bytes.length; cid += 1) {
        const gid = (bytes[cid * 2]! << 8) | bytes[cid * 2 + 1]!
        if (gid !== 0 && !toCid.has(gid)) toCid.set(gid, cid)
      }
    } catch {
      return null
    }
  } else if (cid2gid && !(cid2gid instanceof PDFName && cid2gid.decodeText() === 'Identity')) {
    return null
  }

  let parsed: { glyphForCodePoint(cp: number): { id: number } | undefined } | null | undefined
  return (cp: number) => {
    if (parsed === undefined) {
      try {
        parsed = fontkit.create(decodePDFRawStream(file as PDFRawStream).decode())
      } catch {
        parsed = null
      }
    }
    if (!parsed) return undefined
    try {
      const glyph = parsed.glyphForCodePoint(cp)
      // 0 번은 빈 글리프다. 글꼴에 그 글자가 없다는 뜻이다.
      if (!glyph || glyph.id <= 0) return undefined
      return toCid ? toCid.get(glyph.id) : glyph.id
    } catch {
      return undefined
    }
  }
}

/** 그 반대. 스트림에 적힌 코드가 무슨 글자인지. */
export function charFor(slot: FontSlot, code: number): number | undefined {
  const found = slot.reverse.get(code)
  if (found !== undefined) return found
  return slot.ucs2 ? code : undefined
}

/**
 * 글자 이름을 코드값으로. `/Differences` 가 쓰는 이름을 푼다.
 *
 * `uni0041` 같은 이름은 그대로 읽으면 되고, 아스키 구간은 표준 이름이 정해져
 * 있다. 그 밖의 이름(합자·장식 글리프)은 되돌릴 수 없어 null 을 낸다.
 */
function codePointForGlyphName(name: string): number | null {
  const uni = /^uni([0-9A-Fa-f]{4})$/.exec(name)
  if (uni) return parseInt(uni[1]!, 16)
  const u = /^u([0-9A-Fa-f]{4,6})$/.exec(name)
  if (u) return parseInt(u[1]!, 16)
  if (name.length === 1) return name.codePointAt(0)!
  return ASCII_GLYPH_NAMES.get(name) ?? null
}

/** 아스키 구간의 표준 글자 이름. PDF 규격 부록 D 의 그 표다. */
const ASCII_GLYPH_NAMES = new Map<string, number>([
  ['space', 32], ['exclam', 33], ['quotedbl', 34], ['numbersign', 35], ['dollar', 36],
  ['percent', 37], ['ampersand', 38], ['quotesingle', 39], ['quoteright', 39],
  ['parenleft', 40], ['parenright', 41], ['asterisk', 42], ['plus', 43], ['comma', 44],
  ['hyphen', 45], ['period', 46], ['slash', 47], ['zero', 48], ['one', 49], ['two', 50],
  ['three', 51], ['four', 52], ['five', 53], ['six', 54], ['seven', 55], ['eight', 56],
  ['nine', 57], ['colon', 58], ['semicolon', 59], ['less', 60], ['equal', 61],
  ['greater', 62], ['question', 63], ['at', 64], ['bracketleft', 91], ['backslash', 92],
  ['bracketright', 93], ['asciicircum', 94], ['underscore', 95], ['grave', 96],
  ['quoteleft', 96], ['braceleft', 123], ['bar', 124], ['braceright', 125],
  ['asciitilde', 126], ['bullet', 0x2022], ['endash', 0x2013], ['emdash', 0x2014],
  ['quotedblleft', 0x201c], ['quotedblright', 0x201d], ['quotesinglbase', 0x201a],
  ['ellipsis', 0x2026], ['fi', 0xfb01], ['fl', 0xfb02],
])

/* ── ToUnicode 읽기 ────────────────────────────────────────────── */

/** `<0041>` 이나 `<00410042>` 를 유니코드 코드값 하나로. 여럿이면 null. */
function oneCodePoint(hex: string): number | null {
  if (hex.length % 4 !== 0 || hex.length === 0) {
    // 1바이트 표기(`<41>`)도 쓰인다.
    if (hex.length === 2) return parseInt(hex, 16)
    return null
  }
  const units: number[] = []
  for (let i = 0; i < hex.length; i += 4) units.push(parseInt(hex.slice(i, i + 4), 16))
  if (units.length === 1) return units[0]!
  if (units.length === 2 && units[0]! >= 0xd800 && units[0]! <= 0xdbff) {
    return (units[0]! - 0xd800) * 0x400 + (units[1]! - 0xdc00) + 0x10000
  }
  // 한 코드가 여러 글자로 풀리는 합자(ﬁ 등)는 되돌릴 수 없다.
  return null
}

/**
 * ToUnicode CMap 을 읽는다.
 *
 * 정규식으로 `<lo> <hi> <dst>` 를 훑으면 안 된다. 배열 꼴 `bfrange`
 * (`<0000> <00ff> [<0000> <300c> ...]`)의 **배열 안쪽**까지 세 짝으로 잘못
 * 읽어서, 0 부터 0x300c 까지를 통째로 엉뚱하게 이어 붙인다. 실제로 글리프
 * 535개짜리 서브셋에서 54,926개를 만들어 낸 적이 있다.
 *
 * 그래서 앞에서부터 차례대로 읽는다. `<...>` 하나와 `[...]` 하나를 토막으로
 * 보고, bfrange 는 셋씩(시작, 끝, 대상) bfchar 는 둘씩 짝지어 간다.
 */
function parseToUnicode(text: string): {
  map: Map<number, number>
  reverse: Map<number, number>
  codeBytes: number
} {
  const map = new Map<number, number>()
  const reverse = new Map<number, number>()
  let codeBytes = 0

  const note = (srcHex: string, cp: number | null) => {
    if (cp === null || cp === 0) return
    codeBytes = Math.max(codeBytes, Math.ceil(srcHex.length / 2))
    const code = parseInt(srcHex, 16)
    // 같은 글자에 코드가 여럿이면 처음 것을 쓴다.
    if (!map.has(cp)) map.set(cp, code)
    if (!reverse.has(code)) reverse.set(code, cp)
  }

  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    const list = scan(block[1]!)
    for (let i = 0; i + 1 < list.length; i += 2) {
      const src = list[i]!
      const dst = list[i + 1]!
      if (src.kind !== 'hex' || dst.kind !== 'hex') continue
      note(src.value, oneCodePoint(dst.value))
    }
  }

  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const list = scan(block[1]!)
    for (let i = 0; i + 2 < list.length; i += 3) {
      const from = list[i]!
      const to = list[i + 1]!
      const dst = list[i + 2]!
      if (from.kind !== 'hex' || to.kind !== 'hex') continue
      const lo = parseInt(from.value, 16)
      const hi = parseInt(to.value, 16)
      const width = from.value.length
      const at = (n: number) => (lo + n).toString(16).padStart(width, '0')

      if (dst.kind === 'list') {
        // 하나하나 적어 둔 꼴. 차례대로 코드에 붙인다.
        dst.values.forEach((one, n) => note(at(n), oneCodePoint(one)))
        continue
      }
      // 이어지는 꼴. 시작 글자에서 하나씩 늘려 간다.
      const startAt = oneCodePoint(dst.value)
      if (startAt === null || hi < lo || hi - lo > 0xffff) continue
      for (let n = 0; n <= hi - lo; n += 1) note(at(n), startAt + n)
    }
  }

  return { map, reverse, codeBytes }
}

/** `<...>` 하나와 `[...]` 하나를 토막으로 끊어 차례대로 돌려준다. */
type CMapItem = { kind: 'hex'; value: string } | { kind: 'list'; values: string[] }

function scan(text: string): CMapItem[] {
  const out: CMapItem[] = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '<') {
      const end = text.indexOf('>', i)
      if (end < 0) break
      out.push({ kind: 'hex', value: text.slice(i + 1, end).replace(/[^0-9a-fA-F]/g, '') })
      i = end + 1
    } else if (ch === '[') {
      const end = text.indexOf(']', i)
      if (end < 0) break
      const inner = text.slice(i + 1, end)
      out.push({ kind: 'list', values: [...inner.matchAll(/<([0-9a-fA-F]*)>/g)].map((m) => m[1]!) })
      i = end + 1
    } else {
      i += 1
    }
  }
  return out
}

