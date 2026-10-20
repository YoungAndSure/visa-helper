# 非配偶担保人签署的担保函任务流程

由实际任务配置生成，不包含申请人数据。

任务 ID：`sponsorship_letter`；流程：`draft-v1`；版本：`sponsorship_letter-v1`。

```mermaid
stateDiagram-v2
    [*] --> prepare
    prepare: 整理资料与生成填写指引
    prepare --> filling: GUIDE_READY
    prepare --> review_choice: FILLED
    self_check: 自行核对材料
    self_check --> done: FINISH [selfConfirmed]
    self_check --> await_upload: ASSISTED_CHECK
    self_check --> prepare: EDIT
    await_upload: 等待自愿上传
    await_upload --> assisted_check: REVIEW [reviewProvided]
    await_upload --> self_check: SELF_CHECK
    await_upload --> prepare: EDIT
    assisted_check: 核对辅助检查结果
    assisted_check --> done: FINISH [assistedConfirmed]
    assisted_check --> await_upload: RETRY
    assisted_check --> self_check: SELF_CHECK
    assisted_check --> prepare: EDIT
    done: 材料已准备
    done --> prepare: EDIT
    filling: 完善草稿与取得正式材料
    filling --> review_choice: FILLED
    filling --> prepare: EDIT
    review_choice: 选择检查方式
    review_choice --> self_check: SELF_CHECK
    review_choice --> await_upload: ASSISTED_CHECK
    review_choice --> prepare: EDIT
```

完成后仍可 EDIT 返回准备步骤；原检查及完成确认同时清除。

## 检查项目

- 担保人和资助安排一致
- 申请、行程及担保内容已核对
- 担保人本人已签署（由用户本人确认）
