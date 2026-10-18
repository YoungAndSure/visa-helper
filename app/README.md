# Visa Helper MCP App

首版在 ChatGPT 中完成一位申请人的材料决策树，走到终点后展示 MCP App 材料工作台。`0.8.2` 的第一阶段统一使用 `advance_application`：逐题回答或整段描述均由 GPT 整理为完整问答快照，服务端校验、保存并从根节点执行 XState，返回明确类型的下一步。问答阶段不加载自建 App。完整约定见 [GPT 与 MCP 问答协议](../docs/interview-protocol.md)。

当前材料依据是用户提供的 **2025 年冰岛旅游审核表**，官方现行要求仍待复核；申请记录按用户实际准备申请处理。工作台支持选择材料、记录「准备中」并回到对话准备这一项；文件上传、生成和完成验收尚未实现。

## 本地运行

需要 Node.js 22。进入 `app/` 后运行：

```bash
npm install
npm start
```

服务默认监听 `127.0.0.1:8787/mcp`。运行 `npm test` 验证完整快照、版本冲突、修正与撤回、分支和回放、清单展示、HTTP 调用及旧接口已删除。用 MCP Inspector 连接本地端点，从 `advance_application` 的 `{"answers":{}}` 开始；根据问题目录提交完整答案和当前 `revision`，遵循 `nextAction`，完成后执行其中的清单展示动作。

## 镜像部署

当前通过 Docker 镜像部署到腾讯云。运行 `scripts/build-image.sh` 构建并导出完整镜像；发布包包含镜像、Compose 配置和校验信息。镜像包括业务代码、XState 和完整决策树配置，不包含本机密钥及申请数据。

使用 `scripts/publish-image.sh` 将已验证镜像推送到腾讯云仓库，成功后生成按摘要固定的 `registry.env`；服务器拉取镜像后用 `deploy/compose.yml` 启动。也保留离线导入方式。数据挂载原有目录，MCP 仍只监听宿主机 `127.0.0.1:18081`。`deploy/container.env.example` 提供数据路径和端口示例；仓库发布使用固定摘要的 `registry.env`，离线发布使用 `runtime.env`。数据目录必须明确配置且已经存在。旧版容器和直接运行 Node 的系统服务已退役。

完整构建、上传、启动、验证和回退步骤见[镜像部署说明](../docs/container-deployment.md)。

## MCP 工具

| 工具 | 用途 |
| --- | --- |
| `advance_application` | 唯一的问答推进接口；创建、只读恢复、完整快照提交，返回问题目录及 `ask/repair/clarify/blocked/complete` |
| `get_task_queue` | 只读展示完成后的 App 材料清单，由 `complete.presentation` 指定；不是第二个问答接口 |
| `start_task` | 选择或恢复材料任务；申请表返回独立 XState 流程 |
| `advance_task` | 读取或推进材料任务，生成填写指引，处理可选辅助检查和自行检查 |
| `get_server_info` | 可选诊断：版本、构建/工具/UI 指纹，以及实际客户端工具列表兼容性 |
| `report_ui_ready` | App 专用载入回执；校验页面和服务版本，区分数据返回与页面载入 |

首次 `advance_application({answers:{}})` 返回申请 ID、`revision`、完整 `questionCatalog`、当前 `answers` 和下一步。已有申请每次提交 `applicationId`、最新 `revision` 和**全部答案**，缺少的键会撤回旧答案；只读恢复时传 `applicationId` 并**省略** `answers`。返回的完整答案是服务端已接受的底稿。格式错误整批拒绝且返回 `repair`；旧版本快照返回 `clarify/REVISION_CONFLICT`，不能覆盖已保存内容。相同快照重传不重复追加历史。业务矛盾会保存并交给决策树返回澄清。

逐题或整段输入均由 GPT 维护相同结构，不分两套模式。GPT 可以依据用户已明确表达的事实修正编码，无法确定选项归属时应澄清，不能为了命中分支改变事实。`complete` 的 `presentation` 指示调用 `get_task_queue` 展示清单；聊天只简短提示选择材料，不重复长清单。由于宿主 UI 模板绑定在工具声明上，问答接口不挂模板；最终展示使用现有只读工具，详见协议中的宿主边界。

服务只注册上表 6 个接口，其中 `report_ui_ready` 仅供 App 使用。七个旧问答或重复入口已删除，内部增量提交方法、原生表单代码及依赖也已删除，不保留接口兼容实现。完整参数、返回值和调用顺序见 [MCP 接口说明](../docs/mcp-api.md)。

清单使用 `ui://visa-helper/material-checklist-v4.html`，无旧资源别名。每次响应附带运行版本与 `serverInfo.interview` 协议信息。`get_server_info` 不传实际客户端工具列表时明确显示未检查；界面载入需独立回执。部署后运行 `npm run check:release -- http://127.0.0.1:18081/mcp` 比对本地与部署指纹；追加工具名 JSON 文件可核对当前聊天快照。新会话应能调用 `advance_application`、`get_task_queue`、`start_task`、`advance_task`，旧会话缺少这些工具时保留申请并报告差异。详见[版本诊断与发布记录](../docs/deployment.md)。

UI 使用 MCP Apps 的 `ui/initialize`、`ui/notifications/tool-result`、`tools/call` 和 `ui/message` 桥；后者由用户点击「在对话中继续准备」触发，带上申请和材料任务 ID。状态写入 `app/data/applications.json`，该路径已忽略提交。

## 当前私有测试与公开接入

本原型已通过 Secure MCP Tunnel 在 ChatGPT 中完成私有交互测试，详见 [部署与测试记录](../docs/deployment.md)。它**不能直接公开到互联网**：尚无用户认证和申请所属关系，知道申请 ID 的调用方可能读取其状态。处理真实个人申请前需实现认证、授权、持久化部署和相应的数据处理方案；在此之前不要输入真实护照或个人材料，也不要把此服务通过公网隧道暴露出去。

当前使用锁定版本的 **XState 5.33.2**。`config/rules/` 中的版本化 JSON 包含问题目录、材料目录和原生 `machine.states` 节点及分支，`config/active.json` 指向新申请使用的版本。`src/decision-machine.js` 注册共享判断函数和任务收集动作，`src/checklist.js` 加载模型、校验答案并调用 XState。新模型不再用材料上的 `when` 反向筛选任务；适用问题分支进入材料节点，收集任务 ID，按原表顺序去重输出。新增分支或材料时，同时在模型中添加或连接对应节点。

新增规则应创建**新的版本文件**并更新 `active.json`。已注册判断函数可由 JSON 引用，配置变化在后续请求生效；新增判断函数需要发布代码。已有申请保留原版本，旧文件不能删除或原地改写。旧 JsonLogic 规则通过受校验的等价 XState 模型兼容读取，运行路径不依赖 JsonLogic；它只作为测试对照依赖存在。当前已有 4,004 组输入与旧求值器做差分比对，覆盖部分回答、成人职业、无业担保、未成年、多国、矛盾与失效分支。

## 决策图与输入回放

在 `app/` 中运行 `npm run decision:graph`，生成 [HTML 决策图](../docs/decision-graph/iceland.html)、[SVG](../docs/decision-graph/iceland.svg)、Mermaid、原生模型 JSON 和可独立加载的 XState 模块。51 个节点、62 条连线从实际运行的机器提取；HTML 支持缩放、节点详情和执行路径定位。初始图使用空输入，停在第一题。

指定输入时运行 `npm run decision:graph -- --answers /path/answers.json`，默认输出到忽略提交的 `.local/decision-graph/`，展示实际经过路径。创建申请与保存答案会记录完整输入、模型与执行实现指纹、输出和逐步跳转，保存在申请的 `evaluations` 中；当前 MCP 状态中的 `decision.evaluationId` 可定位一次求值。`npm run decision:replay -- --application 申请ID --evaluation 求值ID --data /path/applications.json` 可重跑历史输入，核对结果与路径并生成图。省略 `--evaluation` 使用该申请最近一次记录。指纹或版本不匹配时要求使用当时发布的代码和配置，不冒充原版回放。详见[决策图与回放说明](../docs/decision-graph/README.md)。

规则版本与每个文件任务的原表编号一起返回。原表中的多文件条目会拆成独立任务，例如雇主营业执照复印件和在职证明。若答案缺失、超出支持范围或表格本身未说明，服务端不输出看似确定的清单。详见[问题树与任务队列设计](../docs/iceland-checklist-flow.md)。

之后需要核实中国居民赴冰岛旅游路径的官方材料和适用条件，发布有来源和复核日期的规则，再实现第二阶段的材料准备、字段采集、文件生成和递交前检查。

开发结构：`config/` 保存问题、任务和 XState 模型，`src/decision-machine.js` 通过 XState 执行并捕获路径，`src/checklist.js` 加载规则与校验输入，`src/workflow.js` 管理服务端状态和求值历史，`src/server.js` 提供 MCP 工具和 UI 资源，`public/application.html` 是嵌入式 UI。早期演示记录需要新建申请才能使用当前决策树。

## 申根申请表任务

`config/tasks/schengen-form-v1.json` 定义字段、自查项和 XState 流程；`src/tasks.js` 执行流程，任务实例、版本、完整数据和执行历史保存在申请的 `taskProgress.schengen_form`。原 PDF 随时下载；对照表可查看或下载为独立 HTML 网页，用户自行填表。上传是可选的，用户可按自查清单确认填妥和签字后完成。辅助检查由 GPT 读取聊天附件后提交观察结果；服务不保存原附件，也不执行独立 OCR。

生成图：`npm run task:graph`。回放：`npm run task:replay -- APPLICATIONS_FILE APPLICATION_ID`，只读验证配置指纹、每步输入和最终状态，不输出个人字段。[任务流程图](../docs/task-workflow-graph.md)。

聊天测试：刷新 Visa Helper 连接后新开对话，恢复已有申请并打开材料清单，点击第一项“统一申根签证申请表”。可以先下载原表和填写对照表，再点击已填好、选择自行检查、逐项确认并确认签字，最后完成任务。也可选择自愿上传，在聊天中提供文件，由 GPT 辅助检查；不愿继续上传时随时切回自查。其他材料的独立准备流程尚未实现。

### 任务专注界面

选择材料后总清单默认收起，右上角“全部任务”展开后可切换任务，顶部进度只按实际完成项计算。填写对照页通过临时链接在浏览器中独立打开，展示原表编号、已知填写内容或未知项目的填写说明，也能下载为可打印 HTML；用户仍自行填写原 PDF。已有明确申请资料会自动显示在对照页，缺失内容不猜测。此更新不增加工具、不修改任务模型版本，已有任务无需重建。

独立对照页需要配置 `VISA_HELPER_GUIDE_BASE_URL`。默认关闭，默认端口绑定本机；启用后应用单独监听 8788，仅提供只读随机链接，不代理 MCP。公网测试需显式设置 `VISA_HELPER_GUIDE_BIND=0.0.0.0`。当前 IP 加端口测试需 `VISA_HELPER_GUIDE_ALLOW_HTTP=1`；域名部署改用 HTTPS。示例见 `deploy/container.env.example`。链接 15 分钟后或资料变化后失效，点击时会重新获取；浏览器打开由 `ui/open-link` 交给客户端处理。
