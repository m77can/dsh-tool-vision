// 图片路径/data URI 处理与格式检测。
// 移植自 deepseek-vision-mcp-rs crates/cli/src/image.rs。

import { readFileSync } from 'node:fs'

/** 默认 prompt：逐字逐行提取图片中的完整文本。 */
export const DEFAULT_PROMPT = '请逐字逐行提取图片中的完整文本内容。如果是JSON/配置文件/代码，请直接输出完整的格式化文本，不要省略任何一行。如果是表格或UI，请逐一列出每个字段和值。'

/** 传给模型的 image 参数描述。 */
export const IMAGE_PARAM_DESC = '必须以 / 开头的绝对路径，或 data:image/...;base64,...。禁止直接传 local://、.reasonix/attachments/... 等引用；须先 shell 执行 ls -al <引用> 取绝对路径再传入。'

/** 是否为绝对路径（POSIX 或 Windows）。 */
export function isAbsoluteImagePath(path) {
  const p = path.trim()
  return p.startsWith('/') || isWindowsAbsolute(p)
}

function isWindowsAbsolute(path) {
  return path.length >= 3
    && /^[A-Za-z]$/.test(path[0])
    && path[1] === ':'
    && (path[2] === '\\' || path[2] === '/')
}

/** 非绝对路径时的快速失败信息。 */
export function pathResolutionError(path) {
  return `"${path}" 不是绝对路径，无法直接读取。请先执行 shell: ls -al ${path}，从输出取以 / 开头的路径再调用 recognize_image。禁止把 local:// 或 .reasonix/attachments/... 直接传入 image。`
}

const DATA_URI_RE = /^data:image\/[a-zA-Z]+;base64,(.+)$/

function decodeDataUri(dataUri) {
  const m = DATA_URI_RE.exec(dataUri)
  if (m !== null) return m[1]
  const comma = dataUri.indexOf(',')
  if (comma !== -1) return dataUri.slice(comma + 1)
  throw new Error('无效的 data URI 格式')
}

/** 把绝对路径或 data URI 解析为 base64 字符串（不含 data: 前缀）。 */
export function readImageBase64(image) {
  const input = image.trim()
  if (input.startsWith('data:')) return decodeDataUri(input)
  if (!isAbsoluteImagePath(input)) throw new Error(pathResolutionError(input))
  let bytes
  try {
    bytes = readFileSync(input)
  } catch {
    throw new Error(`无法读取图片文件 "${input}"，请确认路径存在且可读`)
  }
  return Buffer.from(bytes).toString('base64')
}

/** 依据魔数检测图片扩展名。 */
export function detectFormat(bytes) {
  const b = bytes
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg'
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png'
  if (b.length >= 3 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif'
  if (b.length >= 4 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return 'webp'
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'bmp'
  return 'png'
}

/** 扩展名 → MIME。 */
export function imageMime(ext) {
  if (ext === 'jpg') return 'image/jpeg'
  switch (ext) {
    case 'png': return 'image/png'
    case 'gif': return 'image/gif'
    case 'webp': return 'image/webp'
    case 'bmp': return 'image/bmp'
    default: return 'image/png'
  }
}

/** 把 base64 解码为字节并准备上传用的 bytes/mime/filename。 */
export function prepareUpload(imageBase64) {
  let bytes
  try {
    bytes = Buffer.from(imageBase64, 'base64')
  } catch {
    throw new Error('base64 解码失败')
  }
  const u8 = new Uint8Array(bytes)
  const ext = detectFormat(u8)
  const mime = imageMime(ext)
  const filename = `img_${Date.now()}.${ext}`
  return { bytes: u8, mime, filename }
}
