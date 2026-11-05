/**
 * HWP·HWPX 문서 엔진(rhwp) 과 PDF 에 심을 한글 글꼴을 브라우저로 가져온다.
 *
 * 엔진은 8MB 짜리 WebAssembly 다. 도구를 실제로 누를 때만 받고, 한 번 받으면
 * 탭이 살아 있는 동안 다시 받지 않는다. 번들에 넣지 않고 public/vendor 에서
 * 가져오는 이유는 두 가지다. Vite 가 8MB 를 해시 붙여 한 번 더 뱉을 이유가
 * 없고, 폴더 이름에 버전이 박혀 있으면 교체 시점이 눈에 보인다.
 *
 * 글꼴이 필요한 이유: PDF 는 글자를 쓰는 게 아니라 글리프를 심는 형식이라,
 * 한글을 넣으려면 한글 글꼴 파일이 있어야 한다. 브라우저에 깔린 글꼴은
 * 자바스크립트가 읽을 수 없다.
 */
import { fetchWithProgress, type RatioReport } from '#/lib/fetchProgress'
import { sniffHwp, type HwpBadKind } from '#/lib/hwpSniff'

/** 버전을 폴더로 고정한다. 올릴 때는 폴더를 새로 만들고 이 값을 바꾼다. */
const ENGINE_BASE = '/vendor/rhwp/0.8.4/'
const FONT_BASE = '/vendor/fonts/'

export type RhwpModule = typeof import('../../public/vendor/rhwp/0.8.4/rhwp')
export type HwpDocument = import('../../public/vendor/rhwp/0.8.4/rhwp').HwpDocument

let enginePromise: Promise<RhwpModule> | null = null
let engineLoaded = false
/** 받은 엔진 바이트. 엔진을 새로 띄울 때 다시 받지 않으려고 둔다. */
let wasmBytes: Promise<ArrayBuffer> | null = null
/** 엔진을 몇 번째로 띄우는지. 멈춘 엔진을 버리고 새로 띄울 때 모듈 주소를 바꾸는 데 쓴다. */
let generation = 0
/** 엔진이 마지막으로 멈춘 자리 (Rust 소스 파일:줄). 측정에 남겨 원인을 찾는 데 쓴다. */
let lastPanic = ''
/** 지금까지 잡은 panic 수. 이번 일에서 panic 이 났는지 가르는 데 쓴다. */
let panicCount = 0
/** 지금 엔진의 메모리. 멈춘 엔진이 메모리를 얼마나 쥐고 있는지 재는 데 쓴다. */
let engineMemory: WebAssembly.Memory | null = null
/**
 * 멈춘 엔진이 메모리를 너무 많이 쥐고 있어 이 탭에서는 새 엔진을 띄우면 안 되는 상태.
 * 버린 엔진의 메모리는 페이지를 새로고침해야 풀린다(모듈이 탭 끝까지 남는다).
 */
let engineDead = false
const DEAD_BYTES = 1024 * 1024 * 1024
/** 마지막으로 버린 엔진이 쥐고 있던 메모리(MB). 측정용 */
let discardedMB = 0
let watchingPanics = false

/** 엔진이 막 올라왔을 때 window 에 보내는 이벤트 이름 */
export const ENGINE_EVENT = 'ezpz-hwp-engine'

/**
 * 엔진을 이미 받아 두었는지. 결과 페이지가 한글 미리보기를 곧바로 그릴지,
 * "엔진을 받아야 한다" 고 먼저 물을지 가른다. 변환을 막 끝낸 탭이면 대개 true 다.
 */
export function engineReady(): boolean {
  return engineLoaded
}

/**
 * Rust panic 은 콘솔(console.error)로 "panicked at src/…/파일.rs:줄:칸" 을 남긴다.
 * 그 자리만 기억해 둔다. 문서 내용은 담기지 않는다.
 */
function watchPanics(): void {
  if (watchingPanics || typeof console === 'undefined') return
  watchingPanics = true
  const original = console.error.bind(console)
  console.error = (...args: unknown[]) => {
    try {
      const text = args.map((a) => String(a)).join(' ')
      const m = text.match(/panicked at (?:[^\s:]*\/)?([\w-]+)\/([\w-]+)\.rs:(\d+)/)
      if (m) {
        lastPanic = `${m[1]}.${m[2]}.rs:${m[3]}`
        panicCount += 1
      } else {
        const n = text.match(/panicked at [^\s:]*?([\w-]+)\.rs:(\d+)/)
        if (n) {
          lastPanic = `${n[1]}.rs:${n[2]}`
          panicCount += 1
        }
      }
    } catch {
      /* 기록 실패는 무시한다 */
    }
    original(...args)
  }
}

/**
 * 엔진이 멈췄다는 표시인가. WebAssembly 가 trap 으로 끝나면 그 엔진 인스턴스는 더 쓸 수 없다
 * (빌려 준 객체가 풀리지 않은 채 남아 다음 호출과 해제가 모두 실패한다).
 */
export function isEngineTrap(err: unknown): boolean {
  if (typeof WebAssembly !== 'undefined' && err instanceof WebAssembly.RuntimeError) return true
  const message = String((err as Error)?.message ?? err)
  return /unreachable|memory access out of bounds|recursive use of an object|attempted to take ownership of Rust value|null pointer passed to rust/i.test(
    message,
  )
}

/** 멈춘 엔진을 버린다. 다음 loadEngine 이 새 인스턴스를 띄운다 (받아 둔 바이트는 다시 쓴다). */
export function discardEngine(): void {
  // 멈춘 엔진이 1GB 넘게 쥐고 있으면 새 엔진을 하나 더 띄우는 순간 탭이 죽는다(재현함).
  // 그때는 이 탭에서 엔진을 다시 띄우지 않고, 새로고침하라고 알린다.
  const size = engineMemorySize()
  if (engineMemory) discardedMB = Math.round(size / 1048576)
  if (size >= DEAD_BYTES) engineDead = true
  engineMemory = null
  enginePromise = null
  engineLoaded = false
  generation += 1
}

function engineMemorySize(): number {
  try {
    return engineMemory?.buffer.byteLength ?? 0
  } catch {
    return 0
  }
}

/** 문서를 놓아 준다. 엔진이 멈춘 뒤라 해제가 실패해도, 먼저 난 진짜 오류를 가리지 않는다. */
export function freeDoc(doc: { free(): void } | null | undefined): void {
  if (!doc) return
  try {
    doc.free()
  } catch (err) {
    if (isEngineTrap(err)) discardEngine()
  }
}

/** 엔진이 멈췄을 때. 메시지에 멈춘 자리를 담아 측정으로 원인을 찾게 한다. */
export class EngineCrashError extends Error {
  /** failure.ts 가 이 값으로 갈래를 정한다 (새로고침 안내). */
  code = 'ENGINE_CRASH'
  constructor(where: string) {
    super(where ? `ENGINE_CRASH ${where}` : 'ENGINE_CRASH')
    // name 을 Error 로 두면 측정 코드가 메시지만 쓴다 (ENGINE_CRASH_파일_rs_줄).
  }
}

/**
 * 엔진을 띄운다. 두 번째 호출부터는 이미 받아 둔 것을 그대로 돌려주므로
 * report 가 한 번도 불리지 않는다. 호출부는 그래도 되도록 써야 한다.
 */
export async function loadEngine(report: RatioReport): Promise<RhwpModule> {
  if (engineDead) throw new EngineCrashError('dead')
  if (!enginePromise) {
    const gen = generation
    enginePromise = (async () => {
      if (!wasmBytes) {
        wasmBytes = fetchWithProgress(`${ENGINE_BASE}rhwp_bg.wasm`, report).catch((err) => {
          wasmBytes = null
          throw err
        })
      }
      // @vite-ignore: public/ 에 그대로 둔 파일이다. 번들러가 해석하면 안 된다.
      // 엔진을 새로 띄울 때는 주소를 바꿔야 멈춘 인스턴스가 아닌 새 모듈이 온다.
      const [mod, wasm] = await Promise.all([
        import(/* @vite-ignore */ `${ENGINE_BASE}rhwp.js${gen ? `?i=${gen}` : ''}`) as Promise<RhwpModule>,
        wasmBytes,
      ])
      // 기다리는 방식(WebAssembly.instantiate)으로 올린다. 예전의 initSync 는 8MB 를
      // 화면이 멈춘 채 한 번에 읽어서, 일부 Edge 가 "WebAssembly.Compile is disallowed on
      // the main thread" 로 막았다 (2026-09-30).
      const exported = (await mod.default({ module_or_path: wasm })) as unknown as { memory?: WebAssembly.Memory }
      engineMemory = exported?.memory ?? null
      watchPanics()
      // Rust 쪽 panic 을 콘솔에서 읽을 수 있게 한다. 없으면 "unreachable" 만 남는다.
      mod.init_panic_hook()
      engineLoaded = true
      // 결과 목록의 한글 썸네일이 이 소식을 듣고 다시 그린다.
      if (typeof window !== 'undefined') window.dispatchEvent(new Event(ENGINE_EVENT))
      return mod
    })().catch((err) => {
      // 실패한 약속을 남겨 두면 다시 눌러도 같은 오류만 되풀이한다.
      enginePromise = null
      throw err
    })
  }
  return enginePromise
}

/**
 * 엔진으로 일을 한다. 도중에 엔진이 멈추면(trap) 그 엔진을 버린다.
 * 한 번 멈춘 엔진은 같은 탭의 다음 변환까지 망가뜨린다(2026-09-30 Safari: 한 번 멈춘 뒤
 * 다시 눌러도 계속 실패). 버려 두면 다음 변환은 새 엔진으로 한다.
 *
 * 같은 파일로 곧바로 다시 하지는 않는다. 멈춘 까닭이 그 파일이면 또 멈추고, 메모리가 바닥나
 * 멈춘 경우(panic 기록 없이 unreachable)에는 멈춘 엔진이 쥔 메모리가 그대로 남아 있어 새 엔진을
 * 하나 더 띄우면 탭이 죽는다(313쪽짜리 문서로 재현).
 * 측정에는 멈춘 자리(Rust 파일:줄)를, 기록이 없으면 abort 를 남긴다.
 */
export async function withEngine<T>(report: RatioReport, run: (engine: RhwpModule) => Promise<T> | T): Promise<T> {
  const engine = await loadEngine(report)
  const panicsBefore = panicCount
  try {
    return await run(engine)
  } catch (err) {
    if (!isEngineTrap(err)) throw err
    // finally 의 freeDoc 이 먼저 엔진을 버렸을 수 있다. 그때는 버릴 때 잰 값을 쓴다.
    const mb = engineMemory ? Math.round(engineMemorySize() / 1048576) : discardedMB
    discardEngine()
    throw new EngineCrashError(`${panicCount > panicsBefore ? lastPanic : 'abort'} ${mb}MB`)
  }
}

/**
 * PDF 에 심을 글꼴.
 *
 * gothic·myeongjo 는 문서가 지정한 글꼴이 고딕 계열이냐 명조 계열이냐에 따라
 * 고른다. 둘 다 한자가 없어서, 한자·가나가 나오면 그때만 cjk 를 더 받는다.
 * 한자 없는 문서(대부분)가 4.6MB 를 헛되이 받지 않게 하려는 분리다.
 */
export type FontKey = 'gothic' | 'myeongjo' | 'cjk' | 'ud' | 'vi' | 'thai' | 'deva' | 'sc' | 'tc'

const FONT_FILES: Record<FontKey, string> = {
  gothic: 'NanumGothic-Regular.ttf',
  myeongjo: 'NanumMyeongjo-Regular.ttf',
  cjk: 'NotoSansKR-Regular.otf',
  /**
   * BIZ UDPゴシック. 가나·일본 한자·번체 한자, 키릴·그리스 문자, 폴란드어·튀르키예어
   * 글자가 있다. PDF 편집기가 한글 없는 글에 심는다. TrueType 이라 나눔고딕과
   * 같은 길(FontFile2)로 심긴다. pdf-lib 는 .otf(CFF) 를 통째로 심을 때 형식
   * 표시를 잘못 달아(CIDFontType0C 에 OpenType 통째) 뷰어에 따라 못 읽는다.
   */
  ud: 'BIZUDPGothic-Regular.ttf',
  /**
   * Be Vietnam Pro. 베트남어 성조 글자(ạ ả ấ ơ ư …)가 다 있는 TrueType. BIZ UDPゴシック과
   * 나눔 글꼴에는 이 글자들이 없어서, 베트남어를 쓰면 PDF 에 빈 상자가 찍혔다(2026-10-08 까지).
   */
  vi: 'BeVietnamPro-Regular.ttf',
  /**
   * Sarabun. 태국 공문서 글꼴(TH Sarabun)의 공개판이라 문서에 어울리고, 태국 글자와 라틴 글자·숫자가
   * 함께 있다. 다른 글꼴로는 태국어가 빈 상자로 찍혔다(2026-10-08 까지).
   */
  thai: 'Sarabun-Regular.ttf',
  /** Noto Sans Devanagari. 힌디어 글자. 다른 글꼴로는 빈 상자가 됐다(PDF 편집기, 2026-11-01). */
  deva: 'NotoSansDevanagari-Regular.ttf',
  /** Noto Sans SC·TC 를 TrueType 으로 바꾼 것. PDF 편집기에서 간체·번체 한자를 쓸 때(BIZ UDPゴシック 에 없는 간체 글자가 많다). */
  sc: 'NotoSansSC-Regular.ttf',
  tc: 'NotoSansTC-Regular.ttf',
}

const fontCache = new Map<FontKey, Promise<Uint8Array>>()

export function loadFont(key: FontKey, report: RatioReport): Promise<Uint8Array> {
  let pending = fontCache.get(key)
  if (!pending) {
    pending = fetchWithProgress(`${FONT_BASE}${FONT_FILES[key]}`, report)
      .then((buf) => new Uint8Array(buf))
      .catch((err) => {
        fontCache.delete(key)
        throw err
      })
    fontCache.set(key, pending)
  }
  return pending
}

/**
 * 문서를 여는 동안 나는 오류. 호출부가 문구를 고를 수 있게 코드를 붙인다.
 * HWP → PDF 와 HWPX → HWP 가 같은 구분을 쓴다.
 */
export class HwpDocError extends Error {
  constructor(
    public code: 'PASSWORD_REQUIRED' | 'PASSWORD_WRONG' | 'UNREADABLE' | 'EMPTY',
    /** UNREADABLE 일 때 파일이 실제로 무엇이었나 (hwpSniff) */
    public kind?: HwpBadKind,
    /** 측정용 형식 표시. 알 수 없는 형식의 머리표 등 */
    detail?: string,
  ) {
    // 측정 코드(errorCode)가 메시지를 쓴다: HwpDocError:UNREADABLE_foreign_SCDSA004
    super([code, kind, detail].filter(Boolean).join(' '))
    this.name = 'HwpDocError'
  }
}

function isEncryptedError(message: string): boolean {
  return /암호|비밀번호|encrypt|password/i.test(message)
}

/** rhwp 는 암호가 틀리면 메시지에 "비밀번호가 일치하지 않" 을 넣어 준다. */
function isWrongPassword(message: string): boolean {
  return /비밀번호가 일치하지 않|wrong password|invalid password/i.test(message)
}

/**
 * HWP·HWPX 바이트를 문서로 연다. 암호가 걸린 파일은 암호 없이는 열리지 않으므로
 * 그 경우를 따로 구분해 던진다. 화면이 암호 칸을 띄울 수 있어야 한다.
 */
export function openDocument(
  engine: RhwpModule,
  bytes: Uint8Array,
  password?: string,
): HwpDocument {
  try {
    return password
      ? engine.HwpDocument.openWithPassword(bytes, password)
      : new engine.HwpDocument(bytes)
  } catch (err) {
    // 엔진이 멈춘 것은 파일 탓이 아니다. 그대로 올려 withEngine 이 새 엔진으로 다시 하게 한다.
    if (isEngineTrap(err)) throw err
    const message = String((err as Error)?.message ?? err)
    if (password && isWrongPassword(message)) throw new HwpDocError('PASSWORD_WRONG')
    if (!password && isEncryptedError(message)) throw new HwpDocError('PASSWORD_REQUIRED')
    // 못 연 파일이 실제로 무엇인지 앞머리로 가려 갈래별로 안내한다.
    const { kind, sig } = sniffHwp(bytes)
    throw new HwpDocError('UNREADABLE', kind, sig || undefined)
  }
}
