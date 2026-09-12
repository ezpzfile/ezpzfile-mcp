/**
 * Background removal, the same U²-Net model the website runs.
 *
 * The browser version (src/lib/matteOps.ts) draws on a canvas; here sharp does
 * the pixel work. The model, the normalisation constants and the mask stretch
 * are identical, so both produce the same cut-out for the same photo.
 *
 * The model is fetched on first use rather than shipped in the package. It is
 * 4.4MB and most sessions never ask for a cut-out, so bundling it would make
 * every `npx` slower for a tool most agents never call. It is cached on disk
 * afterwards, so the download happens once per machine, not once per session.
 *
 * Nothing about the photo leaves the machine. The model travels to the photo,
 * which is the same promise the website makes.
 *
 * Licence: U²-Net is Apache-2.0 (github.com/xuebinqin/U-2-Net) and
 * onnxruntime is MIT.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSharp } from './sharp'

/**
 * Downloaded on first use and kept on disk afterwards.
 *
 * The runtime is 14MB and the model 4.4MB. Shipping them in the package would
 * put that on every `npx ezpzfile-mcp`, including the many sessions that never
 * ask for a cut-out, so they are fetched once per machine instead. The
 * onnxruntime JavaScript is small enough to bundle, so only the wasm travels.
 *
 * The version is pinned in the path because /vendor is cached for a year.
 * Bumping onnxruntime means publishing a new folder, never overwriting one.
 */
const ORT_VERSION = '1.29.0'
const BASE = 'https://ezpzfile.com'
const MODEL_URL = `${BASE}/models/u2netp.onnx`
const MODEL_BYTES_MIN = 4_000_000
const ORT_FILES = ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs'] as const
const ORT_WASM_BYTES_MIN = 10_000_000

/** The resolution u2netp was trained at. Changing it ruins the output. */
const INPUT_SIZE = 320
/** ImageNet normalisation, matching rembg's U²-Net preprocessing. */
const MEAN = [0.485, 0.456, 0.406] as const
const STD = [0.229, 0.224, 0.225] as const
/** Beyond this the mask gains no detail, it only costs memory. */
const MAX_EDGE = 4096

function cacheDir(): string {
  const base =
    process.env.EZPZFILE_CACHE ??
    process.env.XDG_CACHE_HOME ??
    (homedir() ? join(homedir(), '.cache') : tmpdir())
  const dir = join(base, 'ezpzfile-mcp')
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Write under a temporary name and rename into place.
 *
 * A download cut off halfway would otherwise leave a short file that the size
 * check on the next run might still accept, and the failure would surface much
 * later as a corrupt model rather than a failed download.
 */
function writeAtomic(file: string, bytes: Uint8Array): void {
  const part = `${file}.${process.pid.toString(36)}.part`
  writeFileSync(part, bytes)
  renameSync(part, file)
}

async function download(url: string, minBytes: number): Promise<Uint8Array> {
  let response: Response
  try {
    response = await fetch(url)
  } catch (error) {
    throw new Error(
      `Could not download ${url}. Background removal is the one operation that needs the network, once per machine; everything else works offline. Original error: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!response.ok) throw new Error(`The server answered ${response.status} for ${url}.`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.length < minBytes) throw new Error(`The download from ${url} is truncated.`)
  return bytes
}

/** Put the onnxruntime wasm on disk and hand back the folder holding it. */
async function ortDir(): Promise<string> {
  const dir = join(cacheDir(), `ort-${ORT_VERSION}`)
  mkdirSync(dir, { recursive: true })
  for (const name of ORT_FILES) {
    const file = join(dir, name)
    const min = name.endsWith('.wasm') ? ORT_WASM_BYTES_MIN : 1_000
    if (existsSync(file) && readFileSync(file).length >= min) continue
    writeAtomic(file, await download(`${BASE}/vendor/ort/${ORT_VERSION}/${name}`, min))
  }
  return `${dir}/`
}

async function modelBytes(): Promise<Uint8Array> {
  const file = join(cacheDir(), 'u2netp.onnx')
  if (existsSync(file)) {
    const cached = readFileSync(file)
    if (cached.length >= MODEL_BYTES_MIN) return new Uint8Array(cached)
  }
  const bytes = await download(MODEL_URL, MODEL_BYTES_MIN)
  writeAtomic(file, bytes)
  return bytes
}

type Session = { inputNames: string[]; outputNames: string[]; run: (feeds: Record<string, unknown>) => Promise<Record<string, { data: unknown }>> }

let sessionPromise: Promise<{ session: Session; Tensor: new (t: string, d: Float32Array, dims: number[]) => unknown }> | null = null

async function getSession() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const ort = await import('onnxruntime-web/wasm')
      // Threads need SharedArrayBuffer and buy little at this model size.
      ort.env.wasm.numThreads = 1
      ort.env.logLevel = 'error'
      // Point the runtime at the cached wasm. Left alone it looks next to the
      // bundle, where nothing was shipped.
      ort.env.wasm.wasmPaths = await ortDir()
      const session = (await ort.InferenceSession.create(await modelBytes(), {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      })) as unknown as Session
      return { session, Tensor: ort.Tensor as unknown as new (t: string, d: Float32Array, dims: number[]) => unknown }
    })().catch((error: unknown) => {
      // A rejected promise left in place would replay the same error forever.
      sessionPromise = null
      throw error
    })
  }
  return sessionPromise
}

/** U²-Net outputs plain numbers, not probabilities, so each photo lands on its own range. */
function stretch(raw: Float32Array): Float32Array {
  let min = Infinity
  let max = -Infinity
  for (const v of raw) {
    if (v < min) min = v
    if (v > max) max = v
  }
  const span = max - min || 1
  const out = new Float32Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) out[i] = ((raw[i] ?? 0) - min) / span
  return out
}

export interface MatteResult {
  bytes: Uint8Array
  width: number
  height: number
  /** Inference only, download and decode excluded. */
  ms: number
}

export async function removeBackground(
  input: Uint8Array,
  opts: { background?: string; threshold?: number } = {},
): Promise<MatteResult> {
  const sharp = await getSharp()
  const meta = await sharp(input).metadata()
  const srcW = meta.width ?? 0
  const srcH = meta.height ?? 0
  if (!srcW || !srcH) throw new Error('Could not read the image.')

  const scale = Math.min(1, MAX_EDGE / Math.max(srcW, srcH))
  const width = Math.max(1, Math.round(srcW * scale))
  const height = Math.max(1, Math.round(srcH * scale))

  const small = await sharp(input)
    .resize(INPUT_SIZE, INPUT_SIZE, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer()

  const plane = INPUT_SIZE * INPUT_SIZE
  const tensor = new Float32Array(plane * 3)
  for (let i = 0; i < plane; i += 1) {
    const p = i * 3
    tensor[i] = ((small[p] ?? 0) / 255 - MEAN[0]) / STD[0]
    tensor[plane + i] = ((small[p + 1] ?? 0) / 255 - MEAN[1]) / STD[1]
    tensor[plane * 2 + i] = ((small[p + 2] ?? 0) / 255 - MEAN[2]) / STD[2]
  }

  const { session, Tensor } = await getSession()
  const started = Date.now()
  const outputs = await session.run({
    [session.inputNames[0] as string]: new Tensor('float32', tensor, [1, 3, INPUT_SIZE, INPUT_SIZE]),
  })
  const ms = Date.now() - started

  // d0 through d6 come back; the first is the final prediction.
  const raw = outputs[session.outputNames[0] as string]?.data
  if (!(raw instanceof Float32Array)) throw new Error('The model returned something unexpected.')
  const mask = stretch(raw)

  const cut = opts.threshold ?? 0
  const maskGray = Buffer.alloc(plane)
  for (let i = 0; i < plane; i += 1) {
    const v = Math.round((mask[i] ?? 0) * 255)
    maskGray[i] = cut > 0 ? (v >= cut * 255 ? 255 : 0) : v
  }

  // sharp promotes a one channel raw buffer to three on resize, so the stride
  // has to come from the result rather than be assumed. Reading it as 1 when
  // it is 3 does not fail, it silently samples the wrong pixel and produces a
  // mask that looks plausible and cuts out the subject instead of the
  // background. Ask for the info and trust that.
  const alphaOut = await sharp(maskGray, { raw: { width: INPUT_SIZE, height: INPUT_SIZE, channels: 1 } })
    .resize(width, height, { fit: 'fill' })
    .toColourspace('b-w')
    .raw()
    .toBuffer({ resolveWithObject: true })
  const alpha = alphaOut.data
  const alphaStride = alphaOut.info.channels

  const rgbOut = await sharp(input)
    .resize(width, height, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const rgb = rgbOut.data
  const rgbStride = rgbOut.info.channels
  const rgba = Buffer.alloc(width * height * 4)
  for (let i = 0; i < width * height; i += 1) {
    const src = i * rgbStride
    rgba[i * 4] = rgb[src] ?? 0
    rgba[i * 4 + 1] = rgb[src + 1] ?? rgb[src] ?? 0
    rgba[i * 4 + 2] = rgb[src + 2] ?? rgb[src] ?? 0
    rgba[i * 4 + 3] = alpha[i * alphaStride] ?? 0
  }

  let pipeline = sharp(rgba, { raw: { width, height, channels: 4 } })
  if (opts.background) {
    // Lay the cut-out back over a solid colour. PNG either way, because JPEG
    // has no alpha and a half transparent edge would turn black.
    pipeline = sharp({
      create: { width, height, channels: 4, background: opts.background },
    }).composite([{ input: await pipeline.png().toBuffer() }])
  }
  return { bytes: new Uint8Array(await pipeline.png().toBuffer()), width, height, ms }
}
