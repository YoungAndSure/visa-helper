# Visa Helper

Visa Helper 的新方向是运行在 ChatGPT 中的签证申请助手：MCP Server 管理申请状态与步骤，MCP Apps UI 负责交互，ChatGPT 负责对话辅助。

- [产品方案](docs/product-plan.md)
- [当前方案与开发进度](docs/development-status.md)
- [新应用与运行说明](app/README.md)
- [MCP 接口说明](docs/mcp-api.md)
- [GPT 与 MCP 完整问答协议](docs/interview-protocol.md)
- [问题树设计与 XState 选型](docs/iceland-checklist-flow.md)
- [申请表任务流程图](docs/task-workflow-graph.md)
- [护照任务流程图](docs/passport-task-workflow-graph.md)
- [共用任务架构](docs/shared-task-workflows.md)
- [全部材料任务与流程图](docs/material-task-workflows.md)
- [流程自动回归与迭代约定](docs/automated-regression.md)
- [镜像构建与部署](docs/container-deployment.md)
- [ChatGPT 部署前检查](docs/deployment.md)
- [旧代码归档](archive/README.md)

当前 `app/` 支持问答生成清单及冰岛清单全部25种任务，按申请人分支展示适用项，复用准备、草稿、自查及可选辅助检查流程。MCP 不接收原始附件；辅助检查由 GPT 读取聊天中用户自愿上传的文件后报告。整套清单规则仍待官方核实，服务尚无用户认证，当前仅作私有测试。
