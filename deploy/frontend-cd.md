# main 稳定发布：GitHub Actions → Node/systemd

适用目标：Ubuntu 22.04、x86_64。构建在 GitHub 的 Ubuntu 22.04 runner 完成；服务器不安装依赖、不构建前端。发布包携带同次 CI 使用的 Node 24，不改服务器 `/usr/bin/node`（现有 Node 22 可以继续服务后端）。

## 生产拓扑

```text
Browser → Nginx (TLS)
  /backend-api/* → http://127.0.0.1:3010/api/   (Backend 直连)
  其他路径       → http://127.0.0.1:3000        (Next.js)
```

沿用后端 canonical Nginx 直连方案。Nginx 在 `/backend-api/` 覆盖写入 `X-Real-IP`/`X-Forwarded-For`、关闭响应缓冲并设置 SSE 读超时；配套示例见 `deploy/nginx/personchat.conf.example`。Next 运行时路由与 `BACKEND_ORIGIN` 不参与公网 API 路径，只用于本地/直连前端端口和部署 loopback 健康检查。

## 触发与门禁

1. 功能先合入 `dev`，完成验证后再通过 PR 合入 `main`。
2. `main` 的 **push** 触发 `Frontend checks`：部署工具回归 → Jest → typecheck → production build。
3. 全部成功才打包并进入 `Deploy stable main to Linux`。PR 检查、`dev` 和 `master` 的 push 都不会部署。
4. 产物包含 standalone、`.next/static`、`public`、Node 24、SHA 清单和版本标识；不包含 `.env*` 或本机 MCP 配置。
5. production 部署串行运行，不中断进行中的部署；排队期间已被更新 main 取代的提交跳过。
6. 服务器校验 SHA256、架构、版本与归档路径后，原子切换 `current`，重启 systemd。本地 loopback 检查首页 2xx、`/personchat-release.json` 的 SHA 与 Next 运行时代理的 `/backend-api/auth/session` 匿名会话响应必须同时正确（不传 Cookie、不创建身份）。**该 loopback 检查不等同于公网 Nginx/TLS 路径**，公网 `/backend-api/` 由 Nginx 直连后端，必须按“首次部署与检查”单独验收。
7. 健康检查失败恢复原 symlink 并重启旧版本，工作流仍失败。首次部署无旧版本时停止失败服务并移除 current，保留产物供排查；unit 的处理见“失败、回滚与保留”。该流程有短暂重启窗口，不承诺零停机。

在 GitHub 为 `main` 启用分支保护：要求通过 PR 合并并通过 `Frontend checks / test`，限制直接 push。工作流根据 main 的 push 事件发布，分支保护用于保证它来自审核过的合并。

部署作业使用 GitHub Environment `production`；如设置 required reviewers，则 main CI 后还要等待该环境的批准，不设置则自动部署。先完成以下服务器与 GitHub 配置，再把这套工作流合入 main。

## 服务器首次准备（只执行一次）

以下是操作员在服务器执行的初始化步骤，本项目脚本不会自动安装 systemd unit、改变 sudoers 或升级现有 Node。

```bash
sudo apt-get update
sudo apt-get install -y python3 curl tar util-linux openssh-server ca-certificates

id personchat-front >/dev/null 2>&1 || sudo useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin personchat-front
id personchat-deploy >/dev/null 2>&1 || sudo useradd --create-home --shell /bin/bash personchat-deploy
sudo install -d -m 0755 -o personchat-deploy -g personchat-front /opt/personchat-front /opt/personchat-front/releases /opt/personchat-front/incoming
sudo install -d -m 0700 -o personchat-deploy -g personchat-deploy /home/personchat-deploy/.ssh
```

将部署专用 SSH **公钥**追加到 `/home/personchat-deploy/.ssh/authorized_keys`，不要覆盖已有公钥；文件所有者为 personchat-deploy，权限 0600。为此流程使用无口令的专用部署密钥（工作流采用 BatchMode，不提供交互解密）；私钥只填入下方 GitHub Secret，不提交仓库、不发到聊天。

从审核后的仓库取得模板，复制到服务器后安装：

```bash
sudo install -m 0644 deploy/systemd/personchat-front.service.example /etc/systemd/system/personchat-front.service
sudo install -m 0640 -o root -g personchat-front deploy/frontend.env.example /etc/personchat-front.env
sudoedit /etc/personchat-front.env
```

`BACKEND_ORIGIN` 只被 Next 运行时路由读取（本地/直连前端端口和 loopback 健康检查）；生产公网 `/backend-api/` 由 Nginx 直连 3010，不读取该变量。后端在同机时可用 `http://127.0.0.1:3010`；该文件不放 Gemini Cookie。修改 systemd 环境文件后重启前端即可，无需重新构建。

后端前置条件（personChat Backend 部署配置，不在本仓库设置）：

- 监听 `127.0.0.1:3010`（或同步修改 Nginx/unit）；
- `AUTH_ENABLED=true`；
- `AUTH_ALLOWED_ORIGINS=https://<公网前端 Origin>`（production 必须 HTTPS）；
- `AUTH_TRUST_PROXY=true`，Nginx 在 loopback 连接上覆盖写入 `X-Real-IP`/`X-Forwarded-For`；
- 包含 Python Worker provider 契约（`READY`/`BUSY`/`LOGIN_REQUIRED`、`/admin/provider/check|restart`）。

安装 Nginx 示例并调整 `server_name`、证书路径和 3010 端口：

```bash
sudo install -m 0644 deploy/nginx/personchat.conf.example /etc/nginx/sites-available/personchat.conf
sudo ln -sfn /etc/nginx/sites-available/personchat.conf /etc/nginx/sites-enabled/personchat.conf
sudoedit /etc/nginx/sites-available/personchat.conf
sudo nginx -t
sudo systemctl reload nginx
```

示例的 `/backend-api/` 直连后端，覆盖客户端 IP 头，关闭缓冲并设置 660s 读超时；`location /` 到 Next 3000；`client_max_body_size` 为 16m（后端附件上限 14m）。

`sudo visudo -f /etc/sudoers.d/personchat-front-deploy` 写入：

```sudoers
personchat-deploy ALL=(root) NOPASSWD: /usr/bin/systemctl restart personchat-front, /usr/bin/systemctl stop personchat-front
```

```bash
sudo chmod 0440 /etc/sudoers.d/personchat-front-deploy
sudo visudo -cf /etc/sudoers.d/personchat-front-deploy
sudo systemd-analyze verify /etc/systemd/system/personchat-front.service
sudo systemctl daemon-reload
```

首次发布前 `current` 尚不存在，**不要 enable 或 start**。首次 CD 部署的 `systemctl restart` 会启动服务。首次部署成功后，再由操作员执行一次 `sudo systemctl enable personchat-front`，保证重启后自动启动。若已按旧步骤 enable，而首次部署失败（脚本会 stop 并移除 `current`），请先执行 `sudo systemctl disable personchat-front`，避免重启时反复启动一个没有 `current` 的 unit；修复后重跑 CD，成功后再 enable。

模板默认目录 `/opt/personchat-front`、服务名 `personchat-front`、loopback 端口 3000。若修改，须同步 unit、sudoers、环境文件以及下方 Actions Variables。发布文件只读，Next 缓存写到 systemd 管理的 `/var/cache/personchat-front`。模板未启用 MCP；如另有 MCP 配置管理需求，需单独设计持久状态目录，不写入只读发布目录。

## GitHub production 环境配置

仓库 Settings → Environments → 新建 `production`，Deployment branches 限制为 `main`。

Variables：

| 名称                   | 值                                       |
| ---------------------- | ---------------------------------------- |
| `FRONTEND_DEPLOY_HOST` | 服务器公网 IP 或可解析的 SSH 主机名      |
| `FRONTEND_DEPLOY_USER` | `personchat-deploy`                      |
| `FRONTEND_SSH_PORT`    | 默认 `22`，按实际 SSH 端口填写           |
| `FRONTEND_DEPLOY_ROOT` | 默认 `/opt/personchat-front`             |
| `FRONTEND_PORT`        | 默认 `3000`，与 unit 相同                |
| `FRONTEND_SERVICE`     | 默认 `personchat-front`，与 sudoers 相同 |

Secrets：

| 名称                   | 值                                                                 |
| ---------------------- | ------------------------------------------------------------------ |
| `FRONTEND_SSH_KEY`     | 部署账号使用的专用 SSH 私钥（完整多行内容）                        |
| `FRONTEND_KNOWN_HOSTS` | 经核验的主机公钥 known_hosts 行，非默认端口使用 `[HOST]:PORT` 格式 |

主机公钥核验：在阿里云可信控制台查看 `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`；在本地用 `ssh-keyscan -t ed25519 -p 22 HOST > known_hosts` 获取，再用 `ssh-keygen -lf known_hosts` 对比指纹。相同后才把 known_hosts 内容填进 Secret。工作流不会自动信任扫描结果，不关闭 StrictHostKeyChecking。

确保 GitHub hosted runner 可以通过 SSH 到达实例；阿里云安全组、服务器防火墙与 SSH 登录策略需要允许该部署账号连接。应用 3000 默认只监听 loopback，公网通过已有 Nginx/TLS 访问，不需要开放 3000。

## 首次部署与检查

配置完成后合并稳定发布 PR 到 main，在 Actions 查看 `Frontend checks`。不需在服务器执行 git pull 或 yarn build。

```bash
sudo systemctl status personchat-front --no-pager
readlink /opt/personchat-front/current
curl -fsS http://127.0.0.1:3000/personchat-release.json
curl -fsS http://127.0.0.1:3000/ >/dev/null
curl -fsS --compressed http://127.0.0.1:3000/backend-api/auth/session
sudo journalctl -u personchat-front -n 80 --no-pager
```

以上 loopback 检查验证前端进程、release marker、Next 运行时代理和后端可达性，**不验证公网 Nginx 直连路径**。首次部署成功后执行：

```bash
sudo systemctl enable personchat-front
```

再从用户域名做真实验收：

```bash
curl -fsS https://chat.example.com/ >/dev/null
curl -fsS https://chat.example.com/backend-api/auth/session
```

并实际验证登录/注册、发送消息、SSE 流式、取消、14MB 附件和管理页 Provider 状态/重启。工作流与 loopback 检查不代替 Nginx/TLS、公网 Origin、登录、SSE 或真实 Gemini 验收。

## 失败、回滚与保留

- 任一 CI 检查失败：不会上传正式发布包，也不会连接服务器部署。
- checksum、平台或清单校验失败：不切换 current，不重启服务。
- 新版健康失败：自动回到旧版本；若回滚本身失败会明确输出 `ROLLBACK FAILED`，需人工处理。
- 应用在健康检查之后才出现的业务问题：可通过 GitHub revert main 的发布变更、经 CI 重新发布；不 force push。
- 紧急情况下由操作员把 current 指回已知正常的 releases 目录，重启并核对该目录 release.json 的 SHA 与 HTTP 版本标识。不要只看 systemctl active。
- releases 与 incoming 目录不会自动删除，以保留回滚和排查证据。定期按磁盘空间清理已不使用的旧目录，至少保留 current 和上一正常版本，不删除正在使用的目录。
- GitHub artifact 保留 7 天；生产环境文件和 SSH 私钥不进入 artifact。required reviewers 不应让部署排队超过 7 天，否则下载 artifact 会失败。
- **失败重跑**：使用 GitHub Actions 的 **Re-run all jobs**，让 test/package/upload 重新执行；upload-artifact 已设置 `overwrite: true`。不要只重跑 deploy job：test job 被跳过时不会产生新 attempt 的 artifact，上一 attempt 的 artifact 不可访问。
- **首次部署失败**：脚本停止服务并移除 `current`。若 unit 曾手工 enable，执行 `sudo systemctl disable personchat-front`，检查 journal 后修复，再重跑 CD；成功后再 enable。
- **提交状态**：新版通过健康检查后脚本设置 committed 状态；随后 SSH 断开、最终输出失败或信号中断都不会回滚已验收版本。工作流可能仍显示失败，请用 release marker 和 systemd 状态核对，不要仅凭 workflow 颜色判断线上版本。

## 本地检查

```bash
node --test scripts/cd/release.test.mjs
bash -n scripts/cd/deploy.sh scripts/cd/push-release.sh
yarn test:ci --runInBand test/backend-proxy.test.ts test/backend-proxy-real-http.test.ts test/v13c-admin.test.tsx
```

CD 回归使用临时目录与模拟 systemctl/curl，验证真实脚本的解包、切换、回滚、权限和控制流；`backend-proxy-real-http` 使用真实本地 HTTP 上游验证 gzip 与 SSE，不依赖 mock fetch。完整的 Ubuntu 22.04 + Node 24 原生发布、不同低权限服务账号读取、SSH、systemd 与公网访问仍须在 CI 和目标环境验收；没有 Linux 环境时这些项必须标为 NOT RUN，不能用 macOS 测试代替。

## 官方参考

- [GitHub Actions 作业依赖与条件](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idneeds)
- [Next.js standalone 产物与静态资源](https://nextjs.org/docs/app/api-reference/config/next-config-js/output)
