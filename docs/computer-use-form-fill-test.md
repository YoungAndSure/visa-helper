# MCP 字段值与浏览器填表验证

## 验证目标

验证同一个助手能从 Visa Helper MCP 读取申请中的已确认字段，并通过浏览器操作把值填到已打开的网页。测试只用虚构日期，网页不连接签证网站，也没有提交申请的按钮。

## 单字段测试页

在开发机运行：

```bash
node app/fixtures/single-field-form.mjs
```

默认地址为 `http://127.0.0.1:18083/`。页面只有一个 `Planned arrival date (YYYY-MM-DD)` 输入框。输入事件会把当前值发回本地服务；`GET /state` 返回 `{"observed":null}` 或最后捕获的值。测试页源码不包含期望日期，避免浏览器从页面直接获得答案。

如果使用远端托管浏览器，`127.0.0.1` 指向该浏览器所在环境，而非开发机；需为这个仅含虚构数据的测试页建立临时可访问的 HTTPS 地址。结束测试后关闭临时入口。

## 2026-10-14 已完成的本机验证

1. 通过已连接的 Visa Helper MCP 创建虚构申请，记录 `arrivalDate = 2027-06-01`。
2. 再调用 `get_application`，确认 MCP 返回该日期。
3. 在隔离的本机 Chromium 中打开测试页，依据页面截图定位输入框，使用浏览器鼠标点击和键盘输入动作填入 MCP 返回的值。
4. 浏览器截图显示输入框为 `2027-06-01`；测试页 `GET /state` 返回 `{"observed":"2027-06-01"}`。

这证明 MCP 取值和浏览器填入的基本闭环可行。浏览器操作由当前 Codex 会话控制的本机 Chromium 完成，**尚不能据此断言 ChatGPT 原生浏览器模式支持与该自定义 MCP App 同时调用**。

## ChatGPT Work 跨工具验证（2026-10-14）

按 [ChatGPT 浏览器文档](https://learn.chatgpt.com/docs/browser)，在 chatgpt.com 切到 **Work**，新建对话并选用 Visa Helper。使用虚构申请和临时 HTTPS 测试页，要求它先调用 `get_application`，再打开网页填入 `arrivalDate`；无需寻找单独的“Agent 模式”开关。

用户在 Work 中执行后报告：它通过 Visa Helper 的 `get_application` 读取到 `2027-06-01`，通过 Codex 的 `open_in_codex` 以及 Chrome 浏览器和开发者协议打开并填写页面，页面显示 `Value captured`，没有提交申请。开发机独立查询测试页 `/state`，从预先清空的 `{"observed":null}` 变为 `{"observed":"2027-06-01"}`。这验证了当前 Work 会话能在同一任务中结合 Visa Helper MCP 与浏览器操作完成单字段填入。工具记录来自用户对 Work 结果的反馈，页面记录由本地服务独立核对；此次执行路径包含 Chrome 开发者协议，不能据此推断所有 ChatGPT 客户端或纯云端浏览器路径均可用。

正式场景仍需处理用户身份与申请归属、护照字段的人工复核、官网字段映射和最终提交前确认。此测试只验证单个虚构日期，不证明真实签证网站可自动填写。
