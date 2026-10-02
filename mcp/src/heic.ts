/**
 * iPhone photos (HEIC, HEIF).
 *
 * sharp reads the HEIF container but its prebuilt binaries leave out the HEVC
 * decoder for patent reasons, so a HEIC photo fails with "compression format
 * has not been built in". libheif compiled to WebAssembly decodes it instead,
 * the same build the website uses (public/vendor/libheif). Rotation is already
 * applied in what it returns.
 *
 * libheif is LGPL-3.0. It ships as its own two files in vendor/libheif with the
 * licence beside them, never bundled, so it can be replaced.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { isHeif } from '../../src/lib/heicOps'
import { getSharp } from './sharp'
import { vendorDir } from './vendor'

export { isHeif }

interface HeifImage {
  get_width(): number
  get_height(): number
  display(into: { data: Uint8ClampedArray; width: number; height: number }, done: (result: unknown) => void): void
  free?(): void
}

interface Libheif {
  HeifDecoder: new () => { decode(bytes: Uint8Array): HeifImage[] }
}

type Factory = (options: Record<string, unknown>) => Promise<Libheif>

const require = createRequire(import.meta.url)
let loading: Promise<Libheif> | null = null

/**
 * The build is a UMD script that exports through `module.exports`. Inside a
 * package marked "type": "module" Node would load it as an ES module, where it
 * exports nothing, so it is evaluated as the CommonJS script it is.
 */
function loadDecoder(): Promise<Libheif> {
  if (!loading) {
    loading = (async () => {
      const dir = vendorDir('libheif')
      const file = join(dir, 'libheif.js')
      const module = { exports: {} as unknown }
      new Function('module', 'exports', 'require', '__filename', '__dirname', readFileSync(file, 'utf8'))(
        module,
        module.exports,
        require,
        file,
        dirname(file),
      )
      const factory = module.exports as Factory
      return factory({
        wasmBinary: readFileSync(join(dir, 'libheif.wasm')),
        // Emscripten prints to stdout by default, which is the protocol channel.
        print: () => {},
        printErr: () => {},
      })
    })().catch((err) => {
      loading = null
      throw err
    })
  }
  return loading
}

/** First picture of a HEIC file as RGBA pixels. Live Photos carry more than one; the first is the photo. */
export async function decodeHeic(bytes: Uint8Array): Promise<{ rgba: Uint8ClampedArray; width: number; height: number; count: number }> {
  const lib = await loadDecoder()
  const images = new lib.HeifDecoder().decode(bytes)
  const image = images[0]
  if (!image) throw new Error('This HEIC file holds no picture libheif can decode. It may be damaged.')
  try {
    const width = image.get_width()
    const height = image.get_height()
    if (!width || !height) throw new Error('The HEIC picture has no size. The file may be damaged.')
    const into = { data: new Uint8ClampedArray(width * height * 4), width, height }
    await new Promise<void>((resolve, reject) => {
      image.display(into, (result) => (result ? resolve() : reject(new Error('libheif could not decode this HEIC picture.'))))
    })
    return { rgba: into.data, width, height, count: images.length }
  } finally {
    for (const one of images) one.free?.()
  }
}

/**
 * HEIC as lossless PNG bytes, so the rest of the image pipeline (sharp, pdf-lib,
 * the cut-out model) can take it like any other photo. Anything else comes back
 * untouched.
 */
export async function heicToPng(bytes: Uint8Array): Promise<{ bytes: Uint8Array; heic: boolean }> {
  if (!isHeif(bytes.subarray(0, 12))) return { bytes, heic: false }
  const { rgba, width, height } = await decodeHeic(bytes)
  const sharp = await getSharp()
  const png = await sharp(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), {
    raw: { width, height, channels: 4 },
  })
    // Fast deflate: this PNG only lives until the next step re-encodes it.
    .png({ compressionLevel: 1 })
    .toBuffer()
  return { bytes: new Uint8Array(png), heic: true }
}
