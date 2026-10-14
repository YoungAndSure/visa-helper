# ChatGPT MCP App 部署与测试

当前状态：`app/` 的 MCP 工具和 MCP Apps UI 原型已部署在腾讯云服务器，通过开发机上的 Secure MCP Tunnel 在 ChatGPT 中完成私有测试。尚不能公开处理真实用户申请。

## 现有服务器的连通性（2026-10-14）

用户提供的腾讯云公网 IP：`129.204.29.242`。从当前开发环境绕过本机 HTTP 代理直连测试：

| 端口 | 结果 |
| --- | --- |
| 22/TCP | 可建立连接；用户将公钥导入后，可以 `ubuntu` 身份通过 SSH 登录。 |
| 80/TCP | 连接被拒绝。 |
| 443/TCP | 连接超时。 |

这些结果表明当前无法通过该 IP 使用 HTTPS `/mcp`。当前结果不能证明 ChatGPT 对中国大陆 IP 的可达性，因为 443 端口本身尚未提供可测试服务。

## 内部试运行（2026-10-14）

- 旧版服务保持运行：Docker 容器 `deploy-visa-helper-1` 对外监听 `18080`，`/healthz` 返回正常。
- 新版代码部署到 `/home/ubuntu/visa-helper-mcp`，由 `visa-helper-mcp.service` 管理。服务已启用且处于 `active` 状态。
- 新版仅监听 `127.0.0.1:18081`，`POST /mcp` 的 `tools/list` 返回四个原型工具及 UI 资源入口。没有公网入口。
- 服务器从 Docker Hub 拉取 `node:22-alpine` 超时，因此内部试运行暂用本地传输的 Node 22 可执行文件及依赖，由 systemd 启动。正式部署前应恢复可重复构建的交付方式。
- 本地验证命令：`curl http://127.0.0.1:18081/`，以及带 `Content-Type: application/json`、`Accept: application/json, text/event-stream` 的 MCP 请求。

## 复用现有腾讯云服务器

1. 规划 HTTPS 入口，开放并从服务器之外测试 `443/TCP` 的可达性；仅在服务器上 `curl localhost` 成功不足以证明 ChatGPT 能连接。
2. 提供稳定的 HTTPS `/mcp` 地址。可采用域名和自动续期证书；也可评估公网 IP 证书，但这类证书有效期很短，必须验证自动续期。
3. 增加用户认证与申请所属关系。ChatGPT 发起的每次读取和写入都要在服务端验证用户身份，不能仅凭申请 ID 授权。
4. 将当前本地 JSON 原型存储迁移为适合部署的持久化存储，并明确备份、删除和日志策略。
5. 正式 HTTPS 入口建成后，重新从外部验证初始化、工具调用和 UI 资源，并在 ChatGPT 中回归测试实际交互。

生产接入参考：[OpenAI MCP Server 部署要求](https://developers.openai.com/plugins/build/mcp-server)、[OpenAI 用户认证指南](https://developers.openai.com/plugins/build/auth)、[OpenAI MCP Server + UI Quickstart](https://developers.openai.com/plugins/build/app-quickstart)。

当前原型只监听 loopback 地址，拒绝绑定公网网卡。完成认证与授权前不要开启公网反向代理或公网临时隧道。

## ChatGPT 私有测试：Secure MCP Tunnel

2026-10-14 实测：腾讯云主机可以访问自己的 `127.0.0.1:18081/mcp`，但直连 `api.openai.com:443` 超时；当前开发机访问该地址返回预期的未认证 HTTP 401。开发机通过 SSH 本地转发调用腾讯云 MCP 的 `tools/list` 成功。因此测试时让 `tunnel-client` 运行在开发机，连接本机的 SSH 转发端口。开发机和 SSH 转发必须在 ChatGPT 测试期间保持运行。

```text
ChatGPT → OpenAI Secure MCP Tunnel → 开发机 tunnel-client
                                      → 127.0.0.1:18081 → SSH 转发
                                      → 腾讯云 127.0.0.1:18081/mcp
```

按[官方 Secure MCP Tunnel 指南](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)执行：

1. 在 [Platform Tunnels](https://platform.openai.com/settings/organization/tunnels) 创建或复用一个 tunnel，并关联**将用于测试的 ChatGPT 工作区**。记录 `tunnel_id`。创建者需要 Tunnels Read + Manage；运行密钥和在 ChatGPT 中选用它的人员需要 Read + Use。还须确认该 ChatGPT 工作区允许添加自定义 MCP 服务。
2. 在 [Platform API Keys](https://platform.openai.com/settings/organization/api-keys) 准备一个只具备运行所需权限的 API key。不要把密钥发到聊天、写入仓库或放在命令参数里。
3. 在开发机安装 [官方 tunnel-client 最新版本](https://github.com/openai/tunnel-client/releases/latest)。先运行 `tunnel-client help quickstart` 核对当前 CLI 语法。已将官方 `v0.0.16` Linux x86_64 压缩包下载到 `/tmp/visa-helper-tunnel-client`，SHA-256 与官方 `SHA256SUMS.txt` 一致，命令帮助可运行；该临时目录不是持久安装位置。
4. 在开发机的一个终端保持 SSH 转发运行：

   ```bash
   ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:18081:127.0.0.1:18081 ubuntu@129.204.29.242
   ```

5. 在开发机另一个终端运行 `tunnel-client`。以下使用占位符；API key 应通过私密的终端输入或安全的环境变量注入，不能原样粘贴到共享记录中：

   ```bash
   tunnel-client init --sample sample_mcp_remote_no_auth --profile visa-helper-test --tunnel-id '<tunnel_id>' --mcp-server-url http://127.0.0.1:18081/mcp
   tunnel-client doctor --profile visa-helper-test --explain
   tunnel-client run --profile visa-helper-test
   ```

   `doctor` 和 `run` 需要 `CONTROL_PLANE_API_KEY`。只有 `doctor` 检查通过、`run` 保持就绪并持续轮询，ChatGPT 才能发现和调用工具。通过 tunnel-client 的本地 `/readyz` 或 `/ui` 核实状态。
6. 在 [ChatGPT Plugins](https://chatgpt.com/plugins) 添加自定义 MCP 服务，Connection 选 **Tunnel**，选择或填入相同 `tunnel_id`。当前原型没有 OAuth，测试时只使用无认证配置和虚构数据。完成连接后，在新对话中选择该应用，测试 `open_visa_helper`、创建申请、填写步骤、恢复状态及不支持的请求；同时检查嵌入式 UI 和工具结果。真正接入个人申请数据前需要增加用户身份验证及申请归属授权。

**完成标准**：不仅 `doctor` 就绪和工具列表可见，还要在 ChatGPT 中成功调用至少一个安全的示例工具。Secure MCP Tunnel 仅供私有测试，不满足公开上架所需的稳定公网 HTTPS 地址。[官方连接与测试流程](https://developers.openai.com/plugins/deploy/connect-chatgpt)。

### 当前账号的实际准备状态

用户已创建用于私有测试的 Tunnel；其 ID 保存在未提交的本地配置中。开发机已下载并校验 `tunnel-client v0.0.16`，二进制与配置位于已忽略提交的 `app/.local/`。`app/scripts/start-private-test.sh` 会启动 SSH 转发、检查 MCP 可达性、无回显读取运行 API key、执行 `doctor`，然后前台运行 tunnel-client。脚本已通过语法与无密钥路径测试；用户随后提供运行密钥并完成端到端测试。

再次测试时，在开发机**交互式终端**运行：

```bash
app/scripts/start-private-test.sh
```

密钥只在本机提示符输入，不发到聊天、不写入仓库。保持终端运行后，在 ChatGPT 中选择该应用。当前使用个人 Pro 套餐；[OpenAI 帮助中心](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)对 Pro 的完整可写 MCP 支持有限制说明；下述实测结果仅描述当前测试连接，不代表所有 Pro 账号均受支持。

2026-10-14 复核：用户已在本机输入运行密钥，`doctor` 结果为 `ok`。本机 tunnel-client `/healthz` 返回 `live`、`/readyz` 返回 `ready`，控制平面状态为 `polling`。新版 MCP 已把 `open_visa_helper` 和 `get_application` 标为只读，`create_application` 和 `submit_step` 标为写入，远程服务重启后从 SSH 转发端口读取工具列表确认生效。

ChatGPT 首次添加时曾提示无法连接。排查发现 tunnel-client 仍处于 `ready`/`polling`，腾讯云 MCP 本机返回 200，但开发机的 SSH 转发端口只接受连接、不返回响应。重新建立 SSH 转发并增加 `ServerAliveInterval=15`、`ServerAliveCountMax=2` 后，开发机的 `tools/list` 再次成功。启动脚本已加入保活参数。当前恢复用的 SSH 进程独立于用户启动脚本；测试结束后应关闭该转发进程，之后重新运行启动脚本即可使用更新后的参数。

用户确认 ChatGPT 连接成功；当前会话出现 `visa-helper` 的四个工具。连接器调用只读工具 `open_visa_helper` 成功，返回“中国护照 · 居住中国 · 冰岛旅游”路径及 `pending_verification` 规则状态。用户在 ChatGPT 中看到独立 UI，点击“创建申请”后出现申请 ID，继续用虚构日期完成“确认并继续”→“保存并继续”→“完成交互演示”，并在新对话中用申请 ID 成功恢复已完成状态。服务器数据文件的只读汇总显示 1 条记录，状态为 `walkthrough_complete`。当前测试连接已实际跑通本原型的 UI 展示、创建、步骤写入、持久化和跨对话恢复。

### 下次复测操作清单

以下命令在**开发机**运行。腾讯云上的 `visa-helper-mcp.service` 须已启动，且开发机的 `app/.local/` 中保留 tunnel-client、profile 和 SSH 主机密钥文件。运行密钥需要具备 Tunnels Read + Use 权限。

1. 检查本机 `18081` 是否已经被旧 SSH 转发占用：`ss -ltnp '( sport = :18081 )'`。若有旧进程，先确认它属于本次测试并结束该进程，再启动脚本；否则脚本无法绑定端口。不要关闭正在使用的其他服务。
2. 在交互式终端运行：

   ```bash
   cd /home/youngsure/Code/visa-helper
   app/scripts/start-private-test.sh
   ```

   按提示在本机输入 Platform 运行 API key，输入不会显示。看到 `RESULT ok` 和“Tunnel 检查通过”后，保持终端运行。该脚本同时建立到腾讯云的 SSH 本地转发，运行 `doctor`，并启动持续轮询的 tunnel-client。`doctor` 对 `/mcp` 返回 HTTP 406 的检查结果是正常的：普通 GET 缺少 MCP 请求所需的头部。
3. 在 ChatGPT 已添加的 Visa Helper 应用中新开对话，发送“打开 Visa Helper”。若需重新添加，到 [ChatGPT Plugins](https://chatgpt.com/plugins) 添加自定义 MCP 服务，Connection 选 **Tunnel**，选择与本地 profile 相同的 tunnel；认证选无认证。Tunnel ID 不是 Server URL。等待工具扫描完成，应看到四个工具和独立 UI。
4. 在 UI 中点“创建申请”，记下界面上的申请 ID；点“确认并继续”，用虚构日期（如 `2027-06-01` 至 `2027-06-10`）点“保存并继续”，再点“完成交互演示”。新开一个 ChatGPT 对话，选择 Visa Helper，发送“打开 Visa Helper”，把刚才的 ID 填入“已有申请 ID”，点“恢复申请”。应显示已完成状态。不要填真实个人信息或上传真实材料。
5. 测试结束后用 `Ctrl-C` 停止启动脚本；脚本会清理它启动的 SSH 转发。若使用过独立启动的 SSH 转发，需单独确认并结束其进程。

如果 ChatGPT 提示“无法连接到 MCP 服务器”，按请求路径逐段检查：先看脚本终端中的 tunnel-client 是否仍在轮询；再在开发机执行 `curl --max-time 5 http://127.0.0.1:18081/`，应立即返回服务响应；最后检查腾讯云上的 `visa-helper-mcp.service`。本机端口能建立 TCP 连接却迟迟没有 HTTP 响应时，优先检查 SSH 转发是否失效，并重新建立转发。连接成功但没有 UI 时，重新扫描工具并调用 `open_visa_helper`。
