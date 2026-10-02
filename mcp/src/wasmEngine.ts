/**
 * Loader for the Ichitaro (JTD) and DocuWorks (XDW) engines.
 *
 * Both are our own Rust code compiled to WebAssembly, the same builds the
 * website's editors run (github.com/ezpzfile/ezpzfile-jtd, ezpzfile-xdw).
 * They ship in the package, so nothing is downloaded.
 *
 * A WebAssembly instance that traps (a Rust panic ends in `unreachable`)
 * cannot be used again, and this server lives for a whole session. So a trap
 * throws the instance away and the next call imports the glue under a new
 * address, which gives a fresh instance. engine.ts does the same for HWP.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isEngineTrap } from './engine'
import { vendorDir } from './vendor'

interface Glue {
  initSync(options: { module: BufferSource }): unknown
}

export class FormatEngineCrash extends Error {
  constructor(label: string) {
    super(
      `The ${label} engine stopped while working on this file. It has been restarted, so other files work again. If this file stops it again, the file is probably damaged or uses something the engine cannot read yet.`,
    )
    this.name = 'FormatEngineCrash'
  }
}

/**
 * `name` is the vendor folder and file prefix (ezpzjtd), `label` what an
 * error message calls it (Ichitaro).
 */
export function wasmEngine<M extends Glue>(name: string, label: string) {
  let loading: Promise<M> | null = null
  let generation = 0

  const load = (): Promise<M> => {
    if (!loading) {
      const gen = generation
      loading = (async () => {
        const dir = vendorDir(name)
        const url = pathToFileURL(join(dir, `${name}_wasm.js`)).href + (gen ? `?i=${gen}` : '')
        const mod = (await import(url)) as M
        mod.initSync({ module: readFileSync(join(dir, `${name}_wasm_bg.wasm`)) })
        return mod
      })().catch((err) => {
        loading = null
        throw err
      })
    }
    return loading
  }

  return async function use<T>(work: (mod: M) => Promise<T> | T): Promise<T> {
    const mod = await load()
    try {
      return await work(mod)
    } catch (err) {
      if (!isEngineTrap(err)) throw err
      loading = null
      generation += 1
      throw new FormatEngineCrash(label)
    }
  }
}

/** Free a wasm-bindgen object without letting a failed free hide the real error. */
export function release(obj: { free(): void } | null | undefined): void {
  try {
    obj?.free()
  } catch {
    // the instance already trapped; use() has thrown it away
  }
}
