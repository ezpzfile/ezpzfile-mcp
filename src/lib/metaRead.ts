/**
 * 파일 정보 보기. 넣은 파일이 사진인지 문서인지 스스로 갈라 읽는다.
 *
 * 값을 화면에 보여 주는 것이 목적이라, 라벨은 사전이 지고 여기서는 키와
 * 다듬은 값만 낸다(20개 언어를 이 파일 안에 넣지 않기 위해서다). 숫자 표기는
 * 어느 언어에서나 같은 꼴을 쓴다. f/2.8, 1/250s, ISO 400, 26mm 는 번역하면
 * 오히려 못 알아본다. 날짜만 `iso` 를 함께 실어 화면에서 현지 형식으로 그린다.
 */
import { locateExif, parseExif, readDimensions, type ExifIfd } from './exifRead'
import { unzip } from './docOps'

export type MetaGroupId = 'file' | 'camera' | 'shot' | 'gps' | 'person' | 'document' | 'stats'

export type MetaFieldKey =
  | 'fileName' | 'fileSize' | 'fileType' | 'dimensions' | 'megapixels'
  | 'make' | 'model' | 'lens' | 'serial' | 'software'
  | 'takenAt' | 'digitizedAt' | 'exposure' | 'aperture' | 'iso' | 'focalLength'
  | 'focalLength35' | 'exposureBias' | 'flash' | 'meteringMode' | 'exposureProgram'
  | 'whiteBalance' | 'orientation' | 'colorSpace'
  | 'coordinates' | 'coordinatesDms' | 'altitude' | 'direction' | 'gpsTime'
  | 'artist' | 'copyright' | 'imageDescription' | 'userComment'
  | 'title' | 'subject' | 'author' | 'lastModifiedBy' | 'keywords' | 'category'
  | 'company' | 'manager' | 'application' | 'producer' | 'creatorTool'
  | 'createdAt' | 'modifiedAt' | 'printedAt' | 'revision' | 'editTime'
  | 'pageCount' | 'pageSize' | 'wordCount' | 'charCount' | 'paragraphCount'
  | 'slideCount' | 'template' | 'encrypted' | 'formatVersion'

export type MetaEnumKey =
  | 'orientationNormal' | 'orientationRotate90' | 'orientationRotate180'
  | 'orientationRotate270' | 'orientationMirrored'
  | 'flashFired' | 'flashNone'
  | 'meterSpot' | 'meterCenter' | 'meterMatrix' | 'meterAverage'
  | 'progManual' | 'progAuto' | 'progAperture' | 'progShutter'
  | 'progPortrait' | 'progLandscape'
  | 'wbAuto' | 'wbManual'
  | 'yes' | 'no'

export interface MetaField {
  key: MetaFieldKey
  /** 이미 다듬은 값. enumKey 가 있으면 사전이 이긴다. */
  text?: string
  /** 사전이 번역할 값 */
  enumKey?: MetaEnumKey
  /** 날짜. 화면에서 현지 형식으로 그린다. */
  iso?: string
  /** 분 단위 시간. 시·분 표기는 언어마다 달라 사전이 맡는다. */
  minutes?: number
}

export interface MetaGroup {
  id: MetaGroupId
  fields: MetaField[]
}

export interface GeoPoint {
  lat: number
  lon: number
  /** 미터. 해수면 아래면 음수 */
  altitude?: number
  /** 카메라가 향한 방위각 */
  direction?: number
}

/** 문서를 만진 사람. 화면 위쪽 카드에 쓴다. */
export interface DocIdentity {
  author?: string
  lastModifiedBy?: string
  company?: string
  manager?: string
  application?: string
  revision?: number
  /** 누적 편집 시간(분) */
  editMinutes?: number
  createdAt?: string
  modifiedAt?: string
}

export interface MetaReading {
  kind: 'photo' | 'document'
  /** 형식 이름. 번역하지 않는다. */
  format: string
  groups: MetaGroup[]
  geo?: GeoPoint
  identity?: DocIdentity
  /** EXIF 안에 숨어 있던 축소판. 자르기 전 원본이 남아 있는 일이 있다. */
  thumbnail?: Blob
  /** 사진 본체 미리보기 */
  preview?: Blob
  /** 실제로 찾아낸 항목 수. 0이면 "정보가 없다"고 말한다. */
  count: number
}

export class UnsupportedFile extends Error {
  constructor(readonly hint: 'hwp' | 'unknown') {
    super('UNSUPPORTED_FILE')
  }
}

/* ------------------------------------------------------------------ 도구 */

function text(b: Uint8Array, at: number, len: number): string {
  let s = ''
  for (let i = 0; i < len && at + i < b.length; i++) s += String.fromCharCode(b[at + i]!)
  return s
}

function push(fields: MetaField[], key: MetaFieldKey, value: string | undefined | null) {
  const trimmed = value?.trim()
  if (trimmed) fields.push({ key, text: trimmed })
}

/** 비어 있는 갈래는 화면에 내지 않는다. */
function groupsOf(...entries: MetaGroup[]): MetaGroup[] {
  return entries.filter((g) => g.fields.length > 0)
}

/** 소수점 뒤 0을 떼어 낸다. 2.80 은 2.8, 26.0 은 26 으로. */
function num(value: number, digits = 1): string {
  return Number(value.toFixed(digits)).toString()
}

/**
 * EXIF 날짜는 'YYYY:MM:DD HH:MM:SS' 이고 시간대가 없다.
 * 있지도 않은 시간대를 짐작해 붙이면 찍은 시각이 몇 시간씩 밀린다.
 * 그래서 이 값만은 글자 그대로 보여 주고 iso 를 달지 않는다.
 */
function exifDate(value: string | undefined): string | undefined {
  if (!value) return undefined
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(value.trim())
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : value.trim()
}

/* ------------------------------------------------------------------ 사진 */

const ORIENTATION: Record<number, MetaEnumKey> = {
  1: 'orientationNormal',
  2: 'orientationMirrored',
  3: 'orientationRotate180',
  4: 'orientationMirrored',
  5: 'orientationMirrored',
  6: 'orientationRotate90',
  7: 'orientationMirrored',
  8: 'orientationRotate270',
}

const METERING: Record<number, MetaEnumKey> = {
  1: 'meterAverage',
  2: 'meterCenter',
  3: 'meterSpot',
  5: 'meterMatrix',
}

const PROGRAM: Record<number, MetaEnumKey> = {
  1: 'progManual',
  2: 'progAuto',
  3: 'progAperture',
  4: 'progShutter',
  6: 'progPortrait',
  7: 'progPortrait',
  8: 'progLandscape',
}

function str(ifd: ExifIfd, tag: number): string | undefined {
  const value = ifd.get(tag)?.text
  return value && value.length > 0 ? value : undefined
}

function one(ifd: ExifIfd, tag: number): number | undefined {
  return ifd.get(tag)?.nums[0]
}

/** 도·분·초 표기. 지도 앱에 그대로 붙여 넣을 수 있는 꼴이다. */
function dms(value: number, positive: string, negative: string): string {
  const sign = value < 0 ? negative : positive
  const abs = Math.abs(value)
  const d = Math.floor(abs)
  const m = Math.floor((abs - d) * 60)
  const s = ((abs - d) * 60 - m) * 60
  return `${d}° ${m}' ${s.toFixed(2)}" ${sign}`
}

function gpsCoordinate(ifd: ExifIfd, valueTag: number, refTag: number): number | undefined {
  const parts = ifd.get(valueTag)?.nums
  const ref = str(ifd, refTag)
  if (!parts || parts.length < 3) return undefined
  const value = parts[0]! + parts[1]! / 60 + parts[2]! / 3600
  if (!Number.isFinite(value)) return undefined
  return ref === 'S' || ref === 'W' ? -value : value
}

async function readPhoto(file: File, bytes: Uint8Array, format: string): Promise<MetaReading> {
  const found = locateExif(bytes)
  const exif = found ? parseExif(bytes, found.at, found.end) : null

  const fileFields: MetaField[] = []
  const camera: MetaField[] = []
  const shot: MetaField[] = []
  const gps: MetaField[] = []
  const person: MetaField[] = []

  push(fileFields, 'fileName', file.name)
  fileFields.push({ key: 'fileType', text: format })

  const size = readDimensions(bytes)
  if (size) {
    fileFields.push({ key: 'dimensions', text: `${size.width} × ${size.height}` })
    const mp = (size.width * size.height) / 1_000_000
    if (mp >= 0.1) fileFields.push({ key: 'megapixels', text: `${num(mp)} MP` })
  }

  let geo: GeoPoint | undefined
  let thumbnail: Blob | undefined

  if (exif) {
    const { ifd0, exif: sub, gps: gpsIfd } = exif

    push(camera, 'make', str(ifd0, 0x010f))
    push(camera, 'model', str(ifd0, 0x0110))
    push(camera, 'lens', str(sub, 0xa434) ?? str(sub, 0xa433))
    push(camera, 'serial', str(sub, 0xa431))
    push(camera, 'software', str(ifd0, 0x0131))

    const taken = exifDate(str(sub, 0x9003) ?? str(ifd0, 0x0132))
    if (taken) shot.push({ key: 'takenAt', text: taken })
    const digitized = exifDate(str(sub, 0x9004))
    if (digitized && digitized !== taken) shot.push({ key: 'digitizedAt', text: digitized })

    const exposure = sub.get(0x829a)
    if (exposure?.pairs?.[0]) {
      const [n, d] = exposure.pairs[0]
      const seconds = d === 0 ? 0 : n / d
      // 1초보다 짧으면 사진에서 쓰는 대로 분수로 적는다.
      shot.push({
        key: 'exposure',
        text: seconds > 0 && seconds < 1 ? `1/${Math.round(1 / seconds)}s` : `${num(seconds, 2)}s`,
      })
    }

    const aperture = one(sub, 0x829d)
    if (aperture) shot.push({ key: 'aperture', text: `f/${num(aperture)}` })

    const iso = one(sub, 0x8827) ?? one(sub, 0x8833)
    if (iso) shot.push({ key: 'iso', text: `ISO ${iso}` })

    const focal = one(sub, 0x920a)
    if (focal) shot.push({ key: 'focalLength', text: `${num(focal)}mm` })
    const focal35 = one(sub, 0xa405)
    if (focal35) shot.push({ key: 'focalLength35', text: `${focal35}mm` })

    const bias = one(sub, 0x9204)
    if (bias !== undefined && bias !== 0) {
      shot.push({ key: 'exposureBias', text: `${bias > 0 ? '+' : ''}${num(bias, 2)} EV` })
    }

    const flash = one(sub, 0x9209)
    if (flash !== undefined) {
      shot.push({ key: 'flash', enumKey: (flash & 1) === 1 ? 'flashFired' : 'flashNone' })
    }

    const metering = one(sub, 0x9207)
    if (metering && METERING[metering]) {
      shot.push({ key: 'meteringMode', enumKey: METERING[metering] })
    }

    const program = one(sub, 0x8822)
    if (program && PROGRAM[program]) {
      shot.push({ key: 'exposureProgram', enumKey: PROGRAM[program] })
    }

    const wb = one(sub, 0xa403)
    if (wb !== undefined) shot.push({ key: 'whiteBalance', enumKey: wb === 0 ? 'wbAuto' : 'wbManual' })

    const orientation = one(ifd0, 0x0112)
    if (orientation && ORIENTATION[orientation]) {
      shot.push({ key: 'orientation', enumKey: ORIENTATION[orientation] })
    }

    const colorSpace = one(sub, 0xa001)
    if (colorSpace === 1) shot.push({ key: 'colorSpace', text: 'sRGB' })
    else if (colorSpace === 0xffff) shot.push({ key: 'colorSpace', text: 'Adobe RGB' })

    const lat = gpsCoordinate(gpsIfd, 0x0002, 0x0001)
    const lon = gpsCoordinate(gpsIfd, 0x0004, 0x0003)
    if (lat !== undefined && lon !== undefined) {
      const altitudeRef = one(gpsIfd, 0x0005)
      const altitudeValue = one(gpsIfd, 0x0006)
      const direction = one(gpsIfd, 0x0011)
      const altitude =
        altitudeValue === undefined
          ? undefined
          : altitudeRef === 1
            ? -altitudeValue
            : altitudeValue

      geo = { lat, lon, altitude, direction }

      gps.push({ key: 'coordinates', text: `${lat.toFixed(6)}, ${lon.toFixed(6)}` })
      gps.push({ key: 'coordinatesDms', text: `${dms(lat, 'N', 'S')}, ${dms(lon, 'E', 'W')}` })
      if (altitude !== undefined) gps.push({ key: 'altitude', text: `${num(altitude)} m` })
      if (direction !== undefined) gps.push({ key: 'direction', text: `${num(direction)}°` })

      const stamp = str(gpsIfd, 0x001d)
      const time = gpsIfd.get(0x0007)?.nums
      if (stamp) {
        const clock =
          time && time.length >= 3
            ? ` ${String(Math.floor(time[0]!)).padStart(2, '0')}:${String(Math.floor(time[1]!)).padStart(2, '0')}:${String(Math.floor(time[2]!)).padStart(2, '0')} UTC`
            : ''
        gps.push({ key: 'gpsTime', text: stamp.replace(/:/g, '-') + clock })
      }
    }

    push(person, 'artist', str(ifd0, 0x013b))
    push(person, 'copyright', str(ifd0, 0x8298))
    push(person, 'imageDescription', str(ifd0, 0x010e))
    const comment = str(sub, 0x9286)
    // UserComment 는 앞 8바이트가 문자 코드 표시라 글자가 아니다.
    if (comment && comment.length > 8) push(person, 'userComment', comment.slice(8))

    if (exif.thumbnail) {
      const slice = bytes.slice(exif.thumbnail.at, exif.thumbnail.at + exif.thumbnail.length)
      // 축소판이 늘 JPEG 인 것은 아니다. 앞 두 바이트로 확인한다.
      if (slice[0] === 0xff && slice[1] === 0xd8) {
        thumbnail = new Blob([slice.buffer as ArrayBuffer], { type: 'image/jpeg' })
      }
    }
  }

  const groups = groupsOf(
    { id: 'file', fields: fileFields },
    { id: 'camera', fields: camera },
    { id: 'shot', fields: shot },
    { id: 'gps', fields: gps },
    { id: 'person', fields: person },
  )

  return {
    kind: 'photo',
    format,
    groups,
    geo,
    thumbnail,
    preview: file.slice(0, file.size, file.type || 'image/jpeg'),
    count: camera.length + shot.length + gps.length + person.length,
  }
}

/* -------------------------------------------------------------------- PDF */

/** PDF 날짜는 D:20260912103000+09'00' 꼴이다. */
function pdfDate(value: Date | undefined): { text: string; iso: string } | undefined {
  if (!value || Number.isNaN(value.getTime())) return undefined
  return { text: value.toISOString(), iso: value.toISOString() }
}

/** `head` 는 파일 앞 64바이트다. 규격 버전을 읽는 데만 쓴다. */
async function readPdf(file: File, head: Uint8Array): Promise<MetaReading> {
  const { PDFDocument } = await import('pdf-lib')
  const doc = await PDFDocument.load(await file.arrayBuffer(), {
    ignoreEncryption: true,
    updateMetadata: false,
  })

  const fileFields: MetaField[] = []
  const document: MetaField[] = []
  const stats: MetaField[] = []

  push(fileFields, 'fileName', file.name)
  fileFields.push({ key: 'fileType', text: 'PDF' })
  // 헤더 첫 줄에 규격 버전이 박혀 있다.
  const header = /^%PDF-(\d\.\d)/.exec(text(head, 0, 16))
  if (header) fileFields.push({ key: 'formatVersion', text: `PDF ${header[1]}` })

  const safe = <T,>(fn: () => T): T | undefined => {
    try {
      return fn()
    } catch {
      return undefined
    }
  }

  push(document, 'title', safe(() => doc.getTitle()))
  push(document, 'subject', safe(() => doc.getSubject()))
  push(document, 'author', safe(() => doc.getAuthor()))
  push(document, 'keywords', safe(() => doc.getKeywords()))
  push(document, 'creatorTool', safe(() => doc.getCreator()))
  push(document, 'producer', safe(() => doc.getProducer()))

  const created = pdfDate(safe(() => doc.getCreationDate()))
  if (created) document.push({ key: 'createdAt', text: created.text, iso: created.iso })
  const modified = pdfDate(safe(() => doc.getModificationDate()))
  if (modified) document.push({ key: 'modifiedAt', text: modified.text, iso: modified.iso })

  const pages = doc.getPageCount()
  stats.push({ key: 'pageCount', text: String(pages) })
  if (pages > 0) {
    const { width, height } = doc.getPage(0).getSize()
    // 포인트를 밀리미터로. 72pt 가 1인치다.
    const mm = (pt: number) => Math.round((pt / 72) * 25.4)
    stats.push({ key: 'pageSize', text: `${mm(width)} × ${mm(height)} mm` })
  }
  stats.push({ key: 'encrypted', enumKey: doc.isEncrypted ? 'yes' : 'no' })

  const author = safe(() => doc.getAuthor())
  const creator = safe(() => doc.getCreator()) ?? safe(() => doc.getProducer())

  return {
    kind: 'document',
    format: 'PDF',
    groups: groupsOf(
      { id: 'file', fields: fileFields },
      { id: 'document', fields: document },
      { id: 'stats', fields: stats },
    ),
    identity:
      author || creator
        ? {
            author: author || undefined,
            application: creator || undefined,
            createdAt: created?.iso,
            modifiedAt: modified?.iso,
          }
        : undefined,
    count: document.length,
  }
}

/* ------------------------------------------------------------------ OOXML */

interface XmlBag {
  get(localName: string): string | undefined
}

function xmlBag(source: string): XmlBag {
  const doc = new DOMParser().parseFromString(source, 'text/xml')
  const map = new Map<string, string>()
  // querySelectorAll 과 접두사 떼기는 MCP 서버(Node, linkedom) 때문이다. linkedom 은 XML 에서
  // getElementsByTagName('*') 가 비어 나오고 localName 에 접두사(dc:title)를 붙인다. 브라우저에서는
  // 둘 다 결과가 같다.
  for (const el of [...doc.querySelectorAll('*')]) {
    const value = el.textContent?.trim()
    // 네임스페이스 접두사가 생성기마다 달라 localName 으로만 본다.
    const name = el.localName.replace(/^.*:/, '')
    if (value && !map.has(name)) map.set(name, value)
  }
  return { get: (name) => map.get(name) }
}

function isoDate(value: string | undefined): { text: string; iso: string } | undefined {
  if (!value) return undefined
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return undefined
  return { text: parsed.toISOString(), iso: parsed.toISOString() }
}

async function readOoxml(
  file: File,
  entries: Awaited<ReturnType<typeof unzip>>,
  format: string,
): Promise<MetaReading> {
  const decoder = new TextDecoder('utf-8')
  const find = (path: string) =>
    entries.find((e) => e.path.toLowerCase() === path)?.bytes

  const coreBytes = find('docprops/core.xml')
  const appBytes = find('docprops/app.xml')
  const core = coreBytes ? xmlBag(decoder.decode(coreBytes)) : null
  const app = appBytes ? xmlBag(decoder.decode(appBytes)) : null

  const fileFields: MetaField[] = []
  const document: MetaField[] = []
  const stats: MetaField[] = []

  push(fileFields, 'fileName', file.name)
  fileFields.push({ key: 'fileType', text: format })

  push(document, 'title', core?.get('title'))
  push(document, 'subject', core?.get('subject'))
  push(document, 'author', core?.get('creator'))
  push(document, 'lastModifiedBy', core?.get('lastModifiedBy'))
  push(document, 'keywords', core?.get('keywords'))
  push(document, 'category', core?.get('category'))
  push(document, 'company', app?.get('Company'))
  push(document, 'manager', app?.get('Manager'))

  const application = app?.get('Application')
  const appVersion = app?.get('AppVersion')
  if (application) {
    document.push({
      key: 'application',
      text: appVersion ? `${application} ${appVersion}` : application,
    })
  }
  push(document, 'template', app?.get('Template'))

  const created = isoDate(core?.get('created'))
  if (created) document.push({ key: 'createdAt', text: created.text, iso: created.iso })
  const modified = isoDate(core?.get('modified'))
  if (modified) document.push({ key: 'modifiedAt', text: modified.text, iso: modified.iso })
  const printed = isoDate(core?.get('lastPrinted'))
  if (printed) document.push({ key: 'printedAt', text: printed.text, iso: printed.iso })

  const revision = Number(core?.get('revision') ?? '')
  if (Number.isFinite(revision) && revision > 0) {
    document.push({ key: 'revision', text: String(revision) })
  }

  // TotalTime 은 분 단위 누적 편집 시간이다. 워드가 문서를 열어 둔 시간을 센다.
  const minutes = Number(app?.get('TotalTime') ?? '')
  const editMinutes = Number.isFinite(minutes) && minutes > 0 ? minutes : undefined
  if (editMinutes) document.push({ key: 'editTime', minutes: editMinutes })

  const counts: Array<[MetaFieldKey, string | undefined]> = [
    ['pageCount', app?.get('Pages')],
    ['slideCount', app?.get('Slides')],
    ['wordCount', app?.get('Words')],
    ['charCount', app?.get('Characters')],
    ['paragraphCount', app?.get('Paragraphs')],
  ]
  for (const [key, value] of counts) {
    const n = Number(value ?? '')
    if (Number.isFinite(n) && n > 0) stats.push({ key, text: String(n) })
  }

  return {
    kind: 'document',
    format,
    groups: groupsOf(
      { id: 'file', fields: fileFields },
      { id: 'document', fields: document },
      { id: 'stats', fields: stats },
    ),
    identity: {
      author: core?.get('creator'),
      lastModifiedBy: core?.get('lastModifiedBy'),
      company: app?.get('Company'),
      manager: app?.get('Manager'),
      application: application ? (appVersion ? `${application} ${appVersion}` : application) : undefined,
      revision: Number.isFinite(revision) && revision > 0 ? revision : undefined,
      editMinutes,
      createdAt: created?.iso,
      modifiedAt: modified?.iso,
    },
    count: document.length,
  }
}

/* ------------------------------------------------------------------- HWPX */

async function readHwpx(
  file: File,
  entries: Awaited<ReturnType<typeof unzip>>,
): Promise<MetaReading> {
  const decoder = new TextDecoder('utf-8')
  const hpf = entries.find((e) => /content\.hpf$/i.test(e.path))
  const versionXml = entries.find((e) => /(^|\/)version\.xml$/i.test(e.path))

  const fileFields: MetaField[] = []
  const document: MetaField[] = []

  push(fileFields, 'fileName', file.name)
  fileFields.push({ key: 'fileType', text: 'HWPX' })

  if (versionXml) {
    // <hv:HCFVersion ... application="Hancom Office Hwp" appVersion="..."/>
    const source = decoder.decode(versionXml.bytes)
    const application = /application="([^"]+)"/.exec(source)?.[1]
    const appVersion = /appVersion="([^"]+)"/.exec(source)?.[1]
    if (application) {
      document.push({
        key: 'application',
        text: appVersion ? `${application} ${appVersion}` : application,
      })
    }
  }

  let author: string | undefined
  let created: { text: string; iso: string } | undefined
  let modified: { text: string; iso: string } | undefined

  if (hpf) {
    const bag = xmlBag(decoder.decode(hpf.bytes))
    author = bag.get('creator')
    push(document, 'title', bag.get('title'))
    push(document, 'subject', bag.get('subject') ?? bag.get('description'))
    push(document, 'author', author)
    push(document, 'keywords', bag.get('subject'))
    created = isoDate(bag.get('date'))
    if (created) document.push({ key: 'createdAt', text: created.text, iso: created.iso })
    modified = isoDate(bag.get('modified'))
    if (modified) document.push({ key: 'modifiedAt', text: modified.text, iso: modified.iso })
  }

  return {
    kind: 'document',
    format: 'HWPX',
    groups: groupsOf(
      { id: 'file', fields: fileFields },
      { id: 'document', fields: document },
    ),
    identity: author ? { author, createdAt: created?.iso, modifiedAt: modified?.iso } : undefined,
    count: document.length,
  }
}

/* ------------------------------------------------------------------ 공개 */

/**
 * 파일을 보고 알아서 갈라 읽는다. 확장자를 믿지 않고 앞 바이트를 본다.
 * 이름은 언제든 바뀌지만 파일 머리는 거짓말을 하지 않는다.
 */
export async function readFileMetadata(file: File): Promise<MetaReading> {
  const head = new Uint8Array(await file.slice(0, 64).arrayBuffer())

  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return readPhoto(file, new Uint8Array(await file.arrayBuffer()), 'JPEG')
  }
  if (head[0] === 0x89 && text(head, 1, 3) === 'PNG') {
    return readPhoto(file, new Uint8Array(await file.arrayBuffer()), 'PNG')
  }
  if (text(head, 0, 4) === 'RIFF' && text(head, 8, 4) === 'WEBP') {
    return readPhoto(file, new Uint8Array(await file.arrayBuffer()), 'WebP')
  }
  if (text(head, 0, 5) === '%PDF-') {
    return readPdf(file, head)
  }
  // 한글 2007 이전의 .hwp 는 ZIP 이 아니라 복합 문서라 여기서 읽지 못한다.
  if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) {
    throw new UnsupportedFile('hwp')
  }

  if (head[0] === 0x50 && head[1] === 0x4b) {
    const entries = await unzip(file)
    const has = (needle: string) => entries.some((e) => e.path.toLowerCase() === needle)

    if (has('word/document.xml')) return readOoxml(file, entries, 'DOCX')
    if (has('xl/workbook.xml')) return readOoxml(file, entries, 'XLSX')
    if (has('ppt/presentation.xml')) return readOoxml(file, entries, 'PPTX')
    if (entries.some((e) => /content\.hpf$/i.test(e.path))) return readHwpx(file, entries)
    if (has('docprops/core.xml')) return readOoxml(file, entries, 'OOXML')
  }

  throw new UnsupportedFile('unknown')
}
