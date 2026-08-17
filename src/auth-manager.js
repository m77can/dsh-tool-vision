// 自动登录认证管理器（移植自 deepseek-vision-mcp 的 src/auth-manager.ts）。
// 仅在真正需要登录时才懒加载 puppeteer：无 Token / API 认证失败时打开浏览器，
// 等待用户在 chat.deepseek.com 登录，从 localStorage.userToken 取回 Token。

import { loadStoredToken, saveStoredToken } from './auth.js'

const LOGIN_URL = 'https://chat.deepseek.com/'
const LOGIN_TIMEOUT_MS = 300_000

/**
 * 懒加载 puppeteer：优先插件配置 / 环境变量路径，其次回退到本机 Node 版 MCP
 * 已安装的 puppeteer，最后尝试包名解析。
 */
async function loadPuppeteer(puppeteerPath) {
  const candidates = [
    'puppeteer',
    puppeteerPath,
    process.env.PUPPETEER_PATH,
    '/home/m77can/Workspace/tools/deepseek-vision-mcp/node_modules/puppeteer/lib/puppeteer/puppeteer.js',
  ].filter(Boolean)
  let lastError
  for (const spec of candidates) {
    try {
      const mod = await import(spec)
      const puppeteer = mod.default ?? mod
      if (typeof puppeteer?.launch === 'function') return puppeteer
    } catch (error) {
      lastError = error
    }
  }
  throw new Error('无法加载 puppeteer（' + (lastError?.message ?? '未找到') + '）。请设置 PUPPETEER_PATH 指向可用的 puppeteer 入口，或安装 puppeteer 后重试。')
}

export class AuthManager {
  constructor(config) {
    this.puppeteerPath = config?.puppeteerPath
    this.token = null
    this.smidV2 = null
    this.browser = null
    this.loginInProgress = false
    this.loginWaiters = []
    const stored = loadStoredToken()
    if (stored?.token) {
      this.token = stored.token
      this.smidV2 = stored.smidV2 ?? null
      console.error('[tool-vision] 📂 从文件加载 Token')
    }
  }

  getToken() {
    return this.token
  }

  getSmidV2() {
    return this.smidV2
  }

  hasToken() {
    return !!this.token
  }

  /**
   * 触发自动登录流程：打开浏览器 → 等待用户登录 → 提取 userToken + smidV2 → 保存。
   * 并发调用会复用同一个登录窗口。
   */
  async login() {
    if (this.loginInProgress) {
      console.error('[tool-vision] ⏳ 等待已有登录流程完成...')
      return new Promise((resolve, reject) => {
        this.loginWaiters.push({ resolve, reject })
      })
    }

    this.loginInProgress = true
    try {
      console.error('[tool-vision] 🌐 打开浏览器进行登录...')
      console.error('[tool-vision] 💡 请在打开的页面中登录 DeepSeek 账号')
      console.error('[tool-vision] 💡 登录后页面会自动检测并关闭')

      const puppeteer = await loadPuppeteer(this.puppeteerPath)

      this.browser = await puppeteer.launch({
        headless: false,
        defaultViewport: { width: 1280, height: 800 },
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      }).catch((error) => {
        console.error('[tool-vision] ⚠️ 无法启动浏览器:', error?.message ?? error)
        throw new Error(
          '无法自动打开浏览器。请登录 chat.deepseek.com，按 F12 → Application → Local Storage → 找到 userToken，' +
          '复制其 JSON.parse 后的 value 值，然后设置环境变量: export DEEPSEEK_USER_TOKEN="你的token"',
        )
      })

      const page = await this.browser.newPage()
      await page.goto(LOGIN_URL, { waitUntil: 'load', timeout: 60_000 }).catch(() => {
        console.error('[tool-vision] ⚠️ 页面加载警告（可忽略）')
      })

      console.error('[tool-vision] ⏳ 等待用户登录...')
      const token = await this.waitForToken(page, LOGIN_TIMEOUT_MS)
      if (!token) throw new Error('[tool-vision] 登录超时或失败')

      const cookies = await page.cookies()
      const smidCookie = cookies.find((c) => c.name === 'smidV2')
      if (smidCookie) this.smidV2 = smidCookie.value

      this.token = token
      saveStoredToken(this.token, this.smidV2 ?? undefined)

      console.error('[tool-vision] ✅ 登录成功，Token 已保存')
      await this.browser.close().catch(() => {})
      this.browser = null

      const waiters = this.loginWaiters.splice(0)
      for (const waiter of waiters) waiter.resolve(this.token)
      return this.token
    } catch (error) {
      const waiters = this.loginWaiters.splice(0)
      for (const waiter of waiters) waiter.reject(error)
      throw error
    } finally {
      this.loginInProgress = false
    }
  }

  /** 轮询 localStorage 中的 userToken。 */
  async waitForToken(page, timeoutMs) {
    const startTime = Date.now()
    while (Date.now() - startTime < timeoutMs) {
      try {
        const token = await page.evaluate(() => {
          try {
            const raw = localStorage.getItem('userToken')
            if (!raw) return null
            const parsed = JSON.parse(raw)
            const value = parsed?.value || parsed
            if (typeof value === 'string' && value.length > 20) return value
            return null
          } catch {
            return null
          }
        })
        if (token) {
          await new Promise((resolve) => setTimeout(resolve, 1500))
          return token
        }
      } catch {
        // 页面可能正在导航
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    return null
  }

  async destroy() {
    if (this.browser) {
      await this.browser.close().catch(() => {})
      this.browser = null
    }
  }
}
