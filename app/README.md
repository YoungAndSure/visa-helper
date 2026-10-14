# Visa Helper MCP App

首版目标是在 ChatGPT 中显示独立的 MCP Apps UI，并让用户点击 UI 后由 MCP Server 决定申请状态和下一步。当前实现是**技术闭环原型**：支持中国护照、居住中国、赴冰岛旅游的场景确认、旅行日期记录和进度恢复；尚无已核实的官方签证规则，不进行材料合规判断。

## 本地运行

需要 Node.js 22。进入 `app/` 后运行：

```bash
npm install
npm start
```

服务默认监听 `127.0.0.1:8787/mcp`。运行 `npm test` 验证服务端步骤顺序与校验。可以用 MCP Inspector 连接本地端点，调用 `open_visa_helper` 查看 UI 资源和工具结果。

`deploy/compose.yml` 提供与旧版服务隔离的 Docker 部署：容器内监听 `8787`，宿主机仅在 `127.0.0.1:18081` 暴露原型。若服务器无法访问 Docker Hub，也可使用 `deploy/visa-helper-mcp.service` 在独立目录运行 Node；该服务同样仅监听本机 `18081`。两种方式都只用于远程运行验证，不能作为公开的 ChatGPT 连接地址。

## MCP 工具

| 工具 | 用途 |
| --- | --- |
| `open_visa_helper` | 展示 MCP Apps UI，可选申请 ID |
| `create_application` | 创建申请 |
| `get_application` | 读取服务端状态并恢复申请 |
| `submit_step` | 提交当前步骤；服务端拒绝跳步、无效日期和不支持的场景 |

UI 使用 MCP Apps 的 `ui/initialize`、`ui/notifications/tool-result` 和 `tools/call` 桥。状态写入 `app/data/applications.json`，该路径已忽略提交。

## 当前私有测试与公开接入

本原型已通过 Secure MCP Tunnel 在 ChatGPT 中完成私有交互测试，详见 [部署与测试记录](../docs/deployment.md)。它**不能直接公开到互联网**：尚无用户认证和申请所属关系，知道申请 ID 的调用方可能读取其状态。处理真实个人申请前需实现认证、授权、持久化部署和相应的数据处理方案；在此之前不要输入真实护照或个人材料，也不要把此服务通过公网隧道暴露出去。

之后需要核实中国居民赴冰岛旅游路径的官方材料和适用条件，发布有来源和复核日期的规则，再增加材料准备、字段采集、文件生成和递交前检查。

开发结构：`src/workflow.js` 管理服务端状态，`src/server.js` 提供 MCP 工具和 UI 资源，`public/application.html` 是嵌入式 UI。
