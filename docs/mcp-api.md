# Visa Helper MCP 接口

应用版本 `0.13.0`，问答协议 `1.1`。MCP 服务仅注册以下 **6 个工具**，其中 5 个供 GPT 调用，1 个仅供 App UI 调用。问答全过程只使用 `advance_application`；其他接口分别负责展示、材料处理和诊断。

## 接口总览

| 接口 | 调用方 | 作用 | 是否修改申请 |
| --- | --- | --- | --- |
| `advance_application` | GPT | 创建或恢复申请，取得问题与选项；提交完整问答，运行决策树并返回 `nextAction` | 创建和提交时修改；恢复只读 |
| `get_task_queue` | GPT 或 App UI | 展示材料清单 App，或刷新其完整任务数据 | 否 |
| `start_task` | GPT 或 App UI | 选择、恢复或暂停一项材料 | 是，保留已保存步骤与数据 |
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

`nextAction.type` 为 `ask`（一次返回当前组全部未答必答题 `questions`，默认一起展示）、`repair`（格式修正）、`clarify`（澄清或版本冲突）、`blocked`（停止）或 `complete`（清单已生成）。完成时按 `nextAction.presentation` 调用展示接口。无效字段整批拒绝，过期版本不能覆盖最新答案。不存在的申请等工具错误返回 `isError: true`、`error` 和 `blocked` 动作。完整交互规范见[问答协议](interview-protocol.md)。

## get_task_queue

**输入**：`{ "applicationId": "申请 UUID" }`。

只在决策树完成后调用，绑定 `ui://visa-helper/material-checklist-v4.html`，让宿主显示清单 App。返回完整 `application`，包括适用任务、当前任务、任务状态和材料原表说明；下一步为 `choose_task`。App 也通过它刷新清单。

该接口不负责收集答案，不推进决策树，不创建材料文件。问题尚未答完时返回 `QUESTIONS_INCOMPLETE`。响应中的 `presentation.status` 只有在 App 发送有效载入回执后才为 `loaded`；数据返回成功不能证明界面已经显示。

## start_task

**输入**：`{ "applicationId": "申请 UUID", "taskId": "任务ID", "action": "start" }`。`action` 可省略；`"pause"` 暂停当前材料并回到全部任务。

暂停保留节点、数据、勾选、任务revision和执行历史，只改变工作台活动状态；重新选择原任务从原步骤继续。选择另一材料时，未完成的原活动材料自动标为暂停。暂停不是完成，也不需要清除检查。GPT遇到“等等／暂停”时先用 `advance_task` 保存已明确收集的信息，再调用此接口暂停；页卡会在暂停或切换前保存尚未提交的勾选。

检查任务仍属于当前清单，选择为当前任务；已有进度和完成状态不会重置。清单中的全部材料任务返回各自的 `taskFlow`：独立任务版本、任务 revision、当前节点、完整字段目录、自查目录、填写指引和 `nextAction`。任务还返回 workflow、policy、requirements、acquisition、requiredCoverage、reviewInstructions 和适用的HTML文档信息。护照及直接准备类任务不返回表格网页。

## advance_task

独立材料任务的统一推进接口，目前覆盖冰岛清单中的全部25种任务ID。下方申请表数据约定仅用于 `schengen_form`，护照结构单列。问答仍使用 `advance_application`，两者的 revision 分别维护。

- 只读恢复：`{ "applicationId": "申请 UUID", "taskId": "schengen_form" }`。
- 保存或推进：增加最新任务 `revision`、可选 `event` 和可选 `data`。`data` 是完整快照，省略整个 data 保留旧数据；传入 data 时缺省字段按空值处理，不能作为局部补丁。
- `data.fields`：字段 ID 到英文填写内容的映射，未知项不填，不以示例代替真实资料。字段目录覆盖原表全部编号项目及签字位置。
- `data.checks`：自查项 ID 到布尔值的映射；`filled`、`signed` 只记录用户明确确认。
- `data.review`：可选辅助检查报告，包含 `documentRead`、已读页码、逐项 checks 和 findings（issue、unreadable 或 note）。仅由 GPT 确实读取聊天附件后提交；MCP 不保存原附件，不执行独立 OCR，也不将此结果标为官方审核通过。

返回 `application`、`taskFlow`、`nextAction`。指引的每个字段带 `reference`（原表页码及项目）、`value`、`guidance` 和 `valueStatus`。明确的已保存任务字段优先；可直接确定的申请答案（现居中国且中国国籍、旅游目的、仅冰岛目的地及已确认日期）自动用于展示，不猜测首入国、入境次数、出生国等未知信息。派生展示不改写任务快照；申请变化时仍要求重新核对。

工作台分为清单总览与任务页卡。总览展示全部适用材料、已完成数量、整体进度及待准备/准备中/已暂停/已完成状态。选择后进入单项任务页卡，仅展示当前材料、阶段进度和步骤；“全部任务”保存并暂停未完成任务后返回总览。任务完成同样返回总览，不自动启动下一项。任务中可通过链接在浏览器打开独立填写对照页：已知项目显示填写内容，未知项目直接显示说明；通过宿主下载通道输出可独立打开、可打印的 HTML 网页，内容使用文本节点转义。

事件只能从返回的 `nextAction.events` 选择：`GUIDE_READY`、`FILLED`、`SELF_CHECK`、`ASSISTED_CHECK`、`REVIEW`、`FINISH`、`RETRY`、`EDIT`。

原 PDF 始终可下载；指引可包含待确认项。自行检查允许不提供个人字段、不上传文件完成。FINISH 要求填妥、签字及全部自查项确认；辅助检查分支还要求报告覆盖四页、各检查项通过、无未解决错误或模糊项。记录区分 `user_self_check` 与 `assistant_reported_review`，均由用户最终确认。任何辅助检查步骤可切回自行检查。

修改填写内容需先 EDIT，清除旧检查和确认；修改申请问答也会令任务回到整理资料并提示重新核对。过期 revision、非法字段、越序事件和完成条件不足均拒绝保存。完整执行历史包含配置版本、指纹、事件、数据快照、起点和终点，可离线回放。[任务流程图](task-workflow-graph.md)。

### 护照任务数据

相同接口使用 `taskId: "passport"`，只读及完整快照语义与申请表相同。`data` 格式如下：

```json
{
  "fields": { "issueDate": "2020-06-01", "expiryDate": "2030-06-01" },
  "checks": { "issued_within_ten_years": true, "validity": true, "blank_pages": true },
  "prepared": false,
  "confirmedDetails": false,
  "review": null
}
```

- `fields` 仅允许上述两个有效日历日期，格式 `YYYY-MM-DD`，都可省略。不得提交姓名、护照号码、图片或文件链接。
- `checks` 保存用户自行核对的明确结果。`prepared` 是用户对原件及按清单要求的递交材料已准备好的确认。自查可在不提供日期或文件时完成，但全部检查项和 prepared 必须明确为 true。
- `review` 为 null 或 `{documentRead:true, checks:{...}, findings:[...]}`。检查项 ID 与目录一致，findings 的 severity 为 issue、unreadable 或 note；可选 fieldId 只能为 issueDate 或 expiryDate。只在实际读取上传资料后记录，不含原文件和物理页码推断。
- 辅助检查完成必须有两项日期、无失败的服务端日期核对、报告的两项日期检查通过，且用户确认 `confirmedDetails:true`、`checks.blank_pages:true` 及 `prepared:true`；资料页照片不能代替空白页确认。未解决错误或模糊项阻止完成。
- 返回 `automaticChecks`，按已确认的预计入境日检查签发后10年，按预计离境后3个日历月检查有效期。未知不算自动通过；已知失败不能用勾选覆盖。`nextAction.questions` 与 `checkCatalog` 包含问题及指引，供 GPT 提问。
- 事件为 SELF_CHECK、ASSISTED_CHECK、REVIEW、FINISH、RETRY、EDIT，以当前 nextAction.events 为准。重试上传会清除旧报告和确认；检查阶段修改日期需先 EDIT。问答变化也会清除旧检查，保留必要日期笔记，并要求重新核对。历史记录保存当时行程日期以支持确定性回放。

护照是一个任务，两条检查路径共用任务实例和完成状态，不要求填写或签署表格。流程图见[护照任务流程](passport-task-workflow-graph.md)。

### 共用材料任务数据

除申请表与护照外，其他23种任务使用下列完整快照。任务字段名、检查项及覆盖ID必须以返回目录为准，不能跨任务复用数据。

```json
{
  "fields": {},
  "checks": {},
  "prepared": false,
  "confirmedDetails": false,
  "rows": [],
  "review": null
}
```

- fields 为任务目录ID到字符串；日期为YYYY-MM-DD，金额为非负数值字符串。
- rows 只用于 daily_itinerary，每项为 date、可选 location、plan、transport、accommodation；其余任务拒绝非空rows。
- review 为 null，或 `{documentRead:true, coverage:[读取范围ID], checks:{检查ID:true}, findings:[...]}`。检查项、范围和finding.fieldId均校验是否属于当前任务。
- 自查完成要求checks中所有检查项为true且prepared为true；辅助检查要求文件证据项在review.checks通过，用户本人确认项在data.checks通过，coverage包含全部requiredCoverage，confirmedDetails及prepared为true，无未解决的issue或unreadable。
- automaticChecks 的已知失败阻止完成；缺少自动核对数据显示unknown，不能把它当作服务端已核实。
- 取得材料流程增加ACQUIRE与READY；仅保存取得指引步骤，不代表执行外部购买或办理。草稿流程提供GUIDE_READY与FILLED，可直接用已有材料进入检查。实际可用事件以nextAction.events为准。
- 各任务分别保存progress及revision。新增接口为零，仍复用start_task/advance_task。申根表与护照原版本及指纹不变，原实例无需重建。

HTML指引的统一返回保持 `nextAction.type: open_url`，标题按任务生成，原步骤保存在taskAction；网页内容和下载不再限定申根表。取得网页不代表任务完成。详见[共用任务架构](shared-task-workflows.md)。

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

## 独立填写对照页

MCP 负责把已知信息整理成填写对照页并返回 URL；GPT 或用户负责打开网页。模型不需要从隐藏元数据提取链接，也不由 MCP 控制浏览器。

在 `start_task` 或 `advance_task` 的整理资料、等待填写阶段，若已配置网页入口，外层返回：

```json
{
  "nextAction": {
    "type": "open_url",
    "url": "生成的预填网页 URL",
    "expiresAt": "到期时间",
    "title": "申请表填写对照页",
    "placement": "right",
    "taskAction": { "type": "prepare_guide" }
  }
}
```

GPT 读取 `open_url` 后调用当前客户端的原生浏览器工具；用户希望自行打开或客户端不能打开时，提供准确的可点击链接。`taskAction` 保留当前业务步骤，打开网页不改变任务状态。其他步骤保留其业务 `nextAction`，同时提供模型可见的 `guidePresentation`，供用户要求重新打开时使用。

卡片展示普通链接；“让助手打开填写对照页”通过 `ui/message` 把用户意图交给当前会话，GPT 再读取任务获得 URL。不使用 `ui/open-link` 的默认浏览器请求冒充已在右侧显示。打开请求返回 queued 时应明确尚未确认显示。点击操作和失败提示显示在卡片顶部。

App 专用 `_meta` 仍可包含 `guideDocument` HTML；下载在该字段缺失时使用 `guidePresentation.url` 的 `resource_link`。这兼容客户端省略私有元数据的情况，不增加 MCP 工具或修改任务模型版本。

独立网页监听器与 MCP 分离，仅允许 GET/HEAD `/guides/随机令牌`，不开放 `/mcp` 或 `/version`。令牌 15 分钟有效，服务重启、申请 revision 或任务 revision 改变后失效。页面不缓存、不索引、不加载第三方脚本；链接持有人可读取该次指引，不应转发。HTTP 的 IP 加端口入口仅为当前用户明确选择的临时测试方式；正式入口使用 HTTPS。

## 0.12.0 任务后台上下文与清单返回

清单及材料结果增加 `handoff`，协议标识 `visa-helper-task-context/1`。其中包含申请/任务定位、当前任务revision和节点、工作台视图（task/checklist）、服务端nextAction；清单视图包含任务名称及done/paused等状态。它不复制个人字段、完整问答或附件。页卡点击后先执行MCP，再将这段结果同步至宿主后台模型上下文，随后发送“准备护照”等短动作。GPT据此继续nextAction，必要时用advance_task读取细节；不重复start_task，不向用户展示内部编号或要求复制工具指令。

优先使用标准 `ui/update-model-context` 的structuredContent，兼容桥使用 `setWidgetState({modelContent: handoff})`。标准消息ui/message或sendFollowUpMessage只包含动作名称。上下文并不触发推理，不能把后台同步成功当作GPT已经回复。不支持上下文的宿主不得回退为带编号的长提示词。

`advance_task` 完成后的 `application.activeTask/taskFlow` 为null，仍在响应的 `taskFlow` 返回刚完成任务以便核验。外层 `nextAction` 为choose_task并含completedTaskId及get_task_queue展示动作。页卡直接渲染完整清单；GPT在聊天中完成任务后调用展示动作。无新增材料自动开始。暂停保留相同节点及确认进度。

`taskFlow.nextAction.questions` 仅在self_check中包含尚未明确通过的检查题。prepare/filling/review_choice/await_upload均为空；填写HTML不嵌自查清单。用户明确填好后先FILLED，再选检查方式；选SELF_CHECK后才在对话中互动确认，不能把缺失或未检查项推断为通过。

## 0.13.0 清单与任务页卡

- `taskFlow.progress` 由保存的节点推导，不单独保存百分比或修改任务历史。字段：`stages`（阶段ID与名称）、`currentStage`、`completedStages`、`totalStages`、`complete`。
- 表格/草稿任务为准备材料 → 填写与整理 → 检查与确认；直接提供材料为准备材料 → 检查与确认。自查、等待上传、辅助检查合并在检查阶段，切换路径不虚增进度；编辑退回准备阶段，暂停恢复保留原阶段。进度条显示已完成阶段，只有完成条件通过后才满格。
- `start_task` 的开始、恢复与暂停结果均带 `nextAction.presentation`，调用现有 `get_task_queue` 展示工作台。完成仍使用同一展示动作。GPT在聊天中导航后执行展示动作；页卡内点击已直接更新界面，不重复展示。无新增工具或输入参数。
- 清单总览标记所有材料状态；进入任务页卡后不展示其他材料。返回“全部任务”先保存未提交勾选并暂停，返回过程不发送额外用户消息。
