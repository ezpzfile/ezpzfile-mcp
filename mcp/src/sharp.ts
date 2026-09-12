/**
 * sharp is loaded on first use, never at import time.
 *
 * It is a native module: on a broken install it throws while loading. Imported
 * at the top of a module that the server imports, that throw happened before
 * `initialize` and killed the process, so a machine that could not build sharp
 * lost all seven tools instead of the two that need pixels.
 */
import type { Sharp, SharpOptions } from 'sharp'

type SharpFactory = (input?: Buffer | Uint8Array | string, options?: SharpOptions) => Sharp

let loading: Promise<SharpFactory> | null = null

export async function getSharp(): Promise<SharpFactory> {
  if (!loading) {
    loading = import('sharp')
      .then((mod) => (mod.default ?? mod) as unknown as SharpFactory)
      .catch((error: unknown) => {
        loading = null
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(
          `The image engine (sharp) failed to load, so this operation is unavailable in this install. Every tool that does not touch pixels still works. Reinstalling usually fixes it: npm rebuild sharp. Original error: ${detail}`,
        )
      })
  }
  return loading
}
