# Visa Helper 镜像构建与部署

当前应用通过 Docker 镜像运行在腾讯云，服务器无需现场安装 npm 依赖。开发机构建并导出镜像，上传到服务器后离线导入，由 Docker Compose 启动。当前 MCP 仍使用腾讯云 `127.0.0.1:18081/mcp`，开发机 SSH 转发及 Secure MCP Tunnel 保持原连接方式。

## 镜像与数据

镜像包含 Node.js 22、按 lockfile 安装的生产依赖（含 XState）、`src/`、`public/`、完整 `config/` 和发布检查工具。规则配置随镜像发布；更新规则配置后同样需要重新打包镜像。镜像不包含开发机的 `.local/`、Tunnel 密钥、申请数据、测试及决策图开发依赖。

镜像内部 `/app/data` 挂载宿主机 `/home/ubuntu/visa-helper-mcp/data`。申请答案、任务进度和历史执行轨迹留在这个目录，不放入镜像。容器以非 root 用户 `node`（UID 1000）运行，数据目录必须允许该用户读写；当前服务器的 `ubuntu` 也是 UID 1000。容器根文件系统只读，仅数据挂载可写。

Compose 要求显式指定已存在的数据目录，并拒绝自动创建缺失目录，避免路径写错后看起来像申请数据被清空。只将端口绑定到宿主机回环地址；通过原有 SSH/Tunnel 访问。Docker 服务已启用开机启动，容器使用 `unless-stopped` 自动恢复。

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
| `runtime.env` | 本次镜像的标签 |
| `release.json` | 镜像 ID、基础镜像摘要、应用构建指纹 |
| `SHA256SUMS` | 发布包文件完整性校验 |

构建机需要访问基础镜像仓库和 npm。腾讯云只导入发布包，不需要访问这些仓库。发布目录、镜像 ID 和校验文件应一起保存；回退使用先前保存的发布包。

## 上传和启动

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

`pull_policy: never` 确保运行已导入的镜像。健康检查访问 `/version`，会实际加载规则与服务元数据。启动失败时保留原发布包和数据，检查容器日志后再处理，不覆盖数据目录。

确认启动成功后，更新 `current` 符号链接指向本次发布目录：

```bash
ln -sfn releases/0.7.0-589a244540ab /home/ubuntu/visa-helper-mcp/current
```

## 查看状态与验证

服务器当前发布可通过固定路径管理：

```bash
cd /home/ubuntu/visa-helper-mcp
sudo docker compose --project-name visa-helper-mcp \
  --env-file current/runtime.env --env-file deploy/container.env \
  -f current/compose.yml ps
sudo docker compose --project-name visa-helper-mcp \
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

后续发布沿用“构建镜像 → 导出发布包 → 上传 → 校验 → 导入 → Compose 更新 → 发布检查”的流程。更新前备份数据；只更换镜像，不替换数据目录。确认新版本可用前保留上一版本镜像和发布包。

需要回退时，用上一发布目录的 `runtime.env` 和 `compose.yml` 执行同样的 `up -d --wait`，环境配置继续指向同一数据目录，成功后将 `current` 链接指回该版本。回退镜像不会自动撤销新版本产生的数据变更，涉及数据格式变更的版本应另行设计迁移。

## 2026 年 10 月 17 日首次切换记录

- 运行镜像：`visa-helper-mcp:0.7.0-589a244540ab`，压缩发布包约 70 MB。
- 镜像 ID：`sha256:5831bc962945418a34e1ba18cb054745329ade8bcb9355b33f102aa26ef3f04b`；基础镜像固定到 `sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402`。
- 正式容器：`visa-helper-mcp-server-1`，监听 `127.0.0.1:18081`；本次应用版本、代码、5 个接口、XState 模型及 UI 指纹均保持不变。
- 切换前在开发机跑通问答、12 项清单及材料选择，并验证重启后答案版本和任务进度不变。腾讯云先使用独立数据副本在 `18082` 预检，再由正式容器接管原端口及数据目录。
- 原数据在切换前后 SHA-256 一致；正式容器通过原 SSH 转发成功恢复先前的退休申请，版本未变、清单仍为 11 项；实际 Secure MCP Tunnel 的版本探测也已到达新容器。
- 切换备份位于 `/home/ubuntu/visa-helper-mcp/backups/before-container-20261017T070837Z`，包含原数据、系统服务定义和旧容器元数据，权限限制为当前服务器用户可读。
- 旧版 `deploy-visa-helper-1` 容器和直接运行 Node 的 `visa-helper-mcp.service` 已退役。旧版命名数据卷保留，未作为当前申请目录使用；预检容器和开发机临时测试容器已清理。
