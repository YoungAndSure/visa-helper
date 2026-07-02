# visa-helper Chrome extension

## 结构

```
extension/
├── public/
│   ├── manifest.json                 ← Chrome MV3 manifest
│   └── icons/                        ← 16/48/128.png 占位（Phase 0 暂缺，Chrome 用默认图）
├── src/
│   ├── background/
│   │   └── index.ts                  ← service worker 入口
│   ├── content/
│   │   └── index.ts                  ← 注入到 VFS 页面的 content script
│   ├── sidepanel/
│   │   ├── index.html
│   │   └── app.ts                    ← 侧边栏 UI（三个 tab 占位）
│   └── shared/                       ← 后续 phase 添加（applicant 模型、audit 规则、pdf.js 包装）
├── vite.config.ts                    ← @crxjs/vite-plugin
├── package.json
└── tsconfig.json
```

## 开发

```bash
cd extension
npm install
npm run dev
```

Vite 跑在 `http://localhost:5173`，但扩展要装在 Chrome 里。

## 装到 Chrome（开发期手动加载）

1. Chrome → `chrome://extensions/`
2. 右上「Developer mode」打开
3. 「Load unpacked」→ 选 `extension/dist/`（Vite 跑 `npm run build` 之后的产物）
   - 或：装 [Extension Dev Tools](https://chromewebstore.google.com/detail/extensions-reloader) 自动 reload
4. 打开任意 `*.vfsglobal.com/*` 页面，点工具栏的扩展图标，侧边栏应打开
5. DevTools → service worker console 应可见「visa-helper service worker alive」日志

## 与后端通信

`form/backend/` 在 `localhost:8000` 跑着；扩展通过 `host_permissions` 白名单访问 `http://localhost:8000/*`。
Phase 2 起会用 `fetch('/suggest')` 等调用。

## Phase 0 范围

最小验证：
- service worker 能注册
- content script 能在 VFS 页面加载并监听 `focusin`
- 侧边栏能开

不实现：
- 字段推荐
- 材料审核
- 任何 LLM 实际调用

详见 `/home/youngsure/.claude/plans/velvet-tickling-matsumoto.md`。
