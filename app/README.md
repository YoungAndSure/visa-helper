# Visa Helper MCP App

首版在 ChatGPT 中完成一位申请人的材料决策树，走到叶子节点后才展示 MCP App 材料工作台。逐题回答使用官方原生表单工具 `ask_next_question`；整段旅行计划由 ChatGPT 提取明确事实后调用 `submit_answers` 推进。原生表单扩展支持 ChatGPT Work 网页和桌面端；缺少原生表单能力的连接明确回退到普通聊天，不宣称已展示问题框。问答阶段不加载自建 App 网页。当前材料依据是用户提供的 **2025 年冰岛旅游审核表**，官方现行要求仍待复核；申请记录按用户实际准备申请处理。工作台支持选择材料、记录「准备中」并回到对话准备这一项；文件上传、生成和完成验收尚未实现。

## 本地运行

需要 Node.js 22。进入 `app/` 后运行：

```bash
npm install
npm start
```

服务默认监听 `127.0.0.1:8787/mcp`。运行 `npm test` 验证问题分支、原生表单多轮协议、任务生成和 MCP 工具。用 MCP Inspector 连接本地端点，从 `create_application` 开始；答案完整后调用 `show_material_checklist` 查看 UI 资源和工具结果。

`deploy/compose.yml` 提供与旧版服务隔离的 Docker 部署：容器内监听 `8787`，宿主机仅在 `127.0.0.1:18081` 暴露原型。若服务器无法访问 Docker Hub，也可使用 `deploy/visa-helper-mcp.service` 在独立目录运行 Node；该服务同样仅监听本机 `18081`。两种方式都只用于远程运行验证，不能作为公开的 ChatGPT 连接地址。

## MCP 工具

| 工具 | 用途 |
| --- | --- |
| `get_server_info` | 查询服务版本、构建/工具/UI 指纹；提交当前实际工具列表后检查连接兼容性 |
| `open_visa_helper` | 保留旧会话兼容，读取状态和版本，不打开问卷 |
| `create_application` | 为一位申请人创建申请记录，返回下一题和问题目录 |
| `ask_next_question` | 请求原生问题表单，用户接受后保存答案；取消时保留缺失项，不支持时明确回退 |
| `get_application` | 读取服务端状态并恢复申请 |
| `get_questions` | 返回下一题、当前缺失问题和完整问题目录，不加载 UI |
| `submit_answers` | 提交一个或多个明确答案，推进到缺少信息的位置或叶子节点；可更正答案 |
| `get_task_queue` | 稳定的最终清单显示入口，也支持旧版 UI 读取完整数据 |
| `show_material_checklist` | 等价的清单显示入口，持续保留兼容 |
| `start_task` | 选择一项适用材料，保存准备中状态并返回该材料的原表说明 |
| `report_ui_ready` | App 专用的清单载入回执，校验页面和服务版本，区分数据返回与页面载入 |

每次结果中的 `nextAction` 明确下一步：`answer_or_ask` 先用已知事实代答，否则调用 `ask_next_question`；`clarify` 澄清矛盾；`call_tool` 在叶子调用 `get_task_queue` 或可用的等价入口；`choose_task` 提示从工作台选择任务。旧清单接口继续返回完整数据以兼容旧组件，新入口通过 `_meta.application` 提供完整数据。工作台支持三种初始载入方式，并自动关联申请。

原生表单使用官方 MCP 2.x 和 OpenAI 表单 SDK。清单使用 `ui://visa-helper/material-checklist-v4.html`，v2/v3 的 URI 保留兼容。每次响应附带运行版本，不能仅凭 ChatGPT 工具快照或请求成功推断新版已加载。`get_server_info` 不传实际客户端列表时明确显示未检查；界面载入需独立回执。部署后运行 `npm run check:release -- http://127.0.0.1:18081/mcp` 比对本地与部署指纹；追加工具名 JSON 文件可核对当前聊天快照。详见[版本诊断与发布记录](../docs/deployment.md)。

UI 使用 MCP Apps 的 `ui/initialize`、`ui/notifications/tool-result`、`tools/call` 和 `ui/message` 桥；后者由用户点击「在对话中继续准备」触发，带上申请和材料任务 ID。状态写入 `app/data/applications.json`，该路径已忽略提交。

## 当前私有测试与公开接入

本原型已通过 Secure MCP Tunnel 在 ChatGPT 中完成私有交互测试，详见 [部署与测试记录](../docs/deployment.md)。它**不能直接公开到互联网**：尚无用户认证和申请所属关系，知道申请 ID 的调用方可能读取其状态。处理真实个人申请前需实现认证、授权、持久化部署和相应的数据处理方案；在此之前不要输入真实护照或个人材料，也不要把此服务通过公网隧道暴露出去。

0.5.0 使用锁定版本的 **XState 5.33.2**。`config/rules/` 中的版本化 JSON 包含问题目录、材料目录和原生 `machine.states` 节点及分支，`config/active.json` 指向新申请使用的版本。`src/decision-machine.js` 注册共享判断函数和任务收集动作，`src/checklist.js` 加载模型、校验答案并调用 XState。新模型不再用材料上的 `when` 反向筛选任务；适用问题分支进入材料节点，收集任务 ID，按原表顺序去重输出。新增分支或材料时，同时在模型中添加或连接对应节点。

新增规则应创建**新的版本文件**并更新 `active.json`。已注册判断函数可由 JSON 引用，配置变化在后续请求生效；新增判断函数需要发布代码。已有申请保留原版本，旧文件不能删除或原地改写。旧 JsonLogic 规则通过受校验的等价 XState 模型兼容读取，运行路径不依赖 JsonLogic；它只作为测试对照依赖存在。当前已有 4,004 组输入与旧求值器做差分比对，覆盖部分回答、成人职业、无业担保、未成年、多国、矛盾与失效分支。

## 决策图与输入回放

在 `app/` 中运行 `npm run decision:graph`，生成 [HTML 决策图](../docs/decision-graph/iceland.html)、[SVG](../docs/decision-graph/iceland.svg)、Mermaid、原生模型 JSON 和可独立加载的 XState 模块。51 个节点、62 条连线从实际运行的机器提取；HTML 支持缩放、节点详情和执行路径定位。初始图使用空输入，停在第一题。

指定输入时运行 `npm run decision:graph -- --answers /path/answers.json`，默认输出到忽略提交的 `.local/decision-graph/`，展示实际经过路径。创建申请与保存答案会记录完整输入、模型与执行实现指纹、输出和逐步跳转，保存在申请的 `evaluations` 中；当前 MCP 状态中的 `decision.evaluationId` 可定位一次求值。`npm run decision:replay -- --application 申请ID --evaluation 求值ID --data /path/applications.json` 可重跑历史输入，核对结果与路径并生成图。省略 `--evaluation` 使用该申请最近一次记录。指纹或版本不匹配时要求使用当时发布的代码和配置，不冒充原版回放。详见[决策图与回放说明](../docs/decision-graph/README.md)。

规则版本与每个文件任务的原表编号一起返回。原表中的多文件条目会拆成独立任务，例如雇主营业执照复印件和在职证明。若答案缺失、超出支持范围或表格本身未说明，服务端不输出看似确定的清单。详见[问题树与任务队列设计](../docs/iceland-checklist-flow.md)。

之后需要核实中国居民赴冰岛旅游路径的官方材料和适用条件，发布有来源和复核日期的规则，再实现第二阶段的材料准备、字段采集、文件生成和递交前检查。

开发结构：`config/` 保存问题、任务和 XState 模型，`src/decision-machine.js` 通过 XState 执行并捕获路径，`src/checklist.js` 加载规则与校验输入，`src/workflow.js` 管理服务端状态和求值历史，`src/server.js` 提供 MCP 工具和 UI 资源，`public/application.html` 是嵌入式 UI。旧演示申请可读取，但需要新建申请才能使用决策树。
