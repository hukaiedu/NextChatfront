# personChat Frontend

基于 NextChat 改造的 personChat Web 前端。

保留 NextChat 的主要聊天体验、Markdown 渲染、会话列表与设置界面;Conversation / Message / Request 已不再由浏览器本地聊天存储作为权威数据源,而是统一由 personChat Backend 管理。Frontend 通过 `/backend-api/*` 调用后端,并通过 SSE 接收 Gemini Web 的实时回答。

Frontend 不直接调用 Gemini API,也不直接驱动 Gemini Web —— 它只负责 UI 和交互,所有聊天能力都由 personChat Backend 提供。

## 系统架构

```text
Browser
   │
   ▼
personChat Frontend
   │
   │ REST / EventSource
   ▼
/backend-api/*
   │
   │ Next.js Rewrite
   ▼
personChat Backend
   │
   ▼
Playwright / Gemini Web
```

Frontend 只负责 UI 和交互;Backend 是 Conversation / Message / Request 的权威数据源。

## 与原 NextChat 的主要区别

### 已改造

- **Conversation / Message / Request 后端化**:全部由 Backend 管理,聊天主数据源是 Backend 数据库。
- **SSE 流式**:通过 `GET /backend-api/requests/:id/events` 接收流式回答(见下文「SSE 流式」)。
- **Cancel 后端化**:停止生成走后端 Cancel 接口(见下文「Cancel」)。
- **Archive / Restore / Delete 后端化**:会话归档、恢复、删除都以后端为准。
- **Draft 首次发送时创建 Backend Conversation**:新建草稿不落库,第一次发送才创建(见下文「首次发送行为」)。
- **页面刷新从 Backend 恢复**:重新拉取 Conversation / Message;生成中刷新会重新跟随 Request 继续 SSE。
- **发送幂等**:每次发送带 `Idempotency-Key`,防止重复提交。

### 已禁用 / 隐藏

以下能力在 V1 已从 UI 移除或返回 404(详见「旧接口与旧能力」):

- 旧多 Provider 代理路由(OpenAI / Anthropic / Google / Azure / 百度 / 字节 / 阿里 / Moonshot / Stability / 讯飞 / DeepSeek / xAI / GLM / SiliconFlow / 302.AI 等)及默认 Proxy
- API Key 配置入口(设置页已无 Key 输入)
- 模型切换(固定使用 `Gemini Web` 通道;V1.1 新增的会话级 Gemini 模型选择见下文「模型选择(V1.1)」,不属于 NextChat 原生 Provider 体系)
- WebDAV / Upstash 同步
- ShareGPT 分享
- Artifacts(Cloudflare KV 分享代理已下线,前端接口返回 404)

## 技术栈

| 依赖 | 版本 |
| --- | --- |
| Next.js | ^14.1.1 |
| React | ^18.2.0 |
| TypeScript | 5.2.2 |
| Zustand | ^4.3.8 |
| React Markdown | ^8.0.7 |
| Yarn | 1.22.19(`packageManager` 锁定) |

已验证 Node 版本:**Node 24.14.0**。仓库未声明最低 Node 版本。

## 关键目录

```text
app/
├─ client/
│  ├─ backend-api.ts        # REST / SSE 后端通信客户端
│  └─ admin-api.ts          # canonical /backend-api/admin/* 运维调用
├─ store/
│  ├─ chat.ts               # 前端会话状态与 Backend 数据同步
│  ├─ auth.ts               # 身份 session 真相(服务端为准)+ 登录 / 退出 / 吊销
│  └─ browser.ts            # 浏览器状态快照 + 共享轮询定时器
├─ components/
│  ├─ chat.tsx              # 聊天主界面
│  ├─ sidebar.tsx           # 会话列表 / 归档切换
│  ├─ browser-status.tsx    # /admin 用的服务端浏览器面板(展示层)
│  └─ settings.tsx          # 设置页(无运维面板)
├─ admin/
│  ├─ page.tsx              # /admin 管理控制台(ADMIN only)
│  └─ login/page.tsx        # /admin/login 管理员登录
└─ api/
   ├─ config/route.ts       # 保留:非敏感 UI 配置
   └─ (其余 Provider / WebDAV 路由已统一 404)

next.config.mjs             # /backend-api/* rewrite 规则
```

- `backend-api.ts`:所有后端请求的唯一出口,只和同源 `/backend-api/*` 说话,无 CORS、无 Provider 鉴权头。
- `admin-api.ts`:运维调用与 Public 聊天调用物理分开,类型独立,不共享 DTO。
- `chat.ts`:会话状态机(草稿 / 已加载 / 在途 Request / 归档),与 Backend 数据同步。
- `auth.ts`:身份只由 `GET /backend-api/auth/session` 决定,本地不落任何凭证。
- `browser.ts`:浏览器状态快照、重启动作与引用计数的共享轮询(展示位只有一份 15s 轮询)。
- `next.config.mjs`:`/backend-api/*` 同源代理。
- `docs/browser-status-api.md`:浏览器状态接口的后端实现规格(交后端 Agent 的交付文档)。

> 原 NextChat 的多 Provider 客户端(`app/client/platforms/*`、`app/client/api.ts`)仍在仓库中,但已不参与聊天链路,仅为残留代码。

## 环境要求

- Node.js
- Yarn 1.x
- personChat Backend(正在运行)
- 现代浏览器(Chrome / Edge / Firefox)

Frontend 本身不需要 Prisma、SQLite 或 Playwright Chromium —— 这些属于 Backend。

## 快速开始

### 1. Clone

```bash
git clone https://github.com/hukaiedu/NextChatfront.git
cd NextChatfront
```

### 2. 安装

```bash
yarn install
```

### 3. Backend

先确保 personChat Backend 已启动。

相关仓库:

```text
https://github.com/hukaiedu/NextChatBack
```

默认 Backend 地址为 `http://127.0.0.1:3010`(如需修改见下节)。

没有 Backend 时,前端页面可以打开,但无法登录会话列表、无法聊天。

## BACKEND_ORIGIN

Frontend 通过 Next.js Rewrite 将 `/backend-api/*` 代理到后端,目标地址由环境变量 `BACKEND_ORIGIN` 指定(`next.config.mjs` 在 dev server / build 启动时读取):

```bash
BACKEND_ORIGIN=http://127.0.0.1:3010
```

请求链路:

```text
Browser 请求 /backend-api/*
↓
Next.js Rewrite(beforeFiles)
↓
BACKEND_ORIGIN/api/*
```

未设置 `BACKEND_ORIGIN` 时默认为 `http://127.0.0.1:3010`。该变量只在启动时读取一次,修改后需重启 dev server / 重新构建。

## V1.4 身份与账号体验

身份只有 `ANONYMOUS`、`REGISTERED`、`ADMIN`。普通用户使用 username/password：

- `/` 为 anonymous-first；普通用户入口是 `/login`、`/register`，管理员入口独立为 `/admin/login`，控制台为 `/admin`。
- 注册调用 `POST /backend-api/auth/register`，保留当前 `User.id`、chat 与 messages，UI 不因身份变更而清空。
- 已有账号登录调用 `POST /backend-api/auth/user/login`；会关闭已有 streams、清除旧 conversation UI 与未发送敏感 draft，再加载目标账号数据，不迁移当前匿名聊天。
- 改密调用 `POST /backend-api/auth/password/change`，保持同一 subject；`POST /backend-api/auth/sessions/revoke-all` 撤销该用户全部 Session。
- logout、revoke-all、identity lost 是真正的 subject transition；多 Tab 在 focus/visibility 时重新 probe，mutation 不自动 replay。

前端不实现 email、OAuth、2FA、password recovery 或 account deletion。Session 由 Backend 以随机 opaque token 管理，数据库只保存 token 的 SHA-256 hash；前端不读取 Cookie。

## 启动开发环境

```bash
yarn dev
```

默认前端端口为 **3000**(Next.js 默认,项目未另行指定),打开 http://localhost:3000 即可使用。

## 生产构建

```bash
yarn build
yarn start
```

`yarn build` 以 `BUILD_MODE=standalone` 执行 Next.js standalone 构建;另有 `yarn export` 生成纯静态导出(该模式无 rewrite,聊天通道不可用,仅用于纯前端预览)。

## 聊天数据来源

Conversation、Message、Request 全部来自 personChat Backend:

- 会话列表:`GET /backend-api/conversations?status=ACTIVE|ARCHIVED`
- 消息历史:`GET /backend-api/conversations/:id/messages`
- 发送消息:`POST /backend-api/conversations/:id/messages`(带 `Idempotency-Key`)
- 停止生成:`POST /backend-api/requests/:id/cancel`
- 事件流:`GET /backend-api/requests/:id/events`(SSE)
- 服务端浏览器状态:不属于聊天主数据,只在 `/admin` 管理控制台按 canonical 路径读取(见「服务端浏览器管理(V1.3-C)」一节)

Frontend **不再将本地 IndexedDB / localStorage 中的聊天记录视为权威数据**。数据库恢复、刷新恢复都以后端为准。

## 本地存储策略

| 内容 | 存储位置 | 说明 |
| --- | --- | --- |
| Theme / UI preference(字号、字体、发送键等) | localStorage | `chat-next-web-config` |
| Mask(角色预设) | localStorage | `chat-next-web-mask` |
| Prompt 资源 | localStorage | `chat-next-web-prompt` |
| 未发送输入 | localStorage | `unfinished-input-<会话 id>`(仅草稿文本,切换会话时恢复) |
| 服务端浏览器状态快照 | 内存 | 每次进入页面重新拉取,不落盘 |
| 登录身份 / Session | HttpOnly Cookie + 内存 store | 前端代码不读 Cookie、不落盘,身份真相只来自 `GET /backend-api/auth/session` |
| 聊天数据(旧 `chat-next-web-store`) | 不持久化 | 启动时主动清除 |

- Conversation / Message / Request **不作为聊天主数据持久化到本地**。
- 旧版本曾把聊天数据写入本地 `chat-next-web-store`(IndexedDB / localStorage),现在 `bootstrap()` 首屏会主动清除,本地残留不会覆盖 Backend 数据。
- 会话拖动排序仅为本次浏览的临时顺序,Backend 没有排序字段。

## 首次发送行为

用户新建会话时只是一个本地草稿(`draft-*`),**不创建 Backend Conversation**:

```text
用户新建草稿
↓
此时不创建 Backend Conversation
↓
用户第一次发送
↓
POST /backend-api/conversations(创建 Backend Conversation,标题取首条消息)
↓
POST /backend-api/conversations/:id/messages(得到 Request)
↓
订阅 SSE,开始跟随流式回答
```

## 模型选择(V1.1)

聊天头部的模型选择器由 personChat Backend 驱动,**不属于 NextChat 原生 Provider/模型体系**(后者保持禁用):

- **目录来源**:`GET /backend-api/provider/models`(后端从 Gemini Web 页面实时读取),前端零硬编码模型;目录加载失败时弹层提供重试项,不阻塞聊天主流程。
- **会话偏好**:已落库会话经 `PATCH /backend-api/conversations/:id`(body `preferredModelKey`)保存,乐观更新、失败回滚并提示;「默认模型」= `preferredModelKey=null`,**不是一个伪造的模型 id**。
- **Draft 语义**:草稿(`draft-*`)里选模型只改内存,**0 后端请求**;首次发送创建 Backend Conversation 时,若草稿带偏好,POST body 显式携带 `modelKey`,后端同事务写入会话偏好与 Request 快照;草稿无偏好则只发 `{content}`。
- **已落库会话**:普通发送 body 只含 `{content}`,**永不携带 `modelKey`**;后端按会话偏好冻结该次 Request 的 `requestedModelKey`。生成中(PENDING / PROCESSING / CANCELLING)选择器禁用。
- **stale key 安全**:历史偏好键不在当前目录时,按钮显示「当前模型不可用」,**不自动清除偏好**;此时发送会被后端判 `PROVIDER_MODEL_UNAVAILABLE`(内部码,Request 终态 FAILED),Public 信封只回 `CHAT_FAILED`,气泡显示通用错误文案,偏好保持不变。
- **偏好持久化唯一来源是后端**:localStorage 不存任何模型偏好;页面刷新后偏好与会话历史均从 Backend 恢复。

## 管理控制台与服务端浏览器(V1.3-C)

`/admin`(App Router 真实路由,**不是** HashRouter 里的 `#/…`)是唯一的管理界面;未登录 ADMIN 时跳 `/admin/login` 只输密码。聊天侧栏与设置页不再有运维面板。

- **身份真相**:只来自 `GET /backend-api/auth/session`(HttpOnly Cookie 由浏览器自动携带,前端代码从不读 Cookie);管理员密码不写 localStorage / sessionStorage,不进 URL,不打日志。
- **canonical 路径**:浏览器状态走 `GET /backend-api/admin/browser/status`,重启走 `POST /backend-api/admin/browser/restart`;Provider 状态 / 打开 / 重启走 `GET /backend-api/admin/provider/status`、`POST /backend-api/admin/provider/open`、`POST /backend-api/admin/provider/restart`(旧 `/backend-api/browser/*`、`/backend-api/provider/status` 等已随后端 alias 退役)。
- **面板内容**:当前身份与登录状态有效期、浏览器 `state` / 启动时间 / 已运行时长 / 类型 / profileDir / Gemini 登录态 / 进行中的回答 / 最近错误 / 状态更新时间。
- **Provider 面板**:`state` 取 `STOPPED` / `STARTING` / `LOGIN_REQUIRED` / `READY` / `BUSY` / `ERROR`;只在进入页面时拉一次,靠「刷新」手动更新(不参与上面的 15s 轮询);「打开 Provider」只把后端浏览器页面切到前台,不确认、不写数据;「重启 Provider」先确认再执行,后端以原始错误码拒绝时(如 `503 PROVIDER_NOT_READY`)原样展示,不跳转、不降级成通用文案。
- **轮询**:挂载时立即拉一次,之后每 15s 一次;页面隐藏时跳过本轮但不停表,切回前台即恢复新鲜度。
- **逐字段降级**:除 `state` 外全部可选,后端缺哪个字段该行就显示 `—`;首帧之前显示「未知」。
- **错误区分**:网络错误按 HTTP 状态分流,`404` 视为「后端尚未提供 canonical Admin API,请升级 personChat Backend」,与「连不上后端服务」分开;拉取失败时保留上一次快照不清空。
- **危险操作一律先确认**:重启(提示会中断正在进行的回答)、吊销全部登录状态(`POST /backend-api/admin/sessions/revoke-all`,提示不可撤销,成功后当前 Cookie 失效并回登录页)、退出管理员登录(只注销当前设备)。
- **不落本地**:浏览器状态与登录态只存在于内存 store,localStorage 不写任何浏览器状态或会话数据。
- **后端规格**:`docs/browser-status-api.md`(字段语义、状态机、`BROWSER_*` 内部错误码、并发约束与验收清单)。

## 图片附件(V1.2)

- 支持从输入区选择 PNG / JPEG / WebP / GIF。
- 最多 4 张;最终单图 ≤ 5MiB、总计 ≤ 10MiB。
- 支持纯图片消息。
- 支持通过输入框粘贴图片(Chromium 已验证;Safari 尚未正式验收)。
- hard reload 后历史图片显示占位信息;原图字节不持久化,不会恢复历史原图。

## SSE 流式

前端通过 `GET /backend-api/requests/:id/events`(经 rewrite 到后端 `/api/requests/:id/events`)用 `EventSource` 订阅一条 Request 的回答流。

前端处理的事件:

| 事件 | 作用 |
| --- | --- |
| `snapshot` | 用当前完整内容重新同步(重连首帧必是整段快照,后端不重放历史 delta) |
| `delta` | 追加内容增量 |
| `status` | 更新 Request / Message 状态 |
| `error` | 显示错误信息并进入终态 |

- 连接断开时按 1s / 2s / 4s / 8s / 15s 退避自动重连;Request 到达终态后连接会正常关闭。
- 内容拼接以「本连接已发送前缀」为基准:delta 是该前缀的增量,snapshot 用完整内容覆盖(且不会回退已渲染的更长文本)。
- 到达终态时若本地气泡仍为空,会回读一次消息历史,避免把空气泡留给用户。

Request 状态机:`PENDING → PROCESSING →(CANCELLING)→ SUCCESS / FAILED / TIMEOUT / CANCELLED`。

## 刷新恢复

```text
浏览器刷新
↓
从 Backend 重新获取会话列表与消息历史
```

如果刷新时有正在生成的回答:

```text
打开该会话,读取消息中的 active Request
↓
重新建立 SSE 连接
↓
首帧 snapshot 对齐已生成内容
↓
继续 streaming
```

刷新不会重发 Prompt。

## Cancel

```text
生成中,发送按钮变为停止按钮
↓
点击停止 → POST /backend-api/requests/:id/cancel
↓
Request 进入 CANCELLING
↓
等待终态
```

- **CANCELLING 期间停止按钮不可重复触发**(disabled)。
- 最终状态为 `CANCELLED`,已生成的部分内容保留显示,不算错误。
- 若后端返回 `REQUEST_NOT_CANCELLABLE`,前端会刷新会话消息以对齐后端状态。

## Conversation 操作

会话列表支持:

- **创建**:新建草稿,首次发送时落库
- **重命名**:已落库会话 `PATCH title`
- **Archive**:归档会话(`PATCH status=ARCHIVED`),从「进行中」列表移除
- **Restore**:在归档列表恢复(`PATCH status=ACTIVE`)
- **Delete**:后端软删除,**删除后不提供旧 NextChat 的 5 秒本地撤销**(后端删除不可恢复)

列表可在「进行中(ACTIVE)」和「归档(ARCHIVED)」之间切换。

## 错误显示

前端只消费后端 **Public 信封**的错误码(V1.3-C 契约):内部实现码(`PROVIDER_*`、`BROWSER_*`、`DATABASE_ERROR`、`INTERNAL_ERROR` …)在 HTTP 响应体、SSE 帧与 DTO 里都已折成通用码,前端码表因此**不含任何内部码**——出现 `PROVIDER_*` 就说明 Public 契约漏了细节。

映射唯一来源:`app/store/chat.ts` 的 `ERROR_TEXT` + `errorTextForCode()` / `backendErrorMessage()`。**未列出的码一律回落到 `请求失败,请重试。`,绝不把后端原始 code 或 message 渲染给用户。**

| 错误码 | 用户文案 |
| --- | --- |
| `CHAT_FAILED` | 请求失败,请重试。(也是未知码的兜底) |
| `SERVICE_BUSY` | 服务暂时繁忙,请稍后重试。 |
| `REQUEST_TIMEOUT` | 请求超时,请重试。 |
| `CONVERSATION_NOT_FOUND` | 会话不存在 |
| `CONVERSATION_DELETED` | 会话已删除 |
| `CONVERSATION_ARCHIVED` | 会话已归档,请先恢复后再发送 |
| `CONVERSATION_REQUEST_IN_PROGRESS` | 这个会话还有回答在进行中,请先等它完成 |
| `REQUEST_NOT_FOUND` | 这个回答已不存在 |
| `REQUEST_NOT_CANCELLABLE` | 这个回答已经结束,无需停止 |
| `IDEMPOTENCY_KEY_REUSED` | 这条消息已提交过,请重新发送 |
| `VALIDATION_ERROR` | 请求内容不符合要求,请检查后重试 |
| `PAYLOAD_TOO_LARGE` | 图片请求数据过大,请减少图片或缩小后重试 |
| `ATTACHMENT_TOO_LARGE` | 图片过大、数量过多或总大小超限 |
| `UNSUPPORTED_ATTACHMENT_TYPE` | 仅支持 PNG/JPEG/WebP/GIF |
| `AUTH_REQUIRED` | 登录状态已更新,请重试 |
| `AUTH_FORBIDDEN` | 没有权限执行该操作 |
| `AUTH_CSRF_REJECTED` | 请求已失效,请刷新页面后重试 |
| `NETWORK_ERROR` | 网络异常,请稍后重试(前端本地生成,表示连不上后端) |

- `CANCELLED` 不是错误码:用户主动停止时正常展示已生成内容。
- 「模型不可用」「服务端浏览器未运行」等运维细节改由 `/admin` 管理控制台呈现,聊天界面只给上面的通用文案。

## 旧接口与旧能力

V1 不再使用 NextChat 原 Provider API。以下路由已统一返回 **404**:

- `/api/openai/*`、`/api/anthropic/*`、`/api/google/*` 等全部旧 Provider 代理(经 `app/api/[provider]/[...path]` 统一关闭)
- `/api/webdav/*`(WebDAV 同步代理)
- `/api/upstash/*`(Upstash 同步代理)
- `/api/tencent`(腾讯混元代理)
- `/api/artifacts`(Cloudflare KV 分享代理)

保留的 `/api/config` **只返回非敏感 UI 配置**(`needCode` / `hideBalanceQuery` / `disableFastLink`,用于访问控制准入判断),不含任何 API Key 或 Provider 凭据,不是 Provider 配置接口。

## 开发与测试

```bash
# 单元测试(CI 模式,V1.2 冻结验收:43 个测试套件 / 440 个测试 PASS)
yarn test:ci

# TypeScript 类型检查
npx tsc --noEmit

# 生产构建验证
yarn build

# ESLint
yarn lint
```

**Windows 注意**:`yarn test:ci` / `yarn test` 脚本内的 `$(yarn bin jest)` 是 bash 语法,在 Windows 的 yarn(cmd 执行)下会失败。Windows 下请直接运行:

```bash
node --no-warnings --experimental-vm-modules ./node_modules/jest/bin/jest.js --ci
```

Lint 说明:`.eslintrc.json` 中为兼容当前工具链关闭了 `unused-imports/no-unused-imports` 一条规则,`yarn lint` 目前可正常运行(仅存在少量 warning,无 error)。

## V1 验收状态

```text
V1 Final Acceptance:
PASS WITH KNOWN LIMITATIONS
```

冻结版本:

```text
Frontend:
f1c5c8af56615152513ab3d41081cd48ed434301

Backend:
4dfb074a48f236b2b3fa20dc7fe88d4e562ff073
```

前端验收覆盖:Conversation 列表、Draft、首次发送、SSE streaming、Refresh history、Processing refresh、Delete、Archive、Restore、Cancel、Failed 展示、Cancelled 展示、本地存储清理,以及 Real Gemini E2E。

## 已知限制

- **Backend 依赖**:没有 personChat Backend,前端无法聊天。
- **共享 Provider 账号**:V1.4 已有 REGISTERED 用户与 User.id ownership/quota 隔离,但所有用户共享 Backend、Browser Profile 与 Google/Gemini 登录态;Browser Pool 与多 Gemini Account 不在本版本。
- **发布闸门**:**READY FOR PRODUCTION RELEASE REVIEW, NOT DEPLOYED** —— 发布前仍需 backup、真实 DB 指纹复核、`prisma migrate deploy`、production env/Nginx 核验、计划中的真实 Gemini smoke 与 post-deploy auth/browser smoke。
- **Gemini 人工登录**:Gemini 登录态由 Backend Browser Profile 提供,前端无法处理登录。
- **Gemini DOM 依赖**:Gemini Web 页面改版会影响 Backend 自动化。
- **单实例**:Backend 当前为单实例架构。
- **RATE_LIMITED**:该错误码当前无可靠的真实检测。

## 安全说明

Frontend **不**保存:

- Google Cookie
- Gemini Token
- Backend 敏感凭证
- 管理员密码(不写 localStorage / sessionStorage,不进 URL query,不进 console.log)
- Session Cookie 内容(HttpOnly,由浏览器自动携带;前端不读 Cookie 判身份)
- 聊天主数据副本

本地只剩**可丢弃**数据:UI 配置、面具 / Prompt 资源、未发送草稿。清掉它们不影响任何权威数据,身份与聊天历史一律回服务端重取。

不应重新开启:

- API Key 输入
- WebDAV
- ShareGPT
- 旧 Provider proxy

## 相关仓库

Backend:

```text
https://github.com/hukaiedu/NextChatBack
```

## Credits

Frontend based on [NextChat](https://github.com/ChatGPTNextWeb/ChatGPT-Next-Web).
