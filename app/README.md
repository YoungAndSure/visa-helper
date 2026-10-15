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
| `create_application` | 为一位申请人创建申请记录，返回下一题和问题目录 |
| `ask_next_question` | 请求原生问题表单，用户接受后保存答案；取消时保留缺失项，不支持时明确回退 |
| `get_application` | 读取服务端状态并恢复申请 |
| `get_questions` | 返回下一题、当前缺失问题和完整问题目录，不加载 UI |
| `submit_answers` | 提交一个或多个明确答案，推进到缺少信息的位置或叶子节点；可更正答案 |
| `show_material_checklist` | 在叶子节点展示 MCP App 材料清单和任务入口 |
| `get_task_queue` | 供 App 加载完整清单和自动恢复状态，不要求用户输入申请 ID |
| `start_task` | 选择一项适用材料，保存准备中状态并返回该材料的原表说明 |

每次结果中的 `nextAction` 明确下一步：`answer_or_ask` 先用已知事实代答，否则调用 `ask_next_question`；`clarify` 澄清矛盾；`call_tool` 在叶子调用 `show_material_checklist`；`choose_task` 提示从工作台选择任务。完整清单通过工具结果 `_meta.application` 提供给 UI，模型只收到数量和下一步。工作台支持初始工具通知、已有 `window.openai` 输出和工具输入三种载入方式，必要时使用申请 ID 自动读取清单。

原生表单使用官方 `@modelcontextprotocol/server` 2.x 与 `@openai/mcp-extensions` 的 `requestFormInput`，由多轮请求协议返回 `input_required` 并接收答案。旧 `open_visa_helper` 已移除，清单使用新资源 `ui://visa-helper/material-checklist-v4.html`。工具变更后仍需更新 ChatGPT 插件连接的工具元数据。

UI 使用 MCP Apps 的 `ui/initialize`、`ui/notifications/tool-result`、`tools/call` 和 `ui/message` 桥；后者由用户点击「在对话中继续准备」触发，带上申请和材料任务 ID。状态写入 `app/data/applications.json`，该路径已忽略提交。

## 当前私有测试与公开接入

本原型已通过 Secure MCP Tunnel 在 ChatGPT 中完成私有交互测试，详见 [部署与测试记录](../docs/deployment.md)。它**不能直接公开到互联网**：尚无用户认证和申请所属关系，知道申请 ID 的调用方可能读取其状态。处理真实个人申请前需实现认证、授权、持久化部署和相应的数据处理方案；在此之前不要输入真实护照或个人材料，也不要把此服务通过公网隧道暴露出去。

当前问题树与文件任务定义在 `config/rules/` 的版本化 JSON 中，`config/active.json` 指向新申请使用的版本。服务端使用开源 `json-logic-js` 执行各节点的条件表达式；`src/checklist.js` 只负责编排问题组、停止条件和任务输出。新增规则时创建**新的版本文件**并更新 `active.json`，服务在下一次请求时读取新配置，无须修改求值代码或重启；已有申请保留原版本，因此旧版本文件不能删除或原地改写。变更后仍需审核规则来源并运行测试。

规则版本与每个文件任务的原表编号一起返回。原表中的多文件条目会拆成独立任务，例如雇主营业执照复印件和在职证明。若答案缺失、超出支持范围或表格本身未说明，服务端不输出看似确定的清单。详见[问题树与任务队列设计](../docs/iceland-checklist-flow.md)。

之后需要核实中国居民赴冰岛旅游路径的官方材料和适用条件，发布有来源和复核日期的规则，再实现第二阶段的材料准备、字段采集、文件生成和递交前检查。

开发结构：`config/` 保存问题与任务规则，`src/checklist.js` 运行规则并产生问题或任务，`src/workflow.js` 管理服务端状态，`src/server.js` 提供 MCP 工具和 UI 资源，`public/application.html` 是嵌入式 UI。旧演示申请可读取，但需要新建申请才能使用决策树。
