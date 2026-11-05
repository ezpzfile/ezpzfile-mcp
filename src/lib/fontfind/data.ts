/**
 * 폰트 찾기 자료 받기. 자료(글자 지문·목록·미리보기)는 사이트와 따로 배포한다(fontfind-data/README.md).
 * 받기만 하고 아무것도 보내지 않는다. 이미지는 브라우저 밖으로 나가지 않는다.
 */
import { prepare, prepareRef16 } from './core.ts'
import type { Box, Gray, Prepared, Ref16, ScriptHint } from './core.ts'
import { f16ToF32, lineInputs, meanEmbedding, rankFamilies } from './ml.ts'
import type { Protos } from './ml.ts'
import { parseDict } from './ocr.ts'
import type { Run } from './ocr.ts'

export const FONTFIND_BASE: string = ((import.meta as { env?: Record<string, string | undefined> }).env?.VITE_FONTFIND_BASE) ?? 'https://ff.ezpzfile.com/v16/'

export type FontScript = ScriptHint

export interface FaceMeta {
  id: string
  src: 'google' | 'noonnu'
  family: string
  weight: number
  scripts: string[]
}

export interface ScriptMeta {
  chars: string
  faces: number[]
  shard: number
  refs: number[]
}

export interface IndexMeta {
  v: number
  n: number
  faces: FaceMeta[]
  scripts: Record<string, ScriptMeta>
}

/** 목록 한 줄(가족 하나) */
export interface FontFamily {
  k: string
  /** 주소용 이름(/fonts/<s>) */
  s: string
  /** 글자 묶음 */
  sc: string[]
  /** 닮은 가족 k */
  sim?: string[]
  name: string
  ko?: string
  ja?: string
  by?: string
  cat: 's' | 'r' | 'd' | 'h'
  /** g 구글 · n 눈누(npm) · x 추가 글꼴(제작사 직접 배포) · c 눈누 웹폰트 저장소 · p 유료(판매처 연결). x·c·p 는 미리보기 그림만 있다 */
  src: 'g' | 'n' | 'x' | 'c' | 'p' | 'o'
  ws: number[]
  /** 색인의 글꼴 번호들 */
  f: number[]
  g?: string
  n?: { p: string; v: string; files: Record<string, string>; page?: number }
  x?: { u?: string; h?: string; l?: string; lu?: string; f?: number; w?: Record<string, string> }
  c?: { r?: string }
  /** 유료: u 구매 페이지, v 판매처, n 굵기 수 */
  p?: { u: string; v: string; n?: number; f?: number }
  /** 운영체제 기본 폰트(맥·윈도우) */
  o?: { os: 'mac' | 'win' }
  /** 구글: 굵기별 TTF 주소(모두 받기) */
  dl?: Record<string, string>
  css?: string
  pv?: string
  pvw?: number
  /** 다른 글자 묶음 견본 그림이 있으면(pv/<pv>-<묶음>.webp): 묶음 → 그림 폭 */
  pvs?: Record<string, number>
  r: number
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

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(FONTFIND_BASE + path)
  if (!r.ok) throw new Error(`fontfind ${path} ${r.status}`)
  return (await r.json()) as T
}

async function getBin(path: string): Promise<ArrayBuffer> {
  const r = await fetch(FONTFIND_BASE + path)
  if (!r.ok) throw new Error(`fontfind ${path} ${r.status}`)
  return r.arrayBuffer()
}

export function loadList(s: FontScript): Promise<FontFamily[]> {
  return once(`list:${s}`, () => getJson<FontFamily[]>(`list-${s}.json`))
}

export function loadMeta(): Promise<IndexMeta> {
  return once('meta', () => getJson<IndexMeta>('meta.json'))
}

export function loadRef(s: FontScript): Promise<Ref16> {
  return once(`ref:${s}`, async () => prepareRef16(new Uint16Array(await getBin(`${s}/ref16.bin`))))
}

function loadShard(s: FontScript, k: number): Promise<Prepared> {
  return once(`shard:${s}:${k}`, async () => prepare(new Uint32Array(await getBin(`${s}/${k}.bin`))))
}

function loadFace16(s: FontScript, fi: number): Promise<Uint16Array> {
  return once(`f16:${s}:${fi}`, async () => new Uint16Array(await getBin(`${s}/f/${fi}.bin`)))
}

/** 글꼴 몇 개의 글자 전부로 만든 읽기 기준표(다시 읽기용). 글꼴 하나에 수십 KB. */
export async function fontRef(meta: IndexMeta, s: FontScript, faces: number[]): Promise<Ref16 | null> {
  const sm = meta.scripts[s]
  if (!sm) return null
  const use = faces.filter((f) => sm.faces.includes(f))
  if (!use.length) return null
  const parts = await Promise.all(use.map((f) => loadFace16(s, f)))
  const C = Array.from(sm.chars).length
  const out = new Uint16Array(parts.length * C * 16)
  parts.forEach((p, i) => out.set(p.subarray(0, C * 16), i * C * 16))
  return prepareRef16(out)
}

/** 그 묶음 견본 그림이 따로 있으면 그것 */
export function pvFor(f: { pv?: string; pvs?: Record<string, number> }, sc: string): string {
  return f.pvs?.[sc] ? `${f.pv}-${sc}` : f.pv!
}

export function previewUrl(pv: string): string {
  return `${FONTFIND_BASE}pv/${pv}.webp`
}

/**
 * 맞대 볼 글자들의 조각을 미리 받아 두고, 글자 → 지문 표를 돌려준다.
 * 라틴 글자(영문·숫자)는 라틴 묶음에서 찾는다.
 */
export async function tableFor(meta: IndexMeta, script: FontScript, chars: string[], onProgress?: (done: number, total: number) => void) {
  const pos = new Map<string, Map<string, number>>()
  const where = (ch: string): FontScript | null => {
    for (const s of [script, 'la'] as FontScript[]) {
      const sm = meta.scripts[s]
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
  const need = new Map<string, { s: FontScript; k: number }>()
  for (const ch of new Set(chars)) {
    const s = where(ch)
    if (!s) continue
    const k = Math.floor(pos.get(s)!.get(ch)! / meta.scripts[s].shard)
    need.set(`${s}:${k}`, { s, k })
  }
  let done = 0
  const loaded = new Map<string, Prepared>()
  await Promise.all(
    [...need.entries()].map(async ([key, { s, k }]) => {
      loaded.set(key, await loadShard(s, k))
      onProgress?.(++done, need.size)
    }),
  )
  return (ch: string) => {
    const s = where(ch)
    if (!s) return null
    const sm = meta.scripts[s]
    const i = pos.get(s)!.get(ch)!
    const k = Math.floor(i / sm.shard)
    const data = loaded.get(`${s}:${k}`)
    if (!data) return null
    return { faces: sm.faces, data, offset: (i - k * sm.shard) * sm.faces.length }
  }
}

/* ───────── 미리보기 글꼴 붙이기 ───────── */

const linked = new Set<string>()

/** 구글 글꼴: 이름과 굵기만 구글에 보낸다(쓰는 글자 범위 조각만 받는다). */
export function linkGoogle(family: string, weights: number[]) {
  const key = `g:${family}`
  if (linked.has(key) || typeof document === 'undefined') return
  linked.add(key)
  const q = encodeURIComponent(family).replace(/%20/g, '+')
  const ws = [...new Set(weights)].sort((a, b) => a - b)
  const el = document.createElement('link')
  el.rel = 'stylesheet'
  el.href = `https://fonts.googleapis.com/css2?family=${q}${ws.length > 1 || ws[0] !== 400 ? `:wght@${ws.join(';')}` : ''}&display=swap`
  document.head.appendChild(el)
}

/** 눈누 글꼴: 공개 웹폰트 묶음(jsDelivr)에서 받는다. 파일이 커서 필요할 때만. */
export function noonnuFamily(f: FontFamily): string {
  return `ezff-${f.s}`
}

export function linkNoonnu(f: FontFamily) {
  if (!f.n || typeof document === 'undefined') return
  const key = `n:${f.k}`
  if (linked.has(key)) return
  linked.add(key)
  const fam = noonnuFamily(f)
  const css = Object.entries(f.n.files)
    .map(
      ([w, file]) =>
        `@font-face{font-family:'${fam}';font-weight:${w};font-display:swap;src:url('https://cdn.jsdelivr.net/npm/${file.includes('@') ? file : `${f.n!.p}@${f.n!.v}/${file}`}')}`,
    )
    .join('\n')
  const el = document.createElement('style')
  el.textContent = css
  document.head.appendChild(el)
}

/** 이 가족을 그릴 CSS font-family 값 */
export function cssFamily(f: FontFamily): string {
  if (f.src === 'g') return `'${f.g}', sans-serif`
  return `'${noonnuFamily(f)}', sans-serif`
}

export function linkFamily(f: FontFamily) {
  if (f.src === 'g') linkGoogle(f.g!, f.ws)
  else if (f.src === 'n') linkNoonnu(f)
}

export function officialUrl(f: FontFamily): string {
  if (f.src === 'g') return `https://fonts.google.com/specimen/${encodeURIComponent(f.g!).replace(/%20/g, '+')}`
  if (f.src === 'x') return f.x?.h ?? f.x?.u ?? '#'
  if (f.src === 'c') return `https://www.google.com/search?q=${encodeURIComponent(`${f.ko ?? f.name} 폰트`)}`
  return f.n?.page ? `https://noonnu.cc/font_page/${f.n.page}` : `https://www.npmjs.com/package/${f.n?.p}`
}

/* ───────── 학습 모델(글자 읽기 없이 줄 모양으로 찾기) ───────── */

type OrtSession = import('onnxruntime-web').InferenceSession

/** 모델(3MB)과 실행기(wasm)를 처음 찾을 때 한 번만 받는다. 못 받으면 글자 맞대기만으로 찾는다. */
export function loadModel(): Promise<{ ort: typeof import('onnxruntime-web'); session: OrtSession }> {
  return once('ml:model', async () => {
    const ort = await import('onnxruntime-web/wasm')
    // 스레드를 쓰려면 COEP 헤더가 필요한데 그러면 광고 iframe 이 막힌다. 한 스레드로 돈다.
    ort.env.wasm.numThreads = 1
    ort.env.logLevel = 'error'
    const bytes = new Uint8Array(await getBin('ml/model.onnx'))
    const session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' })
    return { ort: ort as unknown as typeof import('onnxruntime-web'), session }
  })
}

/* ───────── 사진 속 글자 줄 찾기·읽기(PaddleOCR, Apache-2.0) ───────── */

async function ocrSession(file: string): Promise<Run> {
  const { ort } = await loadModel()
  const bytes = new Uint8Array(await getBin(`ocr/${file}`))
  const s = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' })
  return async (x, dims) => {
    const o = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', x, dims) })
    const t = o[s.outputNames[0]]
    return { data: t.data as Float32Array, dims: t.dims }
  }
}

/** 줄 찾기(1.8MB)·공용 읽기(한·중·일·영, 5.6MB). 사진을 처음 넣을 때 한 번만 받는다 */
export function loadOcr(): Promise<{ det: Run; rec: Run; dict: string[] }> {
  return once('ocr:main', async () => {
    const [det, rec, dict] = await Promise.all([
      ocrSession('det.onnx'),
      ocrSession('rec.onnx'),
      fetch(FONTFIND_BASE + 'ocr/dict.txt').then((r) => r.text()),
    ])
    return { det, rec, dict: parseDict(dict) }
  })
}

/** 한글 읽기(3.6MB): 공용 모델이 못 읽은 줄이 있을 때만 */
export function loadOcrKo(): Promise<{ rec: Run; dict: string[] }> {
  return once('ocr:ko', async () => {
    const [rec, dict] = await Promise.all([ocrSession('rec-ko.onnx'), fetch(FONTFIND_BASE + 'ocr/dict-ko.txt').then((r) => r.text())])
    return { rec, dict: parseDict(dict) }
  })
}

/** 글자 묶음별 읽기 모델(각 4MB, PP-OCRv5): 공용 모델 사전에 없는 키릴·아랍(페르시아 포함)·그리스·태국·데바나가리. 그 줄이 있을 때만 받는다 */
export type OcrLang = 'cy' | 'ar' | 'gr' | 'th' | 'hi'
export function loadOcrLang(l: OcrLang): Promise<{ rec: Run; dict: string[] }> {
  return once(`ocr:${l}`, async () => {
    const [rec, dict] = await Promise.all([ocrSession(`rec-${l}.onnx`), fetch(FONTFIND_BASE + `ocr/dict-${l}.txt`).then((r) => r.text())])
    return { rec, dict: parseDict(dict) }
  })
}

export function loadProtos(s: FontScript): Promise<Protos> {
  return once(`ml:protos:${s}`, async () => {
    const [j, b] = await Promise.all([getJson<{ keys: string[]; fam: number[]; w: number[] }>(`ml/${s}.json`), getBin(`ml/${s}.bin`)])
    return { v: f16ToF32(new Uint16Array(b)), fam: Int32Array.from(j.fam), weight: Int16Array.from(j.w), keys: j.keys }
  })
}

/** 유료·운영체제 기본 폰트 목록 행(src 'p'·'o'). 그 글자 묶음에 없으면 빈 목록 */
export function loadPaidList(s: FontScript): Promise<FontFamily[]> {
  return once(`paidlist:${s}`, () => getJson<FontFamily[]>(`paid2/list-${s}.json`).catch(() => [] as FontFamily[]))
}

/** 글자 묶음별 폰트 수(무료·유료·기본). 목록을 다 받지 않고 언어 단추에 수를 보이려고 따로 둔다 */
export type FontCounts = Record<string, { free: number; paid: number; os: number; check?: number }>
export function loadCounts(): Promise<FontCounts | null> {
  return once('counts', () => getJson<FontCounts>('counts.json').catch(() => null))
}

/** 유료 폰트(판매처 공개 미리보기로 만든 대표 벡터). 목록 행은 무료와 같은 모양(src 'p')이고 글꼴 파일은 없다. */
export function loadPaid(s: FontScript): Promise<{ protos: Protos; byKey: Map<string, FontFamily> } | null> {
  return once(`paid:${s}`, async () => {
    try {
      const [j, b, l] = await Promise.all([
        getJson<{ keys: string[]; fam: number[]; w: number[] }>(`paid2/${s}.json`),
        getBin(`paid2/${s}.bin`),
        loadPaidList(s),
      ])
      return {
        protos: { v: f16ToF32(new Uint16Array(b)), fam: Int32Array.from(j.fam), weight: Int16Array.from(j.w), keys: j.keys },
        byKey: new Map(l.map((f) => [f.k, f])),
      }
    } catch {
      return null
    }
  })
}

/** 줄 상자들 → 가족별 모델 닮음(코사인). 유료 폰트 닮음도 같은 특징 벡터로 함께 낸다. */
/**
 * 글자 묶음 고르기: 줄 모양 특징 하나를 뽑아, 묶음마다 가장 닮은 가족의 닮음을 돌려준다.
 * 가장 높은 묶음이 답(실제 사진 시험 450건에서 96%. 글자 맞대기로 고르던 예전 방법은 화면 언어 쪽으로 쏠려 52%).
 */
export async function scriptSims(gray: Gray, lines: Box[], glyphs: Box[][] | undefined, scripts: FontScript[]): Promise<Partial<Record<FontScript, number>>> {
  // 대표 벡터가 아직 없는 묶음(자료가 덜 올라감)은 빼고 견준다
  const [{ ort, session }, ...protos] = await Promise.all([loadModel(), ...scripts.map((s) => loadProtos(s).catch(() => null))])
  const embs: Float32Array[] = []
  for (const { data, w } of lineInputs(gray, lines, glyphs)) {
    const o = await session.run({ x: new ort.Tensor('float32', data, [1, 1, 64, w]) })
    embs.push(o.emb.data as Float32Array)
  }
  const e = meanEmbedding(embs)
  const out: Partial<Record<FontScript, number>> = {}
  if (!e) return out
  scripts.forEach((s, i) => {
    const p = protos[i]
    if (p) out[s] = rankFamilies(e, p)[0]?.sim ?? 0
  })
  return out
}

export async function modelRank(gray: Gray, lines: Box[], s: FontScript, glyphs?: Box[][]) {
  const [{ ort, session }, protos, paid] = await Promise.all([loadModel(), loadProtos(s), loadPaid(s)])
  const embs: Float32Array[] = []
  for (const { data, w } of lineInputs(gray, lines, glyphs)) {
    const o = await session.run({ x: new ort.Tensor('float32', data, [1, 1, 64, w]) })
    embs.push(o.emb.data as Float32Array)
  }
  const e = meanEmbedding(embs)
  const paidByKey = paid?.byKey ?? new Map<string, FontFamily>()
  if (!e) return { free: [], paid: [], paidAll: new Map<string, { sim: number; weight: number }>(), paidByKey }
  const all = paid ? rankFamilies(e, paid.protos) : []
  const paidRank = all
    .slice(0, 60)
    .map((r) => ({ f: paidByKey.get(r.k)!, sim: r.sim, weight: r.weight }))
    .filter((r) => r.f)
  // 글자 맞대기로 올라온 유료 가족도 모델 닮음을 쓸 수 있게 전부 둔다
  const paidAll = new Map(all.map((r) => [r.k, { sim: r.sim, weight: r.weight }]))
  return { free: rankFamilies(e, protos), paid: paidRank, paidAll, paidByKey }
}
