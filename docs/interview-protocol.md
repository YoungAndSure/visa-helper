# GPT 与 MCP 的完整问答协议

2026-10-20 更新，协议版本 `1.1`，应用版本 `0.11.0`。第一阶段只使用 `advance_application` 推进申请。GPT 把用户的逐次回答或整段描述整理成完整问答快照；MCP 保存、从根节点运行 XState 决策树，返回有明确类型的 `nextAction`。第二阶段继续使用材料工作台处理文件任务。

## 职责与输入方式

| 角色 | 职责 |
| --- | --- |
| GPT | 理解自然语言；根据问题目录归一答案；维护完整问答；提问、澄清或修正表达；提交完整快照；执行下一步动作 |
| MCP | 提供问题定义；校验完整快照；按版本保存答案与执行轨迹；运行决策树；返回下一步 |
| 决策树 | 定义问题顺序、条件跳转、缺失信息、矛盾出口、默认分支及材料任务 |

逐题回答与整段描述使用相同接口和字段，没有两套状态或模式参数。用户随时可以补充后续分支的信息或修改早先回答。GPT 优先使用已经明确提供的信息，仅向用户补问当前决策需要的信息。清单生成前不打开 MCP App 问卷。

## 当前问题组

`nextAction.questions` 是当前分支问题组中尚未回答的必答题，含题目、类型及规范选项；`group` 给出组ID及标题。`questionId`/`question` 标识首个缺失项，供定位使用，默认展示以完整 `questions` 数组为准。第一组为9项基本情况与行程问题；成年职业、无业资助、未成年同行等分支仅在适用时返回。用户可一次逐项回答、整段描述或部分回答；已知事实不重复提问。每次仍提交完整问答快照，服务端从根重新判断。

## 请求

首次取得问题目录：

```json
{
  "answers": {}
}
```

创建记录后返回申请 ID、规则版本、完整问题目录、当前答案、`revision` 和下一步。即使用户开头已经描述完整计划，GPT 也先取得目录，再按定义整理开头的描述，不让用户重复回答。首次也接受已经按相同规则目录正确编码的完整快照。

已有申请提交完整问答：

```json
{
  "applicationId": "申请 UUID",
  "revision": 1,
  "answers": {
    "nationality": "CN",
    "residence": "CN",
    "occupation": "employed"
  }
}
```

所有答案为字符串。选择题使用 `option.value`，日期使用有效的 `YYYY-MM-DD`，文本最长 120 字符。问题 ID、题目、类型和选项以该申请规则版本的 `questionCatalog` 为准。服务端不接受或执行 GPT 编造的问题 ID 或选项值。

`answers` 是完整替换，不是补丁：保留的键表示现有事实，改变值表示更正，删除键表示撤回。未知或尚未确认的答案不填，不提交 `null`，也不能自行改成“否”。`{}` 明确撤回所有答案，回到第一处问题；不删除申请和历史记录。其他分支的已知答案可以保留，但只有实际路径使用的条件影响本次输出。

同一接口恢复申请：

```json
{
  "applicationId": "申请 UUID"
}
```

**省略 `answers` 表示只读恢复，`answers: {}` 表示清空，两者不同。** 恢复不需要 `revision`，不新增求值历史。已有申请写入必须携带最新 `revision`。新建时不带 `revision`。

`clientTools` 在接口格式上可选，GPT 的首次调用指引要求传入实际可调用的 Visa Helper 工具名，以在创建前检查连接兼容性。不提供时明确标为未检查，GPT 必须自行比对返回的必需工具与实际列表，不能将“未检查”当作通过。诊断工具不属于问答循环。

## 响应

```json
{
  "protocolVersion": "1.1",
  "applicationId": "申请 UUID",
  "revision": 2,
  "ruleVersion": "iceland-tourism-user-checklist-2025-03-06-xstate-1",
  "saved": true,
  "status": "questions",
  "answers": {
    "nationality": "CN",
    "residence": "CN",
    "destination": "IS",
    "purpose": "tourism",
    "occupation": "employed"
  },
  "questionCatalog": [
    {
      "id": "occupation",
      "title": "目前属于哪种情况？",
      "type": "choice",
      "options": [
        { "value": "employed", "label": "在职" },
        { "value": "retired", "label": "退休" },
        { "value": "unemployed", "label": "无业" }
      ]
    }
  ],
  "nextAction": {
    "type": "ask",
    "questionId": "applicationCity",
    "question": {
      "id": "applicationCity",
      "title": "计划在哪个中国城市递交申请？",
      "type": "text"
    },
    "group": { "id": "basic", "title": "基本情况与行程" },
    "questions": [
      { "id": "applicationCity", "title": "计划在哪个中国城市递交申请？", "type": "text" },
      { "id": "arrivalDate", "title": "计划何时进入申根区？", "type": "date" },
      { "id": "departureDate", "title": "计划何时离开申根区？", "type": "date" },
      { "id": "ageGroup", "title": "出行时申请人是否已满18岁？", "type": "choice", "options": [{ "value": "adult", "label": "已满18岁" }, { "value": "minor", "label": "未满18岁" }] },
      { "id": "otherSchengenCountries", "title": "这次是否还会去其他申根国家？", "type": "choice", "options": [{ "value": "yes", "label": "是" }, { "value": "no", "label": "否" }] }
    ],
    "instruction": "一次列出这一组全部未答题；接受部分回复，只追问剩余缺口。"
  }
}
```

示例只摘录一个目录问题；实现每次返回该申请的完整目录，避免恢复后缺少定义。响应另含 `decision`、GPT 操作指引、兼容性检查和 `serverInfo`。目录与回答均以当前返回为准，不从聊天里猜字段编码。`status` 是已保存申请的决策状态；`nextAction` 是这次请求应如何处理，优先解释 `nextAction`。例如无效提交被拒绝后，已保存状态仍可能为 `tasks_ready`，但下一步是 `repair`，不能因此显示旧清单并宣称已更正。

`applicationId` 与 `revision` 由服务端管理。`saved: true` 表示该完整快照已经接受，重复相同快照不会再增加版本或历史；`saved: false` 表示只读恢复或提交被拒绝。被拒绝时返回的是已保存的答案，不是此次尝试提交的快照。GPT 应保留本次修改意图，修正后重新提交完整目标快照。

## 下一步动作

| `type` | 含义 | GPT 行为 |
| --- | --- | --- |
| `ask` | 当前公共问题组尚有必答项 | 读取 `questions` 和 `group`；先提交已有明确事实，再将剩余问题及选项一次编号列出，允许部分回复；仅在用户主动要求时逐题提问 |
| `repair` | 字段未知、选项值错误、日期或文本格式不合法 | 读取逐字段 `issues`；能依据既有事实无歧义修正则直接修正并重交，否则澄清；整个提交未保存 |
| `clarify` | 答案在业务上矛盾，或完整快照版本过旧 | 读取 `code`、`reason`、`instruction`；澄清矛盾，或结合最新答案重新组织快照 |
| `blocked` | 路径不支持或规则要求人工复核 | 解释原因，不绕过决策树生成清单 |
| `complete` | 决策树完成，材料任务已生成 | 执行 `presentation` 中的清单展示动作；简短提示用户点击一项材料开始 |

`repair.issues` 包含 `code`、`message`、相关 `questionId`，选项不合法时包含可用 `options`。接口一次报告全部格式错误，不静默丢掉错误字段，也不保存部分问答。第一次提交即无效时不创建申请，返回 `applicationId: null`、`revision: 0` 和当前规则目录；修正后重新创建。

格式校验通过、但日期前后矛盾或婚姻状态与担保人不一致时，完整快照会保存并留下执行历史，下一步为 `clarify`。这是决策树的业务出口，与未保存的格式错误不同。默认或 else 分支由模型配置决定，GPT 不能自行选择跳过。

`REVISION_CONFLICT` 不写入数据、不增加历史。返回最新完整答案和版本，GPT 将用户本次明确变更整合到这个底稿上，再提交完整快照；不得把旧快照换个版本号原样重试。所有问答写入统一经过完整快照接口，不存在增量写入入口。

自动修正仅限同一事实的表达与编码。例如用户说“退休了”，可把错误编码“已退休”改成 `retired`；不能把“偶尔接项目、没有固定单位”擅自归为“无业”。无法解释的分支应澄清或按规则阻断，不为了运行成功篡改事实。收到相同未解决动作时停止自动重试，向用户说明缺失信息。

## 清单展示与宿主边界

推进接口不声明 UI 模板，避免每次问答都挂载网页。`complete` 示例：

```json
{
  "type": "complete",
  "taskCount": 12,
  "presentation": {
    "tool": "get_task_queue",
    "arguments": { "applicationId": "申请 UUID" }
  }
}
```

这是一个问答推进接口，加一个现有的只读展示动作；不再需要单独创建、拉题、逐题表单或提交补丁的调用链。材料选择仍由 `start_task` 处理，不属于第一阶段问答。

[OpenAI 官方工具参考](https://developers.openai.com/plugins/reference) 将 UI 模板入口定义在工具声明的 `_meta.ui.resourceUri` 上，未确认每次结果动态挂载模板的行为。因此本版不声称一个工具既不挂问卷又能自行弹出清单。GPT 按返回的 `presentation` 调用固定清单展示工具；若客户端没有这个工具，报告版本及接口缺失，保留申请，不声称清单已经显示。清单 UI 的实际载入继续由 `report_ui_ready` 回执确认，工具成功不等于界面已显示。

本版默认由 GPT 在聊天中一次列出当前组的全部未答问题。原生表单入口及专用代码已删除；以后若需要原生表单展示，必须由同一套完整问答协议协调。

## 持久化与回放

每份申请保存 `answers`、单调递增的问答 `revision`、固定 `ruleVersion` 及 `evaluations`。每次接受不同快照，从模型入口重新执行，保存完整输入、输出、经过节点、条件判断及模型和执行代码指纹。撤回答案也记录新的完整快照。任务按本次路径重新计算，失效任务不能继续选取；完整清单变化时清除已移除任务的进度，保留仍适用任务的进度。UI 回执在问答变化后失效。

只读恢复、相同快照重传、格式拒绝和版本冲突不会追加执行历史。保留先前历史，不记录用户聊天原文。回放使用指定求值的完整输入，不通过重新调用 GPT 来还原。

已有问答记录没有 `revision` 时按 `0` 读取，首次修改递增为 `1`；不批量改写数据。当前仅保留 `advance_application`、`get_task_queue`、`start_task`、`advance_task`、`get_server_info` 和 App 专用 `report_ui_ready` 六个接口；旧的单独创建、查询、补丁提交、原生表单及重复清单入口已删除，不提供转发或别名。完整说明见 [MCP 接口](mcp-api.md)。

## 验收

- 空快照获得申请 ID、完整问题和选项，问答阶段无 UI 绑定。
- 逐题与整段提取后的完整快照，得到相同的最终答案、路径及材料。
- 提前提供后续分支答案时不重复提问；修改早先答案时重新选择路径。
- 删除一个字段和提交空快照均撤回答案；省略整个 `answers` 只读恢复。
- 错误选项、无效日期和未知字段一起报告，完整提交不部分落盘；已有事实可以修复编码后重交。
- 旧版本及并发写入可触发版本冲突，不覆盖最新数据。
- 矛盾、超出范围、人工复核有明确动作；完成时只交接清单展示。
- 历次完整输入可回跑；更正或撤回不影响先前的求值记录。
