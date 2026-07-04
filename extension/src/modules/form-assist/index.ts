/**
 * form-assist module — 伴行填表。
 *
 * Public API:
 *   mount(rootEl, ctx)
 *   unmount(rootEl)
 *   onUrlChanged(rootEl, url, site)
 *   onFieldFocus(rootEl, desc)
 *
 * 模块间边界：本模块只 import 自 shared/* 和自身内部；
 * 不 import material-audit/。
 *
 * Phase B 阶段:per-site handler 通过 await import('./sites/<id>') 动态加载,
 * 这样每个 site 是独立 chunk,加新 site 不动本文件。
 */

import type { FieldDescriptor, ShellContext } from "../../shared/types";
import type { SiteProfile } from "../../shared/sites";
import { SITES } from "../../shared/sites";

import { createState, effectiveSite, type FormAssistState } from "./state";

const stateByRoot = new WeakMap<HTMLElement, FormAssistState>();

// ---------- public API ----------
export function mount(rootEl: HTMLElement, ctx: ShellContext): void {
  const s = createState(ctx);
  stateByRoot.set(rootEl, s);
  render(rootEl, s);
}

export function unmount(rootEl: HTMLElement): void {
  stateByRoot.delete(rootEl);
  rootEl.innerHTML = "";
}

export function onUrlChanged(rootEl: HTMLElement, _url: string, _site: SiteProfile | null): void {
  const s = stateByRoot.get(rootEl);
  if (!s) return;
  // formAssistSiteId 不重置:用户手动选过就保留。
  render(rootEl, s);
}

export function onFieldFocus(rootEl: HTMLElement, desc: FieldDescriptor): void {
  const s = stateByRoot.get(rootEl);
  if (!s) return;
  s.lastFocused = desc;
  render(rootEl, s);
}

// ---------- 渲染 ----------
async function render(rootEl: HTMLElement, s: FormAssistState): Promise<void> {
  const site = effectiveSite(s);
  rootEl.innerHTML = `
    <div class="site-selector" style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
      <label for="fa-site" style="color:var(--muted);font-size:12px;flex:0 0 auto">当前 site</label>
      <select id="fa-site" style="flex:1;font:inherit;padding:4px 6px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg)">
        <option value="" ${s.formAssistSiteId === null ? "selected" : ""}>自动（URL 检测${s.ctx.detectedSite ? ` · ${s.ctx.detectedSite.country}` : ""}）</option>
        ${SITES_OPTIONS(s.formAssistSiteId)}
      </select>
    </div>
    <div id="fa-site-body"></div>
    ${renderFocusList(s)}
  `;

  const sel = rootEl.querySelector<HTMLSelectElement>("#fa-site");
  if (sel) {
    sel.addEventListener("change", () => {
      s.formAssistSiteId = sel.value || null;
      render(rootEl, s);
    });
  }

  // 动态 import 对应 site 的渲染器;找不到或加载失败走 _unknown
  await renderSite(rootEl, site);
}

async function renderSite(rootEl: HTMLElement, site: SiteProfile | null): Promise<void> {
  const body = rootEl.querySelector<HTMLElement>("#fa-site-body");
  if (!body) return;

  const handlerId = site?.id ?? "_unknown";
  // 用静态 key map 让 Vite 识别每个动态 import → 每 site 一独立 chunk
  const handlers: Record<string, () => Promise<{ render: (el: HTMLElement, s: SiteProfile | null) => void }>> = {
    "vfs-is": () => import("./sites/vfs-is"),
    "udi-no": () => import("./sites/udi-no"),
    "vfs-no": () => import("./sites/vfs-no"),
  };

  const loader = handlers[handlerId];
  if (!loader) {
    const fallback = await import("./sites/_unknown");
    fallback.render(body, site);
    return;
  }
  try {
    const mod = await loader();
    mod.render(body, site);
  } catch (e) {
    const fallback = await import("./sites/_unknown");
    fallback.render(body, site);
    body.dataset.error = String(e);
  }
}

function SITES_OPTIONS(currentId: string | null): string {
  return SITES.map(
    (site) =>
      `<option value="${site.id}" ${currentId === site.id ? "selected" : ""}>${site.label}</option>`,
  ).join("");
}

function renderFocusList(s: FormAssistState): string {
  if (!s.lastFocused) return "";
  return `
    <div style="margin-top:12px;padding:8px;border:1px solid var(--border);border-radius:6px;font-size:12px">
      <div style="color:var(--muted)">最近 focus:</div>
      <div><code>${escapeHtml(s.lastFocused.selector)}</code></div>
      <div>label: ${escapeHtml(s.lastFocused.label || "(无)")}</div>
      <div>type: <code>${escapeHtml(s.lastFocused.type)}</code></div>
    </div>
  `;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}