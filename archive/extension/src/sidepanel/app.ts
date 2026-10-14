/**
 * visa-helper 侧边栏。
 *
 * Phase 0 框架职责：
 *   1. 读活动 tab 的 URL → 匹配 shared/sites.ts 注册表 → 渲染 site 横幅。
 *   2. 根据匹配到的 site 自动切到 defaultView。
 *   3. 三个 tab 可手动切换。
 *   4. 站点未匹配时显示 demo 按钮组，可手动指定 site 验证显示框架。
 *   5. settings tab 提供 ping SW / ping 后端的调试入口。
 *
 * 后续 phase：
 *   - form-assist 应改为"当前 tab 已聚焦字段列表 + 建议值"
 *   - material-audit 应接 /audit 端点
 *   - per-site 渲染可放 src/sidepanel/views/<site>.ts，按 site.id 懒加载
 */

import {
  SITES,
  matchSite,
  defaultViewFor,
  type SiteProfile,
  type ViewId,
} from "../shared/sites";

const $ = <T extends HTMLElement>(sel: string) =>
  document.querySelector(sel) as T | null;

// ---------- state ----------
type State = {
  url: string;
  site: SiteProfile | null; // null = 未识别
  view: ViewId;
  userChoseView: boolean;   // 用户点过 tab 后，不再被默认 view 自动覆盖
};
const state: State = {
  url: "(loading)",
  site: null,
  view: "form-assist",
  userChoseView: false,
};

// ---------- DOM refs ----------
const banner = $("#site-banner")!;
const badge = $("#site-badge")!;
const labelEl = $("#site-label")!;
const hintEl = $("#site-hint")!;
const urlEl = $("#site-url")!;

const demoBar = $("#demo-bar")!;
const demoRow = $("#demo-row")!;

const tabBtns = document.querySelectorAll<HTMLButtonElement>(".tab");
const sections: Record<ViewId, HTMLElement> = {
  "form-assist": $("#view-form-assist")!,
  "material-audit": $("#view-material-audit")!,
  settings: $("#view-settings")!,
};

// ping 健康检查保留
const dot = $("#dot-sw") as HTMLSpanElement;
const statusEl = $("#status-sw") as HTMLSpanElement;
const diag = $("#diag") as HTMLPreElement;
const backendStatus = $("#backend-status") as HTMLSpanElement;
const BACKEND_DEFAULT = "http://localhost:8000";
let backendUrl = BACKEND_DEFAULT;

// ---------- 渲染 ----------

function renderBanner() {
  const s = state.site;
  if (s) {
    banner.classList.remove("unknown");
    badge.textContent = s.country;
    labelEl.textContent = s.label;
    hintEl.textContent = s.contextHint;
  } else {
    banner.classList.add("unknown");
    badge.textContent = "?";
    labelEl.textContent = "未识别页面";
    hintEl.textContent = "等待站点注册表匹配或选择 demo";
  }
  urlEl.textContent = state.url;
  urlEl.title = state.url;
}

function renderDemoBar() {
  demoRow.innerHTML = "";
  for (const s of SITES) {
    const btn = document.createElement("button");
    btn.textContent = s.label;
    btn.dataset.siteId = s.id;
    btn.setAttribute(
      "aria-pressed",
      state.site?.id === s.id ? "true" : "false",
    );
    btn.addEventListener("click", () => {
      state.site = s;
      if (!state.userChoseView) state.view = s.defaultView;
      renderAll();
    });
    demoRow.appendChild(btn);
  }
  demoBar.hidden = state.site !== null;
}

function renderTabs() {
  tabBtns.forEach((b) => {
    b.setAttribute("aria-selected", String(b.dataset.view === state.view));
  });
  (Object.keys(sections) as ViewId[]).forEach((v) => {
    sections[v].hidden = v !== state.view;
  });
}

function renderFormAssistView() {
  const body = $("#form-assist-body")!;
  const s = state.site;
  if (!s) {
    body.innerHTML =
      "未匹配站点 — 选中上方 demo 按钮即可切换 view shell，验证显示框架。";
    return;
  }
  body.innerHTML = `
    <div style="font-size:13px">
      <div><b>${s.label}</b> · <span style="color:var(--muted)">${s.contextHint}</span></div>
      <div style="margin-top:8px;color:var(--muted)">
        Phase 0 占位：将来此处显示"当前 tab 已聚焦的字段列表 + 填入建议"。
      </div>
      <ul style="margin-top:8px">
        <li>点击 VFS 表单字段 → content script 抓 <code>{label, type}</code></li>
        <li>service worker 在 console 打 <code>field-focus</code></li>
        <li>本 view 实时收到并展示</li>
      </ul>
    </div>
  `;
}

function renderAll() {
  renderBanner();
  renderTabs();
  renderFormAssistView();
  renderDemoBar();
}

// ---------- tabs ----------
tabBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    const v = (btn.dataset.view ?? "form-assist") as ViewId;
    state.view = v;
    state.userChoseView = true;
    renderTabs();
    if (v === "settings") pingSW();
  });
});

// ---------- ping ----------
function pingSW() {
  diag.textContent = "pinging…";
  chrome.runtime.sendMessage({ kind: "ping" }, (resp) => {
    if (chrome.runtime.lastError) {
      diag.textContent = "ERR: " + chrome.runtime.lastError.message;
      dot.classList.remove("ok");
      dot.classList.add("err");
      statusEl.textContent = "service worker 未响应";
      return;
    }
    statusEl.textContent = `service worker OK (${new Date(resp.t).toISOString()})`;
    dot.classList.add("ok");
    diag.textContent = JSON.stringify(resp, null, 2);
  });
}

$("#ping-sw")!.addEventListener("click", pingSW);

$("#ping-backend")!.addEventListener("click", async () => {
  diag.textContent = "pinging backend…";
  backendStatus.textContent = "…";
  try {
    const r = await fetch(`${backendUrl}/healthz`);
    const j = await r.json();
    backendStatus.innerHTML = `<span class="dot ${j.llm_available ? "ok" : ""}"></span> ${j.llm_available ? "LLM 已配置" : "LLM 未配置"}`;
    diag.textContent = JSON.stringify(j, null, 2);
  } catch (e) {
    backendStatus.innerHTML = `<span class="dot err"></span> 后端不可达`;
    diag.textContent = "ERR: " + (e as Error).message;
  }
});

// ---------- 启动：读活动 tab URL ----------
async function detectSite() {
  const url: string = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ kind: "get-active-url" }, (resp) => {
      if (chrome.runtime.lastError || !resp?.ok) {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
          resolve(tabs[0]?.url ?? "(no active tab)");
        });
      } else {
        resolve(resp.url as string);
      }
    });
  });

  state.url = url;
  state.site = matchSite(url);
  if (!state.userChoseView) {
    state.view = defaultViewFor(state.site);
  }
  renderAll();
}

window.addEventListener("DOMContentLoaded", detectSite);
