# 加载 visa-helper 到 Chrome

> **本仓库 `extension/dist/` 已入仓。**
> 大多数用户 clone 完只需要「Load unpacked → 选 `extension/dist/`」，**无需 npm install，也无需 vite build**。
>
> dist 入仓是有意的：clone 即装，避免每台测试机都要装 Node / 跑 `npm install` / 碰 `@crxjs/vite-plugin` 这类偶尔依赖坑。代价是改了源码后必须本地重 build + 跟 src 一起提交，否则 dist 会僵。

## 0. 先起后端（可选，仅后端验收需要）

```bash
cd /home/youngsure/Code/visa-helper
form/backend/.venv/bin/uvicorn form.backend.app:app --host 127.0.0.1 --port 8000
```

终端应看到 `Application startup complete.` 和 `Uvicorn running on http://127.0.0.1:8000`。
LLM 是否配置看 `/healthz`：`{"status":"ok","llm_available":true|false}`。

如果只要测侧边栏框架（site 检测 + tab 切换 + demo 按钮），完全可以不跑后端。

## 1. 直接加载 dist

1. 打开 `chrome://extensions/`
2. 右上角 **Developer mode** 打开
3. **Load unpacked** → 选 **`extension/dist/`** 这个目录（仓库自带，不需要 build）
4. 顶部应出现一张 "visa-helper" 卡片；如有红色 "Errors" 点开看
5. 复制扩展的 **ID**（一串 32 字符的字母），仅 dev 期记一下用

## 1b. 改了源码 → 重新构建 dist

只有改了 `extension/src/` 下的 TS / `extension/public/` 下的 manifest / `extension/vite.config.ts` 时才需要：

```bash
cd extension
npm install              # 第一次或 lockfile 变更时
npx vite build           # 重新生成 extension/dist/
git add extension/dist/  # 跟源码一起 commit
git commit -m "..."      # 同一次 commit 里 src + dist 一起进
git push
```

`dist/` 改名（每次 build 哈希变）后**不要**只 commit src 不 commit dist——加载时 dist 还是旧版，看不到代码改动。

## 2. 验收 Phase 0

dist 加载成功后：

### 2a. 服务 worker 是否活着

1. 打开任意网页（不需要 vfsglobal）→ 工具栏点 visa-helper 图标 → 侧边栏打开
2. 顶部应该立即出现 site 横幅（"未识别页面"也可以——代表 URL 路由框架已经注入）
3. 切到 **设置** tab → "Ping service worker" 按钮点一下
   - 应变绿："service worker OK (...)"
   - 出错就看 `chrome://extensions/` → visa-helper → "Service worker" 链接 → console
     期望看到 `[visa-helper/sw] service worker alive`

### 2b. content_script 注入（仅 vfsglobal 页面）

1. 打开 `*.vfsglobal.com/*` 页面
2. 顶部横幅应自动识别 site 并切到"伴行填表" tab
3. DevTools → Console 应有 `[visa-helper/content] content script loaded <URL>`
4. 点表单字段 → service worker console 出 `[visa-helper/sw] field-focus {label, type}`

### 2c. demo 模式

未识别页面上，**伴行填表** 视图下方会出现 "demo 按钮组"。点任一按钮（冰岛 / 挪威 UDI …）即可模拟切换 site——用来在没有真表单的页面验证显示框架。

### 2d. 后端联调（可选，需要起步骤 0）

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
- **别 rsync `node_modules/`**：跨机器拷 node_modules 会挂（postinstall 跑的 bin 是平台相关的）。每台机器各自 `npm install`，或者干脆只拷 `dist/`
