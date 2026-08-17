// host 端图片接收路由与媒体校验 —— 逐行移植自 dsh-tool-describe-image 的
// src/attach-routes.ts + src/media.ts，仅把 /describe-image 前缀改为 /vision。
// 图片字节存进 durable attachment store，id→ref 映射存进程内注册表（与参考一致）。

export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024
export const MAX_ATTACH_BODY_BYTES = 16 * 1024 * 1024

/** 可接受的图片媒体类型。 */
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']

export function isImageMimeType(value) {
  return typeof value === 'string' && IMAGE_MEDIA_TYPES.includes(value)
}

/** 依据 magic bytes 检测图片媒体类型。 */
export function sniffMimeType(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6 && bytes.subarray(0, 6).toString('ascii') === 'GIF87a') return 'image/gif'
  if (bytes.length >= 6 && bytes.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif'
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return undefined
}

/** 严格解码 base64：标准字母表、正确 padding、长度是 4 的倍数。 */
export function decodeBase64(encoded) {
  if (encoded.length === 0 || encoded.length % 4 !== 0) return undefined
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return undefined
  if (/=/.test(encoded) && !/={1,2}$/.test(encoded)) return undefined
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.toString('base64') !== encoded) return undefined
  return bytes
}

/** id → ImageAttachmentRef 的进程内注册表（与参考一致）。 */
const ATTACHMENT_REF_REGISTRY = new Map()
const ATTACHMENT_REF_REGISTRY_CAP = 128

export function registerAttachmentRef(ref) {
  ATTACHMENT_REF_REGISTRY.delete(ref.attachmentId)
  ATTACHMENT_REF_REGISTRY.set(ref.attachmentId, ref)
  while (ATTACHMENT_REF_REGISTRY.size > ATTACHMENT_REF_REGISTRY_CAP) {
    const oldest = ATTACHMENT_REF_REGISTRY.keys().next().value
    if (oldest === undefined) break
    ATTACHMENT_REF_REGISTRY.delete(oldest)
  }
}

export function attachmentRefById(id) {
  return ATTACHMENT_REF_REGISTRY.get(id)
}

export function safeDecodeUriComponent(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

export function attachmentMarkdown(id) {
  return '![图片](/vision/raw/' + encodeURIComponent(id).replace(/%3A/gi, ':') + ')'
}

export function attachmentNote(ref) {
  return '[image attachment ' + JSON.stringify(ref) + ']'
}

function validateAttachPayload(payload, maxBytes) {
  if (typeof payload !== 'object' || payload === null) {
    return { error: { code: 'internal', message: 'request body must be a JSON object' } }
  }
  const { data, mediaType, name } = payload
  if (typeof data !== 'string' || data.length === 0) {
    return { error: { code: 'rejected', message: 'image data must be a non-empty base64 string' } }
  }
  if (!isImageMimeType(mediaType)) {
    return { error: { code: 'rejected', message: 'mediaType must be one of image/png, image/jpeg, image/gif, image/webp' } }
  }
  if (name !== undefined && (typeof name !== 'string' || name.length === 0)) {
    return { error: { code: 'rejected', message: 'name must be a non-empty string when present' } }
  }
  const bytes = decodeBase64(data)
  if (bytes === undefined) {
    return { error: { code: 'rejected', message: 'image data is not valid base64' } }
  }
  if (bytes.length === 0) {
    return { error: { code: 'rejected', message: 'image data is empty' } }
  }
  if (bytes.length > maxBytes) {
    return { error: { code: 'rejected', message: 'image is ' + bytes.length + ' bytes, above the ' + maxBytes + '-byte bound' } }
  }
  if (sniffMimeType(bytes) !== mediaType) {
    return { error: { code: 'rejected', message: 'bytes do not match the declared ' + mediaType + ' type' } }
  }
  return { payload: { data, mediaType, name }, bytes }
}

async function handleAttach(ctx, maxBytes, payload) {
  const validated = validateAttachPayload(payload, maxBytes)
  if ('error' in validated) return { ok: false, error: validated.error }
  const attachments = ctx.get('attachments')
  if (attachments === undefined) {
    return { ok: false, error: { code: 'internal', message: 'the attachment service is not mounted; the route cannot store images' } }
  }
  try {
    const ref = await attachments.saveImage({
      data: validated.bytes,
      mediaType: validated.payload.mediaType,
      ...(validated.payload.name === undefined ? {} : { name: validated.payload.name }),
    })
    registerAttachmentRef(ref)
    return { ok: true, ref, note: attachmentNote(ref), markdown: attachmentMarkdown(ref.attachmentId) }
  } catch (error) {
    return { ok: false, error: { code: 'internal', message: 'attachment store rejected the image: ' + (error?.message ?? error) } }
  }
}

async function readJsonBody(req, cap) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buffer = chunk
    chunks.push(buffer)
    total += buffer.length
    if (total > cap) return null
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function json(res, envelope, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(envelope))
}

async function serveRawImage(ctx, req, res) {
  const match = /^\/vision\/raw\/([^/]+)$/.exec(new URL(req.url ?? '/', 'http://x').pathname)
  if (match === null) {
    res.writeHead(404)
    res.end()
    return
  }
  const id = safeDecodeUriComponent(match[1])
  if (id === null) {
    res.writeHead(404)
    res.end()
    return
  }
  const ref = attachmentRefById(id)
  if (ref === undefined) {
    res.writeHead(404)
    res.end()
    return
  }
  const attachments = ctx.get('attachments')
  if (attachments === undefined) {
    res.writeHead(404)
    res.end()
    return
  }
  try {
    const stored = await attachments.readImage(ref)
    res.writeHead(200, { 'content-type': ref.mediaType, 'content-length': String(stored.data.byteLength), 'cache-control': 'private, max-age=3600' })
    res.end(Buffer.from(stored.data))
  } catch {
    res.writeHead(404)
    res.end()
  }
}

export function registerAttachRoute(ctx, readMaxBytes = () => DEFAULT_MAX_BYTES) {
  const webserver = ctx.webServer ?? ctx.get('webServer')
  if (webserver === undefined) return undefined
  return webserver.register({
    kind: 'prefix',
    path: '/vision',
    handler: async (req, res) => {
      if (req.method === 'GET') {
        await serveRawImage(ctx, req, res)
        return
      }
      if (req.method !== 'POST') {
        json(res, { ok: false, error: { code: 'internal', message: 'only POST is allowed' } }, 405)
        return
      }
      const body = await readJsonBody(req, MAX_ATTACH_BODY_BYTES)
      if (body === null) {
        json(res, { ok: false, error: { code: 'internal', message: 'request body must be JSON within 16 MiB' } }, 400)
        return
      }
      const outcome = await handleAttach(ctx, readMaxBytes(), body)
      if (outcome.ok) {
        json(res, { ok: true, value: { note: outcome.note, markdown: outcome.markdown, ref: outcome.ref } })
        return
      }
      json(res, { ok: false, error: outcome.error }, outcome.error.code === 'rejected' ? 422 : 500)
    },
  })
}

/** 从 markdown 引用 / raw 路径 / 裸 id 提取 attachment id。 */
export function extractVisionId(image) {
  const s = image.trim()
  let m = /^!\[[^\]]*]\((?:https?:\/\/[^)\s]*)?\/vision\/raw\/([^)\s]+)\)$/.exec(s)
  if (m !== null) return safeDecodeUriComponent(m[1])
  m = /^(?:https?:\/\/[^/\s]+)?\/vision\/raw\/([^/\s]+)$/.exec(s)
  if (m !== null) return safeDecodeUriComponent(m[1])
  if (/^sha256:[0-9a-f]{64}$/.test(s)) return s
  return null
}

/** 把工具 image 参数解析成 data URI（与参考一致：从 attachment store 读字节）。 */
export async function resolveImageInput(ctx, image) {
  const id = extractVisionId(image)
  if (id === null) return image
  const ref = attachmentRefById(id)
  if (ref === undefined) {
    throw new Error('无法解析图片引用 "' + image + '"：附件已过期或不存在，请重新粘贴图片')
  }
  const attachments = ctx.get('attachments')
  if (attachments === undefined || typeof attachments.readImage !== 'function') {
    throw new Error('无法解析图片引用 "' + image + '"：attachment store 不可用')
  }
  const stored = await attachments.readImage(ref)
  return 'data:' + ref.mediaType + ';base64,' + Buffer.from(stored.data).toString('base64')
}
