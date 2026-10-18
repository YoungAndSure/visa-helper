# Visa Helper 镜像构建与部署

当前应用通过 Docker 镜像运行在腾讯云，服务器无需现场安装 npm 依赖。推荐构建镜像后发布到腾讯云镜像仓库，服务器按摘要拉取并由 Docker Compose 启动；离线导出包保留为备用方式。首次切换使用过 SCP 上传镜像包，记录保留在文末。当前 MCP 仍使用腾讯云 `127.0.0.1:18081/mcp`，开发机 SSH 转发及 Secure MCP Tunnel 保持原连接方式。

## 镜像与数据

镜像包含 Node.js 22、按 lockfile 安装的生产依赖（含 XState）、`src/`、`public/`、完整 `config/` 和发布检查工具。规则配置随镜像发布；更新规则配置后同样需要重新打包镜像。镜像不包含开发机的 `.local/`、Tunnel 密钥、申请数据、测试及决策图开发依赖。

镜像内部 `/app/data` 挂载宿主机 `/home/ubuntu/visa-helper-mcp/data`。申请答案、任务进度和历史执行轨迹留在这个目录，不放入镜像。容器以非 root 用户 `node`（UID 1000）运行，数据目录必须允许该用户读写；当前服务器的 `ubuntu` 也是 UID 1000。容器根文件系统只读，仅数据挂载可写。

Compose 要求显式指定已存在的数据目录，并拒绝自动创建缺失目录，避免路径写错后看起来像申请数据被清空。MCP 端口只绑定宿主机回环地址，通过原有 SSH/Tunnel 访问。独立只读填写对照页可另外启用，默认关闭；当前按用户指定的临时 IP 加端口方式启用，说明见文末。Docker 服务已启用开机启动，容器使用 `unless-stopped` 自动恢复。

## 在开发机构建

需要 Node.js 22、Docker，以及当前用户访问 Docker daemon 的权限。首次准备依赖后，在仓库根目录执行：

```bash
npm ci --prefix app
app/scripts/build-image.sh
```

构建脚本默认生成 Linux amd64 镜像，与当前腾讯云服务器一致。它先解析官方 `node:22-alpine` 的镜像摘要，再按确切摘要构建；通过 `NODE_IMAGE` 可显式指定其他 Node 基础镜像。生产依赖在镜像内通过 `npm ci --omit=dev` 安装，不复制开发机的 `node_modules`。

构建后会在不联网、不挂载申请数据的容器中检查规则、XState、工具数和代码指纹，成功才导出发布包。发布包位于忽略提交的 `app/.local/releases/版本-构建指纹/`：

| 文件 | 用途 |
| --- | --- |
| `image.tar.gz` | 完整 Docker 镜像，可离线导入 |
| `compose.yml` | 容器运行配置 |
| `runtime.env` | 本次本地镜像标签及离线拉取策略 `never` |
| `release.json` | 镜像 ID、基础镜像摘要、应用构建指纹 |
| `SHA256SUMS` | 发布包文件完整性校验 |

构建机需要访问基础镜像仓库和 npm。发布目录、镜像 ID 和校验文件应一起保存。仓库发布不重新构建镜像，也不读取申请数据；上传的是已经验证过的完整镜像。

## 发布到腾讯云镜像仓库

沿用之前的仓库 `ccr.ccs.tencentyun.com/visa-helper/visa-helper`，当前版本标签为 `0.7.0-589a244540ab`。使用仓库控制台提供的登录信息，在实际执行推送的机器上运行 `docker login ccr.ccs.tencentyun.com`。密码只在终端输入，不写进仓库或聊天。默认的 `sudo docker` 使用 root 凭据，普通用户使用自己的配置；可以分别登录，也可以用 `sudo docker --config /home/ubuntu/.docker ...` 明确读取现有用户配置。不要仅凭网页登录成功判断 Docker 已登录。

在已登录的机器上，推送本地已构建镜像：

```bash
app/scripts/publish-image.sh   visa-helper-mcp:0.7.0-589a244540ab   ccr.ccs.tencentyun.com/visa-helper/visa-helper   app/.local/releases/0.7.0-589a244540ab/registry.env
```

该脚本只添加仓库标签并推送，成功后取得仓库摘要。第三个参数可选；提供时生成 `registry.env`，其中 `VISA_HELPER_IMAGE` 固定为 `仓库@sha256:摘要`，拉取策略为 `missing`。推送失败不写入新发布配置，不能将本地打标签当成已经上传成功。

也可以在已持有镜像的服务器上运行同一脚本，无需再从开发机上传一次大文件。镜像上传成功后应核对远端摘要，并在具备拉取权限的服务器验证拉取。仓库凭据由 Docker 管理，不包含在应用镜像或 Compose 文件中。

当前服务器的仓库登录保存在 `ubuntu` 用户的 `/home/ubuntu/.docker`，执行 Docker 管理命令需要 sudo。拉取时使用 `sudo docker --config /home/ubuntu/.docker ...`，直接读取该用户现有配置，不复制凭据。登录到 `ubuntu` 后执行普通 `docker login` 即可更新这个配置；它与 root 的默认配置不同。

服务器使用相同数据配置，用仓库发布配置拉取并启动：

```bash
sudo docker --config /home/ubuntu/.docker compose --project-name visa-helper-mcp   --env-file registry.env   --env-file /home/ubuntu/visa-helper-mcp/deploy/container.env   -f compose.yml pull
sudo docker --config /home/ubuntu/.docker compose --project-name visa-helper-mcp   --env-file registry.env   --env-file /home/ubuntu/visa-helper-mcp/deploy/container.env   -f compose.yml up -d --wait --wait-timeout 60
```

这里的 `compose.yml` 使用当前仓库的部署配置，支持 `VISA_HELPER_PULL_POLICY`；首次离线包中的旧 Compose 固定为 `never`，使用仓库方式前需更新该配置。服务器拉取的是已经构建的镜像，不安装 npm，不同步业务源码。现有服务若已运行相同镜像内容，仅上传仓库无需重启；后续部署可采用仓库摘要。

## 离线上传和启动

以下是当前服务器目录，后续发布替换其中的版本目录即可。

```bash
ssh ubuntu@129.204.29.242 'mkdir -p /home/ubuntu/visa-helper-mcp/releases/0.7.0-589a244540ab'
scp app/.local/releases/0.7.0-589a244540ab/* ubuntu@129.204.29.242:/home/ubuntu/visa-helper-mcp/releases/0.7.0-589a244540ab/
```

服务器的 `deploy/container.env` 保存环境固定配置，不包含 API 密钥：

```dotenv
VISA_HELPER_DATA_DIR=/home/ubuntu/visa-helper-mcp/data
VISA_HELPER_PORT=18081
```

示例在仓库 `app/deploy/container.env.example`。实际目录必须预先存在，且数据文件的属主与容器 UID 一致。已有服务器直接沿用原目录，不初始化或覆盖申请文件。

在服务器导入并启动：

```bash
cd /home/ubuntu/visa-helper-mcp/releases/0.7.0-589a244540ab
sha256sum -c SHA256SUMS
sudo docker load -i image.tar.gz
sudo docker compose --project-name visa-helper-mcp \
  --env-file runtime.env \
  --env-file /home/ubuntu/visa-helper-mcp/deploy/container.env \
  -f compose.yml up -d --wait --wait-timeout 60
```

离线包的 `runtime.env` 显式设置 `VISA_HELPER_PULL_POLICY=never`，确保运行已导入的镜像；仓库配置则使用 `missing`，按需拉取。健康检查访问 `/version`，会实际加载规则与服务元数据。启动失败时保留原发布包和数据，检查容器日志后再处理，不覆盖数据目录。

确认启动成功后，更新 `current` 符号链接指向本次发布目录：

```bash
ln -sfn releases/0.7.0-589a244540ab /home/ubuntu/visa-helper-mcp/current
```

## 查看状态与验证

服务器当前发布可通过固定路径管理：

```bash
cd /home/ubuntu/visa-helper-mcp
sudo docker --config /home/ubuntu/.docker compose --project-name visa-helper-mcp \
  --env-file current/runtime.env --env-file deploy/container.env \
  -f current/compose.yml ps
sudo docker --config /home/ubuntu/.docker compose --project-name visa-helper-mcp \
  --env-file current/runtime.env --env-file deploy/container.env \
  -f current/compose.yml logs --tail 100 server
```

在容器内验证代码、工具、规则、UI 和 HTTP/MCP 指纹：

```bash
sudo docker exec visa-helper-mcp-server-1 \
  node scripts/check-release.mjs http://127.0.0.1:8787/mcp
```

这证明容器内部服务一致。还应在开发机通过原 SSH 转发运行：

```bash
node app/scripts/check-release.mjs http://127.0.0.1:18081/mcp
```

然后检查现有 Tunnel 与 `get_server_info` 响应。代码与接口指纹不变时不需要仅因换成容器就重建 ChatGPT 连接。此处的自动检查不能代替宿主里的自然语言交互和 UI 显示验收。

## 更新与回退

后续发布优先使用“构建镜像 → 推送腾讯云仓库 → 取得摘要 → 服务器拉取 → Compose 更新 → 发布检查”；无法访问仓库时再使用离线包。更新前备份数据；只更换镜像，不替换数据目录。确认新版本可用前保留上一版本镜像和发布包。

需要回退时，用上一发布目录的 `runtime.env` 和 `compose.yml` 执行同样的 `up -d --wait`，环境配置继续指向同一数据目录，成功后将 `current` 链接指回该版本。回退镜像不会自动撤销新版本产生的数据变更，涉及数据格式变更的版本应另行设计迁移。

## 2026 年 10 月 17 日仓库发布记录

已从开发机成功推送到原腾讯云仓库：

```text
ccr.ccs.tencentyun.com/visa-helper/visa-helper:0.7.0-589a244540ab
```

仓库摘要为 `sha256:5831bc962945418a34e1ba18cb054745329ade8bcb9355b33f102aa26ef3f04b`。开发机按此摘要从仓库回拉成功，镜像 ID 与服务器正在运行的镜像一致。发布配置 `registry.env` 已保存到本地及服务器对应发布目录，后续可使用仓库摘要部署。

首次发布时未更换运行容器，服务器当时尚未独立登录，未做服务器直接拉取验证。后续用户在服务器配置登录后，已完成下节记录的拉取、流程验证和正式切换。整个过程未向服务器转交开发机登录凭据。

## 2026 年 10 月 17 日服务器仓库拉取与切换

用户在服务器 `ubuntu` 账户下完成仓库登录后，通过 `sudo docker --config /home/ubuntu/.docker pull 仓库@摘要` 直接拉取成功。镜像层已有缓存，Docker 校验仓库摘要后复用；镜像 ID 与发布记录完全相同。未复制登录凭据。

正式发布目录为 `/home/ubuntu/visa-helper-mcp/releases/0.7.0-589a244540ab-registry`，`current` 链接已指向该目录。目录内 `runtime.env` 直接引用腾讯云仓库摘要，拉取策略为 `missing`；正式容器的 `Config.Image` 也已变为该仓库摘要，不再引用本地构建标签。

切换前使用数据副本在独立端口验证了 5 个接口、16 个问题、逐步补充问答、12 项在职材料、任务选择、退休分支 11 项材料、撤回答案及恢复。预检通过后才切换正式容器，备份位于 `/home/ubuntu/visa-helper-mcp/backups/before-registry-20261017T074258Z`。

正式申请数据切换前后 SHA-256 一致。通过原 SSH 转发恢复先前的退休申请成功，答案版本未变、清单为 11 项；发布指纹检查通过。实际 Visa Helper 连接的 `get_server_info` 返回进程实例 `77029273-86bb-4337-b0bb-a3b5a95f8db2`，与正式端口一致，确认已到达新容器。这里验证了接口及传输链路，未声称重新完成 ChatGPT 页面视觉验收。

正式容器健康，仍监听 `127.0.0.1:18081`，数据仍挂载原目录。预检容器、网络和临时数据副本已清理。

## 2026 年 10 月 17 日首次切换记录

- 运行镜像：`visa-helper-mcp:0.7.0-589a244540ab`，压缩发布包约 70 MB。
- 镜像 ID：`sha256:5831bc962945418a34e1ba18cb054745329ade8bcb9355b33f102aa26ef3f04b`；基础镜像固定到 `sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402`。
- 正式容器：`visa-helper-mcp-server-1`，监听 `127.0.0.1:18081`；本次应用版本、代码、5 个接口、XState 模型及 UI 指纹均保持不变。
- 切换前在开发机跑通问答、12 项清单及材料选择，并验证重启后答案版本和任务进度不变。腾讯云先使用独立数据副本在 `18082` 预检，再由正式容器接管原端口及数据目录。
- 原数据在切换前后 SHA-256 一致；正式容器通过原 SSH 转发成功恢复先前的退休申请，版本未变、清单仍为 11 项；实际 Secure MCP Tunnel 的版本探测也已到达新容器。
- 切换备份位于 `/home/ubuntu/visa-helper-mcp/backups/before-container-20261017T070837Z`，包含原数据、系统服务定义和旧容器元数据，权限限制为当前服务器用户可读。
- 旧版 `deploy-visa-helper-1` 容器和直接运行 Node 的 `visa-helper-mcp.service` 已退役。旧版命名数据卷保留，未作为当前申请目录使用；预检容器和开发机临时测试容器已清理。

## 2026年10月18日申请表任务发布

当前镜像标签为 `0.8.0-8e992a64cc53`，仓库摘要 `sha256:96f025128f7c1f526630deeccb73962676b09208bf605e5ce29ffce692a3a5b7`。发布目录为 `/home/ubuntu/visa-helper-mcp/releases/0.8.0-8e992a64cc53-registry`，`current` 已切换到该目录。服务器从仓库直接拉取，沿用原数据挂载；切换前备份到 `backups/before-pdf-task-*`，切换后原文件校验和未变化。旧发布目录保留供回退。最终容器健康检查及镜像内发布检查通过；真实 Visa Helper 连接已确认更新到新版本。

本次增加独立申请表任务配置，镜像包含 `config/tasks/`，版本信息增加 `taskWorkflow` 模型指纹。构建和发布检查要求六个工具且包含 `advance_task`。此变更要求宿主重载工具列表、重新打开材料清单；不改变 Tunnel 路径和服务器端口。

## 2026年10月18日任务界面更新

当前镜像 `0.8.1-565fae4fcce8`，仓库摘要 `sha256:7b8693315fa9d80fad3f6460c7520bb94f13d4c53c6e106de90a0707996d8b72`，发布目录 `/home/ubuntu/visa-helper-mcp/releases/0.8.1-565fae4fcce8-registry`，`current` 已切换。更新前数据备份在 `backups/before-focused-guide-*`，更新后校验和不变。容器健康、HTTP/MCP 发布检查及实际 Visa Helper 连接确认通过。工具集合、接口契约和任务模型指纹未变化；此次主要更新任务专注界面及基于已确认资料的网页版填写对照表。

## 2026年10月18日独立填写对照页发布

当前镜像 `0.8.2-48f2a80acdfa`，仓库摘要 `sha256:5323028d56f22745a65567fbc5d5b5e4ed4bd02e21c7fa1fa242056f7ddecbc6`，发布目录 `/home/ubuntu/visa-helper-mcp/releases/0.8.2-48f2a80acdfa-registry`。镜像已从仓库拉取并切换，原申请文件校验和未变化；切换前数据备份在 `backups/before-browser-guide-*`。环境旧配置保存在 `deploy/container.env.before-guide`。

当前独立页面使用以下显式测试配置：

```dotenv
VISA_HELPER_GUIDE_BASE_URL=http://129.204.29.242:18080
VISA_HELPER_GUIDE_BIND=0.0.0.0
VISA_HELPER_GUIDE_PORT=18080
VISA_HELPER_GUIDE_ALLOW_HTTP=1
```

容器 8788 提供只读令牌页面，18080 仅转发该监听器；不会转发 8787 的 MCP。18080 是旧应用退役后空出的端口。公网访问有效指引链接为 200，根路径与 `/mcp` 为 404，MCP 仍绑定本机 18081。链接由 MCP 当前进程内存维护，15 分钟有效，服务重启后原链接失效；从任务重新点击即可取得新链接。关闭公网页面时，清空 base URL、将 bind 改回 127.0.0.1 后重新启动；正式环境改用 HTTPS 并关闭 ALLOW_HTTP。
