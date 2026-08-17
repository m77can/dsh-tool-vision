// DeepSeek 网页版识图（Vision）HTTP 客户端。
// 移植自 deepseek-vision-mcp-rs crates/cli/src/client.rs，并加入
// deepseek-vision-mcp（Node 版）的自动登录重试：401/403 或业务层鉴权失败
// 时调用 AuthManager.login() 打开浏览器，登录成功后重试原请求。

import { MISSING_TOKEN_HINT, resolveStaticCredentials } from './auth.js'
import { DEFAULT_PROMPT, prepareUpload, readImageBase64 } from './image.js'
import { solvePowChallenge } from './pow.js'

const DEFAULT_BASE_URL = 'https://chat.deepseek.com'
const DEFAULT_TIMEOUT_MS = 300_000

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** DS 业务层鉴权失败（HTTP 可能仍为 200）。 */
function isAuthApiError(code, msg) {
  const n = Number(code)
  if (n === 40003 || n === 401 || n === 403) return true
  const m = (msg || '').toLowerCase()
  return m.includes('authorization failed') || m.includes('invalid token') || m.includes('unauthorized')
}

/** 组合调用方信号与整体超时，得到传给 fetch 的 AbortSignal。 */
function combineSignal(signal, timeoutMs) {
  const parts = []
  if (signal !== undefined && signal !== null) parts.push(signal)
  if (timeoutMs !== undefined && timeoutMs > 0) parts.push(AbortSignal.timeout(timeoutMs))
  if (parts.length === 0) return undefined
  if (parts.length === 1) return parts[0]
  return AbortSignal.any(parts)
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal))
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      reject(abortReason(signal))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function abortReason(signal) {
  return signal?.reason ?? new Error('已取消')
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortReason(signal)
}

function truncate(text, max) {
  if (text.length <= max) return text
  return `${text.slice(0, max)}...`
}

export class VisionClient {
  constructor(config, authManager) {
    this.baseUrl = (config?.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '')
    this.timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.authManager = authManager ?? null

    const creds = resolveStaticCredentials(config)
    this.token = creds.token ?? null
    this.smidV2 = creds.smidV2 ?? null
  }

  /** 无 Token 时触发自动登录；登录不可用时给出带指引的错误。 */
  async ensureToken(signal) {
    if (this.token) return this.token
    if (!this.authManager) throw new Error(MISSING_TOKEN_HINT)
    throwIfAborted(signal)
    console.error('[tool-vision] 🌐 需要登录，打开浏览器...')
    const token = await this.authManager.login()
    this.token = token
    this.smidV2 = this.authManager.getSmidV2() ?? this.smidV2
    throwIfAborted(signal)
    return token
  }

  async refreshAuth(signal) {
    if (!this.authManager) throw new Error(MISSING_TOKEN_HINT)
    console.error('[tool-vision] 🔑 认证失败，触发自动登录...')
    const token = await this.authManager.login()
    this.token = token
    this.smidV2 = this.authManager.getSmidV2() ?? this.smidV2
    console.error('[tool-vision] ✅ Token 已更新')
    return token
  }

  commonHeaders() {
    const headers = {
      'Authorization': `Bearer ${this.token}`,
      'User-Agent': USER_AGENT,
      'Accept': 'application/json, text/event-stream, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'Origin': this.baseUrl,
      'Referer': `${this.baseUrl}/`,
      'X-App-Version': '2.0.0',
      'X-Client-Version': '1.0.0-always',
      'X-Client-Locale': 'zh-CN',
      'X-Client-Platform': 'web',
    }
    if (this.smidV2) headers['Cookie'] = `smidV2=${this.smidV2}`
    return headers
  }

  async fetchJson(method, path, body, extraHeaders = {}, signal, allowRetry = true) {
    const url = `${this.baseUrl}${path}`
    const headers = this.commonHeaders()
    Object.assign(headers, extraHeaders)
    if (body !== undefined) headers['Content-Type'] = 'application/json'

    const resp = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    })
    const text = await resp.text()

    if ((resp.status === 401 || resp.status === 403) && allowRetry && this.authManager) {
      await this.refreshAuth(signal)
      return this.fetchJson(method, path, body, extraHeaders, signal, false)
    }
    if (!resp.ok) {
      throw new Error(`DS API ${resp.status}: ${truncate(text, 300)}`)
    }

    let json
    try {
      json = JSON.parse(text)
    } catch {
      json = text
    }
    const appError = extractAppError(json)
    if (appError !== undefined) {
      if (isAuthApiError(appError.code, appError.msg) && allowRetry && this.authManager) {
        await this.refreshAuth(signal)
        return this.fetchJson(method, path, body, extraHeaders, signal, false)
      }
      throw new Error(`DS API ${appError.code}: ${appError.msg}`)
    }
    return json
  }

  async createAndSolvePow(targetPath, signal) {
    try {
      const res = await this.fetchJson('POST', '/api/v0/chat/create_pow_challenge', { target_path: targetPath }, {}, signal)
      const challengeData = extractChallenge(res)
      if (challengeData === undefined) {
        console.error('[tool-vision] PoW 原始响应缺少 challenge:', truncate(JSON.stringify(res), 400))
        return ''
      }
      return await solvePowChallenge(challengeData)
    } catch (error) {
      console.error('[tool-vision] PoW challenge/求解失败:', error?.message ?? error)
      return ''
    }
  }

  async uploadImage(imageBase64, signal, allowRetry = true) {
    const { bytes, mime, filename } = prepareUpload(imageBase64)
    const powHeader = await this.createAndSolvePow('/api/v0/file/upload_file', signal)

    const headers = this.commonHeaders()
    if (powHeader !== '') headers['x-ds-pow-response'] = powHeader

    const form = new FormData()
    form.append('file', new Blob([bytes], { type: mime }), filename)

    const resp = await fetch(`${this.baseUrl}/api/v0/file/upload_file`, {
      method: 'POST',
      headers,
      body: form,
      signal,
    })
    const text = await resp.text()

    if ((resp.status === 401 || resp.status === 403) && allowRetry && this.authManager) {
      await this.refreshAuth(signal)
      return this.uploadImage(imageBase64, signal, false)
    }
    if (!resp.ok) throw new Error(`DS API ${resp.status}: ${truncate(text, 300)}`)

    let raw
    try {
      raw = JSON.parse(text)
    } catch {
      raw = text
    }
    const appError = extractAppError(raw)
    if (appError !== undefined) {
      if (isAuthApiError(appError.code, appError.msg) && allowRetry && this.authManager) {
        await this.refreshAuth(signal)
        return this.uploadImage(imageBase64, signal, false)
      }
      throw new Error(`DS API ${appError.code}: ${appError.msg}`)
    }
    const fileId = extractBizId(raw)
    if (fileId === undefined) throw new Error('上传失败：无 file_id')
    return fileId
  }

  async waitForFile(fileId, signal) {
    const maxWaitSeconds = Math.max(1, Math.floor(this.timeoutMs / 1000) - 1)
    for (let i = 0; i < maxWaitSeconds; i++) {
      throwIfAborted(signal)
      const raw = await this.fetchJson('GET', `/api/v0/file/fetch_files?file_ids=${encodeURIComponent(fileId)}`, undefined, {}, signal)
      const status = extractFileStatus(raw)
      if (status !== undefined) {
        const upper = status.toUpperCase()
        if (upper === 'SUCCESS') return
        if (upper === 'FAILED' || upper === 'ERROR') throw new Error(`文件处理失败: ${status}`)
      }
      await sleep(1000, signal)
    }
    throw new Error('文件处理超时')
  }

  async forkToVision(fileId, signal) {
    const raw = await this.fetchJson('POST', '/api/v0/file/fork_file_task', {
      file_id: fileId,
      to_model_type: 'vision',
    }, {}, signal)
    const id = extractBizId(raw)
    if (id === undefined) throw new Error('Fork 失败：无 id')
    return id
  }

  async createSession(signal) {
    const raw = await this.fetchJson('POST', '/api/v0/chat_session/create', { agent: 'chat' }, {}, signal)
    const id = extractBizId(raw)
    if (id === undefined) throw new Error('创建会话失败：无 id')
    return id
  }

  getHifTokens(signal) {
    // 与 Rust 一致：非阻塞地预热两个 hif 端点，失败不影响主流程。
    const headers = this.commonHeaders()
    for (const url of ['https://hif-leim.deepseek.com/query', 'https://hif-dliq.deepseek.com/query']) {
      fetch(url, { headers, signal }).catch(() => {})
    }
  }

  async visionComplete(sessionId, visionFileId, prompt, signal, allowRetry = true) {
    const powHeader = await this.createAndSolvePow('/api/v0/chat/completion', signal)

    const body = {
      chat_session_id: sessionId,
      parent_message_id: null,
      model_type: 'vision',
      prompt,
      ref_file_ids: [visionFileId],
      thinking_enabled: false,
      search_enabled: false,
      action: null,
      preempt: false,
    }
    const bodyStr = JSON.stringify(body)

    const headers = {
      'accept': '*/*',
      'accept-language': 'zh_CN,zh_CN;q=0.9,en;q=0.8',
      'Authorization': `Bearer ${this.token}`,
      'Content-Type': 'application/json',
      'priority': 'u=1, i',
      'Origin': this.baseUrl,
      'Referer': `${this.baseUrl}/a/chat/s/${sessionId}`,
      'x-app-version': '2.0.0',
      'x-client-locale': 'zh_CN',
      'x-client-platform': 'web',
      'x-client-timezone-offset': '28800',
      'x-client-version': '2.0.0',
    }
    if (powHeader !== '') headers['x-ds-pow-response'] = powHeader
    if (this.smidV2) headers['Cookie'] = `smidV2=${this.smidV2}`

    const resp = await fetch(`${this.baseUrl}/api/v0/chat/completion`, {
      method: 'POST',
      headers,
      body: bodyStr,
      signal,
    })
    const raw = await resp.text()

    if ((resp.status === 401 || resp.status === 403) && allowRetry && this.authManager) {
      await this.refreshAuth(signal)
      return this.visionComplete(sessionId, visionFileId, prompt, signal, false)
    }
    if (!resp.ok) throw new Error(`Vision HTTP ${resp.status}: ${truncate(raw, 300)}`)

    const result = parseSseResponse(raw)
    if (result.startsWith('__SSE_ERROR__:')) {
      const msg = result.slice('__SSE_ERROR__:'.length)
      if (isAuthApiError(0, msg) && allowRetry && this.authManager) {
        await this.refreshAuth(signal)
        return this.visionComplete(sessionId, visionFileId, prompt, signal, false)
      }
      throw new Error(msg)
    }
    return result
  }

  async recognize(image, prompt, signal) {
    const imageBase64 = readImageBase64(image)
    const effectivePrompt = prompt?.trim() ? prompt.trim() : DEFAULT_PROMPT

    await this.ensureToken(signal)

    const uploadId = await this.uploadImage(imageBase64, signal)
    await this.waitForFile(uploadId, signal)

    const visionId = await this.forkToVision(uploadId, signal)
    await this.waitForFile(visionId, signal)

    const sessionId = await this.createSession(signal)
    this.getHifTokens(signal)

    return await this.visionComplete(sessionId, visionId, effectivePrompt, signal)
  }
}

/** 解析 chat/completion 的 SSE 文本，返回纯文本结果。 */
export function parseSseResponse(raw) {
  let result = ''
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim()
    if (!t.startsWith('data:')) continue
    const payload = t.slice(5).trim()
    if (payload === '[DONE]') break
    let ev
    try {
      ev = JSON.parse(payload)
    } catch {
      continue
    }
    if (ev?.type === 'error') {
      const msg = typeof ev.content === 'string' ? ev.content : 'Vision 错误'
      return `__SSE_ERROR__:${msg}`
    }
    if (typeof ev?.v === 'string') result += ev.v
    if (ev?.type === 'text') {
      if (typeof ev.text === 'string') result += ev.text
      else if (typeof ev.content === 'string') result += ev.content
    }
  }
  return result === '' ? '（无返回内容）' : result
}

function parseCode(value) {
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const n = Number(value)
    return Number.isNaN(n) ? undefined : n
  }
  return undefined
}

function extractAppError(json) {
  const fromObj = (obj) => {
    if (obj === null || typeof obj !== 'object') return undefined
    const code = parseCode(obj.code)
    if (code === undefined || code === 0 || code === 200) return undefined
    const fallback = truncate(JSON.stringify(obj), 200)
    const msg = (typeof obj.msg === 'string' && obj.msg !== '')
      ? obj.msg
      : (typeof obj.message === 'string' && obj.message !== '')
        ? obj.message
        : fallback
    return { code, msg }
  }
  return fromObj(json) ?? fromObj(json?.data)
}

function bizData(raw) {
  return raw?.data?.biz_data ?? raw
}

function extractBizId(raw) {
  const biz = bizData(raw)
  const id = biz?.id ?? biz?.file_id
  return typeof id === 'string' ? id : undefined
}

function extractFileStatus(raw) {
  const biz = bizData(raw)
  return biz?.files?.[0]?.status !== undefined ? String(biz.files[0].status) : undefined
}

function extractChallenge(res) {
  if (typeof res?.challenge === 'string') return res.challenge
  if (typeof res?.biz_data?.challenge === 'string') return res.biz_data.challenge
  const ch = res?.data?.biz_data?.challenge
  if (ch === undefined) return undefined
  return typeof ch === 'string' ? ch : JSON.stringify(ch)
}

/** 便捷入口：缺 token 且启用 autoLogin 时会通过 authManager 触发浏览器登录。 */
export async function recognizeImage(config, image, prompt, signal, authManager) {
  const timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const client = new VisionClient(config, authManager)
  return await client.recognize(image, prompt, combineSignal(signal, timeoutMs))
}
