/**
 * 편집기들이 같이 쓰는 글꼴 도우미(public/vendor/ezpz-fonts/1/fonts.js)를 사이트 쪽에서 부른다.
 * 구글 글꼴 목록은 이름만 먼저 읽고, 파일은 고르는 순간 구글 서버에서 받는다(이 브라우저에 보관).
 * 내 컴퓨터 글꼴은 크롬·엣지에서 허락을 받은 뒤 읽는다. 파일은 우리 서버를 거치지 않는다.
 */
export interface WebFont {
  /** 구글 글꼴 이름(파일 안 이름) */
  f: string
  ko?: string
  ja?: string
  /** s 고딕 r 명조 d 장식 h 손글씨 m 고정폭 */
  c: string
  /** 쓰는 글자(ko ja sc tc la) */
  s: string[]
  /** 굵기 → 파일 */
  w: Record<string, string>
}

export interface EzpzFontsApi {
  catalog(): Promise<WebFont[]>
  find(name: string): WebFont | null
  bytes(name: string, opts?: { weight?: number; italic?: boolean }): Promise<ArrayBuffer | null>
  use(name: string, opts?: { weights?: number[]; doc?: Document }): Promise<boolean>
  localFamilies(): Promise<string[]>
  isLocal(name: string): boolean
}

export const EZPZ_FONTS_SRC = '/vendor/ezpz-fonts/1/fonts.js'

let pending: Promise<EzpzFontsApi> | null = null

export function ezpzFonts(): Promise<EzpzFontsApi> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'))
  const w = window as unknown as { EZPZFonts?: EzpzFontsApi }
  if (w.EZPZFonts) return Promise.resolve(w.EZPZFonts)
  pending ??= new Promise<EzpzFontsApi>((resolve, reject) => {
    const s = document.createElement('script')
    s.src = EZPZ_FONTS_SRC
    s.async = true
    s.onload = () => (w.EZPZFonts ? resolve(w.EZPZFonts) : reject(new Error('fonts helper missing')))
    s.onerror = () => {
      pending = null
      reject(new Error('fonts helper not loaded'))
    }
    document.head.appendChild(s)
  })
  return pending
}

/** 쓰는 사람에게 보일 이름: 그 말의 이름이 있으면 "나눔고딕 (Nanum Gothic)" */
export function webFontLabel(f: WebFont, locale: string): string {
  const own = locale === 'ko' ? f.ko : locale === 'ja' ? f.ja : undefined
  return own && own !== f.f ? `${own} (${f.f})` : f.f
}

/** 글꼴 고르기 값: 'font:Nanum Gothic' */
export const FONT_FACE_PREFIX = 'font:'
export const isCustomFace = (face: string | undefined): face is `font:${string}` =>
  typeof face === 'string' && face.startsWith(FONT_FACE_PREFIX)
export const customFamily = (face: string) => face.slice(FONT_FACE_PREFIX.length)
