/**
 * Node 에서 한글 문서 엔진(rhwp)과 글꼴을 올린다.
 *
 * 브라우저 쪽(src/lib/rhwp.ts)과 하는 일은 같지만 가져오는 방법이 다르다.
 * 거기서는 fetch 로 내려받고 여기서는 디스크에서 읽는다. 엔진과 글꼴은 npm
 * 패키지에 함께 실려 나가므로 설치 뒤에는 네트워크가 필요 없다.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DOMParser } from 'linkedom'
import { sniffHwp, type HwpBadKind } from '../../src/lib/hwpSniff'

const here = dirname(fileURLToPath(import.meta.url))

/** dist/ 에서 한 칸 올라가면 패키지 뿌리. 개발 중에는 저장소의 public/ 을 본다. */
function assetRoot(): string {
  const packaged = join(here, '..', 'vendor')
  try {
    readFileSync(join(packaged, 'rhwp', 'rhwp_bg.wasm'))
    return packaged
  } catch {
    return join(here, '..', '..', 'public', 'vendor')
  }
}

const ROOT = assetRoot()
const RHWP_DIR = ROOT.endsWith('vendor') && ROOT.includes('public')
  ? join(ROOT, 'rhwp', '0.8.4')
  : join(ROOT, 'rhwp')
const FONT_DIR = join(ROOT, 'fonts')

export type RhwpModule = typeof import('../../public/vendor/rhwp/0.8.4/rhwp')
export type HwpDocument = import('../../public/vendor/rhwp/0.8.4/rhwp').HwpDocument

let enginePromise: Promise<RhwpModule> | null = null
/**
 * 엔진을 몇 번 새로 띄웠나. WebAssembly 가 trap 으로 멈춘 인스턴스는 다시 쓸 수 없고,
 * 같은 모듈을 다시 import 하면 그 멈춘 인스턴스가 그대로 온다. 주소에 번호를 붙여
 * 새 모듈을 받는다(사이트 src/lib/rhwp.ts 와 같은 방법).
 */
let generation = 0

export async function loadEngine(): Promise<RhwpModule> {
  if (!enginePromise) {
    const gen = generation
    enginePromise = (async () => {
      const mod = (await import(
        pathToFileURL(join(RHWP_DIR, 'rhwp.js')).href + (gen ? `?i=${gen}` : '')
      )) as unknown as RhwpModule
      mod.initSync({ module: readFileSync(join(RHWP_DIR, 'rhwp_bg.wasm')) })
      mod.init_panic_hook()
      return mod
    })().catch((err) => {
      enginePromise = null
      throw err
    })
  }
  return enginePromise
}

export type FontKey = 'gothic' | 'myeongjo' | 'cjk'

const FONT_FILES: Record<FontKey, string> = {
  gothic: 'NanumGothic-Regular.ttf',
  myeongjo: 'NanumMyeongjo-Regular.ttf',
  cjk: 'NotoSansKR-Regular.otf',
}

const fontCache = new Map<FontKey, Uint8Array>()

/** 패키지에 실린 글꼴 파일의 경로. 일본어 문서를 그릴 때 캔버스에 글꼴을 등록하는 데 쓴다. */
export function fontFile(name: string): string {
  return join(FONT_DIR, name)
}

export function loadFont(key: FontKey): Uint8Array {
  let bytes = fontCache.get(key)
  if (!bytes) {
    bytes = new Uint8Array(readFileSync(join(FONT_DIR, FONT_FILES[key])))
    fontCache.set(key, bytes)
  }
  return bytes
}

/**
 * 그리기 코드(src/lib/svgPdf.ts)는 브라우저의 DOMParser 를 쓴다. 같은 코드를
 * 두 벌로 만들지 않으려고 Node 쪽에 그 이름을 채워 넣는다.
 */
export function installDom(): void {
  const g = globalThis as Record<string, unknown>
  if (!g.DOMParser) g.DOMParser = DOMParser
}

/**
 * 엔진이 멈췄다는 표시인가. trap 으로 끝난 인스턴스는 빌려 준 객체가 풀리지 않은 채 남아
 * 다음 호출과 해제가 모두 실패한다. 서버는 오래 떠 있으므로 한 번 멈추면 그 뒤의 한글 일이
 * 전부 실패했다. 사이트(src/lib/rhwp.ts)와 같은 기준으로 가린다.
 */
export function isEngineTrap(err: unknown): boolean {
  if (err instanceof WebAssembly.RuntimeError) return true
  const message = String((err as Error)?.message ?? err)
  return /unreachable|memory access out of bounds|recursive use of an object|attempted to take ownership of Rust value|null pointer passed to rust/i.test(
    message,
  )
}

/** 멈춘 엔진을 버린다. 다음 loadEngine 이 새 인스턴스를 띄운다. */
export function discardEngine(): void {
  enginePromise = null
  generation += 1
}

/** 문서를 놓아 준다. 엔진이 멈춘 뒤라 해제가 실패해도 먼저 난 진짜 오류를 가리지 않는다. */
export function freeDoc(doc: { free(): void } | null | undefined): void {
  if (!doc) return
  try {
    doc.free()
  } catch (err) {
    if (isEngineTrap(err)) discardEngine()
  }
}

/** 엔진이 이 파일에서 멈췄다. 엔진은 이미 새로 띄울 준비가 되어 있다. */
export class EngineCrashError extends Error {
  constructor() {
    super(
      'The HWP engine stopped while working on this file. It has been restarted, so other files work again. If this file stops it again, the file is probably damaged or uses something the engine cannot handle yet.',
    )
    this.name = 'EngineCrashError'
  }
}

/** 엔진으로 일을 한다. 도중에 엔진이 멈추면 그 엔진을 버리고 알기 쉬운 오류로 바꾼다. */
export async function withEngine<T>(run: (engine: RhwpModule) => Promise<T> | T): Promise<T> {
  const engine = await loadEngine()
  try {
    return await run(engine)
  } catch (err) {
    if (!isEngineTrap(err)) throw err
    discardEngine()
    throw new EngineCrashError()
  }
}

/** 문서를 여는 동안 나는 오류. 호출부가 문구를 고를 수 있게 코드를 붙인다. */
export class HwpDocError extends Error {
  constructor(
    public code: 'PASSWORD_REQUIRED' | 'PASSWORD_WRONG' | 'UNREADABLE' | 'EMPTY',
    /** UNREADABLE 일 때 앞머리로 가린 갈래 (src/lib/hwpSniff.ts) */
    public kind?: HwpBadKind,
  ) {
    super(code)
    this.name = 'HwpDocError'
  }
}

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
    const message = String((err as Error)?.message ?? err)
    if (password && /비밀번호가 일치하지 않|wrong password/i.test(message)) {
      throw new HwpDocError('PASSWORD_WRONG')
    }
    if (!password && /암호|비밀번호|encrypt|password/i.test(message)) {
      throw new HwpDocError('PASSWORD_REQUIRED')
    }
    if (isEngineTrap(err)) throw err
    // 엔진은 진짜 한글 문서는 거의 다 연다(HWP 3.0 포함). 못 여는 것은 대개 한글 파일이
    // 아닌 것이라, 앞머리를 보고 무엇인지 알려 준다.
    throw new HwpDocError('UNREADABLE', sniffHwp(bytes).kind)
  }
}
