// dsh-tool-vision —— DeepSeek Vision 识图工具插件（host half）。
// 在 dsh 宿主进程启动时向 ctx.tools 注册 recognize_image 工具，注册 /vision 图片接收路由，
// 并注入一段 system-prompt 提示，让 DeepSeek 模型在需要看图时优先调用它。
// 核心 HTTP 流程见 vision.js；自动登录见 auth-manager.js；图片接收见 attach.js；PoW 见 pow.js。

import { recognizeImage } from './vision.js'
import { AuthManager } from './auth-manager.js'
import { DEFAULT_MAX_BYTES, registerAttachRoute, resolveImageInput } from './attach.js'
import { IMAGE_PARAM_DESC } from './image.js'

/** 稳定的 cordis 插件名。 */
export const name = 'tool-vision'

/** 工具注册、system prompt 提示与 /vision 图片路由依赖这些服务（dsh-base/web-app 已提供）。 */
export const inject = ['tools', 'systemPrompt', 'webServer']

const DEFAULT_TIMEOUT_MS = 300_000

const GUIDANCE = '本机已安装 dsh-tool-vision 插件（DeepSeek 识图）：当前对话使用 DeepSeek 模型时，分析图片/截图内容必须优先调用 recognize_image 工具，不要让 DeepSeek 模型直接"看"图。用户在输入框粘贴/拖拽的图片会以 ![图片](/vision/raw/sha256:…) 引用出现在消息里：此时直接把 URL 里的 sha256 id 作为 image 传入，无需 ls -al、也无需拼路径，你就能通过本工具拿到图片内容。用户围绕图片的文字（如"这个报错是什么"）要作为 prompt 传给 recognize_image。image 也可以是以 / 开头的绝对路径或 data:image/...;base64,...；只有遇到 local:// 或 .reasonix/attachments/... 这类文件系统引用时，才先 shell 执行 ls -al <引用> 解析出绝对路径。首次使用且未配置 Token 时会自动打开浏览器让你登录。'

const TOOL_DESCRIPTION = '使用 DeepSeek 识图模式（Vision）分析图片内容。当前对话使用 DeepSeek 模型时，分析图片必须优先调用本工具，不要让 DeepSeek 直接识图。image 可以是：① 输入框贴图产生的 markdown 引用 ![图片](/vision/raw/<id>)——只把 URL 里的 sha256 id 作为 image 传入，不要传整段 markdown，无需 ls -al；② 绝对路径（以 / 开头）；③ data URI。禁止直接传 local://、.reasonix/attachments/... 等文件系统引用，遇到时先 shell 执行 ls -al <引用> 解析绝对路径。prompt 应优先传用户对这张图的具体问题/指令，用户没有明确指令时才省略。支持格式：JPEG、PNG、GIF、WebP、BMP。首次使用且未设置 DEEPSEEK_USER_TOKEN 时会自动打开浏览器让您登录；认证失败时也会自动重新登录。'

const IMAGE_PARAM = IMAGE_PARAM_DESC + ' 或本插件输入框贴图产生的短引用 ![图片](/vision/raw/<id>)——此时把 URL 里的 sha256 id 作为 image 传入，无需 ls -al。'

/** 手工构建 registry 需要的 ToolDefinition（原始 JSON Schema，等价于 defineTool 的编译产物）。 */
function buildTool(config, getAuthManager, ctx) {
  return {
    name: 'recognize_image',
    description: TOOL_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        image: { type: 'string', description: IMAGE_PARAM },
        prompt: {
          type: 'string',
          description: '对图片的提问或指令。优先把用户围绕这张图片的具体问题或要求原样作为 prompt 传入（例如"这个报错是什么""把表格提取成CSV""翻译图片里的文字"）；用户没有明确指令时才省略，走默认的逐字提取文本。',
        },
      },
      required: ['image'],
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      if (args === null || typeof args !== 'object') {
        throw new Error('recognize_image: 参数必须是对象')
      }
      if (typeof args.image !== 'string' || args.image.trim() === '') {
        throw new Error('recognize_image: image 参数必须是字符串（绝对路径、data URI 或 /vision/raw 引用 id）')
      }
      const imageInput = await resolveImageInput(ctx, args.image)
      const prompt = typeof args.prompt === 'string' && args.prompt.trim() !== '' ? args.prompt : undefined
      const authManager = getAuthManager()
      return await recognizeImage(config, imageInput, prompt, exec.signal, authManager)
    },
  }
}

/**
 * 挂载插件：注册 /vision 图片接收路由、recognize_image 工具并注入 system-prompt 提示。
 * @param {object} ctx - cordis 插件上下文（含 tools / systemPrompt / webServer 服务）
 * @param {object|undefined} config - 插件配置（loader 原样透传，无 Config schema）
 */
export function apply(ctx, config) {
  const resolved = {
    enabled: true,
    baseUrl: 'https://chat.deepseek.com',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    announceToAgent: true,
    autoLogin: true,
    maxBytes: DEFAULT_MAX_BYTES,
    userToken: undefined,
    smidV2: undefined,
    ...(config ?? {}),
  }
  if (resolved.enabled === false) return

  // 仅在未显式提供 Token 时启用自动登录（与 Node 版 MCP 行为一致）。
  // AuthManager 懒创建：只有真正缺 Token / 鉴权失败时才会去加载 puppeteer 并打开浏览器。
  const useAutoLogin = resolved.autoLogin !== false && !resolved.userToken && !process.env.DEEPSEEK_USER_TOKEN
  let authManager = null
  const getAuthManager = () => {
    if (useAutoLogin) {
      if (authManager === null) authManager = new AuthManager(resolved)
      return authManager
    }
    return null
  }

  let disposeTool = undefined
  let disposeSection = undefined
  let disposeRoute = undefined

  const refresh = () => {
    disposeTool?.()
    disposeTool = undefined
    disposeSection?.()
    disposeSection = undefined
    disposeRoute?.()
    disposeRoute = undefined

    if (resolved.announceToAgent !== false) {
      disposeSection = ctx.systemPrompt.section({
        name: 'plugin:tool-vision',
        order: 140,
        text: GUIDANCE,
      })
    }
    disposeTool = ctx.tools.register(buildTool(resolved, getAuthManager, ctx))
    disposeRoute = registerAttachRoute(ctx, () => resolved.maxBytes ?? DEFAULT_MAX_BYTES)
  }

  refresh()
  ctx.effect(() => () => {
    disposeTool?.()
    disposeTool = undefined
    disposeSection?.()
    disposeSection = undefined
    disposeRoute?.()
    disposeRoute = undefined
    if (authManager !== null) void authManager.destroy()
    authManager = null
  }, 'tool-vision: registrations')
}
