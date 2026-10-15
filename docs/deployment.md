# ChatGPT MCP App 部署与测试

当前版本为 `0.4.0`：MCP 推进决策树，缺少答案时实际请求原生问题表单，叶子节点使用独立入口展示材料工作台。材料来源复核与用户申请记录分别处理，界面不再标为「模拟」。

## 2026-10-15：原生表单与独立清单入口

用户已反复刷新，工具列表也已出现 `start_task`，但展示内容仍是旧问卷全文（包括「开始一次模拟申请」「已有申请 ID／恢复申请」），因此不能归因于未刷新。当前清单源码没有这些控件；旧 UI 的具体缓存位置未能从分享链接确认。新版移除旧 `open_visa_helper` 工具，以新工具 `show_material_checklist` 和资源 `ui://visa-helper/material-checklist-v4.html` 展示最终清单；`get_task_queue` 仅供 App 自动读取完整状态。工作台兼容完整工具通知、初始输出已存在、仅工具输入已存在三种宿主载入时序，均自动关联当前申请。

原先「如可用则用原生问题卡」只是模型指引，未发起表单请求。新版升级官方 MCP 服务端 2.x，使用 `@openai/mcp-extensions` 的 `requestFormInput` 实现 `ask_next_question`，通过 MRTR 的 `input_required` 请求一道题；接收答案后仍运行同一决策树。只在当前请求声明 MCP 2026-07-28 及 `elicitation.form`、`openai/elicitation.form` 时请求原生表单，否则明确返回聊天回退，不伪称已展示。[官方表单说明](https://developers.openai.com/plugins/build/extensions)、[官方平台支持表](https://github.com/openai/mcp-extensions/blob/main/docs/spec.md#platform-support)。后者明确 Web 指 Work 浏览器，Classic ChatGPT 不在该扩展支持范围；因此原生问题框应在 Work 网页或桌面测试，代码更新本身不要求 Work。

移除用户界面和工具说明中的「模拟」标签，API 路径状态改为 `pending_verification`。旧申请仍保留其规则版本，输出端按实际申请准备呈现；材料来源单独写明为用户提供的 2025 年审核表、现行官方要求待复核，不把未核实来源描述为已验证规则。

本地测试已验证原生表单的逐题多轮请求、答案保存、取消保留缺失项、不支持时明确回退，以及走到叶子后的清单动作。无头浏览器验证上述三种初始状态来源均能显示完整清单、选择材料并回到对话，且没有「模拟」「恢复申请」文案。原生表单在 ChatGPT Work 宿主中的实际展示仍需部署后验收。

0.4.0 已部署到现有腾讯云服务，更新前备份代码和依赖，申请数据保留。实际部署的 HTTP 已验证八个工具、旧入口移除、v4 清单资源，以及原生表单的请求—答案—下一题一轮交互。经现有 OpenAI Tunnel 连接的兼容读取调用成功，返回新清单动作及 `pending_verification` 来源状态。后台 Tunnel 健康且就绪。上述验证不等于已在 ChatGPT Work 中看到弹框；这部分仍需使用支持的宿主验收。

新版工具应有八个：`create_application`、`get_application`、`get_questions`、`submit_answers`、`ask_next_question`、`show_material_checklist`、`get_task_queue`（App 可见）、`start_task`。验收时应看到新增的 `ask_next_question` 和 `show_material_checklist`，并不再调用旧 `open_visa_helper`；仅核对 `start_task` 不足以确认本次更新。

## 历史：0.3.0 对话推进决策树，叶子节点展示 App

用户反馈此前问卷网页与聊天同时提问、没有继续补齐信息、清单后缺少明确下一步。新版把问答接口与 UI 分开：`create_application`、`get_questions`、`submit_answers` 和兼容入口 `open_visa_helper` 都没有 UI 关联。`submit_answers` 接收一题或从用户整段话提取的多个答案，返回 `nextQuestion`、`pendingQuestions` 和 `nextAction`。GPT 优先使用原话中的明确事实推进，遇到信息缺口或冲突再追问，直到 `tasks_ready` 后调用 `get_task_queue`。

`get_task_queue` 是唯一展示 App 的工具，关联 `ui://visa-helper/task-workspace-v3.html`。完整清单在结果 `_meta.application` 中供 UI 使用；模型只收到数量和下一步，避免聊天重复长清单。工作台可点击材料，调用新增的 `start_task` 保存「准备中」状态、显示原表说明，并通过用户点击触发 `ui/message` 回到聊天继续这一项。文件上传、生成与完成验收尚未实现。

本地已验证：逐题推进与整段信息批量提交、缺失项继续追问的接口状态、叶子节点动作、问答工具不带 UI 关联、未完成问答不能读取清单、任务选择持久化和失效分支保护。使用无头 Chromium 与模拟 MCP Apps 宿主桥，连到真实 MCP 工具，验证完整元数据载入 12 项材料、点击「在职证明」保存状态、以及 `ui/message` 携带正确申请与任务 ID。该浏览器测试不等于 ChatGPT 宿主内的完整体验验收。

已部署到现有腾讯云私有服务并重启。经当前连接的 Visa Helper 和 Tunnel 实测：创建虚构申请；一次提交包含后续职业分支的已知事实后，仅剩递交城市；补齐后返回叶子节点和 `get_task_queue` 动作；清单接口返回 12 项计数，模型结果不带完整材料数组。另在服务器本机通过 MCP SDK 验证七个工具中仅 `get_task_queue` 关联 UI，以及任务选择成功持久化。ChatGPT 中的最终原生问答表现和页卡显示仍待刷新连接后的用户复测。

在 ChatGPT 复测前，保持 SSH 转发和 Tunnel 运行，在插件连接详情执行 **Refresh**，确认七个工具和新版 UI 关联后新建会话；只新建会话不保证更新工具快照。[官方刷新流程](https://developers.openai.com/plugins/deploy/connect-chatgpt)。复测应覆盖：

1. 发送「我要申请签证」，应在对话中开始引导和第一题，不显示 MCP 问卷网页。回答后继续下一处缺失信息。
2. 新申请中一次描述一位虚构成人的护照国籍、居住地、递交城市、冰岛旅游、明确日期和职业；已明确的信息不重复询问，只补未提供的条件。
3. 补齐必要条件后直接显示材料 App。聊天只简短说明点击材料开始，不复制全部清单；选择材料能显示对应说明和准备中状态，点击「在对话中继续准备」能接续同一项。

## 历史记录：此前的决策树模拟版（同日）

以下记录保留排查背景；当前交互和工具以本页上节为准。

本日修复开场重复问卷：实际会话中的工具说明仍要求「整组一起问」，与服务器实时 `tools/list` 不一致；仅新建会话未更新该连接的工具快照。另发现 `open_visa_helper` 在无申请时只返回空状态，现已改为返回两种文字输入方式的开场提示，以及不要在页卡旁重复列出问卷的对话指引。修改已通过自动测试并部署；经当前已连接的 Visa Helper 实际调用，确认收到新版开场提示。完整聊天表现仍需刷新连接后新建会话复测。工具说明发生变化时，应先在插件连接详情执行 Refresh，再新建会话；参见[官方刷新流程](https://developers.openai.com/plugins/deploy/connect-chatgpt)。

私有服务仍由 `visa-helper-mcp.service` 管理，仅监听腾讯云的 `127.0.0.1:18081`。当前有六个工具：`open_visa_helper`、`create_application`、`get_application`、`get_questions`、`submit_answers`、`get_task_queue`。旧版 `submit_step` 已移除；旧演示记录仍可读取，但新问答需要新建申请。

规则在 `app/config/rules/` 中按版本保存，`app/config/active.json` 指向新申请使用的版本。使用开源 JsonLogic 求值器；切换配置版本无需改代码或重启服务，旧申请继续使用创建时的版本。当前唯一配置来自用户提供的 2025 年材料审核表，仅供虚构申请模拟。

服务器本机通过 MCP 调用验证：新建申请返回 `basic` 问题组；用虚构日期与情况回答后返回 `adult` 组；提交「在职」后得到 `tasks_ready` 和 12 个文件任务，其中包括在职证明。更新前做了文件备份，数据目录未替换。

**在 ChatGPT 中复测**：按下文启动开发机的 SSH 转发与 Tunnel，刷新 Visa Helper 连接，使工具列表从旧版四个更新为上述六个。新对话中选用 Visa Helper，像普通用户一样说「我想去冰岛旅游，签证材料要准备什么？」。首个窗口应说明可逐题回答，或在对话中一次写出旅行计划。先用虚构信息在对话中描述部分行程和职业，检查已提取答案与仅剩缺失问题；再用页卡逐题补齐，检查最终任务队列。不要输入真实个人资料。

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

用户已创建用于私有测试的 Tunnel；其 ID 保存在未提交的本地配置中。开发机已下载并校验 `tunnel-client v0.0.16`，二进制与配置位于已忽略提交的 `app/.local/`。`app/scripts/start-private-test.sh` 默认在后台管理 SSH 转发与 tunnel-client，启动前检查 MCP 可达性并执行 `doctor`。2026-10-15 已增加后台管理，具体命令见下文。

在开发机准备 `CONTROL_PLANE_API_KEY` 环境变量后运行：

```bash
app/scripts/start-private-test.sh start
app/scripts/start-private-test.sh status
app/scripts/start-private-test.sh stop
```

`start` 读取继承的环境变量；未设置时，可从本机 `app/.local/tunnel.env` 读取 `CONTROL_PLANE_API_KEY=运行密钥`。该文件位于忽略目录，脚本把权限设为 `600`，不打印内容。若仍无密钥且在交互终端中，则无回显询问。另一个终端中新执行的 `export` 不会改变已经启动的 Codex 进程环境；需要由 Codex 代启动时，使用本机环境文件即可，不把密钥发到聊天。

后台日志为 `app/.local/private-test.log`，进程信息为同目录的 `private-test.pid`。重复 `start` 不会重复启动；`stop` 只停止本脚本管理的进程，并清理它新建的 SSH 转发；启动时若复用已有转发，不会停止该外部转发。既有的手动前台 tunnel-client 需要先退出，才能把 `8080` 交给后台进程；脚本不会杀死外部服务。后台使用独立会话并忽略终端挂断，启动成功后可以关闭终端；需要排查时使用 `foreground` 子命令。后台运行仍使用 `127.0.0.1:18081` 和 `127.0.0.1:8080` 端口，不提供开机自启。

新增进程测试使用模拟客户端与转发，验证私密读取密钥、重复启动、就绪状态、停止清理，以及密钥不进入命令参数或日志；该测试不使用实际运行密钥。

在 ChatGPT 中选择该应用进行测试。当前使用个人 Pro 套餐；[OpenAI 帮助中心](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)对 Pro 的完整可写 MCP 支持有限制说明；下述实测结果仅描述当前测试连接，不代表所有 Pro 账号均受支持。

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
3. 在 ChatGPT 已添加的 Visa Helper 应用中新开对话，发送“打开 Visa Helper”。若需重新添加，到 [ChatGPT Plugins](https://chatgpt.com/plugins) 添加自定义 MCP 服务，Connection 选 **Tunnel**，选择与本地 profile 相同的 tunnel；认证选无认证。Tunnel ID 不是 Server URL。重新扫描工具后，应看到六个工具和独立 UI。
4. 像普通用户一样说「我想去冰岛旅游，签证材料要准备什么？」。ChatGPT 应自行创建申请并显示第一组问题，无需用户提到工具、决策树或申请 ID。可用中国护照、居住中国、北京递交、仅赴冰岛旅游、`2027-06-01` 至 `2027-06-10`、已成年、在职的虚构答案。应先出现基础问题组，再出现职业问题组，最后显示含在职证明的 12 项文件任务。新开一个 ChatGPT 对话，选择 Visa Helper，发送“继续上次的申请”，用刚才的申请 ID 恢复，应显示同一队列。不要填真实个人信息或上传真实材料。
5. 测试结束后用 `Ctrl-C` 停止启动脚本；脚本会清理它启动的 SSH 转发。若使用过独立启动的 SSH 转发，需单独确认并结束其进程。

如果 ChatGPT 提示“无法连接到 MCP 服务器”，按请求路径逐段检查：先看脚本终端中的 tunnel-client 是否仍在轮询；再在开发机执行 `curl --max-time 5 http://127.0.0.1:18081/`，应立即返回服务响应；最后检查腾讯云上的 `visa-helper-mcp.service`。本机端口能建立 TCP 连接却迟迟没有 HTTP 响应时，优先检查 SSH 转发是否失效，并重新建立转发。连接成功但没有 UI 时，重新扫描工具并调用 `open_visa_helper`。

如果保存回答时报 `Unknown tool({"name":"visa_helper.submit_step"})`，说明 ChatGPT 仍持有旧版四工具定义。当前服务端已发布六个工具，保存回答使用 `submit_answers`。到 [ChatGPT Plugins](https://chatgpt.com/plugins) 打开 Visa Helper 连接并点 **Refresh**，确认工具列表出现 `get_questions`、`submit_answers`、`get_task_queue` 且不再出现 `submit_step`，然后**新建对话**测试。旧对话可能仍引用旧工具定义；这类错误发生在进入保存逻辑之前，原回答需要重新提交。若刷新后仍显示旧工具，检查正在运行的 Tunnel 是否连接到本服务，再重新连接该自定义 MCP 服务。
