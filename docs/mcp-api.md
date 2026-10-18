# Visa Helper MCP 接口

应用版本 `0.8.1`，问答协议 `1.0`。MCP 服务仅注册以下 **6 个工具**，其中 5 个供 GPT 调用，1 个仅供 App UI 调用。问答全过程只使用 `advance_application`；其他接口分别负责展示、材料处理和诊断。

## 接口总览

| 接口 | 调用方 | 作用 | 是否修改申请 |
| --- | --- | --- | --- |
| `advance_application` | GPT | 创建或恢复申请，取得问题与选项；提交完整问答，运行决策树并返回 `nextAction` | 创建和提交时修改；恢复只读 |
| `get_task_queue` | GPT 或 App UI | 展示材料清单 App，或刷新其完整任务数据 | 否 |
| `start_task` | GPT 或 App UI | 选择或恢复一项材料；申请表返回独立任务流程 | 是，选择任务；保留已有进度 |
| `advance_task` | GPT 或 App UI | 读取或推进材料任务，保存完整任务数据与执行记录 | 提交时修改，读取不修改 |
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

检查任务仍属于当前清单，选择为当前任务；已有进度和完成状态不会重置。`schengen_form` 返回 `taskFlow`：独立任务版本、任务 revision、当前节点、完整字段目录、自查目录、填写指引和 `nextAction`。其他材料暂时仅返回原表要求。

## advance_task

独立材料任务的统一推进接口，目前实现 `schengen_form`。问答仍使用 `advance_application`，两者的 revision 分别维护。

- 只读恢复：`{ "applicationId": "申请 UUID", "taskId": "schengen_form" }`。
- 保存或推进：增加最新任务 `revision`、可选 `event` 和可选 `data`。`data` 是完整快照，省略整个 data 保留旧数据；传入 data 时缺省字段按空值处理，不能作为局部补丁。
- `data.fields`：字段 ID 到英文填写内容的映射，未知项不填，不以示例代替真实资料。字段目录覆盖原表全部编号项目及签字位置。
- `data.checks`：自查项 ID 到布尔值的映射；`filled`、`signed` 只记录用户明确确认。
- `data.review`：可选辅助检查报告，包含 `documentRead`、已读页码、逐项 checks 和 findings（issue、unreadable 或 note）。仅由 GPT 确实读取聊天附件后提交；MCP 不保存原附件，不执行独立 OCR，也不将此结果标为官方审核通过。

返回 `application`、`taskFlow`、`nextAction`。指引的每个字段带 `reference`（原表页码及项目）、`value`、`guidance` 和 `valueStatus`。明确的已保存任务字段优先；可直接确定的申请答案（现居中国且中国国籍、旅游目的、仅冰岛目的地及已确认日期）自动用于展示，不猜测首入国、入境次数、出生国等未知信息。派生展示不改写任务快照；申请变化时仍要求重新核对。

清单选择任务后默认收起，顶部显示已完成数量和进度，右上角“全部任务”可展开或收起。任务中可查看独立填写对照页：已知项目显示填写内容，未知项目直接显示说明；通过宿主下载通道输出可独立打开、可打印的 HTML 网页，内容使用文本节点转义。

事件只能从返回的 `nextAction.events` 选择：`GUIDE_READY`、`FILLED`、`SELF_CHECK`、`ASSISTED_CHECK`、`REVIEW`、`FINISH`、`RETRY`、`EDIT`。

原 PDF 始终可下载；指引可包含待确认项。自行检查允许不提供个人字段、不上传文件完成。FINISH 要求填妥、签字及全部自查项确认；辅助检查分支还要求报告覆盖四页、各检查项通过、无未解决错误或模糊项。记录区分 `user_self_check` 与 `assistant_reported_review`，均由用户最终确认。任何辅助检查步骤可切回自行检查。

修改填写内容需先 EDIT，清除旧检查和确认；修改申请问答也会令任务回到整理资料并提示重新核对。过期 revision、非法字段、越序事件和完成条件不足均拒绝保存。完整执行历史包含配置版本、指纹、事件、数据快照、起点和终点，可离线回放。[任务流程图](task-workflow-graph.md)。

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
start_task：选择或恢复材料
    ↓ schengen_form
advance_task：填写指引、用户填表、可选检查、用户确认完成
```

`get_server_info` 随需诊断；`report_ui_ready` 由页面自动回报，不增加用户问答步骤。
