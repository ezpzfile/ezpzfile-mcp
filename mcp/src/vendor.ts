/**
 * Where the shipped engines live.
 *
 * In the package they sit in vendor/ next to dist/, one folder per engine
 * (build.mjs copies them there). Run from a checkout without a build, they are
 * read from the repository's public/vendor, where the website keeps each engine
 * in a folder named after its version, because /vendor is cached for a year.
 */
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** Newest first: 0.10.0 before 0.9.1, whatever follows the version is ignored. */
export function newestVersion(names: string[]): string | undefined {
  const key = (name: string) => (/^(\d+)\.(\d+)\.(\d+)/.exec(name) ?? []).slice(1).map(Number)
  return names
    .filter((name) => /^\d+\.\d+\.\d+/.test(name))
    .sort((a, b) => {
      const [x, y] = [key(a), key(b)]
      for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return (y[i] ?? 0) - (x[i] ?? 0)
      return 0
    })[0]
}

export function vendorDir(name: string): string {
  const packaged = join(here, '..', 'vendor', name)
  if (existsSync(packaged)) return packaged
  const base = join(here, '..', '..', 'public', 'vendor', name)
  const version = existsSync(base) ? newestVersion(readdirSync(base)) : undefined
  if (!version) throw new Error(`The ${name} engine is missing from this install. Reinstalling the package should bring it back.`)
  return join(base, version)
}
