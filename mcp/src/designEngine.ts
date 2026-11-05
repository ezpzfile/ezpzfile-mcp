/**
 * The design engines behind the site's Vector editor (.ai .eps .svg …) and PSD editor
 * (.psd .psb …): VectorCraft and PhotoCraft (both MIT OR Apache-2.0), built for WASI
 * with the small patches in the site repo (vector-studio/, psd-studio/). The same
 * engines the editors run, without a window.
 *
 * Each runs as one long-lived child process under Node's WASI (a small runner file in the
 * cache). Node is started with --no-turbo-fast-api-calls: in Node 22 a WASI call made
 * through V8's fast-call path can trigger a garbage collection that crashes the process
 * (SIGSEGV in uvwasi path_filestat_get under MarkCompact, seen on every render of an
 * edited .ai). The regular call path is safe and the cost is not measurable.
 *
 * VectorCraft speaks MCP over stdio (`mcp --headless`); PhotoCraft speaks its JSON-lines
 * control protocol (`serve`). Both are wrapped here behind call(method, params).
 *
 * The wasm files are large (40 MB), so like the background-removal model they are
 * downloaded once, gzipped, from ezpzfile.com and cached; the sha256 is checked.
 * EZPZFILE_ENGINES_DIR points at local builds instead.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { ToolError } from './result'

export type EngineKind = 'vector' | 'photo'

interface EngineSpec {
  file: string
  version: string
  sha256: string
  args: string[]
  protocol: 'mcp' | 'lines'
}

/**
 * Built from the editors' sources with vector-studio/vectorcraft-wasi.patch and
 * psd-studio/photocraft-wasi.patch (`cargo build --release -p <name>-cli --target wasm32-wasip1`,
 * RUSTC_BOOTSTRAP=1 for PhotoCraft), gzipped into public/vendor/engines/<version>/. A new build
 * gets a new version folder and checksum here; /vendor is cached for a year.
 */
export const ENGINES: Record<EngineKind, EngineSpec> = {
  vector: { file: 'vectorcraft-cli.wasm', version: '0.7.0-aa548d2-wasi1', sha256: 'ea73c6bd2299803e3b6d861761f605765c9824fcbb2adb5b67c9e338353903ff', args: ['mcp', '--headless'], protocol: 'mcp' },
  // automation roots: the whole tree the preopens give; request paths are relative to it
  photo: { file: 'photocraft-cli.wasm', version: '0.4.1-c9a7d26-wasi1', sha256: 'af03f973f4e714f831fd22f4d034efb89ee10b639775b365ba6e7bf0f5bb8b02', args: ['serve', '--automation-read-root', '/', '--automation-write-root', '/'], protocol: 'lines' },
}

const BASE = 'https://ezpzfile.com'

function cacheDir(): string {
  const base = process.env.EZPZFILE_CACHE ?? process.env.XDG_CACHE_HOME ?? (homedir() ? join(homedir(), '.cache') : tmpdir())
  const dir = join(base, 'ezpzfile-mcp')
  mkdirSync(dir, { recursive: true })
  return dir
}

async function wasmPath(kind: EngineKind): Promise<string> {
  const spec = ENGINES[kind]
  const local = process.env.EZPZFILE_ENGINES_DIR
  if (local && existsSync(join(local, spec.file))) return join(local, spec.file)
  const dir = join(cacheDir(), `${kind}-${spec.version}`)
  const file = join(dir, spec.file)
  if (existsSync(file)) return file
  mkdirSync(dir, { recursive: true })
  const url = `${BASE}/vendor/engines/${spec.version}/${spec.file}.gz`
  let bytes: Uint8Array
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const got = new Uint8Array(await res.arrayBuffer())
    // a CDN may already have undone the gzip (Content-Encoding): wasm starts with \0asm
    bytes = got[0] === 0 && got[1] === 0x61 && got[2] === 0x73 && got[3] === 0x6d ? got : gunzipSync(got)
  } catch (err) {
    throw new ToolError(
      'ENGINE',
      `The ${kind === 'vector' ? 'vector (AI, EPS, SVG)' : 'image (PSD)'} engine is downloaded once, about 13 MB, and this download failed: ${(err as Error).message}. Everything else works offline.`,
      ['network access to ezpzfile.com once'],
    )
  }
  if (spec.sha256) {
    const got = createHash('sha256').update(bytes).digest('hex')
    if (got !== spec.sha256) throw new ToolError('ENGINE', `The downloaded ${spec.file} does not match its checksum; it was not used.`, [])
  }
  const part = `${file}.${process.pid.toString(36)}.part`
  writeFileSync(part, bytes)
  renameSync(part, file)
  return file
}

/**
 * The engines see the file system through WASI preopens. On macOS and Linux that is the
 * whole tree at `/`. On Windows each drive becomes `/c`, `/d` …, and toWasi() turns
 * `C:\\Users\\me\\a.psd` into `/c/Users/me/a.psd`.
 */
function preopens(): Record<string, string> {
  if (process.platform !== 'win32') return { '/': '/' }
  const out: Record<string, string> = {}
  for (const l of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') if (existsSync(`${l}:\\`)) out[`/${l.toLowerCase()}`] = `${l}:\\`
  return out
}

/** The machine's font folders, as the engines see them, for text the document's fonts lack. */
function fontDirs(): string[] {
  const home = homedir()
  const extra = (process.env.EZPZFILE_FONT_DIRS ?? '').split(/[;:](?![\\/])/).filter(Boolean)
  const list =
    process.platform === 'darwin'
      ? ['/System/Library/Fonts', '/Library/Fonts', join(home, 'Library/Fonts')]
      : process.platform === 'win32'
        ? [join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts'), join(process.env.LOCALAPPDATA ?? join(home, 'AppData/Local'), 'Microsoft/Windows/Fonts')]
        : ['/usr/share/fonts', '/usr/local/share/fonts', join(home, '.local/share/fonts'), join(home, '.fonts')]
  return [...extra, ...list].filter((d) => existsSync(d)).map(toWasi)
}

export function toWasi(path: string): string {
  if (process.platform !== 'win32') return path
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(path)
  return m ? `/${m[1]!.toLowerCase()}/${m[2]!.replace(/\\/g, '/')}` : path.replace(/\\/g, '/')
}

/**
 * A tiny runner file, written once to the cache. Not this bundle: loading the bundle
 * touches process.stdin on the way, which makes the pipe non-blocking, and the engine's
 * WASI read of stdin then fails with EAGAIN.
 */
const RUNNER = `import { WASI } from 'node:wasi'
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
const [wasm, ...args] = process.argv.slice(2)
let pre = { '/': '/' }
if (process.platform === 'win32') { pre = {}; for (const l of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') if (existsSync(l + ':\\\\')) pre['/' + l.toLowerCase()] = l + ':\\\\' }
const wasi = new WASI({ version: 'preview1', args: ['engine', ...args], env: { HOME: process.env.EZPZ_GUEST_HOME ?? homedir(), EZPZ_FONT_DIRS: process.env.EZPZ_FONT_DIRS ?? '', EZPZ_HOST_OS: process.env.EZPZ_HOST_OS ?? '', WINDIR: process.env.EZPZ_GUEST_WINDIR ?? '' }, preopens: pre, returnOnExit: true })
const inst = await WebAssembly.instantiate(await WebAssembly.compile(readFileSync(wasm)), wasi.getImportObject())
process.exitCode = wasi.start(inst)
`

function runnerPath(): string {
  const file = join(cacheDir(), 'wasi-runner-3.mjs')
  if (!existsSync(file) || readFileSync(file, 'utf8') !== RUNNER) writeFileSync(file, RUNNER)
  return file
}

/** `node index.js --wasi-run <wasm> args…`: run a WASI command and exit with its code. */
export async function runWasiCommand(argv: string[]): Promise<void> {
  const [wasm, ...args] = argv
  const { WASI } = await import('node:wasi')
  const wasi = new WASI({ version: 'preview1', args: ['engine', ...args], env: { HOME: homedir() }, preopens: preopens(), returnOnExit: true })
  const mod = await WebAssembly.compile(readFileSync(wasm!))
  const inst = await WebAssembly.instantiate(mod, wasi.getImportObject() as WebAssembly.Imports)
  process.exitCode = wasi.start(inst)
}

class EngineProcess {
  private child: ChildProcess | null = null
  private buf = ''
  private next = 1
  private waits = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private ready: Promise<void> | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(readonly kind: EngineKind) {}

  private async start(): Promise<void> {
    const spec = ENGINES[this.kind]
    const wasm = await wasmPath(this.kind)
    const child = spawn(process.execPath, ['--no-turbo-fast-api-calls', '--no-warnings', runnerPath(), wasm, ...spec.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        EZPZ_FONT_DIRS: fontDirs().join(':'),
        EZPZ_GUEST_HOME: toWasi(homedir()),
        EZPZ_HOST_OS: process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux',
        EZPZ_GUEST_WINDIR: process.platform === 'win32' ? toWasi(process.env.WINDIR ?? 'C:\\Windows') : '',
      },
    })
    this.child = child
    let stderr = ''
    child.stderr!.on('data', (d) => (stderr = (stderr + d).slice(-4000)))
    child.stdout!.on('data', (d) => {
      this.buf += d
      let i
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i)
        this.buf = this.buf.slice(i + 1)
        if (!line.trim()) continue
        let msg: { id?: number; result?: unknown; error?: { message?: string }; ok?: boolean }
        try {
          msg = JSON.parse(line)
        } catch {
          continue
        }
        const w = msg.id !== undefined ? this.waits.get(msg.id) : undefined
        if (!w) continue
        this.waits.delete(msg.id!)
        if (msg.error || msg.ok === false) w.reject(new ToolError('ENGINE', String(msg.error?.message ?? msg.error ?? 'engine error'), []))
        else w.resolve(msg.result)
      }
    })
    child.on('exit', (code, signal) => {
      // a child we stopped on purpose (endPhotoSession) may exit after its successor started
      if (this.child !== child) return
      const why = new ToolError('ENGINE', `The ${this.kind} engine stopped (${signal ?? code}). ${stderr.split('\n').filter((l) => /panicked|error/i.test(l)).slice(0, 2).join(' ')} The next call starts a fresh one.`, [])
      for (const w of this.waits.values()) w.reject(why)
      this.waits.clear()
      this.child = null
      this.ready = null
    })
    if (spec.protocol === 'mcp') {
      await this.raw('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'ezpzfile-mcp', version: '0' } })
      child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    }
  }

  private raw(method: string, params: unknown): Promise<unknown> {
    const id = this.next++
    const spec = ENGINES[this.kind]
    const line = spec.protocol === 'mcp' ? { jsonrpc: '2.0', id, method, params } : { id, method, params }
    return new Promise((resolve, reject) => {
      this.waits.set(id, { resolve, reject })
      this.child!.stdin!.write(`${JSON.stringify(line)}\n`)
    })
  }

  /** One request at a time, in order: the engines keep one active document. */
  call(method: string, params: unknown = {}): Promise<unknown> {
    const run = async () => {
      if (!this.child) this.ready = null
      this.ready ??= this.start()
      await this.ready
      return this.raw(method, params)
    }
    const p = this.queue.then(run, run)
    this.queue = p.catch(() => undefined)
    return p
  }

  stop(): void {
    const c = this.child
    this.child = null
    this.ready = null
    c?.kill()
  }
}

const procs = new Map<EngineKind, EngineProcess>()

export function engine(kind: EngineKind): EngineProcess {
  let p = procs.get(kind)
  if (!p) procs.set(kind, (p = new EngineProcess(kind)))
  return p
}

process.on('exit', () => {
  for (const p of procs.values()) p.stop()
})

/* ------------------------------------------------------------------ vector */

type McpContent = { content?: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean }

/** Call a VectorCraft MCP tool; returns its JSON (text content parsed) or image data. */
export async function vec(tool: string, args: Record<string, unknown> = {}): Promise<{ json: unknown; image?: string }> {
  const r = (await engine('vector').call('tools/call', { name: tool, arguments: args })) as McpContent
  const text = r.content?.find((c) => c.type === 'text')?.text
  const image = r.content?.find((c) => c.type === 'image')?.data
  if (r.isError) throw new ToolError('ENGINE', text ?? `${tool} failed`, [])
  let json: unknown = text
  if (text) {
    try {
      json = JSON.parse(text)
    } catch {
      json = text
    }
  }
  return { json, image }
}

/** Run one VectorCraft engine command. */
export async function vecCommand(command: string, params: Record<string, unknown> = {}): Promise<unknown> {
  return (await vec('run_command', { command, params })).json
}

/* ------------------------------------------------------------------ photo */

export async function photo(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  return engine('photo').call(method, params)
}

/**
 * PhotoCraft numbers layers across the whole session, so the same file opened twice gets
 * new ids. Each tool call ends the session, and the next one starts fresh: the ids
 * doc_inspect lists are then the ids doc_edit and doc_render find.
 */
export function endPhotoSession(): void {
  procs.get('photo')?.stop()
}
