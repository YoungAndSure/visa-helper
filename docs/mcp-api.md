# Visa Helper MCP 接口

应用版本 `0.7.0`，问答协议 `1.0`。MCP 服务仅注册以下 **5 个工具**，其中 4 个供 GPT 调用，1 个仅供 App UI 调用。问答全过程只使用 `advance_application`；其他接口分别负责展示、材料处理和诊断。

## 接口总览

| 接口 | 调用方 | 作用 | 是否修改申请 |
| --- | --- | --- | --- |
| `advance_application` | GPT | 创建或恢复申请，取得问题与选项；提交完整问答，运行决策树并返回 `nextAction` | 创建和提交时修改；恢复只读 |
| `get_task_queue` | GPT 或 App UI | 展示材料清单 App，或刷新其完整任务数据 | 否 |
| `start_task` | GPT 或 App UI | 选择清单中的一项材料，记录为准备中，取得该项要求 | 是，修改任务进度 |
| `get_server_info` | GPT 或 App UI | 查询版本、构建、工具、规则和 UI 指纹；检查当前客户端工具是否齐全 | 否 |
| `report_ui_ready` | 仅 App UI | 清单渲染完成后发送回执，校验服务和页面版本 | 是，仅写入载入回执 |

## advance_application

唯一的问答推进接口，逐题回答与整段描述使用相同结构。

**输入字段**：

- `applicationId`：申请 UUID。创建时省略，恢复和后续提交时提供。
- `revision`：服务端返回的最新问答版本。修改已有申请时必须提供；创建和只读恢复时省略。
- `answers`：完整的 `问题ID → 标准字符串答案` 映射。选项使用 `value`，日期使用 `YYYY-MM-DD`。
- `clientTools`：可选的实际可调用 Visa Helper 工具名列表。GPT 首次调用应传入，用于在创建前发现连接工具缺失。

**三种调用**：

```json
{ "answers": {} }
```

创建申请，返回申请 ID、完整 `questionCatalog`（问题、类型、选项）、当前答案、版本、当前位置和下一步。

```json
{ "applicationId": "申请 UUID" }
```

只读恢复，取得已保存的完整问答与下一步，不新增执行历史。

```json
{
  "applicationId": "申请 UUID",
  "revision": 1,
  "answers": { "nationality": "CN", "occupation": "employed" }
}
```

用完整快照替换已有问答；省略的答案会撤回。已有申请显式提交 `answers: {}` 会撤回全部答案；与省略整个 `answers` 的只读恢复不同。

**返回**：`applicationId`、`revision`、`ruleVersion`、`saved`、完整 `answers`、`questionCatalog`、`decision`、`nextAction`，以及来源说明和服务诊断信息。

`nextAction.type` 为 `ask`（补问）、`repair`（格式修正）、`clarify`（澄清或版本冲突）、`blocked`（停止）或 `complete`（清单已生成）。完成时按 `nextAction.presentation` 调用展示接口。无效字段整批拒绝，过期版本不能覆盖最新答案。不存在的申请等工具错误返回 `isError: true`、`error` 和 `blocked` 动作。完整交互规范见[问答协议](interview-protocol.md)。

## get_task_queue

**输入**：`{ "applicationId": "申请 UUID" }`。

只在决策树完成后调用，绑定 `ui://visa-helper/material-checklist-v4.html`，让宿主显示清单 App。返回完整 `application`，包括适用任务、当前任务、任务状态和材料原表说明；下一步为 `choose_task`。App 也通过它刷新清单。

该接口不负责收集答案，不推进决策树，不创建材料文件。问题尚未答完时返回 `QUESTIONS_INCOMPLETE`。响应中的 `presentation.status` 只有在 App 发送有效载入回执后才为 `loaded`；数据返回成功不能证明界面已经显示。

## start_task

**输入**：`{ "applicationId": "申请 UUID", "taskId": "任务ID" }`。

检查任务仍属于当前清单，将它标为 `in_progress`，保存为当前任务。返回更新后的申请、该任务的原始要求，以及 `nextAction.type: work_on_task`，供 GPT 继续帮助用户准备这一份材料。

问题未完成时拒绝；任务不在当前清单中时返回 `TASK_NOT_FOUND`。这个接口只开始准备，不表示文件已收集或任务已完成。文件上传、生成与完成验收尚未实现。

## get_server_info

**输入**：可选 `clientTools`（实际可调用工具名数组）、`clientUiHash`（当前页面指纹）。空对象也可调用。

返回 `serverInfo`：应用版本、进程实例、构建指纹、工具契约指纹、实际工具列表、必需工具、问答协议、规则及 UI 指纹。另返回 `compatibility`，表示客户端工具和页面是否与服务一致；不传工具列表时明确为 `not_checked`。

它用于诊断，不参与问答状态流转，不创建申请。这里的客户端一致性检查不提供已删除接口的兼容实现。

## report_ui_ready

**输入**：

```json
{
  "applicationId": "申请 UUID",
  "uiSourceHash": "64位页面指纹",
  "buildHash": "64位服务构建指纹",
  "applicationUpdatedAt": "渲染时的申请更新时间"
}
```

`applicationUpdatedAt` 在输入格式上可选，当前 App 会提供。清单 DOM 渲染完成后由 App 自动调用，GPT 不调用。验证页面、服务及申请状态是否一致，然后保存载入时间并返回 `uiReceipt`。版本或状态不一致时拒绝回执。

## 已删除的入口

以下接口不再注册，不保留转发、别名或补丁语义：

`open_visa_helper`、`create_application`、`get_application`、`get_questions`、`submit_answers`、`ask_next_question`、`show_material_checklist`。

原生表单专用代码及依赖已删除；旧的 `application-v2.html`、`task-workspace-v3.html` 资源别名也已删除。已有的有效问答申请可通过统一接口及其申请 ID 恢复，数据与历史记录不会因删除接口而清空。旧连接需重新加载工具列表才能使用当前接口。

## 调用顺序

```text
advance_application：取得目录、提交完整问答、根据 nextAction 循环
    ↓ complete.presentation
get_task_queue：展示清单
    ↓ 用户选择材料
start_task：开始准备所选文件
```

`get_server_info` 随需诊断；`report_ui_ready` 由页面自动回报，不增加用户问答步骤。
