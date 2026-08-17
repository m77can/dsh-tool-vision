// Token 静态解析与持久化：插件配置 → 环境变量 → ~/.deepseek-vision/config.json。
// 与 deepseek-vision-mcp-rs / deepseek-vision-mcp 保持同一文件格式，
// 因此 Rust CLI `deepseek-vision-cli login` 或 Node MCP 保存的 Token 可直接复用。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const MISSING_TOKEN_HINT =
  '未找到 DeepSeek 登录 Token。请任选其一：' +
  '① 在 profile 的 cordis.patch.yml 中给 tool-vision 配置 userToken；' +
  '② 设置环境变量 DEEPSEEK_USER_TOKEN；' +
  '③ 运行 deepseek-vision-cli login；' +
  '④ 登录 chat.deepseek.com → F12 → Application → Local Storage → userToken → JSON.parse(value).value，并写入 ~/.deepseek-vision/config.json'

export function tokenFilePath() {
  return join(homedir(), '.deepseek-vision', 'config.json')
}

/** 读取保存的 { token, smidV2, savedAt }；不存在/损坏返回 undefined。 */
export function loadStoredToken() {
  const path = tokenFilePath()
  if (!existsSync(path)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed?.token !== 'string' || parsed.token === '') return undefined
    return {
      token: parsed.token,
      smidV2: typeof parsed.smidV2 === 'string' ? parsed.smidV2 : (typeof parsed.smid_v2 === 'string' ? parsed.smid_v2 : undefined),
      savedAt: parsed.savedAt ?? parsed.saved_at,
    }
  } catch {
    return undefined
  }
}

/** 保存 token 到 ~/.deepseek-vision/config.json（与 Node MCP 同格式）。 */
export function saveStoredToken(token, smidV2) {
  if (!token) return
  const path = tokenFilePath()
  try {
    mkdirSync(dirname(path), { recursive: true })
    const stored = { token, ...(smidV2 !== undefined && smidV2 !== null ? { smidV2 } : {}), savedAt: Date.now() }
    writeFileSync(path, JSON.stringify(stored, null, 2), 'utf8')
  } catch (error) {
    console.error('[tool-vision] 保存 Token 失败:', error?.message ?? error)
  }
}

/** 静态解析 { token, smidV2 }；token 可能为 undefined（调用方决定是否走自动登录）。 */
export function resolveStaticCredentials(config) {
  const stored = loadStoredToken()
  return {
    token: firstNonEmpty(config?.userToken, process.env.DEEPSEEK_USER_TOKEN, stored?.token),
    smidV2: firstNonEmpty(config?.smidV2, process.env.DEEPSEEK_SMIDV2, stored?.smidV2),
  }
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return undefined
}
