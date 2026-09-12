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

export async function loadEngine(): Promise<RhwpModule> {
  if (!enginePromise) {
    enginePromise = (async () => {
      const mod = (await import(
        pathToFileURL(join(RHWP_DIR, 'rhwp.js')).href
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

/** 문서를 여는 동안 나는 오류. 호출부가 문구를 고를 수 있게 코드를 붙인다. */
export class HwpDocError extends Error {
  constructor(public code: 'PASSWORD_REQUIRED' | 'PASSWORD_WRONG' | 'UNREADABLE' | 'EMPTY') {
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
    throw new HwpDocError('UNREADABLE')
  }
}
