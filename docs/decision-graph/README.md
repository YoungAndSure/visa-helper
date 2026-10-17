# 冰岛申请决策图与输入回放

当前模型使用 XState 5.33.2，包含 51 个节点、62 条连线。结构和执行来自同一份版本化模型；问题顺序、阻断结果和材料清单与旧实现做了 4,004 组输入的差分验证。规则来源仍为用户提供的 2025 年审核表。

## 查看决策图

- [离线 HTML 决策图](iceland.html)：浏览器打开即可缩放、选择节点，查看问题、材料引用与条件结果；下拉框定位本次经过的节点。
- [SVG 决策图](iceland.svg)：完整结构，可放大查看。
- [Mermaid 源码](iceland.mmd)：可在支持 Mermaid 的工具中展示。
- [原生 XState 结构 JSON](iceland.machine.json)：与服务端模型的 `machine` 部分一致。
- [可执行 XState 模块](iceland.xstate.mjs)：包含模型和同一组判断／收集函数，只依赖 XState。可复制到开源 Stately Sketch 中查看或演练；直接用 Node 执行时，需要在能解析 `xstate` 包的项目目录中加载。
- [空输入的执行记录](iceland.trace.json)：停在第一题，用于展示记录结构。

HTML 中绿色表示经过的节点与连线，橙色表示停留节点。生成图时不提供输入，就显示第一题等待状态。材料节点引用任务目录中的 ID；不同节点可引用相同 ID，执行结果去重。

## 从模型重新生成

在仓库的 `app/` 目录运行：

```bash
npm run decision:graph
```

图的节点和连线通过 XState 实例的状态节点及跳转提取，由 MIT 开源 Dagre 自动排布；不需要手动维护坐标，也不需要购买可视化平台。生成文件保存在本目录。

指定一份结构化答案，可同时检查执行路径：

```bash
npm run decision:graph -- --answers /path/answers.json
```

文件内容是字段到标准答案的对象，例如：

```json
{
  "nationality": "CN",
  "residence": "CN",
  "applicationCity": "北京",
  "destination": "IS",
  "purpose": "tourism",
  "arrivalDate": "2027-06-01",
  "departureDate": "2027-06-10",
  "ageGroup": "adult",
  "otherSchengenCountries": "no",
  "occupation": "employed"
}
```

该输入到达 `ready`，输出 12 项材料。自定义输入的图和记录默认写入 `app/.local/decision-graph/`，与公开提交的空输入图分开。`--out` 可指定其他目录，`--version` 可指定保留的规则版本。

## 回放一次已保存的求值

创建申请和保存答案时，在服务端申请记录的 `evaluations` 中追加完整输入快照与输出。模型使用的输入是合并后的全部答案，`answerPatch` 只说明当次修改了什么；读取状态不会重复追加历史。MCP 申请状态的 `decision` 返回引擎版本、模型与实现指纹、停留节点和最近求值 ID。

使用对应服务器的数据文件，在安装了开发依赖的环境运行：

```bash
npm run decision:replay -- --application 申请ID --evaluation 求值ID --data /path/applications.json
```

省略 `--evaluation` 使用最近一次求值。回放校验引擎版本、模型指纹和执行实现指纹，检查输出与路径一致后生成带历史路径的图。版本不匹配时，应切换到保留的对应发布构建后再执行。历史求值 ID 与新生成图的输入相对应，不会拿申请的最新答案覆盖旧输入。

回放直接使用结构化快照，不调用 GPT，不需要聊天原文。升级前没有记录的历史无法恢复；旧申请升级后继续提交答案会开始保存求值记录。

## 查看原生 XState 模型

可使用本地部署的 [Stately Sketch](https://github.com/statelyai/sketch)。复制 `iceland.xstate.mjs` 的代码可保留判断函数的实际实现；仅导入 JSON 时，命名的 guard 和 action 仍需绑定对应实现。此迁移已验证导出模块可以只依赖 XState 重现任务选择，Sketch 界面的导入展示需要在其宿主中验收。
