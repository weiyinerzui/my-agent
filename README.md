# My Agent

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/weiyinerzui/my-agent)

在 Cloudflare Workers 上运行 Pi Agent 的轻量 Web 聊天应用。内置模型配置面板，可接入任意 OpenAI 兼容 API；API Key 使用 AES-GCM 加密后保存在 Durable Object 中，回复通过 SSE 流式返回。

A minimal web chat UI for the Pi agent on Cloudflare Workers, with configurable OpenAI-compatible models.

> 不需要 Workers AI，也不需要 Workers Paid 计划。模型请求由 Worker 直接发往你自己配置的 OpenAI 兼容站点。

## 功能

- 网页端与 Pi Agent 聊天，SSE 流式输出
- 多套模型配置，支持新增、编辑、启用、删除、切换
- 连接测试：保存前即可验证 Base URL、模型 ID 和 API Key
- API Key 加密存储，接口和日志永远不会返回明文
- 对话历史持久化在 Durable Object，刷新页面不丢失
- 单页静态 UI，无前端构建步骤，支持深色模式
- 所有 `/api/*` 使用 `AUTH_TOKEN` Bearer 鉴权

## 一键部署

点击上方 **Deploy to Cloudflare** 按钮，按提示登录 GitHub 和 Cloudflare，然后填写两个密钥：

| 密钥 | 用途 | 生成方式 |
| --- | --- | --- |
| `AUTH_TOKEN` | 登录网页、调用 API 的访问令牌 | `openssl rand -hex 32` |
| `CONFIG_ENCRYPTION_KEY` | 加密保存模型 API Key 的主密钥 | `openssl rand -base64 32` |

Windows PowerShell：

```powershell
# AUTH_TOKEN
[Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLower()
# CONFIG_ENCRYPTION_KEY
[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

部署完成后打开 Worker 的 `*.workers.dev` 地址，输入 `AUTH_TOKEN`，在「设置」中添加第一个模型即可开始聊天。

> `CONFIG_ENCRYPTION_KEY` 必须妥善保存。更换它会导致已经加密存储的 API Key 无法解密，需要在设置里重新填写。

## 手动部署

需要 Node.js 20+、Cloudflare 账号和 Wrangler。

```bash
git clone https://github.com/weiyinerzui/my-agent.git
cd my-agent
npm ci
npx wrangler login

npx wrangler secret put AUTH_TOKEN
npx wrangler secret put CONFIG_ENCRYPTION_KEY

npm run deploy
```

部署成功后会输出 `https://<worker-name>.<subdomain>.workers.dev`。

## 本地开发

```bash
npm ci
cp .dev.vars.example .dev.vars   # Windows: copy .dev.vars.example .dev.vars
```

编辑 `.dev.vars`，填入本地使用的两个值，然后：

```bash
npm run dev
```

打开 `http://localhost:8787`。

`.dev.vars` 已被 `.gitignore` 忽略，不要提交真实密钥。

## 配置模型

在网页「设置」中填写：

| 字段 | 说明 |
| --- | --- |
| 名称 | 仅用于展示，例如 `DeepSeek` |
| Base URL | API 的完整前缀；OpenAI 兼容服务通常是 `.../v1`，DeepSeek 则是 `https://api.deepseek.com` |
| 模型 ID | 服务商文档中的模型名，例如 `deepseek-chat` |
| API Key | 只写入、不回显；编辑时留空表示保留原值 |
| 上下文窗口 / 最大输出 | 按模型能力填写，默认 `128000` / `8192` |
| 支持 reasoning | 模型是否支持 reasoning 参数 |

常见 Base URL 示例：

| 服务 | Base URL |
| --- | --- |
| OpenAI | `https://api.openai.com/v1` |
| DeepSeek | `https://api.deepseek.com` |
| OpenRouter | `https://openrouter.ai/api/v1` |
| 自建 / 中转站 | 按其文档填写到 `/v1` 为止 |

注意：

- **不要**在 Base URL 中包含 `/chat/completions`，应用会自动追加。
- 一键部署使用 Cloudflare Workers Builds 构建，首次部署需要授权 GitHub 与 Cloudflare，并根据 `.dev.vars.example` 提示填写两个密钥。
- 出于 SSRF 防护，`localhost`、`127.0.0.1`、内网 IP 和云元数据地址会被拒绝。本地模型请使用公网隧道（如 Cloudflare Tunnel）暴露。
- 保存后先点「测试」确认连通，再开始聊天。

## 架构

```
浏览器 (public/)
   │  Authorization: Bearer <AUTH_TOKEN>
   ▼
Worker (src/index.ts)
   ├─ /api/*  → Assistant Durable Object
   └─ 其他    → Cloudflare Assets 静态文件
                        │
                        ▼
              Assistant (src/assistant.ts)
              ├─ 配置：DO KV `settings:v1`，API Key AES-GCM 加密
              ├─ 模型：每个 profile 注册一个 pi-ai provider
              ├─ Pi：PiHarness / PiSession
              └─ 聊天：submit + watch + wait → SSE ReadableStream
```

## API

所有请求都需要：

```http
Authorization: Bearer <AUTH_TOKEN>
```

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/config` | 读取配置（不含 API Key 明文） |
| `POST` | `/api/config/profiles` | 新增或更新模型配置 |
| `DELETE` | `/api/config/profiles/:id` | 删除配置 |
| `POST` | `/api/config/profiles/:id/activate` | 切换当前模型 |
| `POST` | `/api/config/profiles/:id/test` | 测试连接 |
| `GET` | `/api/chat/history?session=1` | 读取历史 |
| `POST` | `/api/chat` | SSE 流式聊天，body 为 `{"prompt":"..."}` |
| `POST` | `/api/chat/reset` | 清空对话 |
| `GET` | `/api/ask?q=...` | 非流式问答，便于 curl |

SSE 事件：

```
event: start   data: {"operationId":"..."}
event: delta   data: {"text":"累计文本"}
event: done    data: {"text":"最终文本","status":"done","reason":null,"detail":null}
event: error   data: {"message":"..."}
```

## 安全说明

- `AUTH_TOKEN` 是唯一的信任边界。任何持有它的人都能读取和修改所有模型配置，**请使用足够长的随机值**，不要公开分享。
- API Key 使用 AES-GCM 加密后存入 Durable Object，AAD 绑定 profile ID；接口只返回 `hasApiKey`。
- 解密只发生在 Durable Object 内存中，用于构造 provider 的鉴权回调；不会写入日志。
- Base URL 只允许 `http(s)`，并拒绝 localhost、私有网段、IPv6 映射地址和常见云元数据地址。DNS 重绑定无法在 Worker 内完全防御，因此请只填写可信服务商。
- 本应用是单租户设计，没有多用户隔离；所有浏览器共享同一段对话。
- 模型回复按纯文本渲染（`textContent`），不解析 Markdown，避免 XSS。

## 测试

```bash
npm test            # vitest
npm run typecheck   # tsc --noEmit
npm run deploy -- --dry-run
```

## 已知限制

- 单个共享会话；多会话列表未实现。
- 纯文本回复，不渲染 Markdown。
- 无文件上传、工具调用 UI、限流和多用户认证。
- 删除当前 profile 时会自动切换到剩余的第一套配置；没有剩余配置时聊天返回明确的 409 错误。

## 项目结构

```
src/
  index.ts          Worker 路由、鉴权
  assistant.ts      Durable Object：配置、模型注册、聊天
  config/           类型、校验、加密、DO KV、provider
  chat/             历史映射、SSE 桥接
public/             静态网页
test/               Vitest 测试
```
