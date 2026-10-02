/**
 * Node version of src/lib/rhwp.ts, used in place of it inside this bundle
 * (build.mjs, nodeShims).
 *
 * The site version downloads the HWP engine and the fonts and reports progress
 * while it does. Here both are read from the package on disk by ../engine, so
 * the progress callbacks are accepted and never called.
 */
import { loadFont as readFont, withEngine as useEngine, type FontKey, type RhwpModule } from '../engine'

export {
  discardEngine,
  EngineCrashError,
  freeDoc,
  HwpDocError,
  isEngineTrap,
  openDocument,
  type FontKey,
  type HwpDocument,
  type RhwpModule,
} from '../engine'

export function withEngine<T>(_report: unknown, run: (engine: RhwpModule) => Promise<T> | T): Promise<T> {
  return useEngine(run)
}

export async function loadFont(key: FontKey, _report?: unknown): Promise<Uint8Array> {
  return readFont(key)
}
