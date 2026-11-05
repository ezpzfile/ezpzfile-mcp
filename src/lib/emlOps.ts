/**
 * .eml (RFC 5322 / MIME) 읽기.
 *
 * 메일 본문은 남이 보낸 HTML 이라 그대로 붙이면 안 된다. 두 겹으로 막는다.
 *  1) sandbox 를 건 iframe 안에서만 그린다. 스크립트도, 부모 접근도 막힌다.
 *  2) 그 안에 CSP 를 심어 외부 요청 자체를 차단한다. 추적 픽셀이 열람 사실을
 *     보내지 못하게 하는 것이 목적이고, 이 서비스에서는 기본값이어야 한다.
 */

export interface EmlAddress {
  name: string
  address: string
}

export interface EmlAttachment {
  filename: string
  mimeType: string
  size: number
  bytes: Uint8Array
  /** 본문에 인라인으로 박힌 이미지인지 */
  inline: boolean
  contentId: string
  /** 메일 안에 든 메일(Outlook 의 "항목 첨부" 등)을 이미 읽어 둔 것. 있으면 바로 연다 */
  embedded?: EmlMessage
}

export interface EmlMessage {
  subject: string
  from: EmlAddress | null
  to: EmlAddress[]
  cc: EmlAddress[]
  date: string
  html: string
  text: string
  attachments: EmlAttachment[]
  /** 외부에서 불러오는 이미지 개수 (차단 대상) */
  remoteImageCount: number
  bcc?: EmlAddress[]
  /** 머리글 원문(있으면 "원문 머리글 보기") */
  headers?: string
  messageId?: string
  inReplyTo?: string
  references?: string[]
  /** 'template' 이면 Outlook 서식 파일(.oft) */
  kind?: 'mail' | 'template' | 'other'
}

function toAddress(value: unknown): EmlAddress | null {
  const v = value as { name?: string; address?: string } | undefined
  if (!v?.address && !v?.name) return null
  return { name: v.name ?? '', address: v.address ?? '' }
}

function toAddressList(value: unknown): EmlAddress[] {
  if (!Array.isArray(value)) return []
  return value.map(toAddress).filter((a): a is EmlAddress => a !== null)
}

export async function parseEml(file: File | Blob | Uint8Array, opts: { charset?: string | null } = {}): Promise<EmlMessage> {
  const { default: PostalMime } = await import('postal-mime')
  const { fixCharset, headerText } = await import('#/lib/mail/charset')
  const raw = file instanceof Uint8Array ? file : new Uint8Array(await file.arrayBuffer())
  const bytes = await fixCharset(raw, opts.charset)
  const parsed = await PostalMime.parse(bytes)

  const attachments: EmlAttachment[] = (parsed.attachments ?? []).map((a) => {
    const content =
      a.content instanceof ArrayBuffer
        ? new Uint8Array(a.content)
        : new Uint8Array((a.content as unknown as ArrayBufferView)?.buffer ?? [])
    return {
      filename: a.filename || 'attachment',
      mimeType: a.mimeType || 'application/octet-stream',
      size: content.length,
      bytes: content,
      inline: a.disposition === 'inline',
      contentId: (a.contentId ?? '').replace(/^<|>$/g, ''),
    }
  })

  const html = parsed.html ?? ''
  const remoteImageCount = (html.match(/<img[^>]+src=["']https?:\/\//gi) ?? []).length
  const ids = (s: string | undefined) => s?.match(/<[^<>\s]+>/g)?.map((x) => x.slice(1, -1)) ?? []

  return {
    subject: parsed.subject ?? '',
    from: toAddress(parsed.from),
    to: toAddressList(parsed.to),
    cc: toAddressList(parsed.cc),
    bcc: toAddressList(parsed.bcc),
    date: parsed.date ?? '',
    html,
    text: parsed.text ?? '',
    attachments,
    remoteImageCount,
    headers: (opts.charset ? new TextDecoder('utf-8').decode(bytes.subarray(0, Math.min(bytes.length, 65536))).split(/\r?\n\r?\n/)[0] : await headerText(raw)) ?? '',
    messageId: ids(parsed.messageId)[0],
    inReplyTo: ids(parsed.inReplyTo)[0],
    references: ids(parsed.references),
    kind: 'mail',
  }
}

function dataUrl(bytes: Uint8Array, mime: string): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return `data:${mime};base64,${btoa(binary)}`
}

/**
 * iframe srcdoc 으로 넣을 문서를 만든다.
 * cid: 로 참조된 인라인 이미지는 첨부에서 찾아 data URL 로 바꾼다. * 그건 메일 안에 이미 들어 있는 것이라 외부 요청이 생기지 않는다.
 */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** 본문 HTML. 본문 안 그림(cid:)은 첨부에서 꺼내 data: 주소로 바꿔 넣는다. 글자만 있는 메일은 <pre> 로. */
function bodyHtml(message: EmlMessage): string {
  let body = message.html
  if (body) {
    for (const attachment of message.attachments) {
      if (!attachment.contentId) continue
      const url = dataUrl(attachment.bytes, attachment.mimeType)
      body = body.replaceAll(`cid:${attachment.contentId}`, url)
    }
    return body
  }
  return `<pre>${escapeHtml(message.text)}</pre>`
}

/** 스크립트는 어떤 경우에도 막는다. 바깥 그림은 사용자가 허락했을 때만. */
function frameCsp(allowRemoteImages: boolean): string {
  return allowRemoteImages
    ? "default-src 'none'; img-src * data: blob:; style-src 'unsafe-inline'; font-src data:"
    : "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:"
}

export function buildEmailFrame(
  message: EmlMessage,
  opts: { allowRemoteImages: boolean },
): string {
  const body = bodyHtml(message)
  const csp = frameCsp(opts.allowRemoteImages)

  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    `<base target="_blank">` +
    `<style>` +
    `html,body{margin:0;padding:16px;background:#fff;color:#131a2e;` +
    `font:14px/1.65 -apple-system,'Apple SD Gothic Neo','Noto Sans KR',sans-serif;` +
    `word-break:break-word;overflow-wrap:anywhere}` +
    `img{max-width:100%;height:auto}` +
    `pre{white-space:pre-wrap;font:inherit;margin:0}` +
    `table{max-width:100%}` +
    `a{color:#4f46e5}` +
    `</style></head><body>${body}</body></html>`
  )
}

/**
 * PDF 로 저장할 때 인쇄 창에 넘기는 문서. 맨 위에 제목과 보낸 사람·받는 사람·날짜·첨부 목록을
 * 표로 찍고, 그 아래에 화면에서 보던 본문을 그대로 둔다.
 *
 * 브라우저의 인쇄 → "PDF로 저장"을 쓴다. 그래서 글자가 그림이 아니라 글자로 남아 PDF 안에서
 * 찾고 복사할 수 있고, 한글·일본어·아랍어 등 어떤 글자든 그 기기의 글꼴로 찍힌다.
 * 첨부 파일 자체는 PDF 에 들어가지 않는다(이름과 크기만 적는다).
 */
export function buildEmailPrintDoc(
  message: EmlMessage,
  opts: {
    allowRemoteImages: boolean
    title: string
    labels: { from: string; to: string; cc: string; date: string; attachments: (n: number) => string }
    /** 첨부 한 개를 "이름 (크기)" 로 적는 함수 */
    attachmentLine: (a: EmlAttachment) => string
    dateText: string
    /** 본문 뒤에 붙이는 "첨부 이미지" 구역의 제목 */
    imagesTitle: string
  },
): string {
  const person = (a: EmlAddress) => (a.name ? `${a.name} <${a.address}>` : a.address)
  const rows: [string, string][] = []
  if (message.from) rows.push([opts.labels.from, person(message.from)])
  if (message.to.length > 0) rows.push([opts.labels.to, message.to.map(person).join(', ')])
  if (message.cc.length > 0) rows.push([opts.labels.cc, message.cc.map(person).join(', ')])
  if (opts.dateText) rows.push([opts.labels.date, opts.dateText])
  const files = message.attachments.filter((a) => !a.contentId || !message.html.includes(`cid:${a.contentId}`))
  if (files.length > 0) rows.push([opts.labels.attachments(files.length), files.map(opts.attachmentLine).join(', ')])

  // 그림 첨부(본문에 박히지 않은 사진·스캔)는 본문 뒤에 한 장씩 싣는다. 브라우저가 그릴 수 있는 형식만.
  const printable = /^image\/(jpeg|jpg|pjpeg|png|gif|webp|bmp|avif)$/i
  const pictures = files.filter((a) => printable.test(a.mimeType) && a.bytes.length > 0)
  const picturesHtml =
    pictures.length > 0
      ? `<section class="ezpz-pics"><h2>${escapeHtml(opts.imagesTitle)}</h2>` +
        pictures
          .map(
            (a) =>
              `<figure><img src="${dataUrl(a.bytes, a.mimeType)}" alt="${escapeHtml(a.filename)}">` +
              `<figcaption>${escapeHtml(a.filename)}</figcaption></figure>`,
          )
          .join('') +
        `</section>`
      : ''

  // 늦게 불러오기(lazy)로 표시된 그림은 보이지 않는 틀에서 끝내 안 불려 빈칸으로 찍힌다. 바로 불러오게 바꾼다.
  const body = bodyHtml(message).replace(/\sloading\s*=\s*(["'])lazy\1/gi, '')

  const head =
    `<header class="ezpz-head"><h1>${escapeHtml(opts.title)}</h1><table>` +
    rows.map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join('') +
    `</table></header>`

  return (
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${frameCsp(opts.allowRemoteImages)}">` +
    `<title>${escapeHtml(opts.title)}</title>` +
    `<style>` +
    `@page{margin:14mm}` +
    `html,body{margin:0;padding:0;background:#fff;color:#131a2e;` +
    `font:13px/1.6 -apple-system,'Segoe UI','Apple SD Gothic Neo','Noto Sans KR','Hiragino Sans','Noto Sans JP',sans-serif;` +
    `word-break:break-word;overflow-wrap:anywhere;-webkit-print-color-adjust:exact;print-color-adjust:exact}` +
    `.ezpz-head{margin:0 0 14px;padding:0 0 12px;border-bottom:1px solid #c9cedb;break-inside:avoid}` +
    `.ezpz-head h1{font-size:18px;line-height:1.35;margin:0 0 8px}` +
    `.ezpz-head table{border-collapse:collapse;font-size:12px;width:100%}` +
    `.ezpz-head th{text-align:start;vertical-align:top;color:#5b6478;font-weight:600;padding:2px 12px 2px 0;white-space:nowrap;width:1%}` +
    `.ezpz-head td{padding:2px 0;vertical-align:top}` +
    `img{max-width:100%;height:auto}` +
    `pre{white-space:pre-wrap;font:inherit;margin:0}` +
    `table{max-width:100%}` +
    `a{color:#4f46e5}` +
    // 고정 너비 표·그림이 쪽 밖으로 잘리지 않게(인쇄 너비 맞춤)
    `main table{width:auto!important;max-width:100%!important;table-layout:auto}main td,main th{word-break:break-word}main *{max-width:100%!important;box-sizing:border-box}` +
    `.ezpz-pics{margin-top:18px;padding-top:12px;border-top:1px solid #c9cedb}` +
    `.ezpz-pics h2{font-size:14px;margin:0 0 10px}` +
    `.ezpz-pics figure{margin:0 0 14px;break-inside:avoid}` +
    `.ezpz-pics img{display:block;max-width:100%;max-height:240mm;object-fit:contain}` +
    `.ezpz-pics figcaption{font-size:11px;color:#5b6478;margin-top:4px}` +
    `</style></head><body>${head}<main>${body}</main>${picturesHtml}</body></html>`
  )
}

/** 헤더와 본문을 텍스트 파일로 내보낼 때 쓰는 형태 */
export function emlToPlainText(message: EmlMessage, labels: {
  from: string
  to: string
  cc: string
  subject: string
  date: string
}): string {
  const person = (a: EmlAddress) => (a.name ? `${a.name} <${a.address}>` : a.address)
  const lines = [
    `${labels.subject}: ${message.subject}`,
    `${labels.from}: ${message.from ? person(message.from) : ''}`,
    `${labels.to}: ${message.to.map(person).join(', ')}`,
  ]
  if (message.cc.length > 0) lines.push(`${labels.cc}: ${message.cc.map(person).join(', ')}`)
  lines.push(`${labels.date}: ${message.date}`, '', '')

  const body =
    message.text ||
    message.html
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/\n{3,}/g, '\n\n')
      .trim()

  return lines.join('\n') + body
}
