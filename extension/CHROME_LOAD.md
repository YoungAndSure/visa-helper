# 加载 visa-helper 到 Chrome（开发期）

## 0. 先起后端

```bash
cd /home/youngsure/Code/visa-helper
form/backend/.venv/bin/uvicorn form.backend.app:app --host 127.0.0.1 --port 8000
```

终端应看到 `Application startup complete.` 和 `Uvicorn running on http://127.0.0.1:8000`。
LLM 是否配置看 `/healthz`：`{"status":"ok","llm_available":true|false}`。

## 1. 构建扩展产物

```bash
cd extension
npm install              # 第一次需要，已经装过则跳过
npx vite build           # 产出在 extension/dist/
```

## 2. 在 Chrome 里加载

1. 打开 `chrome://extensions/`
2. 右上角 **Developer mode** 打开
3. 点 **Load unpacked** → 选 `extension/dist/` 这个目录
4. 顶部应出现一张 "visa-helper" 卡片；如有红色 "Errors" 点开看
5. 复制扩展的 **ID**（一串 32 字符的字母），写到
   `extension/public/manifest.json` 里 `web_accessible_resources` / `host_permissions`
   不需要重改，但 dev 期可以记一下

## 3. 验收 Phase 0

扩展已在 `*.vfsglobal.com` 注册 content_script。需要找一个带表单的 VFS 页面测试。

### 3a. 服务 worker 是否活着

1. 打开任意 `*.vfsglobal.com/*` 页面（例如登录前的着陆页也行）
2. Chrome 工具栏点 visa-helper 图标 → 侧边栏应打开
3. 侧边栏自动 ping service worker：红点应变绿，"service worker OK" 文字
4. 点 "Ping 后端 /healthz"：应显示 LLM 已配置/未配置

如果没变绿：
- `chrome://extensions/` → 点 "Service worker" 链接（inspect views）→ Console 看日志
- 期望看到 `[visa-helper/sw] service worker alive`

### 3b. content_script 是否注入

1. 仍在那张 `*.vfsglobal.com` 页面
2. DevTools → Console（页面，不是 service worker）
3. 应立刻看到 `[visa-helper/content] content script loaded <URL>`
4. 点击任意表单字段（input / select / textarea）：
   - Console 不应有报错
   - 切回 service worker 的 Console → 应看到 `[visa-helper/sw] field-focus {selector, label, type}`

### 3c. 后端联调（可选）

```bash
curl -X POST http://localhost:8000/suggest \
  -H 'Content-Type: application/json' \
  -d '{"mode":"form-fill","field_label":"Surname","applicant_context":{"surname_romanized":"DOE"}}'
```

如果一切正常，Phase 0 done。下一步进 Phase 1（VFS 表单 DOM 探测 + fields.json）。

## 已知问题

- **必须登录 VFS 才能填表**：表单往往在登录后；未登录态下 content_script 仍会注入（manifest 按 URL 匹配）但找不到字段
- **VFS 的表单可能在 iframe 里**：DevTools 的 iframe 列表里找 `form service provider` 那个 frame，content script 默认不跨 frame
- **service worker 是 ESM**：Chrome 121+ 支持；如果 chrome 版本老于 121，要把 manifest 里 `"type": "module"` 去掉
