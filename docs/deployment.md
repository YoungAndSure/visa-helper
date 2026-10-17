# ChatGPT MCP App 部署与测试

当前版本为 `0.7.0`，问答协议 `1.0`。服务仅注册 5 个接口：`advance_application`、`get_task_queue`、`start_task`、`get_server_info` 和仅供 App 使用的 `report_ui_ready`。七个旧问答或重复入口、原生表单实现及旧 UI 资源别名均已删除，不提供旧接口兼容。接口参数与职责见 [MCP 接口说明](mcp-api.md)，问答循环见[完整问答协议](interview-protocol.md)。

## 当前部署方式

当前已改用 Docker 镜像，详见[镜像构建与部署](container-deployment.md)。正式容器为 `visa-helper-mcp-server-1`，使用原有数据目录和 `127.0.0.1:18081`。旧版 `18080` 容器已删除，直接运行 Node 的 systemd 服务已停用并移除。SSH 转发与 Secure MCP Tunnel 保持原路径，接口及运行指纹未变化。

下列记录中的 systemd 启动方式仅描述历史发布。当前排查服务请用 Docker Compose 状态和日志，不再启动已退役的系统服务。

## 2026-10-17 接口精简

- 问答创建、目录查询、恢复与完整提交均使用 `advance_application`；完成后按返回动作展示清单，用户选材料后用 `start_task`。
- 删除 `open_visa_helper`、`create_application`、`get_application`、`get_questions`、`submit_answers`、`ask_next_question`、`show_material_checklist`。不保留隐藏入口或转发。原生表单代码、`@openai/mcp-extensions` 依赖和 v2/v3 UI 别名同时删除。
- 发布检查比对精确工具集合，而非只检查必需接口存在；自动测试核对只有 5 个工具、旧工具调用失败、旧资源不可读取，以及新问答循环和任务展示。
- 申请数据保留，已有有效问答申请通过统一入口恢复；旧连接必须重载工具列表。GPT 可见 4 个工具，载入回执仅供 App 使用。

### 精简版部署验证

`0.7.0` 已部署到原腾讯云服务，构建指纹 `589a244540ab`，工具契约 `d6f8db600838`。代码和旧表单依赖备份到 `/tmp/visa-helper-before-0.7.0.tgz`；部署前后申请数据 SHA-256 完全一致。远端已实际删除旧表单源码及依赖。

8 个自动测试文件通过。通过现有 SSH 转发连接真实 MCP，精确确认工具数为 5、七个旧接口全部调用失败、UI 资源仅剩 1 个；虚构申请从空问答到 12 项清单，再选择在职证明成功。不存在申请的错误响应也通过输出协议验证。本地与部署的代码、工具、规则、UI 和协议发布检查通过。这些是服务端及传输验证，未把它们当作 ChatGPT 宿主已显示页面的证据。

下列发布记录描述各自版本的历史行为；涉及旧接口的命令和兼容策略已被本节取代。

## 2026-10-17 完整快照协议

- 新增唯一问答推进工具 `advance_application`，首次 `{ "answers": {} }` 创建并返回完整目录和选项；已有申请带最新 `revision` 提交全部答案。省略 `answers` 只读恢复，显式空对象撤回所有答案。
- 返回 `ask`、`repair`、`clarify`、`blocked` 或 `complete`。格式错误整批拒绝；业务矛盾保存后澄清；旧版本快照拒绝覆盖并返回最新底稿。完成时 `nextAction.presentation` 指向现有的 `get_task_queue` 展示工具。
- 新协议的工具不绑定 UI，不弹出问卷网页。旧增量与原生表单入口保留兼容，但不用于新问答；旧记录没有 `revision` 时只读按 `0` 返回，不批量改写数据。材料规则和 XState 图保持相同版本。
- 连接兼容检查现在要求实际工具列表包含 `advance_application`、`get_task_queue`、`start_task`。不能仅凭版本号或刷新成功推断当前聊天拥有这些工具；以真实可调用列表为准。`serverInfo.interview` 返回协议版本、统一入口和完整快照语义。

### 本次部署验证

- 已部署至现有腾讯云 `visa-helper-mcp.service`，状态为 `active`。最终构建 `35448b02fc30`，工具契约 `4a9ff13585f9`，问答协议 `1.0`；XState 模型 `9450e64159ec` 与 UI 源码 `9bc6cd059123` 保持原指纹。
- 部署前备份 `/tmp/visa-helper-before-0.6.0.tgz`；首次更新前后原申请数据 SHA-256 相同，最终同步时再核对包含验证记录的数据摘要仍相同。没有覆盖数据目录或批量迁移原记录。
- 8 个自动测试文件通过，新增协议测试覆盖逐题与整段完整提交、提前回答、撤回、只读恢复、重复提交、格式整批拒绝、矛盾出口、并发及旧接口引发的版本冲突、任务失效、历史输入回放，以及兼容性不通过时禁止创建。
- 通过现有 SSH 转发的真实 MCP 端点创建虚构申请，取得 16 个问题；在职生成 12 项，退休生成 11 项。错误选项返回 `repair` 且原答案不变；过期版本返回 `REVISION_CONFLICT`；恢复保留同一版本与答案。真实清单工具正确返回工作台数据，但这不是宿主已显示的证明。
- `check:release` 比对本地与部署的代码、工具、模型、UI 和协议通过。另通过已连接的 Visa Helper 发出只读请求（不存在的申请 ID），确认 Secure MCP Tunnel 返回 `0.6.0` 和完整快照协议信息。
- 本次 Codex 会话实际可调用工具快照仍缺 `advance_application` 和 `get_task_queue`，传入该真实列表后服务准确报告缺失。不能把服务端 `tools/list` 通过当成聊天快照通过；ChatGPT 中的新协议自然语言交互和最终 UI 仍需更新连接后的宿主验收。

**ChatGPT 验收**：在工具列表确认统一入口可用后，普通地说“我要申请冰岛旅游签证”。逐题回答时只补当前缺失信息；另一次直接描述整段计划，已明确的信息不重复问。修改职业或撤回日期，检查下一题和清单随路径变化。完成后显示材料 App，聊天不重复长清单。自动化测试验证接口与状态，不代替 GPT 对自然语言的实际理解和 ChatGPT 宿主显示验收。

## 2026-10-17 XState 迁移与验证

- 当前运行规则为 `iceland-tourism-user-checklist-2025-03-06-xstate-1`，模型指纹 `9450e64159ec`；服务构建指纹 `7837baf8584e`。模型包含 51 个节点、62 条跳转，从实际 XState 状态与跳转生成图；运行逻辑中不再使用 JsonLogic，旧求值器仅供测试对照。
- 7 个自动测试文件通过，其中 4,004 组输入与冻结的 0.4.1 求值器比较，覆盖全部职业／担保与未成年人分支、多国行程、部分答案、矛盾及旧答案残留。已有 MCP 原生表单、清单及材料选择测试继续通过。
- 浏览器实际打开生成的图，验证节点数量、点击材料详情与路径定位；另外用真实 MCP 工具和浏览器宿主测试桥验证 12 项清单载入、材料选择与聊天交接。可直接查看[决策图及回放说明](decision-graph/README.md)。这些检查不等同于已经在 ChatGPT 宿主内再次看到全部页面。
- 已部署到现有腾讯云 `visa-helper-mcp.service`，更新前备份至 `/tmp/visa-helper-before-0.5.0.tgz`，申请数据不覆盖。部署前后对原有 14 条申请做只读比较，数据文件 SHA-256 和全部业务输出摘要均完全相同；旧规则版本的申请经已校验的兼容映射使用等价 XState 模型执行。
- 实际通过 Secure MCP Tunnel 创建测试申请并批量提交，返回 `0.5.0`、`xstate`、`5.33.2`、`ready` 和 12 项材料。修改职业为退休后返回 11 项；在腾讯云上指定先前的在职求值 ID 回放，输出与路径匹配。新答案未覆盖旧输入历史。
- 最终发布检查确认本地／目标服务的代码、模型、XState、工具与 UI 指纹一致，当前聊天真实工具名称列表的兼容性检查通过；工具契约指纹仍为 `062e060d631b`，没有增删本次流程所需接口。后台 Tunnel 保持就绪。

创建申请和保存答案后，申请记录的 `evaluations` 保存完整输入、版本／指纹、结果和路径。MCP 返回的 `decision.evaluationId` 可定位一次求值；图与回放在开发工具中完成，未增加生产管理页面。首次迁移前的历史输入未保存，不能事后恢复。图导出脚本需要开发依赖；本次在目标服务同时提供了 XState 与开源 Dagre 包，便于私有环境回放。

## 2026-10-15：版本诊断与兼容机制

已确认的故障链：0.4.0 服务返回要求调用新清单入口，但用户聊天的工具快照仍保留旧 `open_visa_helper`、没有新入口；随后本会话的实际工具列表才变为 0.4.0 的列表。工具快照和运行中的服务确有不同步。前几次改动又删除旧入口、把 `get_task_queue` 从显示工具改成仅供 App 读取，导致旧会话无法完成流程。这是本项目缺少兼容约束和客户端核对机制造成的可避免问题。`content: []` 本身不是 UI 展示的判据，关键是客户端发现到的工具 UI 关联及宿主实际载入。具体为何 ChatGPT 多次 Refresh 后仍保留某轮旧快照，无法从本仓库日志确认；不能据此认定用户未刷新，也不能保证重复刷新必然解决。

0.4.1 的机制：

- `get_server_info(clientTools?, clientUiHash?)` 返回版本、源代码构建指纹、工具契约指纹、UI 源码指纹、进程实例和启动时间。`clientTools` 必须来自当前模型实际可调用的列表；不传就明确为 `not_checked`，不能把服务端自己的 `tools/list` 冒充 ChatGPT 客户端列表。缺少工具时给出确切缺项。`create_application` 若收到不兼容列表，会在写入申请前返回 `CLIENT_TOOLS_MISMATCH`；旧客户端不传列表时保留兼容，但结果明确未核对。
- 所有业务工具结果（包括业务错误）附带同一 `serverInfo`，原生表单中间结果附在 `_meta.serverInfo`。即使版本工具还未进入聊天快照，也能从既有工具响应确认实际后端版本。只读 `GET /version` 提供独立查询，设置 `Cache-Control: no-store`；该端点仍只通过本机或 SSH 转发访问。
- `get_task_queue` 恢复为稳定的清单显示工具，返回完整数据并带 UI 关联，不再要求它的旧调用方紧接着调用新工具；`show_material_checklist` 继续作为等价入口。`open_visa_helper` 恢复为可调用的兼容状态接口。v2/v3 的资源 URI 也指向当前清单，避免资源路径删除导致旧客户端失败。以后不能在同一迭代中直接删掉这些接口。
- 页脚显示实际界面版本、服务版本和指纹。UI 指纹不匹配时暂停材料操作。App 成功渲染清单后调用 App 专用的 `report_ui_ready`；服务端校验构建、UI 指纹和申请更新时间才保存回执。数据返回时 `presentation.status` 仍为 `not_confirmed`，匹配回执后才为 `loaded`；修改答案使旧回执失效。这确认的是组件已接收并渲染数据，不等于用户已阅读。
- 发布检查使用 `node app/scripts/check-release.mjs http://127.0.0.1:18081/mcp` 比对本地与目标服务的版本、代码、工具、UI 指纹，以及 HTTP/MCP 是否为同一实例。可追加一个 JSON 工具名数组文件，核对真实聊天快照。未提供文件时明确标记 `hostInventoryChecked: false`；不能把后端检查通过当成 ChatGPT 宿主验收通过。

回归测试固定覆盖旧入口和参数、旧清单调用、旧资源 URI、客户端缺项提前报错、未传列表不能声称已检查、版本错误不能产生 UI 回执，以及答案变化清除回执。浏览器覆盖三种载入时序和错误 UI 指纹时的实际阻断。发布前用检查脚本对仍运行的 0.4.0 做了反例验证，正确报出版本落后且缺少版本接口，而非误报成功。

0.4.1 已部署并通过发布检查：代码指纹 `0953d8df00d7`、工具契约 `062e060d631b`、UI `9bc6cd059123`。HTTP `/version` 与 MCP 返回同一进程实例；通过实际 Visa Helper 连接和 Secure MCP Tunnel 的既有 `get_application` 调用也返回相同版本和完整代码指纹。当前聊天真实工具快照包含七个流程工具，兼容性检查通过，但仍未发现新增 `get_server_info`；因此「缺少版本查询工具」和「服务仍是旧版」不能画等号。将历史旧快照交给同一检查器，正确拒绝并列出缺少 `ask_next_question`、`show_material_checklist`。后台 Tunnel 保持就绪。自动测试五个文件通过，浏览器三种载入时序及错误指纹阻断通过；本轮没有把这些测试当成 ChatGPT 宿主内已看到清单的证据，实际读取返回 `presentation.status: not_confirmed`。

平台工具元数据刷新是宿主能力，MCP 服务不能强制清空现有聊天的工具快照。发现缺项时保留申请，报告版本/指纹及缺项；更新后按实际工具列表再次核对，不能只回复用户「刷新后再试」。

### 下次遇到版本疑问时

1. 优先调用 `get_server_info`，传入本次聊天实际可调用的 Visa Helper 工具名。也可从当前 `advance_application` 响应里的 `serverInfo` 读取版本；若连统一接口都不可调用，使用 `/version` 检查部署并重新加载连接，不调用已删除的旧接口，不为查询版本另建申请。
2. 开发机运行 `node app/scripts/check-release.mjs http://127.0.0.1:18081/mcp` 核对目标部署；要核对 ChatGPT 工具快照，再追加保存其实际工具名数组的 JSON 文件。只比对工具名不能证明宿主中的参数定义、UI 关联也已更新，仍须核对工具详情和载入回执。
3. 后端指纹落后或不一致时，先检查部署目录、进程及 SSH/Tunnel 目标；后端一致但客户端缺项时，保留申请 ID，再更新连接并重新读取真实工具列表。更新后仍缺项就继续定位连接，不启动问答碰运气。
4. 到终点后按 `complete.presentation` 使用 `get_task_queue`。返回数据但 `presentation.status` 仍为 `not_confirmed` 时，不声称页面已经显示；检查页脚与 `report_ui_ready` 回执。只有匹配当前构建、UI 和申请状态的回执才算已载入。

## 历史：0.4.0 原生表单与独立清单入口

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
6. 在 [ChatGPT Plugins](https://chatgpt.com/plugins) 添加自定义 MCP 服务，Connection 选 **Tunnel**，选择或填入相同 `tunnel_id`。当前原型没有 OAuth，测试时只使用无认证配置和虚构数据。完成连接后，在新对话中选择该应用，通过 `advance_application` 测试创建、完整问答提交、恢复状态及不支持的请求；同时检查嵌入式 UI 和工具结果。真正接入个人申请数据前需要增加用户身份验证及申请归属授权。

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

1. 运行 `app/scripts/start-private-test.sh status` 查看后台状态；若未启动，再进行下一步。脚本会复用能正确返回当前 MCP 的已有 SSH 转发，不需要每次清理端口。
2. 在开发机终端运行：

   ```bash
   cd /home/youngsure/Code/visa-helper
   app/scripts/start-private-test.sh start
   ```

   优先读取本机 `app/.local/tunnel.env` 中的运行密钥；未设置时在交互终端无回显输入。脚本建立或复用 SSH 转发，运行 `doctor` 并在后台启动 tunnel-client，成功后可以关闭终端。`doctor` 对 `/mcp` 返回 HTTP 406 的检查结果是正常的：普通 GET 缺少 MCP 请求所需的头部。
3. 先按本页「下次遇到版本疑问时」核对部署与实际聊天工具。若需重新添加，到 [ChatGPT Plugins](https://chatgpt.com/plugins) 添加自定义 MCP 服务，Connection 选 **Tunnel**，选择与本地 profile 相同的 tunnel；认证选无认证。Tunnel ID 不是 Server URL。不能仅凭工具数量或 Refresh 点击成功认定更新完成。
4. 像普通用户一样说「我想去冰岛旅游，签证材料要准备什么？」。问答阶段留在聊天，由 GPT 根据统一推进接口返回的问题引导；无需用户提到工具、决策树或申请 ID。可用中国护照、居住中国、北京递交、仅赴冰岛旅游、`2027-06-01` 至 `2027-06-10`、已成年、在职的虚构答案。整段已有信息不应重复询问，补齐后显示含在职证明的 12 项材料。核对页脚版本与载入回执，再选择一项材料准备；恢复已有申请时保留原申请 ID。
5. 测试结束后运行 `app/scripts/start-private-test.sh stop`。脚本只清理其管理的进程；复用的外部 SSH 转发仍需单独管理。

如果 ChatGPT 提示“无法连接到 MCP 服务器”，按请求路径逐段检查：先运行后台状态检查；再在开发机执行 `curl --max-time 5 http://127.0.0.1:18081/version`，应立即返回当前版本信息；最后按[镜像部署说明](container-deployment.md)检查腾讯云容器状态和日志。本机端口能建立 TCP 连接却迟迟没有 HTTP 响应时，优先检查 SSH 转发是否失效。连接成功但没有 UI 时，核对清单工具的 UI 关联和实际载入回执；`get_task_queue` 是唯一清单展示入口。

历史 `Unknown tool({"name":"visa_helper.submit_step"})` 表示调用了旧版步骤演示接口；当前保存决策树答案使用 `advance_application` 完整快照。按版本诊断步骤核对实际后端和客户端工具，再决定更新连接还是部署；检查原答案是否保存，避免未经核对重复提交。不能只因用户说已刷新就假定工具快照已经替换。
