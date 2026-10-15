# Visa Helper MCP App

首版在 ChatGPT 对话中完成一位申请人的材料决策树，走到叶子节点后才展示 MCP App 材料工作台。当前规则来自用户提供的 **2025 年冰岛旅游审核表**，仅供模拟。问答阶段没有自建网页或表单；ChatGPT 可以逐题询问，也可以从整段旅行计划提取明确的事实，调用 `submit_answers` 推进决策树，直到缺少信息才继续问用户。材料工作台支持选择材料、记录「准备中」并回到对话准备这一项；文件上传、生成和完成验收尚未实现。

## 本地运行

需要 Node.js 22。进入 `app/` 后运行：

```bash
npm install
npm start
```

服务默认监听 `127.0.0.1:8787/mcp`。运行 `npm test` 验证问题分支、任务生成和 MCP 工具。用 MCP Inspector 连接本地端点，从 `create_application` 开始；答案完整后调用 `get_task_queue` 查看 UI 资源和工具结果。

`deploy/compose.yml` 提供与旧版服务隔离的 Docker 部署：容器内监听 `8787`，宿主机仅在 `127.0.0.1:18081` 暴露原型。若服务器无法访问 Docker Hub，也可使用 `deploy/visa-helper-mcp.service` 在独立目录运行 Node；该服务同样仅监听本机 `18081`。两种方式都只用于远程运行验证，不能作为公开的 ChatGPT 连接地址。

## MCP 工具

| 工具 | 用途 |
| --- | --- |
| `open_visa_helper` | 兼容旧入口，返回继续对话的下一步，不加载 UI |
| `create_application` | 为一位申请人创建模拟申请，返回第一组问题 |
| `get_application` | 读取服务端状态并恢复申请 |
| `get_questions` | 返回下一题、当前缺失问题和完整问题目录，不加载 UI |
| `submit_answers` | 提交一个或多个明确答案，推进到缺少信息的位置或叶子节点；可更正答案 |
| `get_task_queue` | 仅在叶子节点展示 MCP App 材料清单和任务入口 |
| `start_task` | 选择一项适用材料，保存准备中状态并返回该材料的原表说明 |

每次结果中的 `nextAction` 明确下一步：`answer_or_ask` 先用对话中已知事实代答、否则提问；`clarify` 澄清矛盾；`call_tool` 在叶子调用 `get_task_queue`；`choose_task` 提示用户从工作台选择任务。完整清单通过工具结果 `_meta.application` 提供给 UI，模型只收到数量和下一步，避免在聊天中重复长清单。

UI 使用 MCP Apps 的 `ui/initialize`、`ui/notifications/tool-result`、`tools/call` 和 `ui/message` 桥；后者由用户点击「在对话中继续准备」触发，带上申请和材料任务 ID。状态写入 `app/data/applications.json`，该路径已忽略提交。

## 当前私有测试与公开接入

本原型已通过 Secure MCP Tunnel 在 ChatGPT 中完成私有交互测试，详见 [部署与测试记录](../docs/deployment.md)。它**不能直接公开到互联网**：尚无用户认证和申请所属关系，知道申请 ID 的调用方可能读取其状态。处理真实个人申请前需实现认证、授权、持久化部署和相应的数据处理方案；在此之前不要输入真实护照或个人材料，也不要把此服务通过公网隧道暴露出去。

当前问题树与文件任务定义在 `config/rules/` 的版本化 JSON 中，`config/active.json` 指向新申请使用的版本。服务端使用开源 `json-logic-js` 执行各节点的条件表达式；`src/checklist.js` 只负责编排问题组、停止条件和任务输出。新增规则时创建**新的版本文件**并更新 `active.json`，服务在下一次请求时读取新配置，无须修改求值代码或重启；已有申请保留原版本，因此旧版本文件不能删除或原地改写。变更后仍需审核规则来源并运行测试。

规则版本与每个文件任务的原表编号一起返回。原表中的多文件条目会拆成独立任务，例如雇主营业执照复印件和在职证明。若答案缺失、超出支持范围或表格本身未说明，服务端不输出看似确定的清单。详见[问题树与任务队列设计](../docs/iceland-checklist-flow.md)。

之后需要核实中国居民赴冰岛旅游路径的官方材料和适用条件，发布有来源和复核日期的规则，再实现第二阶段的材料准备、字段采集、文件生成和递交前检查。

开发结构：`config/` 保存问题与任务规则，`src/checklist.js` 运行规则并产生问题或任务，`src/workflow.js` 管理服务端状态，`src/server.js` 提供 MCP 工具和 UI 资源，`public/application.html` 是嵌入式 UI。旧演示申请可读取，但需要新建申请才能使用决策树。
