/**
 * visa-helper 侧边栏。
 *
 * 框架职责：
 *   1. 读活动 tab 的 URL → 匹配 shared/sites.ts 注册表 → 作为 form-assist 的默认值。
 *   2. 三个 tab 可手动切换。
 *   3. 伴行填表顶部有 site 选择器，默认跟随 URL（detectedSite），用户可手动覆盖。
 *   4. 材料审核顶部有国家选择器，永远手动，不跟 URL、不继承伴行填表。
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
  /** URL 自动检测出的 site（只读语义，banner / form-assist 默认值都用它） */
  detectedSite: SiteProfile | null;
  view: ViewId;
  /** 用户点过 tab 后，不再被默认 view 自动覆盖 */
  userChoseView: boolean;
  /**
   * 伴行填表当前生效的 site。
   *  - null  = 跟随 detectedSite（URL 自动）
   *  - 'xxx' = 用户在 form-assist 选择器里手动指定，覆盖 URL 检测
   * 切换 tab 时不会被 material-audit 污染。
   */
  formAssistSiteId: string | null;
  /**
   * 材料审核当前生效的国家（用 site.id 表达，因为 audit checklist 是按 country 切的）。
   * 永远手动，初始为 null → 必须用户选才能进入审核流程。
   * 不受 URL 检测影响，不受 formAssistSiteId 影响。
   */
  auditCountryId: string | null;
};
const state: State = {
  url: "(loading)",
  detectedSite: null,
  view: "form-assist",
  userChoseView: false,
  formAssistSiteId: null,
  auditCountryId: null,
};

/** 当前 form-assist 真正展示用的 site（手动 > URL） */
function effectiveFormAssistSite(): SiteProfile | null {
  const id = state.formAssistSiteId;
  if (id) return SITES.find((s) => s.id === id) ?? null;
  return state.detectedSite;
}

/** 当前 material-audit 选中的 country（手动，没有 fallback） */
function effectiveAuditSite(): SiteProfile | null {
  const id = state.auditCountryId;
  if (!id) return null;
  return SITES.find((s) => s.id === id) ?? null;
}

// ---------- DOM refs ----------
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
  const s = effectiveFormAssistSite();
  // 顶部选择器：跟随 URL 自动 / 手动指定 site
  const selectorHtml = `
    <div class="site-selector" style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
      <label for="fa-site" style="color:var(--muted);font-size:12px;flex:0 0 auto">当前 site</label>
      <select id="fa-site" style="flex:1;font:inherit;padding:4px 6px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg)">
        <option value="" ${state.formAssistSiteId === null ? "selected" : ""}>自动（URL 检测${state.detectedSite ? ` · ${state.detectedSite.country}` : ""}）</option>
        ${SITES.map(
          (site) =>
            `<option value="${site.id}" ${state.formAssistSiteId === site.id ? "selected" : ""}>${site.label}</option>`,
        ).join("")}
      </select>
    </div>
  `;

  if (!s) {
    body.innerHTML =
      selectorHtml +
      `<div style="color:var(--muted);font-size:13px">未匹配站点 — 在上方选择 site 进入填表流程即可（"自动" 模式只在 URL 命中已注册 site 时有效）。</div>`;
    return;
  }
  body.innerHTML =
    selectorHtml +
    `
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

  // 绑定 selector 事件（每次重渲染后重绑）
  const sel = $("#fa-site") as HTMLSelectElement | null;
  if (sel) {
    sel.addEventListener("change", () => {
      state.formAssistSiteId = sel.value || null;
      renderFormAssistView();
    });
  }
}

function renderMaterialAuditView() {
  const body = $("#material-audit-body")!;
  const s = effectiveAuditSite();
  // 顶部选择器：永远手动，跟 URL 检测 / form-assist 选择都解耦
  const selectorHtml = `
    <div class="audit-selector" style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
      <label for="ma-country" style="color:var(--muted);font-size:12px;flex:0 0 auto">审核国家</label>
      <select id="ma-country" style="flex:1;font:inherit;padding:4px 6px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg)">
        <option value="">请选择…</option>
        ${SITES.map(
          (site) =>
            `<option value="${site.id}" ${state.auditCountryId === site.id ? "selected" : ""}>${site.label} · ${site.flow}</option>`,
        ).join("")}
      </select>
    </div>
  `;

  if (!s) {
    body.innerHTML =
      selectorHtml +
      `<div style="color:var(--muted);font-size:13px">
         审核哪个国家由你手动选择 — 这里不跟随 URL 检测，也不继承伴行填表的选择。
         <div style="margin-top:8px;font-size:12px">Phase 2+ 会读取 <code>audit/checklist.json</code> + <code>audit/audit.py</code> 跑核对。</div>
       </div>`;
    return;
  }
  body.innerHTML =
    selectorHtml +
    `
    <div style="font-size:13px">
      <div><b>${s.label}</b> · <span style="color:var(--muted)">${s.contextHint}</span></div>
      <div style="margin-top:8px;color:var(--muted)">
        Phase 1+：将根据所选国家加载 <code>audit/checklist-${s.country.toLowerCase()}.json</code>，
        上传材料后调 <code>POST /audit</code>（或本地 <code>audit.py</code>）。
      </div>
    </div>
  `;

  const sel = $("#ma-country") as HTMLSelectElement | null;
  if (sel) {
    sel.addEventListener("change", () => {
      state.auditCountryId = sel.value || null;
      renderMaterialAuditView();
    });
  }
}

function renderAll() {
  renderTabs();
  renderFormAssistView();
  renderMaterialAuditView();
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
  state.detectedSite = matchSite(url);
  // form-assist 跟随 URL 检测（仅在用户没手动指定时才用 detectedSite），
  // 这里**不**重置 formAssistSiteId — 用户手动选过就保留用户的。
  if (!state.userChoseView) {
    state.view = defaultViewFor(state.detectedSite);
  }
  // material-audit 的 auditCountryId 永远不动；它不跟 URL 也不跟 form-assist。
  renderAll();
}

window.addEventListener("DOMContentLoaded", detectSite);
