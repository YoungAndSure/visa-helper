# visa-helper Chrome extension

## 这玩意是个啥

MV3 Chrome 扩展，目标是给 VFS / UDI 这类签证申请网站加一个"伴行侧边栏"：
- 在表单页识别当前站点（冰岛 / 挪威 …），自动切到对应 fill 助手
- 监听字段 focus，把标签 + 类型上报
- 后续 phase 会接 `/suggest` 后端给建议值 + 给材料做审核

**分发方式**：仓库直接 ship **pre-built `dist/`** — clone 完即可在 Chrome 里 Load unpacked，
不需要 npm、不需要 Node。改了 `extension/src/` 再跑 `npx vite build` 重新生成 dist。

详见 [`CHROME_LOAD.md`](./CHROME_LOAD.md)。

## 结构

```
extension/
├── public/
│   └── manifest.json                 ← Chrome MV3 manifest
├── src/
│   ├── background/
│   │   └── index.ts                  ← service worker 入口（含 get-active-url）
│   ├── content/
│   │   └── index.ts                  ← 注入到 VFS 页面的 content script（focusin 监听）
│   ├── sidepanel/
│   │   ├── index.html
│   │   └── app.ts                    ← 侧边栏 UI：site 横幅 + tabs + demo 按钮
│   └── shared/
│       └── sites.ts                  ← URL → site 路由表（每加一国就 push 一行）
├── dist/                             ← ✅ 入仓：build 产物，Load unpacked 用这个
├── vite.config.ts                    ← @crxjs/vite-plugin
├── package.json
└── tsconfig.json
```

⚠️ **dist 入仓是有意的**（区别于一般 npm 项目 ignore build 产物的惯例）。这是 release-style 仓库
做法——本项目目的是把扩展拷到任何装了 Chrome 121+ 的机器上立即能用，不依赖测试机的 Node 工具链。

## 装到 Chrome（开发期 / 测试机）

```bash
git clone git@github.com:YoungAndSure/visa-helper.git
```

```
Chrome → chrome://extensions/ → Developer mode → Load unpacked → 选 extension/dist/
```

详见 [`CHROME_LOAD.md`](./CHROME_LOAD.md)。

## 改了源码

```bash
cd extension
npm install              # 第一次或 lockfile 变更时
npx vite build           # 重新生成 extension/dist/
git add extension/src/ extension/dist/
git commit -m "..."
git push
```

`src/` 跟 `dist/` 必须在同一次 commit 里。dist 没跟 = 加载出来的还是旧版。

## 与后端通信

`backend/` 在 `localhost:8000` 跑着；扩展通过 `host_permissions` 白名单访问 `http://localhost:8000/*`。
Phase 0 不需要后端，Phase 1+ 会用 `fetch('/suggest')` 等调用。

## Phase 0 范围

最小验证：
- service worker 能注册
- content script 能在 VFS 页面加载并监听 `focusin`
- 侧边栏能根据当前 URL 自动切 tab / 渲染 site 横幅
- 未识别页面提供 demo 按钮组手动模拟 site

不实现：
- 字段推荐
- 材料审核
- 任何 LLM 实际调用
