# 浏览器状态接口(personChat Backend)

前端已完成浏览器状态展示(设置页面板 + 聊天头部状态胶囊),需要后端补两个接口。
本文档是交给后端 Agent 的实现规格,可直接粘贴。

- 目标仓库:`https://github.com/hukaiedu/NextChatBack`(Express + SQLite + Playwright,默认 `http://127.0.0.1:3010`)
- 前端不新增任何环境变量、不直连后端:请求经 `next.config.mjs` rewrite,`/backend-api/browser/*` → 后端 `/api/browser/*`
- 信封与既有接口一致:成功 `{ "data": ... }`,失败 `{ "error": { "code", "message", "requestId" } }`

## 1. `GET /api/browser/status`

返回服务端 Playwright 浏览器的当前状态快照。**只读、必须永远可用**——即使浏览器已经崩了、启动失败了,也要返回 200 + 一个表达该状态的快照,而不是 500。

```jsonc
// 200 OK
{
  "data": {
    "state": "RUNNING", // 必填,见状态机
    "browserType": "chromium", // 可选,"chromium" | "chrome" | "msedge"
    "headless": true, // 可选,boolean
    "profileDir": "data/browser-profile", // 可选,相对后端工作目录
    "startedAt": "2026-09-06T06:20:00.000Z", // 可选,本次浏览器启动时间(ISO 8601,UTC)
    "uptimeMs": 11520000, // 可选,now - startedAt,毫秒
    "providerLoggedIn": true, // 可选,boolean | null(null = 未探测)
    "activeRequests": 0, // 可选,PENDING/PROCESSING/CANCELLING 的 Request 数
    "lastError": null, // 可选,{ code, message, at }
    "observedAt": "2026-09-06T09:32:00.000Z" // 可选,本快照生成时间(ISO 8601)
  }
}
```

字段约定(前端逐字段降级渲染,缺字段显示 `—`,不会报错):

| 字段               | 必填   | 语义与坑                                                                                                                                                |
| ------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state`            | **是** | 唯一决定彩色圆点的字段。取值必须严格是状态机里的 5 个大写枚举,前端对未知值一律按 `UNKNOWN` 处理                                                        |
| `browserType`      | 否     | 小写原样返回即可,前端只做展示、不做映射                                                                                                                |
| `headless`         | 否     | `true` → 「无头模式」,`false` → 「有头模式」,`null`/缺失 → `—`                                                                                        |
| `profileDir`       | 否     | **不要返回绝对路径**,相对工作目录就够,避免泄露部署机路径                                                                                              |
| `startedAt`        | 否     | 语义是「本次浏览器实例启动时间」,不是后端进程启动时间。重启后必须变化(前端用它验证重启是否真的生效)                                                  |
| `uptimeMs`         | 否     | 后端算好返回,前端不做时区/夏令时计算。`STOPPED` / `FAILED` 时给 `null`,不要给 0(0 会显示成「0s」,语义是刚启动)                                     |
| `providerLoggedIn` | 否     | 三态:`true` 已登录 / `false` 未登录 / `null` 未探测。**探测不能阻塞 status 接口**,见第 3 节                                                           |
| `activeRequests`   | 否     | `SELECT COUNT(*) FROM requests WHERE status IN ('PENDING','PROCESSING','CANCELLING')`。重启保护靠它,前端也用它解释「为什么不能重启」                   |
| `lastError`        | 否     | 最近一次浏览器级故障:`{ code, message, at }`。`code` 用后端自己的错误码字符串,`message` 面向日志(前端原样展示,请控制在 200 字符内、不含堆栈与凭据) |
| `observedAt`       | 否     | 每次都要更新。前端展示「状态更新于」,用于判断看到的是不是新鲜数据                                                                                      |

无鉴权要求(与既有 `/api/*` 一致),无 query 参数,无分页。

## 2. `POST /api/browser/restart`

关闭并重新拉起服务端浏览器,保留持久化 Profile(登录态不丢)。

```jsonc
// 200 OK —— body 与 GET /api/browser/status 的 data 完全同构,是重启完成后的新快照
{ "data": { "state": "RUNNING", "startedAt": "2026-09-06T09:35:12.000Z", "uptimeMs": 120, ... } }
```

- **同步语义**:等到新浏览器实例可用(`RUNNING`)再返回 200,返回体就是新快照。前端会直接把它写进本地状态,不再额外回读。
- 请求无 body。
- 重启期间 `GET /api/browser/status` 应返回 `state: "RESTARTING"`(前端会显示「重启中…」)。

并发与安全约束(**这是本接口最重要的部分**):

1. **有回答在生成时拒绝**:`activeRequests > 0` 时返回 `409 BROWSER_RESTART_CONFLICT`,不做任何破坏性动作。不要「先 kill 再报错」。
2. **自身互斥**:同一时刻只允许一个 restart 在执行。第二个请求返回 `409 BROWSER_RESTART_CONFLICT`(复用同一码即可,前端已合并提示文案)。
3. **超时**:拉起新实例超过 N 秒(建议 N=30)返回 `504 BROWSER_RESTART_TIMEOUT`,并把 `state` 留在真实值(能起来就 `RUNNING`,起不来就 `FAILED`)。前端收到该错误码后会立刻强制回读一次真实状态,所以**接口返回后状态必须已经自洽**,不能停留在 `RESTARTING`。
4. **启动失败**:`Playwright launch` 抛错 → `500 BROWSER_LAUNCH_FAILED`,同时把这次失败写进 `lastError`,并把 `state` 置为 `FAILED`。此后 `GET /status` 要能持续反映 `FAILED`,直到一次成功的 restart。失败发生在关闭旧实例 / Profile 清理等**非启动阶段**时,用 `500 BROWSER_RESTART_FAILED`(前端文案不同,都指向后端日志)。
5. **未运行**:浏览器从未启动且当前不可重启(例如配置里禁用了浏览器)→ `409 BROWSER_NOT_RUNNING`。
6. **绝不破坏数据**:restart 不得取消、改写或删除任何 Request / Message。正在进行中的回答由第 1 条挡住,不需要额外的中断逻辑。
7. **Profile 锁**:`data/browser-profile` 被上一个实例占用时,确保旧实例已彻底 `close()` 再启动新实例,避免 Chromium `ProcessSingleton` 锁冲突。

## 3. `providerLoggedIn` 探测建议

不要为了这个字段去导航页面。用低成本判定即可,任选其一:

- 浏览器启动/重启后读一次持久化 Profile 的登录标记(cookie 名或首页 DOM 探针),缓存在内存里,`GET /status` 只读缓存;
- 或复用心跳里已有的探测结果。

探测不出结果时返回 `null`(前端显示「未知」),**不要让探测异常污染 status 接口的 200**。

## 4. 状态机

```text
启动中          STARTING → RUNNING
正常运行        RUNNING
人工/自动重启    RUNNING → RESTARTING → RUNNING
                                   ↘ FAILED
故障/崩溃       RUNNING → FAILED →(自动恢复)→ RESTARTING → RUNNING
完全退出        RUNNING → STOPPED →(下一次用到时)→ STARTING → RUNNING
```

| state                     | 前端展示        | 圆点 |
| ------------------------- | --------------- | ---- |
| `RUNNING`                 | 运行中          | 绿   |
| `STARTING` / `RESTARTING` | 启动中 / 重启中 | 黄   |
| `STOPPED`                 | 已停止          | 灰   |
| `FAILED`                  | 异常            | 红   |
| 其他(含未知值)          | 未知            | 灰   |

## 5. 错误码(前端已加中文映射,务必用这些字符串)

| code                       | HTTP | 前端提示                                     |
| -------------------------- | ---- | -------------------------------------------- |
| `BROWSER_NOT_RUNNING`      | 409  | 服务端浏览器未运行,请在浏览器状态面板中重启 |
| `BROWSER_LAUNCH_FAILED`    | 500  | 服务端浏览器启动失败,请查看后端日志         |
| `BROWSER_RESTART_CONFLICT` | 409  | 有回答正在生成,请先停止生成再重启浏览器     |
| `BROWSER_RESTART_FAILED`   | 500  | 服务端浏览器重启失败,请查看后端日志         |
| `BROWSER_RESTART_TIMEOUT`  | 504  | 服务端浏览器重启超时,请稍后刷新状态         |

`message` 建议给英文短语(便于日志聚合),前端优先按 `code` 出文案、`code` 不在表内时才回退展示 `message`。
既有的 `PROVIDER_BROWSER_CRASHED` 语义不变,仍用于**单次 Request 的失败原因**;`BROWSER_*` 用于**浏览器生命周期接口自身**的错误。

## 6. 路由注册注意

- 必须注册在 `app.use(express.json())` 与统一错误处理之间,且**不能被 `/api/:provider/*` 之类的通配代理抢先匹配**。
- 未实现前的现状:这两个路径会命中 Express 的 **HTML 404**。前端已把 `NETWORK_ERROR` + HTTP 404 单独识别为「当前后端未提供浏览器状态接口,请升级 personChat Backend」——面板副标题和重启失败提示都用这条文案,不会误报成「连不上后端服务」。实现后该提示自然消失。
- 不要返回 HTML 错误页;错误也要走 `{ "error": { ... } }` 信封并带 `Content-Type: application/json`。

## 7. 后端验收清单

- [ ] `curl -s localhost:3010/api/browser/status | jq .data.state` → `RUNNING`,且 `startedAt` 等于本次浏览器启动时间
- [ ] 正常状态下 `GET /api/browser/status` 稳定返回 200,连续调用 100 次不出现 5xx(前端每 15s 轮询一次,页面隐藏时跳过本轮但不停表)
- [ ] 任一字段人为置 `null` / 删除后,`GET /status` 仍返回 200,前端对应行显示 `—`
- [ ] 浏览器 kill 掉后 `GET /status` 返回 `state: "FAILED"` 且 `lastError` 非空,`uptimeMs` 为 `null`
- [ ] 有一条 PENDING/PROCESSING Request 时 `POST /api/browser/restart` → `409 BROWSER_RESTART_CONFLICT`,且 Request 最终仍能正常完成
- [ ] 两个 restart 并发 → 一个 200、一个 `409`
- [ ] 成功 restart 后 `startedAt` 变化、`uptimeMs` 接近 0,`data/browser-profile` 的登录态仍在(`providerLoggedIn` 仍为 `true`)
- [ ] restart 返回后立刻 `GET /status`,状态不再是 `RESTARTING`
- [ ] 全部响应为 JSON 信封,`error` 含 `requestId`
