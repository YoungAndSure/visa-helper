# Visa Helper MCP App

首版目标是在 ChatGPT 中通过对话完成一位申请人的材料决策树，再在独立 MCP Apps UI 中查看文件任务队列。当前实现使用用户提供的 **2025 年冰岛旅游审核表**作为模拟规则：服务返回当前问题组和完整问题目录，页卡每次展示一题；用户也可以在 ChatGPT 对话中一次写出旅行计划，由 ChatGPT 提取明确的答案并通过 `submit_answers` 保存，随后只追问缺失项。规则按年龄、职业、担保和多国行程生成文件任务。规则尚未核实为现行官方要求，不进行真实申请的材料合规判断，也尚未实现第二阶段的文件收集和制作。

## 本地运行

需要 Node.js 22。进入 `app/` 后运行：

```bash
npm install
npm start
```

服务默认监听 `127.0.0.1:8787/mcp`。运行 `npm test` 验证问题分支、任务生成和 MCP 工具。可以用 MCP Inspector 连接本地端点，调用 `open_visa_helper` 查看 UI 资源和工具结果。

`deploy/compose.yml` 提供与旧版服务隔离的 Docker 部署：容器内监听 `8787`，宿主机仅在 `127.0.0.1:18081` 暴露原型。若服务器无法访问 Docker Hub，也可使用 `deploy/visa-helper-mcp.service` 在独立目录运行 Node；该服务同样仅监听本机 `18081`。两种方式都只用于远程运行验证，不能作为公开的 ChatGPT 连接地址。

## MCP 工具

| 工具 | 用途 |
| --- | --- |
| `open_visa_helper` | 展示 MCP Apps UI，可选申请 ID |
| `create_application` | 为一位申请人创建模拟申请，返回第一组问题 |
| `get_application` | 读取服务端状态并恢复申请 |
| `get_questions` | 返回当前决策树问题组及选项 |
| `submit_answers` | 保存用户回答，返回下一组问题或文件任务队列；可更正答案 |
| `get_task_queue` | 问题回答完成后读取文件任务队列 |

UI 使用 MCP Apps 的 `ui/initialize`、`ui/notifications/tool-result` 和 `tools/call` 桥。状态写入 `app/data/applications.json`，该路径已忽略提交。

## 当前私有测试与公开接入

本原型已通过 Secure MCP Tunnel 在 ChatGPT 中完成私有交互测试，详见 [部署与测试记录](../docs/deployment.md)。它**不能直接公开到互联网**：尚无用户认证和申请所属关系，知道申请 ID 的调用方可能读取其状态。处理真实个人申请前需实现认证、授权、持久化部署和相应的数据处理方案；在此之前不要输入真实护照或个人材料，也不要把此服务通过公网隧道暴露出去。

当前问题树与文件任务定义在 `config/rules/` 的版本化 JSON 中，`config/active.json` 指向新申请使用的版本。服务端使用开源 `json-logic-js` 执行各节点的条件表达式；`src/checklist.js` 只负责编排问题组、停止条件和任务输出。新增规则时创建**新的版本文件**并更新 `active.json`，服务在下一次请求时读取新配置，无须修改求值代码或重启；已有申请保留原版本，因此旧版本文件不能删除或原地改写。变更后仍需审核规则来源并运行测试。

规则版本与每个文件任务的原表编号一起返回。原表中的多文件条目会拆成独立任务，例如雇主营业执照复印件和在职证明。若答案缺失、超出支持范围或表格本身未说明，服务端不输出看似确定的清单。详见[问题树与任务队列设计](../docs/iceland-checklist-flow.md)。

之后需要核实中国居民赴冰岛旅游路径的官方材料和适用条件，发布有来源和复核日期的规则，再实现第二阶段的材料准备、字段采集、文件生成和递交前检查。

开发结构：`config/` 保存问题与任务规则，`src/checklist.js` 运行规则并产生问题或任务，`src/workflow.js` 管理服务端状态，`src/server.js` 提供 MCP 工具和 UI 资源，`public/application.html` 是嵌入式 UI。旧演示申请可读取，但需要新建申请才能使用决策树。
