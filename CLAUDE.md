# visa-helper — 项目约定

## 提交习惯

- **每完成一个改动就立即 `git commit`**（一个逻辑改动 = 一个 commit），不要攒着。
- commit message 用中英混合、说明改了什么和为什么；结尾带
  `Co-Authored-By: Claude <noreply@anthropic.com>`。
- 只有用户明确说"push"时才推到 origin；平时只在本地 commit。
- commit 前确认没把 `iceland/`、`.venv/`、`*.log`、真实 PII 带进去（见 .gitignore）。
