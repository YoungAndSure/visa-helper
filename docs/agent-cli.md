# 可替换的 Agent CLI 执行层

## 接口和职责

统一接口是 `AgentRunner.run(prompt: str) -> str`：输入任务提示词，返回 Agent 最终文本。
当前工厂默认创建 `ClaudeRunner`，内部调用 Claude Code CLI；后续替换 DSH 等只需新增实现、
修改工厂，不改前端协议或业务规则。暂不实现 SQL 工具和知识库工具。

在线链路：后端加载国家/签证类型规则 → 每条规则构造提示词与材料清单 → AgentRunner →
Claude（模型、工具执行循环）→ 返回文本 → 业务层校验判定与证据 → 标注 → 汇总报告。
规则覆盖范围由后端确定；Agent 自主决定如何使用已配置工具，但不能自行跳过必查规则。
每条规则一个独立任务，失败不影响后续规则；当前串行执行，尚无材料跨任务缓存。

离线规则生成也通过同一文本接口：读取管理员目录 → 构造来源提示词 → AgentRunner →
校验 JSON/引用 → 草稿 → 人工发布。填表伴侣和旧 `/material-audit/verify` 仍用原模型客户端，
不在这次替换范围内。

模块边界：

- `backend/shared/agent_runner.py`：文本接口、Claude 子进程、配置转交、异常与超时。
- `backend/modules/material_audit/rule_agent.py`：脱敏文件清单、审核提示词、业务 JSON 校验。
- `backend/modules/material_audit/audit_agent.py`：规则选择、逐条执行、错误隔离、报告。
- `backend/modules/rule_generation/service.py`：资料读取、规则生成提示词、来源校验。

## Claude 配置

本机已有 Claude Code 2.1.201；通过本机 `--version` 和 `--help` 核验参数，没有重复安装或升级。

| 环境变量 | 作用 |
| --- | --- |
| `AGENT_PROVIDER` | 默认 `claude`，未知实现明确拒绝 |
| `CLAUDE_CLI_PATH` | 可选可执行文件路径；默认检查 PATH、用户 `.local/bin` 和常见 Homebrew 目录 |
| `CLAUDE_SETTINGS_FILE` | 可选 Claude settings JSON 的绝对路径，权限和命令限制由此管理 |
| `CLAUDE_MCP_CONFIG` | 可选 MCP JSON 的绝对路径，后续 SQL/知识库工具在此加载 |
| `AGENT_MODEL` | 可选模型覆盖；否则使用 Claude 自身模型配置 |
| `AGENT_TIMEOUT_SECONDS` | 默认 300 秒，允许 1..3600 秒，每条规则独立计时 |
| `LOG_ONLY=1` | 强制禁止启动 Agent，包括直接调用 runner |

后端不复制/修改 Claude 的登录凭据、模型地址或用户配置。默认只自动发现用户级 settings，
不加载项目 project/local settings；额外配置由上面的绝对路径显式传入。launchd 不继承终端
环境变量，因此需要在服务运行环境单独配置这些路径，不能仅在终端 export。

Python 里不硬编码命令白名单，不传权限跳过参数。权限、工具、SQL 后续在 Claude 配置维护。
没有人在场批准的工具调用可能被拒绝，runner 会将权限拒绝视为任务未完成，不能自动放权。
临时工作目录不是操作系统沙箱；正式启用需通过服务账号/容器隔离、Claude 权限配置及只读
数据库凭据落实访问边界。hooks/MCP 是管理员信任的可执行配置，需要审核。

## 文本和文件传递

提示词通过标准输入传入，不放 shell 拼接命令、不出现在命令行参数中。通用 runner 不接收
业务对象；规则层将文件清单、规则、输出 Schema 编入提示词，解析最终文本为 RuleDecision。

为了让 CLI 读取 PDF/JPG，规则层每次创建独立临时目录，以生成的文件名保存用户确认后的
脱敏副本（目录私有、文件 0600）。先核对 Base64、文件大小和签名，只提供匿名 material_id，
不传原文件名。正常结束、输出解析失败、异常及受控超时都会删除该目录。
这替代此前“后端只用内存”的实现；不写入规则库、知识库或仓库数据目录。

主机断电、后端进程被强杀可能留下临时目录；生产部署应增加独立临时卷/内存文件系统与
过期清理，当前不承诺崩溃后零残留。使用 `--no-session-persistence` 禁止 Claude 会话保存，
但不能据此保证 Claude 缓存、用户配置的 hooks/MCP 或模型供应商零留存，需另外审计。

必须选择具备所需视觉能力的模型与工具。纯文本读取不能代替图像/版式检查，不能因为 CLI
成功退出就认为视觉审核成功。提示词要求读不到材料或视觉能力不足时 WARNING，不编造证据。
材料与引用均标记为待检查数据，不允许其中的内容成为执行命令的授权。

## 结果与运行边界

内部用 Claude JSON 结果信封，检查退出码、result 类型、success 状态、is_error、权限拒绝及
非空 result 文本；对业务仅返回字符串。业务独立做 JSON Schema 和证据引用校验。
非零退出、异常信封、空输出、非法业务 JSON、超时均为失败，不算材料 FAIL，也不伪造 PASS。

默认单任务时限 300 秒，结束/超时后清理独立进程组中的普通子进程。主动脱离进程组的工具
需要部署级隔离约束，不能仅靠 Python 包装保证。后端不自动重试；Claude 内部的模型重试、
计费与轮数限制遵循其配置，进程超时不代表供应商停止计费。
日志只记录开始、结束状态、耗时，不落提示词、输出正文、stderr 或模型异常正文。

`/healthz` 的 `audit_agent_available` 只表示开关允许且找到 CLI，不验证登录、网络、配置或
视觉能力。旧 `llm_available` 仍表示填表/verify 直连模型配置；`log_only` 用于黑盒测试防付费。
当前本机服务继续 `LOG_ONLY=1`，本轮不修改权限配置、不启用真实调用。

## 验证

`backend/tests/test_agent_runner.py` 用合成 CLI 启动真实子进程，测试文本传递、配置转交、超时、
异常输出、权限拒绝、临时文件清理和 API 到进程完整链路。规则编排和生成来源校验测试继续保留。
`tests/blackbox/` 检查 LOG_ONLY 与两个可用性字段，避免误触真实模型。
这些测试不消耗模型额度，不代表已经完成真实 Claude 的登录、图片读取和准确率联调。

参考：[Claude 非交互调用](https://code.claude.com/docs/en/headless)、
[Claude CLI 参数](https://code.claude.com/docs/en/cli-usage)。
