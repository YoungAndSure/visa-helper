/**
 * visa-helper 侧边栏 shell。
 *
 * 职责:
 *   1. 读活动 tab URL → 走 shared/detector 匹配 site → 存到 ctx.detectedSite。
 *   2. 三个 tab 可手动切换;切到 form-assist / material-audit 时 mount 对应模块,
 *      切走时 unmount。settings tab 不挂模块。
 *   3. form-assist 模块需要 field-focus 事件:content script 走 background → shell → module。
 *   4. settings tab 提供 ping SW / ping 后端的调试入口(用 shared/rpc.health)。
 *
 * 不在本 shell 做任何业务渲染 — 全部委托给 modules/{form-assist,material-audit}。
 */

import {
  SITES,
  type SiteProfile,
  type ViewId,
} from "../shared/sites";
import { matchSite, defaultViewFor } from "../shared/detector";
import { RpcClient } from "../shared/rpc";
import type { FieldDescriptor } from "../shared/types";

import * as formAssist from "../modules/form-assist";
import * as materialAudit from "../modules/material-audit";

const $ = <T extends HTMLElement>(sel: string) =>
  document.querySelector(sel) as T | null;

// ---------- state ----------
type State = {
  url: string;
  detectedSite: SiteProfile | null;
  view: ViewId;
  userChoseView: boolean;
};
const state: State = {
  url: "(loading)",
  detectedSite: null,
  view: "form-assist",
  userChoseView: false,
};

// ---------- DOM refs ----------
const tabBtns = document.querySelectorAll<HTMLButtonElement>(".tab");
const sections: Record<ViewId, HTMLElement> = {
  "form-assist": $("#view-form-assist")!,
  "material-audit": $("#view-material-audit")!,
  settings: $("#view-settings")!,
};

// ping 健康检查
const dot = $("#dot-sw") as HTMLSpanElement;
const statusEl = $("#status-sw") as HTMLSpanElement;
const diag = $("#diag") as HTMLPreElement;
const backendStatus = $("#backend-status") as HTMLSpanElement;
const BACKEND_DEFAULT = "http://localhost:8000";
const rpc = new RpcClient(BACKEND_DEFAULT);

// 当前挂载的 view（用于切走时 unmount）
let mountedView: ViewId | null = null;

// ---------- 渲染 ----------
function renderTabs(): void {
  tabBtns.forEach((b) => {
    b.setAttribute("aria-selected", String(b.dataset.view === state.view));
  });
  (Object.keys(sections) as ViewId[]).forEach((v) => {
    sections[v].hidden = v !== state.view;
  });
  syncMount();
}

/** 切到新 view 时:卸载旧 view 的 module,挂载新 view 的 module。 */
function syncMount(): void {
  const newView = state.view;
  if (newView === mountedView) return;

  if (mountedView === "form-assist") formAssist.unmount(sections["form-assist"]);
  if (mountedView === "material-audit") materialAudit.unmount(sections["material-audit"]);
  // settings tab 不挂模块,也不需要显式 unmount。

  if (newView === "form-assist") {
    formAssist.mount(sections["form-assist"], {
      backendUrl: rpc.backendUrl,
      detectedSite: state.detectedSite,
    });
  } else if (newView === "material-audit") {
    materialAudit.mount(sections["material-audit"], {
      backendUrl: rpc.backendUrl,
      detectedSite: state.detectedSite,
    });
  } else if (newView === "settings") {
    pingSW();
  }

  mountedView = newView;
}

// ---------- tabs ----------
tabBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    const v = (btn.dataset.view ?? "form-assist") as ViewId;
    state.view = v;
    state.userChoseView = true;
    renderTabs();
  });
});

// ---------- ping ----------
function pingSW(): void {
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
  const r = await rpc.health();
  if (!r.ok) {
    backendStatus.innerHTML = `<span class="dot err"></span> 后端不可达 (${r.reason})`;
    diag.textContent = JSON.stringify(r, null, 2);
    return;
  }
  const { llm_available } = r.data;
  backendStatus.innerHTML = `<span class="dot ${llm_available ? "ok" : ""}"></span> ${llm_available ? "LLM 已配置" : "LLM 未配置"}`;
  diag.textContent = JSON.stringify(r.data, null, 2);
});

// ---------- 启动：读活动 tab URL ----------
async function detectSite(): Promise<void> {
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
  if (!state.userChoseView) {
    state.view = defaultViewFor(state.detectedSite);
  }
  renderTabs();

  // URL 检测结果变了 — 通知 form-assist 模块(它用这个做 selector 默认值)
  if (mountedView === "form-assist") {
    formAssist.onUrlChanged(sections["form-assist"], url, state.detectedSite);
  }
}

// ---------- field focus 转发 ----------
// content script → background → 这里 → form-assist 模块
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== "object") return;
  if (msg.kind !== "field-focus") return false;
  const desc: FieldDescriptor = {
    selector: msg.selector,
    label: msg.label,
    type: msg.type,
  };
  if (mountedView === "form-assist") {
    formAssist.onFieldFocus(sections["form-assist"], desc);
  }
  sendResponse({ ok: true, ack: "forwarded-to-form-assist" });
  return true;
});

window.addEventListener("DOMContentLoaded", detectSite);

// SITES 仍在 shell 里用到,因为 onMessage 引用类型需要 import(虽然实际不直接用),
// 保留它以便未来从 ShellContext 共享给 module。
// (eslint-disable no-unused-vars)
void SITES;