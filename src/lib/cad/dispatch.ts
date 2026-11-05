/**
 * RVT 가 아닌 CAD·BIM 파일(DWG, DXF, JWW(Jw_cad), iCAD SX(ICD), SXF(SFC·P21), PCB(Gerber·드릴·ODB++·IPC-2581), IGES, Inventor(IPT·IAM), DWFx, IFC, STEP, SKP, glTF/GLB, OBJ, STL, 3DS, FBX)을 일꾼 안에서 연다.
 *
 * 형식은 바이트로 정한다(확장자는 오류 문구를 고를 때만 쓴다). 엔진마다 따로 떨어진 조각(lazy chunk)이라
 * 이 파일은 동적 import 만 들고 있다. 앞머리 몇 바이트로 어느 엔진부터 물어볼지 정하고, 그 엔진의 sniff
 * 함수가 "내 것"이라고 해야 읽는다. 아무도 아니라고 하면 not-format 이다.
 *
 * 3D 결과는 화면이 RVT 와 같은 3D 화면·탐색기를 쓰도록 여기서 손질한다(normalize3d):
 * - 카테고리: 엔진이 categoryName(IFC 클래스, 레이어, 재질)만 주므로 이름마다 번호(1,000,000 부터)를 붙인다.
 *   덩어리·모서리·요소가 같은 번호를 쓰게 해서 카테고리 끄기·색 칠하기·모서리 숨기기가 그대로 된다.
 *   요소는 삼각형을 가장 많이 가진 덩어리의 카테고리를 따른다(메시는 덩어리가 재질별이다).
 * - 레벨: IFC 층(levelId·levelName)을 RvtModel.levels 꼴로 만든다. 높이는 그 층 요소들 바닥 높이의 최빈값.
 */
import type { CategoryCount, GeomElement, Level, RvtGeometry, RvtModel, RvtSheet2D } from '../rvt/types.ts'

export type CadFormat = 'dwg' | 'dxf' | 'jww' | 'icd' | 'sxf' | 'pcb' | 'iges' | 'inventor' | 'dwfx' | 'ifc' | 'gltf' | 'obj' | 'stl' | '3ds' | 'fbx' | 'skp' | 'step'
export type CadErrorCode = 'not-format' | 'corrupt' | 'unsupported-version' | 'encrypted' | 'too-large' | 'dwf-classic' | 'missing-parts'

export interface CadLayer {
  name: string
  color: string
  visible: boolean
  frozen?: boolean
  items?: number
  /** 축척 1:n (Jw_cad 레이어 그룹). 실제 길이 mm = 도면 mm x scale */
  scale?: number
  /** PCB 층: 종류(copper·mask·silk·paste·outline·drill·board …), 면(top·bottom·inner·both), 구리 층 번호, 권장 투명도 */
  kind?: string
  side?: string | null
  order?: number
  opacity?: number
}

/** PCB 비교에서 찾은 차이 하나(mm, 파일 좌표: 시트 좌표 = 파일 좌표 - sheet.origin) */
export interface PcbDiffItem {
  layer: string
  kind: 'added' | 'removed'
  x: number
  y: number
  box: [number, number, number, number]
  areaMm2: number
}

/** STEP 조립 구조의 노드(조립품·부품 배치·바디). id 는 요소 id 와 같다(조립 노드는 요소가 없다) */
export interface AssemblyNode {
  id: number
  parent: number | null
  name: string
  product: string
  depth: number
  hasGeometry: boolean
}

export interface CadMeta {
  format: CadFormat
  /** 엔진이 알려 준 형식 이름(예: 'DXF (ASCII)', 'IFC (zip)') */
  label: string
  info: Record<string, string | number>
  warnings: string[]
  /** 조립품(Inventor .iam)이 부르는데 함께 넣지 않은 부품 파일 이름 */
  missingParts?: string[]
}

export type CadOpened =
  | { kind: '3d'; meta: CadMeta; model: RvtModel; geometry: RvtGeometry; props: Record<number, Record<string, string>> | null; tree?: AssemblyNode[] }
  | {
      kind: '2d'
      meta: CadMeta
      sheets: RvtSheet2D[]
      layers: CadLayer[]
      /** PCB: 같은 판의 3D(있을 때). 화면의 2D/3D 전환이 쓴다 */
      alt3d?: { model: RvtModel; geometry: RvtGeometry }
      /** PCB 비교: 차이 목록 */
      diffs?: PcbDiffItem[]
    }

export class CadOpenError extends Error {
  code: CadErrorCode
  format: CadFormat | null
  /** 파일 앞머리의 버전 문자열(DWG: 'AC1009' 등). GA 의 version_tag */
  versionTag?: string
  /** missing-parts: 없는 부품 파일 이름 */
  missing?: string[]
  constructor(code: CadErrorCode, message: string, format: CadFormat | null, extra: { versionTag?: string; missing?: string[] } = {}) {
    super(message)
    this.code = code
    this.format = format
    if (extra.versionTag) this.versionTag = extra.versionTag
    if (extra.missing) this.missing = extra.missing
  }
}

/** 열기 선택: 조립품이 부르는 다른 파일을 상대 경로·이름으로 찾아 준다(Inventor .iam) */
export interface CadOpenOptions {
  resolve?: (relPath: string) => Uint8Array | null
  /** 연 파일의 이름(PCB 는 이름으로 층을 짐작한다) */
  name?: string
  /** 함께 넣은 파일 전부(PCB: Gerber 층·드릴 묶음, ODB++ 폴더). 경로는 넣은 곳에서 본 상대 경로 */
  files?: { name: string; bytes: Uint8Array }[]
  /** PCB 3D 를 만들지(큰 묶음은 처음에 끈다) */
  threeD?: boolean
}

type Progress = (stage: string, ratio: number) => void
type Engine = 'dwg' | 'dxf' | 'jww' | 'icd' | 'sxf' | 'pcb' | 'iges' | 'inventor' | 'ifc' | 'mesh' | 'skp' | 'step'

const text = (b: Uint8Array, a: number, n: number) => {
  let s = ''
  for (let i = a; i < Math.min(b.length, a + n); i++) s += String.fromCharCode(b[i]!)
  return s
}

/** 앞머리로 물어볼 엔진의 순서를 정한다. 틀려도 괜찮다: 맞는 엔진이 나올 때까지 sniff 로 확인한다. */
function order(b: Uint8Array): Engine[] {
  const head = text(b, 0, 32)
  const first: Engine[] = []
  // SketchUp: FF FE FF + 길이 + UTF-16 "SketchUp Model"
  // OLE 상자(D0 CF 11 E0): 이 입구까지 온 OLE 는 Inventor 뿐이다(RVT 는 일꾼이 먼저 가른다)
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) first.push('inventor')
  else if (b[0] === 0xff && b[1] === 0xfe && b[2] === 0xff) first.push('skp')
  else if (/^(AC1|AC2|MC0)/.test(head)) first.push('dwg')
  else if (head.startsWith('JwwData.')) first.push('jww')
  // iCAD SX: "MOD0" + 머리 낱말(두 바이트 순서 모두)
  else if (head.startsWith('MOD0')) first.push('icd')
  else if (head.startsWith('(DWF V')) first.push('dxf')
  // zip: SXF(.sfz·.p2z)는 STEP 보다 먼저(STEP 이 SXF 를 자기 것으로 잡는다). PCB 묶음 zip 은 맨 뒤
  else if (head.startsWith('PK')) first.push('dxf', 'ifc', 'sxf', 'step', 'mesh', 'pcb')
  // ISO 10303-21: IFC 스키마면 IFC, 아니면 STEP(AP203·AP214·AP242). 두 엔진의 sniff 가 서로를 거절한다
  else if (/^(﻿|\xEF\xBB\xBF)?\s*ISO-10303-21/.test(head)) first.push('ifc', 'sxf', 'step')
  // gzip: .stpz
  else if (b[0] === 0x1f && b[1] === 0x8b) first.push('step', 'pcb')
  else if (head.startsWith('glTF') || head.startsWith('Kaydara FBX') || (b[0] === 0x4d && b[1] === 0x4d)) first.push('mesh')
  else if (head.startsWith('AutoCAD Binary DXF')) first.push('dxf')
  const rest: Engine[] = ['dxf', 'dwg', 'jww', 'icd', 'sxf', 'iges', 'inventor', 'ifc', 'step', 'skp', 'mesh', 'pcb']
  return [...first, ...rest.filter((e) => !first.includes(e))]
}

function codeOf(err: unknown): CadErrorCode {
  const c = (err as { code?: string })?.code
  if (c === 'not-format' || c === 'corrupt' || c === 'unsupported-version' || c === 'encrypted' || c === 'too-large') return c
  return 'corrupt'
}

const MESH_FORMAT: Record<string, CadFormat> = { gltf: 'gltf', fbx: 'fbx', '3ds': '3ds', stl: 'stl', obj: 'obj' }

export async function openCad(bytes: Uint8Array, onProgress: Progress, opts: CadOpenOptions = {}): Promise<CadOpened> {
  for (const engine of order(bytes)) {
    if (engine === 'dwg') {
      const m = await import('./dwg/index.ts')
      if (!m.sniffDwg(bytes)) continue
      try {
        const r = await m.readDwg(bytes, onProgress)
        return twoD('dwg', r.info, r.sheets, r.layers)
      } catch (err) {
        // DWG 엔진은 오류마다 파일의 버전 문자열(AC1009 등)을 붙여 준다
        const tag = (err as { versionTag?: string })?.versionTag
        throw new CadOpenError(codeOf(err), String((err as Error)?.message ?? err), 'dwg', { versionTag: tag })
      }
    }
    if (engine === 'sxf') {
      const m = await import('./sxf/index.ts')
      if (!m.sniffSxf(bytes)) continue
      try {
        const r = await m.readSxf(bytes, onProgress)
        if (r.kind !== '2d') throw new CadOpenError('corrupt', 'no 2D sheet', 'sxf')
        return twoD('sxf', r.info, r.sheets, r.layers)
      } catch (err) {
        if (err instanceof CadOpenError) throw err
        throw new CadOpenError(codeOf(err), String((err as Error)?.message ?? err), 'sxf')
      }
    }
    if (engine === 'pcb') {
      const m = await import('./pcb/index.ts')
      const files = opts.files?.length ? opts.files : [{ name: opts.name ?? 'board', bytes }]
      // 묶음 안에 PCB 파일이 하나라도 있어야 한다(zip 은 일단 열어 본다)
      if (!files.some((f) => m.sniffPcb(f.name, f.bytes)) && !files.some((f) => /(^|\/)matrix\/matrix$/i.test(f.name))) continue
      try {
        const r = await m.readPcb(files, onProgress, { threeD: opts.threeD !== false })
        const opened = twoD('pcb', r.info, r.sheets, r.layers as CadLayer[])
        if (opened.kind === '2d') {
          opened.meta.warnings = [...new Set([...opened.meta.warnings, ...r.warnings])]
          if (r.geometry && r.geometry.stats.triangles > 0) {
            const g = threeD('pcb', r.info, r.geometry, null)
            if (g.kind === '3d') opened.alt3d = { model: g.model, geometry: g.geometry }
          }
        }
        return opened
      } catch (err) {
        // zip 안에 PCB 가 없었다: 다른 엔진이 없으니 형식 아님
        throw new CadOpenError(codeOf(err), String((err as Error)?.message ?? err), 'pcb')
      }
    }
    if (engine === 'iges') {
      const m = await import('./iges/iges.ts')
      if (!m.sniffIges(bytes)) continue
      try {
        const r = await m.readIges(bytes, onProgress)
        return threeD('iges', r.info, r.geometry, null)
      } catch (err) {
        throw new CadOpenError(codeOf(err), String((err as Error)?.message ?? err), 'iges')
      }
    }
    if (engine === 'inventor') {
      const m = await import('./inventor/inventor.ts')
      if (!m.sniffInventor(bytes)) continue
      let r: Awaited<ReturnType<typeof m.readInventor>>
      try {
        r = await m.readInventor(bytes, onProgress, { resolve: opts.resolve })
      } catch (err) {
        throw new CadOpenError(codeOf(err), String((err as Error)?.message ?? err), 'inventor')
      }
      // 조립품이 부르는 부품을 함께 넣지 않았다: 하나도 못 놓았으면 안내(오류), 일부만 없으면 화면에 알린다
      const missing = String(r.info.missingComponents ?? '')
        .split(';')
        .map((x) => x.trim().split(/[\\/]/).pop() ?? '')
        .filter(Boolean)
      const placed = Number(r.info.placed ?? 0)
      if (missing.length && (r.kind === '2d' || placed === 0)) throw new CadOpenError('missing-parts', `${missing.length} component file(s) missing`, 'inventor', { missing })
      // 조립품인데 하나도 놓지 못했고 부품 목록도 읽지 못했다(조립품 파일만 넣었을 때 흔하다): 같은 안내, 이름 없이
      if (r.info.document === 'assembly' && placed === 0 && r.kind === '2d') throw new CadOpenError('missing-parts', 'assembly without placed components', 'inventor', { missing: [] })
      const opened = r.kind === '3d' ? threeD('inventor', r.info, r.geometry, null) : twoD('inventor', r.info, r.sheets, r.layers)
      if (missing.length) opened.meta.missingParts = missing
      return opened
    }
    if (engine === 'jww') {
      const m = await import('./jww/index.ts')
      if (!m.sniffJww(bytes)) continue
      try {
        const r = await m.readJww(bytes, onProgress)
        if (r.kind !== '2d') throw new CadOpenError('corrupt', 'no 2D sheet', 'jww')
        // "용지 밖까지 그렸다"는 알림일 뿐 빠진 것이 아니다. 화면의 "못 그린 것" 안내에 넣지 않는다
        for (const sh of r.sheets) sh.warnings = sh.warnings.filter((w) => !w.startsWith('drawing extends beyond the paper'))
        return twoD('jww', r.info, r.sheets, r.layers)
      } catch (err) {
        if (err instanceof CadOpenError) throw err
        throw new CadOpenError(codeOf(err), String((err as Error)?.message ?? err), 'jww')
      }
    }
    if (engine === 'icd') {
      const m = await import('./icd/icd.ts')
      if (!m.sniffIcd(bytes)) continue
      try {
        const r = await m.readIcd(bytes, onProgress)
        // 3D(@3DPARAM): 솔리드마다 요소 하나. 2D(@正面·@平面 등): 선 종류별 가짜 레이어
        if (r.kind === '3d') return threeD('icd', r.info, r.geometry, null)
        return twoD('icd', r.info, r.sheets, r.layers)
      } catch (err) {
        throw new CadOpenError(codeOf(err), String((err as Error)?.message ?? err), 'icd')
      }
    }
    if (engine === 'dxf') {
      const m = await import('./dxf/index.ts')
      if (m.sniffDwf(bytes)) {
        if (bytes[0] === 0x28) throw new CadOpenError('dwf-classic', 'classic DWF (W2D) is not supported', 'dwfx')
        try {
          const r = await m.readDwf(bytes, onProgress)
          if (r.kind === '2d') return twoD('dwfx', r.info, r.sheets, r.layers)
          throw new CadOpenError('corrupt', 'no 2D sheets', 'dwfx')
        } catch (err) {
          if (err instanceof CadOpenError) throw err
          throw new CadOpenError(codeOf(err), String((err as Error)?.message ?? err), 'dwfx')
        }
      }
      if (!m.sniffDxf(bytes)) continue
      try {
        const r = await m.readDxf(bytes, onProgress)
        if (r.kind === '3d') return threeD('dxf', r.info, r.geometry, null)
        return twoD('dxf', r.info, r.sheets, r.layers)
      } catch (err) {
        throw new CadOpenError(codeOf(err), String((err as Error)?.message ?? err), 'dxf')
      }
    }
    if (engine === 'ifc') {
      const m = await import('./ifc/ifc.ts')
      if (!m.sniffIfc(bytes)) continue
      try {
        const r = await m.readIfc(bytes, onProgress)
        return threeD('ifc', r.info, r.geometry, r.geometry.props ?? null)
      } catch (err) {
        throw new CadOpenError(codeOf(err), String((err as Error)?.message ?? err), 'ifc')
      }
    }
    if (engine === 'step') {
      const m = await import('./step/stp.ts')
      if (!(m.sniffStep(bytes) || (bytes[0] === 0x1f && bytes[1] === 0x8b && (await m.sniffStepAsync(bytes))))) continue
      try {
        const r = await m.readStep(bytes, onProgress)
        const g = r.geometry
        // levelId·levelName 은 STEP 에서 부모 조립 노드와 경로다. 층으로 읽히지 않게 속성으로 옮긴다
        const props: Record<number, Record<string, string>> = {}
        for (const e of g.elements) {
          const p: Record<string, string> = {}
          if (e.name) p.Name = e.name
          if (e.typeName) p.Part = e.typeName
          if (e.familyName) p['Product ID'] = e.familyName
          if (e.levelName) p.Parent = e.levelName
          props[e.id] = p
          e.levelId = null
          e.levelName = null
        }
        const opened = threeD('step', r.info, g, props)
        if (opened.kind === '3d' && g.tree) opened.tree = g.tree
        return opened
      } catch (err) {
        throw new CadOpenError(codeOf(err), String((err as Error)?.message ?? err), 'step')
      }
    }
    if (engine === 'skp') {
      const m = await import('./skp/skp.ts')
      if (!m.sniffSkp(bytes)) continue
      try {
        const r = await m.readSkp(bytes, onProgress)
        // 텍스처 그림은 좌표가 없어 면에 입히지 못한다(재질 색으로 칠한다). 화면으로 보내지 않는다.
        delete r.geometry.textures
        return threeD('skp', r.info, r.geometry, null)
      } catch (err) {
        throw new CadOpenError(codeOf(err), String((err as Error)?.message ?? err), 'skp')
      }
    }
    if (engine === 'mesh') {
      const m = await import('./mesh/index.ts')
      const f = m.sniffMesh(bytes)
      if (!f) continue
      const format = MESH_FORMAT[f]!
      try {
        const r = await m.readMesh(bytes, onProgress)
        return threeD(format, r.info, r.geometry, null)
      } catch (err) {
        throw new CadOpenError(codeOf(err), String((err as Error)?.message ?? err), format)
      }
    }
  }
  throw new CadOpenError('not-format', 'not a supported CAD / BIM file', null)
}

function meta(format: CadFormat, info: Record<string, string | number>, warnings: string[]): CadMeta {
  return { format, label: String(info.format ?? format.toUpperCase()), info, warnings }
}

function twoD(format: CadFormat, info: Record<string, string | number>, sheets: RvtSheet2D[], layers: CadLayer[]): CadOpened {
  const warnings = [...new Set(sheets.flatMap((s) => s.warnings ?? []))]
  // 레이어 목록이 없는 형식(DWFx)은 항목에 붙은 레이어 이름으로 만든다
  if (layers.length === 0) {
    const seen = new Map<string, number>()
    for (const s of sheets) for (const it of s.items) if (it.layer) seen.set(it.layer, (seen.get(it.layer) ?? 0) + 1)
    layers = [...seen].map(([name, items]) => ({ name, color: '#808080', visible: true, items }))
  }
  return {
    kind: '2d',
    meta: meta(format, info, warnings),
    sheets,
    layers: layers.map((l) => ({
      name: l.name,
      color: l.color,
      visible: l.visible,
      frozen: l.frozen,
      items: l.items,
      ...(l.scale ? { scale: l.scale } : {}),
      ...(l.kind ? { kind: l.kind, side: l.side ?? null, ...(l.order != null ? { order: l.order } : {}), ...(l.opacity != null ? { opacity: l.opacity } : {}) } : {}),
    })),
  }
}

/** 카테고리 번호. 레빗의 기본 카테고리(음수)와 겹치지 않는 자리 */
export const CAD_CAT_BASE = 1_000_000

function threeD(format: CadFormat, info: Record<string, string | number>, g: RvtGeometry, props: Record<number, Record<string, string>> | null): CadOpened {
  // 카테고리 번호 붙이기
  const ids = new Map<string, number>()
  const idOf = (name: string | null | undefined) => {
    const k = name && name.trim() ? name : ''
    let id = ids.get(k)
    if (id == null) ids.set(k, (id = CAD_CAT_BASE + ids.size))
    return id
  }
  const elIndex = new Map<number, number>()
  g.elements.forEach((e, i) => elIndex.set(e.id, i))
  // 요소마다 덩어리별 삼각형 수 → 가장 많은 덩어리의 카테고리
  const best = new Map<number, { cat: number; n: number }>()
  for (const b of g.buckets) {
    b.category = idOf(b.categoryName)
    for (const r of b.ranges) {
      const cur = best.get(r.elementId)
      if (!cur || r.count > cur.n) best.set(r.elementId, { cat: b.category, n: r.count })
    }
  }
  const names = new Map<number, string>()
  for (const [k, v] of ids) names.set(v, k)
  for (const e of g.elements) {
    const hit = best.get(e.id)
    e.category = hit ? hit.cat : idOf(e.categoryName)
    if (!names.has(e.category)) names.set(e.category, e.categoryName ?? '')
    const n = names.get(e.category)
    e.categoryName = n || null
  }
  for (const [k, v] of ids) names.set(v, k)
  if (g.edges) {
    const parallel = g.edges.length === g.buckets.length
    g.edges.forEach((ed, i) => {
      if (ed.categoryName !== undefined && ed.categoryName !== null) ed.category = idOf(ed.categoryName)
      else if (parallel) ed.category = g.buckets[i]!.category
    })
  }
  const counts = new Map<number, number>()
  for (const e of g.elements) if (e.category != null) counts.set(e.category, (counts.get(e.category) ?? 0) + 1)
  const categoryCounts: CategoryCount[] = [...ids].map(([name, id]) => ({ categoryId: id, label: name || null, count: counts.get(id) ?? 0 }))
  return { kind: '3d', meta: meta(format, info, g.warnings), model: stubModel(g, categoryCounts, info), geometry: g, props }
}

function levelsOf(els: GeomElement[]): Level[] {
  const by = new Map<number, { name: string | null; zs: number[] }>()
  for (const e of els) {
    if (e.levelId == null) continue
    let l = by.get(e.levelId)
    if (!l) by.set(e.levelId, (l = { name: e.levelName, zs: [] }))
    if (e.bbox) l.zs.push(e.bbox.min[2])
  }
  return [...by].map(([id, l]) => {
    // 바닥 높이의 최빈값(1 cm 단위). 슬래브가 층 아래로 내려가도 벽·문 바닥이 층 높이에 모인다.
    const freq = new Map<number, number>()
    for (const z of l.zs) {
      const k = Math.round(z * 100)
      freq.set(k, (freq.get(k) ?? 0) + 1)
    }
    let mode = 0
    let n = -1
    for (const [k, c] of freq) if (c > n || (c === n && k < mode)) [mode, n] = [k, c]
    const z = l.zs.length ? mode / 100 : 0
    return { id, name: l.name, elevation_ft: z / 0.3048, elevation_m: z, isBuildingStory: true, levelType: null, inGroupType: false }
  })
}

/** 화면이 RvtModel 을 기대하는 자리(레벨·카테고리 이름)를 채우는 빈 모델 */
function stubModel(g: RvtGeometry, categoryCounts: CategoryCount[], info: Record<string, string | number>): RvtModel {
  const levels = levelsOf(g.elements)
  return {
    info: {
      revitVersion: '',
      build: '',
      originalPath: '',
      documentGuid: '',
      locale: '',
      worksharing: null,
      basicFileInfo: {},
      projectTitle: typeof info.projectName === 'string' ? info.projectName : null,
      projectParameters: [],
      externalReferences: [],
      worksets: [],
      streams: [],
      schemaClasses: 0,
    },
    summary: { elements: g.elements.length, levels: levels.length, views: 0, sheets: 0, walls: 0, doors: 0, windows: 0, rooms: 0, grids: 0, families: 0 },
    classCounts: {},
    categoryCounts,
    levels,
    views: [],
    sheets: [],
    walls: [],
    openings: [],
    rooms: [],
    grids: [],
    families: [],
    warnings: g.warnings,
    timings: {},
    preview: null,
  }
}

/** PCB 두 묶음 비교(일꾼에서). 결과는 2D 시트 한 장과 차이 목록 */
export async function comparePcbSets(a: { name: string; bytes: Uint8Array }[], b: { name: string; bytes: Uint8Array }[], onProgress: Progress): Promise<CadOpened> {
  const m = await import('./pcb/index.ts')
  try {
    const r = await m.comparePcb(a, b, onProgress)
    const opened = twoD('pcb', r.info, r.sheets, r.layers as CadLayer[])
    if (opened.kind === '2d') {
      opened.diffs = r.diffs.map((d) => ({ layer: d.layer, kind: d.kind, x: d.x, y: d.y, box: d.box, areaMm2: d.areaMm2 }))
      opened.meta.warnings = [...new Set([...opened.meta.warnings, ...r.warnings])]
    }
    return opened
  } catch (err) {
    throw new CadOpenError(codeOf(err), String((err as Error)?.message ?? err), 'pcb')
  }
}
