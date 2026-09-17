# Next.js 升级 Browser E2E 验证报告

## 状态

PASS

## Baseline

- 分支：`security/upgrade-nextjs`
- HEAD：`6648f5aef83709e98d6af44629f4e3f9f96e7f60`
- `front/AGENTS.md`：不可用并继续；`daylog`：不可用并继续，未伪造。
- karpathy-guidelines：已加载并遵守；computer-use：已加载并遵守。
- 本轮未修改业务代码、依赖或仓库配置；未 commit、未 push。
- 既有 5 个未跟踪 docs 报告文件保持原样、未加入本轮修改。

## 完成内容

- 恢复本地 Browser E2E 运行链路。
- 使用临时 SQLite 数据库和临时 Browser Profile；真实 `back/data/database/app.db` 与真实 Browser Profile 未使用、未修改。
- 使用临时构建目录 `.next-e2e` 验证生产构建并在验证结束后删除；未留下无关构建目录。

## 根因与修复

1. 浏览器环境检查时，`cua.getState()` 和 tab inventory 路径返回 `nodeRepl.fetch request failed`；`listBrowsers()` 与直接创建 In-app Browser tab 仍可用。修复为使用可用的直接 tab 创建/绑定路径，不修改项目代码。
2. 旧 standalone 运行产物缺少客户端 chunk，浏览器记录 `ChunkLoadError`。修复为在独立 `.next-e2e` 目录重新生成 production build，并以临时端口启动验证。
3. Prisma 临时迁移目标若尚未创建为空 SQLite 文件会只返回笼统 `Schema engine error`。先创建精确的临时 SQLite 文件后，`prisma migrate deploy` 成功应用 7 个 migration。
4. 后端 Gemini 预热访问外网被本机网络策略拒绝（`ERR_NETWORK_ACCESS_DENIED`）；该外部 Provider 不属于本轮认证/会话 E2E，未绕过、未修改配置。

## 修改位置

- 本轮 production code：无。
- 本轮测试工具/本地运行环境：无持久化配置修改；仅使用临时环境变量、临时数据库、临时 profile 和临时构建目录。

## 验证

启动与准备命令及真实结果：

- `yarn prisma generate --schema prisma/schema.prisma`：exit 0。
- `yarn prisma migrate deploy --schema prisma/schema.prisma`（临时 SQLite）：exit 0，7/7 migrations applied。
- `yarn mask`：exit 0。
- `node node_modules/next/dist/bin/next build`（`NEXT_DIST_DIR=.next-e2e`、`BUILD_MODE=standalone`）：exit 0；production build 完成。
- `node dist/main.js`（临时 DB/profile，后端 `127.0.0.1:3010`）：启动成功；Gemini 预热因网络策略失败，服务仍监听。
- `node node_modules/next/dist/bin/next start -p 3102`（`NEXT_DIST_DIR=.next-e2e`）：启动成功。

Browser E2E（真实 CUA Browser 操作）：

- 登录页加载：PASS。
- 注册并完成匿名 → REGISTERED 身份切换：PASS；回到 `/`，可见 `当前已登录为 @e2e_user_20260915`。
- Chat 页面加载：PASS；可见新聊天、会话计数、输入框 `chat-input`、发送按钮和模型选择器。
- Session 保持：PASS；正确登录后刷新连续 3/3 次，仍保持同一注册用户名和 Chat 页面。
- 登出并切回匿名身份：PASS；设置页“退出”后回到 Chat，显示 `当前身份：访客`。
- 注册用户登录：PASS；正确凭据从登录页回到 Chat，注册身份可见。
- Backend API 调用：PASS；注册、登录、session probe、匿名 bootstrap 和模型目录请求均由浏览器页面触发并完成/返回可见结果。
- 401 凭据错误：PASS；错误密码真实返回 401，页面留在 `/login` 并显示 `用户名或密码错误`。
- 401 失效 Session：PASS；删除临时 DB 中当前 Session 后，业务请求真实收到 `AUTH_REQUIRED`/401；重新加载页面后前端收敛为 `当前身份：访客`，没有恢复旧注册身份。

附加检查：

- `git diff`：已执行；仅包含升级前已存在的 Next.js 升级文件，无本轮 production code 变化。
- `git diff --staged`：已执行；无 staged 文件。
- `git diff --check` 与 `git diff --staged --check`：无格式错误输出。
- 图片优化配置未被本轮重新打开；`next.config.mjs` 未修改。
- Backend API 路由未被本轮修改；认证、Session、身份切换流程均有浏览器证据。

## 安全与资源

- 真实数据库：unchanged。
- 真实 Browser Profile：unchanged。
- 临时 E2E DB：仅用于本轮验证，Session 清理操作限定在临时路径。
- 未发现本轮新增 secret 泄漏；测试密码未写入仓库报告或源码。

## Git 状态

- staged：0。
- commit：not executed。
- push/tag：no。
- 本轮新增报告文件为未跟踪文件，不纳入 commit；既有 5 个历史 docs 文件仍为未跟踪，未修改、未 staging。

## 偏差与风险

- Browser bridge 的 inventory 仍可能返回 `nodeRepl.fetch request failed`；直接 tab 创建路径可用，E2E 已完成。
- 本机禁止访问 `gemini.google.com`，因此未执行真实 Provider 发送/回复链路；这不是本轮前端认证/Session E2E 的失败，但保留为环境遗留问题。

## Verdict

PASS：本轮指定的登录、Session 保持、身份切换、Chat 页面加载、Backend API 调用和 401 后行为均已真实验证。无业务代码、依赖、配置、commit 或 push 变更。

## Next

等待下一步授权；如需 Provider 端到端消息验证，需要先提供允许访问 Gemini 的本地网络/代理环境。
