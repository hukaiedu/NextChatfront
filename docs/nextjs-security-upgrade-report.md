# personChat Frontend — Next.js 安全升级报告

日期：2026-09-15

## 状态

PARTIAL

## Baseline

- 前端项目根目录 `AGENTS.md`：不可用并继续；按用户提供的项目规则执行。
- `.qoder/skills/karpathy-guidelines/SKILL.md`：不可用；已加载环境中的 `karpathy-guidelines`。
- daylog：不可用并继续。
- 基线分支：`main`，HEAD `6648f5ae`，与 `origin/main` 一致。
- 本轮分支：`security/upgrade-nextjs`。
- 本轮开始时已有 5 个未跟踪 docs 报告文件；均未修改、未暂存、未纳入本轮变更。

## 完成内容

- Next.js 从 `^14.1.1` 升级到 `^15.5.25`。
- `@next/third-parties` 从 `^14.1.0` 升级到 `^15.5.25`。
- React 依赖升级到 React 19 兼容线：`react`/`react-dom` 规格为 `^19.2.0`，锁定解析版本为 `19.3.0`。
- `@types/react`、`@types/react-dom` 升级到 19.x；锁定解析版本为 `19.3.0`。
- `eslint-config-next` 从 `13.4.19` 升级到 `15.5.25`，ESLint 从 `^8.49.0` 升级到 `^8.57.1`。
- `yarn.lock` 已同步更新。
- 修复 Next 15/React 19 类型兼容问题：`NextRequest.ip` 改用既有请求头回退逻辑；显式初始化 React refs；更新 nullable `RefObject` 类型；将两个内部组件函数改为符合 hooks lint 规则的组件名。未改变认证流程、API 行为或业务逻辑。

## 修改位置

- `package.json`
- `yarn.lock`
- `app/api/auth.ts`
- `app/components/chat.tsx`
- `app/components/markdown.tsx`
- `app/components/ui-lib.tsx`
- `app/components/voice-print/voice-print.tsx`
- 本报告：`docs/nextjs-security-upgrade-report.md`

## 依赖变化说明

Next.js 官方 2026-08-25 安全公告给出的维护线修复版本为 15.5.24；当前 npm backport 版本为 15.5.25，本轮采用 15.5.25。该版本用于修复 Next.js 14.1.1 所在线路无法覆盖的当前 Critical 风险。

## 验证

| 命令 | 真实结果 |
|---|---|
| `yarn test:ci ...` | exit 1：Windows shell 不支持脚本中的 POSIX `$(yarn bin jest)`，不是断言失败 |
| `node --no-warnings --experimental-vm-modules node_modules/jest/bin/jest.js --ci --runInBand` targeted 集 | exit 0：5 suites，52 tests 通过 |
| 核心 targeted 集连续 3 次 | exit 0：每次 4 suites，51 tests 通过，无 flaky |
| 全量 Jest（中途首次重跑） | exit 1：1 个 `chat-message-pagination` 时序断言失败，52 suites/554 tests 通过 |
| 失败用例定向连续 3 次 | exit 0：每次 1 test 通过 |
| 最终全量 Jest | exit 0：53 suites，555 tests 通过 |
| `node node_modules/typescript/bin/tsc --noEmit` | exit 0 |
| `node node_modules/next/dist/bin/next lint` | exit 0；仅既有 hooks、`img` 和 Sass 警告，无 lint error |
| `yarn lint` | exit 1：Windows 环境找不到 `.bin/next`；等价 Next lint 已通过 |
| `yarn build` | exit 1：mask 成功后 Windows 环境找不到 `cross-env` |
| `yarn mask && BUILD_MODE=standalone next build` 等价命令 | exit 0：Next 15.5.25 production build 成功，10 个页面/API 路由生成 |
| `yarn audit --level critical` | 输出 3 个与 Next 无关的 Critical：`axios > form-data`、`jsdom > form-data`、`concurrently > shell-quote` |

## 安全与资源

- standalone 配置核验：`images.unoptimized=false`；未重新打开已知图片优化风险。
- export 配置核验：`images.unoptimized=true`，保持原有静态导出行为。
- production route 表未出现 API 路径新增、删除或改名；仅 `app/api/auth.ts` 做类型兼容改动。
- 登录、Session、身份切换、Backend API 回归测试均通过。
- diff 敏感模式扫描未发现 API key、Bearer token 或密码泄漏。
- Browser E2E：NOT RUN。Browser bridge 在初次调用、一次重试和重置后重试均返回 `nodeRepl.fetch request failed`，未伪造结果。
- 真实 DB：unchanged。
- Browser Profile：unchanged。

## Git 状态

- 当前分支：`security/upgrade-nextjs`
- staged：0
- commit：未执行
- push/tag：未执行
- 本轮修改仅为上述升级相关文件；原有 5 个 docs 文件仍显示为未跟踪，未被修改或纳入本轮变更。

## 偏差与风险

- `AGENTS.md` 与 daylog 均不可用，已如实记录。
- Windows 下现有 `test:ci`、`lint`、`build` 包装脚本存在 shell/.bin 兼容问题；等价底层命令已真实通过。
- 全量审计仍有 3 个与 Next.js 无关的 Critical 传递依赖问题，本轮未扩大范围处理。
- Browser E2E 受工具桥接故障阻塞。

## Verdict

PARTIAL：Next.js 安全升级及代码验证通过；Browser E2E 尚未执行，且存在本轮范围外的依赖审计遗留问题。

## Next

修复或提供可用的 Browser bridge 后，补跑登录页、主页面和 API 代理的 Browser E2E；另行安排 `form-data`/`shell-quote` 传递依赖治理。
