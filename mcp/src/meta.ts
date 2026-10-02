/**
 * What a file records about itself: camera and settings, where a photo was
 * taken, who wrote a document and when, which program made it.
 *
 * The website's reader does the work (src/lib/metaRead.ts): it looks at the
 * first bytes rather than the name, and handles JPEG, PNG, WebP, PDF, DOCX,
 * XLSX, PPTX and HWPX. It returns keys, not words, so each language can label
 * them; the English labels below are the ones the site's metadata viewer uses.
 * Ichitaro files are read by our JTD engine, which knows their summary.
 *
 * Nothing here changes the file. image_edit strip_metadata removes what this
 * finds.
 */
import { DOMParser } from 'linkedom'
import {
  readFileMetadata,
  UnsupportedFile,
  type MetaEnumKey,
  type MetaField,
  type MetaFieldKey,
  type MetaGroupId,
  type MetaReading,
} from '../../src/lib/metaRead'
import { isHeif } from './heic'
import { readJtd } from './jtd'
import { formatBytes } from './result'

const GROUP: Record<MetaGroupId, string> = {
  file: 'File',
  camera: 'Camera',
  shot: 'Capture settings',
  gps: 'Location',
  person: 'People and rights',
  document: 'Document',
  stats: 'Size',
}

const FIELD: Record<MetaFieldKey, string> = {
  fileName: 'File name',
  fileSize: 'File size',
  fileType: 'Format',
  dimensions: 'Dimensions',
  megapixels: 'Megapixels',
  make: 'Make',
  model: 'Model',
  lens: 'Lens',
  serial: 'Body serial number',
  software: 'Software used',
  takenAt: 'Taken',
  digitizedAt: 'Digitised',
  exposure: 'Shutter',
  aperture: 'Aperture',
  iso: 'Sensitivity',
  focalLength: 'Focal length',
  focalLength35: 'Focal length (35mm equivalent)',
  exposureBias: 'Exposure compensation',
  flash: 'Flash',
  meteringMode: 'Metering',
  exposureProgram: 'Shooting mode',
  whiteBalance: 'White balance',
  orientation: 'Orientation',
  colorSpace: 'Colour space',
  coordinates: 'Coordinates',
  coordinatesDms: 'Degrees, minutes, seconds',
  altitude: 'Altitude',
  direction: 'Facing',
  gpsTime: 'Location recorded',
  artist: 'Photographer',
  copyright: 'Copyright',
  imageDescription: 'Image description',
  userComment: 'User comment',
  title: 'Title',
  subject: 'Subject',
  author: 'Author',
  lastModifiedBy: 'Last saved by',
  keywords: 'Keywords',
  category: 'Category',
  company: 'Company',
  manager: 'Manager',
  application: 'Created with',
  producer: 'Producer',
  creatorTool: 'Original program',
  createdAt: 'Created',
  modifiedAt: 'Modified',
  printedAt: 'Last printed',
  revision: 'Save count',
  editTime: 'Total editing time',
  pageCount: 'Pages',
  pageSize: 'Page size',
  wordCount: 'Words',
  charCount: 'Characters',
  paragraphCount: 'Paragraphs',
  slideCount: 'Slides',
  template: 'Template',
  encrypted: 'Password protected',
  formatVersion: 'Format version',
}

const VALUE: Record<MetaEnumKey, string> = {
  orientationNormal: 'Upright',
  orientationRotate90: 'Rotated 90° clockwise',
  orientationRotate180: 'Upside down',
  orientationRotate270: 'Rotated 90° anticlockwise',
  orientationMirrored: 'Mirrored',
  flashFired: 'Fired',
  flashNone: 'Did not fire',
  meterSpot: 'Spot',
  meterCenter: 'Centre weighted',
  meterMatrix: 'Matrix',
  meterAverage: 'Average',
  progManual: 'Manual',
  progAuto: 'Automatic',
  progAperture: 'Aperture priority',
  progShutter: 'Shutter priority',
  progPortrait: 'Portrait',
  progLandscape: 'Landscape',
  wbAuto: 'Auto',
  wbManual: 'Manual',
  yes: 'Yes',
  no: 'No',
}

function valueOf(field: MetaField): string {
  if (field.enumKey) return VALUE[field.enumKey]
  if (field.minutes !== undefined) {
    const hours = Math.floor(field.minutes / 60)
    const minutes = field.minutes % 60
    return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`
  }
  return field.text ?? field.iso ?? ''
}

export interface MetadataResult {
  text: string
  data: Record<string, unknown>
}

function render(reading: MetaReading, size: number): MetadataResult {
  const lines: string[] = []
  const groups: Record<string, Record<string, string>> = {}
  for (const group of reading.groups) {
    const fields: Record<string, string> = {}
    lines.push(GROUP[group.id])
    for (const field of group.fields) {
      const value = valueOf(field)
      if (!value) continue
      fields[field.key] = value
      lines.push(`  ${FIELD[field.key]}: ${value}`)
    }
    if (group.id === 'file') {
      fields.fileSize = formatBytes(size)
      lines.push(`  ${FIELD.fileSize}: ${formatBytes(size)}`)
    }
    groups[group.id] = fields
  }
  const head =
    reading.count > 0
      ? `${reading.format} ${reading.kind}: ${reading.count} ${reading.count === 1 ? 'entry' : 'entries'} recorded`
      : `${reading.format} ${reading.kind}: nothing recorded beyond the basics. Either it was stripped already, or the program that made it writes none.`
  const notes: string[] = []
  if (reading.geo) notes.push('This file records where it was taken. Strip it before sharing: image_edit op strip_metadata.')
  if (reading.thumbnail) notes.push('A thumbnail is embedded. Cropped or edited photos sometimes keep the original picture in it.')
  return {
    text: [head, '', ...lines, ...(notes.length ? ['', ...notes] : [])].join('\n'),
    data: {
      kind: reading.kind,
      format: reading.format,
      count: reading.count,
      groups,
      geo: reading.geo ?? null,
      identity: reading.identity ?? null,
      hasThumbnail: Boolean(reading.thumbnail),
    },
  }
}

/** Ichitaro writes author, dates and its own version into the file. The engine reads them. */
async function jtdMetadata(bytes: Uint8Array, name: string): Promise<MetadataResult> {
  const { summary } = await readJtd(bytes, 'text')
  const document: MetaField[] = []
  const add = (key: MetaFieldKey, value: string | number | undefined) => {
    if (value !== undefined && String(value).trim()) document.push({ key, text: String(value).trim() })
  }
  add('author', summary.author)
  add('lastModifiedBy', summary.last_author)
  add('createdAt', summary.created)
  add('modifiedAt', summary.saved)
  add('printedAt', summary.printed)
  add('revision', summary.revision)
  add('pageCount', summary.pages)
  add('application', summary.application)
  add('template', summary.template)
  return render(
    {
      kind: 'document',
      format: 'JTD (Ichitaro)',
      groups: [
        { id: 'file', fields: [{ key: 'fileName', text: name }, { key: 'fileType', text: 'JTD (Ichitaro)' }] },
        ...(document.length ? [{ id: 'document' as const, fields: document }] : []),
      ],
      count: document.length,
    },
    bytes.length,
  )
}

export async function readMetadata(bytes: Uint8Array, name: string, kind: string): Promise<MetadataResult> {
  if (kind === 'jtd' || kind === 'jtt') return jtdMetadata(bytes, name)
  if (isHeif(bytes.subarray(0, 12))) {
    throw new Error('Reading metadata from HEIC photos is not supported yet. JPEG, PNG and WebP photos are.')
  }

  // DOCX, XLSX, PPTX and HWPX keep their properties in XML.
  const g = globalThis as Record<string, unknown>
  if (!g.DOMParser) g.DOMParser = DOMParser

  try {
    return render(await readFileMetadata(new File([bytes.slice().buffer as ArrayBuffer], name)), bytes.length)
  } catch (err) {
    if (err instanceof UnsupportedFile) {
      throw new Error(
        err.hint === 'hwp'
          ? 'This is a binary .hwp file, and reading the document properties of that format is not supported yet. Its text is: call doc_read without format.'
          : 'metadata reads photos (JPEG, PNG, WebP), PDF, Office files (DOCX, XLSX, PPTX), HWPX and Ichitaro (JTD). This file is none of those.',
      )
    }
    throw err
  }
}
