/**
 * 유료 폰트 글자 맞대기. 판매처 미리보기로 받은 글자에서 만든 "숫자 지문"(글자 하나에 64개 숫자)과 비교한다.
 * 숫자 지문은 32x32 글자 모양을 흐리고(4이웃 더하기) 고정 난수 행렬 G(64x1024)로 줄인 것이라 그림으로 되돌릴 수 없다.
 * 만드는 쪽: scripts/fontfind/vendor/build_paid_glyph.py (같은 계산).
 */
import { N } from './core.ts'
import type { Bits, Glyph } from './core.ts'
import { FONTFIND_BASE } from './data.ts'
import type { FontScript } from './data.ts'

export interface PaidGlyphIndex {
  v: number
  dim: number
  scale: number
  scripts: Record<string, { chars: string; keys: string[]; shard: number }>
}

const memo = new Map<string, Promise<unknown>>()
function once<T>(key: string, make: () => Promise<T>): Promise<T> {
  let p = memo.get(key) as Promise<T> | undefined
  if (!p) {
    p = make().catch((e) => {
      memo.delete(key)
      throw e
    })
    memo.set(key, p)
  }
  return p
}

async function bin(path: string): Promise<ArrayBuffer> {
  const r = await fetch(FONTFIND_BASE + path)
  if (!r.ok) throw new Error(`fontfind ${path} ${r.status}`)
  return r.arrayBuffer()
}

export function loadPaidGlyphIndex(): Promise<PaidGlyphIndex | null> {
  return once('pg:index', async () => {
    try {
      const r = await fetch(FONTFIND_BASE + 'pg/index.json')
      return r.ok ? ((await r.json()) as PaidGlyphIndex) : null
    } catch {
      return null
    }
  })
}

function loadG(): Promise<Float32Array> {
  return once('pg:g', async () => new Float32Array(await bin('pg/g64.bin')))
}

function loadShard(s: string, k: number): Promise<Int8Array> {
  return once(`pg:${s}:${k}`, async () => new Int8Array(await bin(`pg/${s}/${k}.bin`)))
}

/** 32x32 지문 → 64개 숫자(길이 1). build_paid_glyph.py vec() 와 같다 */
export function project(bits: Bits, G: Float32Array, dim = 64): Float32Array | null {
  const m = new Float32Array(N * N)
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) m[y * N + x] = (bits[y] >>> x) & 1
  const o = new Float32Array(N * N)
  let sum = 0
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = y * N + x
      let v = m[i]
      if (y > 0) v += m[i - N]
      if (y < N - 1) v += m[i + N]
      if (x > 0) v += m[i - 1]
      if (x < N - 1) v += m[i + 1]
      o[i] = v
      sum += v
    }
  const mean = sum / (N * N)
  for (let i = 0; i < o.length; i++) o[i] -= mean
  const p = new Float32Array(dim)
  let n2 = 0
  for (let d = 0; d < dim; d++) {
    let acc = 0
    const row = d * N * N
    for (let i = 0; i < o.length; i++) acc += G[row + i] * o[i]
    p[d] = acc
    n2 += acc * acc
  }
  const n = Math.sqrt(n2)
  if (n < 1e-6) return null
  for (let d = 0; d < dim; d++) p[d] /= n
  return p
}

/** 숫자 지문 코사인 → 무료 글자 맞대기(similarity)와 같은 저울(무료 글꼴로 맞춘 직선, 상관 0.93) */
export const toGlyphScale = (cos: number) => 0.687 * cos + 0.278

export interface PaidGlyphScore {
  k: string
  score: number
  n: number
}

/**
 * 관찰한 글자들(글자 + 32x32 지문) → 유료 가족별 평균 닮음. 라틴 글자는 la 묶음에서 찾는다.
 * 가족이 가진 글자가 70% 미만이면 뺀다(무료 rankFaces 와 같은 규칙).
 */
export async function rankPaidGlyph(obs: { glyph: Glyph; char: string }[], script: FontScript): Promise<{ scores: PaidGlyphScore[]; covered: Set<string> }> {
  const none = { scores: [] as PaidGlyphScore[], covered: new Set<string>() }
  const idx = await loadPaidGlyphIndex()
  if (!idx) return none
  const G = await loadG()
  const pos = new Map<string, Map<string, number>>()
  const where = (ch: string): string | null => {
    for (const s of [script, 'la']) {
      const sm = idx.scripts[s]
      if (!sm) continue
      let m = pos.get(s)
      if (!m) {
        m = new Map(Array.from(sm.chars).map((c, i) => [c, i]))
        pos.set(s, m)
      }
      if (m.has(ch)) return s
    }
    return null
  }
  const use = obs.map((o) => ({ ...o, s: where(o.char) })).filter((o) => o.s)
  if (!use.length) return none
  const dim = idx.dim
  const sum = new Map<string, number>()
  const cnt = new Map<string, number>()
  await Promise.all(
    use.map(async (o) => {
      const sm = idx.scripts[o.s!]
      const i = pos.get(o.s!)!.get(o.char)!
      const k = Math.floor(i / sm.shard)
      const data = await loadShard(o.s!, k)
      const q = project(o.glyph.bits, G, dim)
      if (!q) return
      const F = sm.keys.length
      const base = (i - k * sm.shard) * F * dim
      for (let f = 0; f < F; f++) {
        const off = base + f * dim
        let dot = 0
        let n2 = 0
        for (let d = 0; d < dim; d++) {
          const v = data[off + d]
          dot += v * q[d]
          n2 += v * v
        }
        if (!n2) continue // 그 가족에 없는 글자
        const key = sm.keys[f]
        sum.set(key, (sum.get(key) ?? 0) + toGlyphScale(dot / Math.sqrt(n2)))
        cnt.set(key, (cnt.get(key) ?? 0) + 1)
      }
    }),
  )
  const need = Math.max(1, Math.ceil(use.length * 0.7))
  const out: PaidGlyphScore[] = []
  for (const [k, s] of sum) {
    const n = cnt.get(k)!
    if (n < need) continue
    out.push({ k, score: (s / n) * (0.9 + 0.1 * (n / use.length)), n })
  }
  out.sort((a, b) => b.score - a.score)
  // 숫자 지문이 있는 가족(이 글자들을 맞대 본 가족)
  const covered = new Set<string>(cnt.keys())
  return { scores: out, covered }
}
