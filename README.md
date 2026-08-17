# @m77can/dsh-tool-vision

把 DeepSeek 网页版识图（Vision）模式封装为 dsh 插件，向 agent 注册一个
`recognize_image` 工具，让 DeepSeek 模型可以分析图片内容。

## 安装

先给 profile 换国内 npm 源（已配置则跳过）：

```bash
echo 'registry=https://registry.npmmirror.com' > ~/.dsh/profiles/web/.npmrc
```

再用 `file:` 安装（会把 puppeteer 一并装进 profile）：

```bash
cd /path/to/dsh-tool-vision
dsh plugin --profile web add file:/path/to/dsh-tool-vision
```

安装后重启 dsh web（`dsh web`），新建会话即可生效。

> puppeteer 的 postinstall 会被 pnpm 拦截，需要把它加入 profile 的
> `pnpm-workspace.yaml` 的 `allowBuilds`（首次安装报 `ERR_PNPM_IGNORED_BUILDS` 时，
> 把生成的 `puppeteer: set this to true or false` 改成 `true` 再重跑即可）。

## 在输入框粘贴 / 拖拽图片

纯文本模型（DeepSeek）不支持直接接收图片块，所以本插件在**浏览器端拦截发送**：

1. 你在输入框粘贴或拖入图片后点发送；
2. 发送前图片被上传到 host 的 `/vision/attach`，改写成绝对引用
   `![图片](http://<origin>/vision/raw/sha256:…)` 后以纯文本发出去；
3. 模型看到的是这段引用文本（不是图片块），它把 URL 里的 `sha256:…` id 交给
   `recognize_image`，工具从 attachment store 还原图片字节并走 DeepSeek Vision 识图；
4. 只有识图返回的文本进入对话，图片本身不进会话记录。

## 认证（Token）与自动登录

静态 Token 优先级从高到低：

1. 插件配置 `userToken`（写在 `cordis.patch.yml` 的 row config 中）
2. 环境变量 `DEEPSEEK_USER_TOKEN` / `DEEPSEEK_SMIDV2`
3. 本地文件 `~/.deepseek-vision/config.json`（与 Rust CLI / Node MCP 共用）

**自动登录**：未显式配置 Token 时（上面 1、2 都没有），首次调用
`recognize_image` 或 API 返回 401/403 时会自动用 Puppeteer 打开浏览器，
等待你登录 chat.deepseek.com，然后从 `localStorage.userToken` 取回 Token 并
保存到 `~/.deepseek-vision/config.json`，随后自动重试原请求。

Token 也可手动获取：登录 `https://chat.deepseek.com` → F12 → Application →
Local Storage → `userToken` → `JSON.parse(value).value`。

## 工具

### `recognize_image`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `image` | string | ✅ | ① 贴图引用 `![图片](http://<origin>/vision/raw/<id>)` 里的 `sha256:…` id（直接传 id，无需 ls -al）；② 绝对路径（`/` 开头）；③ `data:image/...;base64,...`。`local://`、`.reasonix/attachments/...` 等引用先 `ls -al` 解析绝对路径。 |
| `prompt` | string | ❌ | 优先传用户对这张图的具体问题/指令（如「这个报错是什么」「把表格提取成CSV」）；用户没有明确指令时才省略，走默认逐字提取文本。 |

支持格式：JPEG、PNG、GIF、WebP、BMP。

## 插件配置

默认配置即可用，最小 row：

```yaml
- insert:
    - id: tool-vision
      name: '@m77can/dsh-tool-vision'
```

需要覆盖时才追加 `config`（键见下表）：

```yaml
- insert:
    - id: tool-vision
      name: '@m77can/dsh-tool-vision'
      config:
        baseUrl: 'https://chat.deepseek.com'
        timeoutMs: 300000
        maxBytes: 10485760
        autoLogin: true
        announceToAgent: true
```

| 键 | 默认 | 说明 |
|------|------|------|
| `baseUrl` | `https://chat.deepseek.com` | DeepSeek 网页版 API 基址 |
| `timeoutMs` | `300000` | 整体超时（毫秒），也作为工具协作超时预算 |
| `maxBytes` | `10485760` | 贴图上传的图片字节上限 |
| `userToken` | — | 可选：直接提供 Token（优先于环境变量，建议用环境变量代替） |
| `smidV2` | — | 可选 Cookie（建议用环境变量 `DEEPSEEK_SMIDV2`） |
| `autoLogin` | `true` | 未显式提供 Token 时，是否启用浏览器自动登录 |
| `puppeteerPath` | — | 可选：指定 puppeteer 入口（默认用依赖里的 puppeteer，一般无需设置） |
| `enabled` | `true` | 是否启用插件 |
| `announceToAgent` | `true` | 是否向 agent 注入 system-prompt 提示 |

## 项目结构

```
├── src/
│   ├── index.js          # host 插件入口（recognize_image 工具 + systemPrompt + /vision 路由）
│   ├── client.js         # 浏览器半部：贴图发送拦截 + 会话内缩略图
│   ├── attach.js         # host 图片接收路由 + 引用解析
│   ├── vision.js         # DeepSeek Vision 客户端（上传/轮询/fork/会话/SSE + 认证重试）
│   ├── auth-manager.js   # Puppeteer 浏览器自动登录
│   ├── auth.js           # Token 静态解析与持久化
│   ├── pow.js            # WASM PoW 求解器（DeepSeekHashV1）
│   └── image.js          # 图片路径/data URI 处理与格式检测
├── assets/sha3_wasm_bg.7b9ca65ddd.wasm   # 原 Rust 项目携带的 sha3 PoW WASM
├── cordis.patch.yml      # bundle patch：把插件插入 profile roster
└── package.json
```

## 说明

- **非官方 API**：调用 DeepSeek 网页版内部接口，可能随官网变更失效。
- 自动登录复用 Puppeteer 下载的 Chrome（缓存于 `~/.cache/puppeteer`）。
- 贴图字节存进 durable attachment store（跨重启保留），id→ref 映射存进程内注册表，不会写入会话记录。
