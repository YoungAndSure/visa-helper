# Visa Helper 开发约定

## 流程与自动回归

- 修改 `app/` 下的业务代码、决策树、任务定义、共用流程、检查规则或工具协议后，完成前运行 `npm run test:regression --prefix app`。
- 新增节点、跳转、条件或规则时，补充 `app/test/support/` 中有明确预期结果的场景；不能只从流程图自动生成一条成功路径来证明业务正确。
- `app/test/fixtures/flow-contract.json` 是需审查的结构契约。流程有意变更后，先补充并跑通场景，再运行 `npm run test:flows:update-contract --prefix app`，核对差异并提交。CI 不得自动更新它，不能通过删用例、忽略未覆盖路径或降低覆盖要求消除失败。
- 运行 `npm run task:graph --prefix app` 同步任务图；`task:graph:check` 必须通过。第一阶段图使用 `decision:graph` 更新，`decision:graph:check` 同样必须通过。配置、场景、契约和生成的流程图一起提交。
- 回归报告只使用虚构测试输入，保存在忽略提交的 `app/.local/test-results/`；不连接生产服务，不读取用户申请数据或真实附件。
- 自动化逻辑覆盖不代表 GPT 自然语言理解、真实附件阅读或客户端浏览器交互已验收。报告需区分验证范围。
