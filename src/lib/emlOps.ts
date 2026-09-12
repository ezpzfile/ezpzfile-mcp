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

export async function parseEml(file: File): Promise<EmlMessage> {
  const { default: PostalMime } = await import('postal-mime')
  const parsed = await PostalMime.parse(await file.arrayBuffer())

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

  return {
    subject: parsed.subject ?? '',
    from: toAddress(parsed.from),
    to: toAddressList(parsed.to),
    cc: toAddressList(parsed.cc),
    date: parsed.date ?? '',
    html,
    text: parsed.text ?? '',
    attachments,
    remoteImageCount,
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
export function buildEmailFrame(
  message: EmlMessage,
  opts: { allowRemoteImages: boolean },
): string {
  let body = message.html

  if (body) {
    for (const attachment of message.attachments) {
      if (!attachment.contentId) continue
      const url = dataUrl(attachment.bytes, attachment.mimeType)
      body = body.replaceAll(`cid:${attachment.contentId}`, url)
    }
  } else {
    const escaped = message.text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
    body = `<pre>${escaped}</pre>`
  }

  const csp = opts.allowRemoteImages
    ? "default-src 'none'; img-src * data: blob:; style-src 'unsafe-inline'; font-src data:"
    : "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:"

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
