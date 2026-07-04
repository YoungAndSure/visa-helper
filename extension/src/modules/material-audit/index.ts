/**
 * material-audit module — 材料审核。
 *
 * Public API:
 *   mount(rootEl, ctx)
 *   unmount(rootEl)
 *
 * 模块间边界：本模块只 import 自 shared/* 和自身内部；
 * 不 import form-assist/。
 *
 * Phase B 阶段:per-country handler 通过 await import('./countries/<id-prefix>') 动态加载。
 * 国家到文件名的映射目前用 site.id 的 prefix(e.g. vfs-is / udi-no 都映射到 countries/iceland.ts / norway.ts),
 * 后续接 RPC 时再细化映射表。
 */

import type { ShellContext } from "../../shared/types";
import type { SiteProfile } from "../../shared/sites";
import { SITES } from "../../shared/sites";

import { createState, effectiveCountry, type MaterialAuditState } from "./state";

const stateByRoot = new WeakMap<HTMLElement, MaterialAuditState>();

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

// ---------- 渲染 ----------
async function render(rootEl: HTMLElement, s: MaterialAuditState): Promise<void> {
  const country = effectiveCountry(s);
  rootEl.innerHTML = `
    <div class="audit-selector" style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
      <label for="ma-country" style="color:var(--muted);font-size:12px;flex:0 0 auto">审核国家</label>
      <select id="ma-country" style="flex:1;font:inherit;padding:4px 6px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--fg)">
        <option value="">请选择…</option>
        ${SITES_OPTIONS(s.auditCountryId)}
      </select>
    </div>
    <div id="ma-country-body"></div>
  `;

  const sel = rootEl.querySelector<HTMLSelectElement>("#ma-country");
  if (sel) {
    sel.addEventListener("change", () => {
      s.auditCountryId = sel.value || null;
      render(rootEl, s);
    });
  }

  await renderCountry(rootEl, country);
}

async function renderCountry(rootEl: HTMLElement, site: SiteProfile | null): Promise<void> {
  const body = rootEl.querySelector<HTMLElement>("#ma-country-body");
  if (!body) return;

  // site.id → countries/<country>.ts 文件名(显式列,新增国家时这里加一行)
  const countryId = site ? siteCountryFromSite(site) : "_unknown";
  // 用静态 key map 让 Vite 识别每个动态 import → 每国家一独立 chunk
  const handlers: Record<string, () => Promise<{ render: (el: HTMLElement, s: SiteProfile | null) => void }>> = {
    iceland: () => import("./countries/iceland"),
    norway: () => import("./countries/norway"),
  };

  const loader = handlers[countryId];
  if (!loader) {
    const fallback = await import("./countries/_unknown");
    fallback.render(body, site);
    return;
  }
  try {
    const mod = await loader();
    mod.render(body, site);
  } catch (e) {
    const fallback = await import("./countries/_unknown");
    fallback.render(body, site);
    body.dataset.error = String(e);
  }
}

/** site.id → countries/<country>.ts 的文件名(不含扩展名)。 */
function siteCountryFromSite(site: SiteProfile): string {
  // vfs-is / udi-no / vfs-no → iceland / norway / norway
  // 后续加新国家时显式在这里列。
  if (site.country === "IS") return "iceland";
  if (site.country === "NO") return "norway";
  return "_unknown";
}

function SITES_OPTIONS(currentId: string | null): string {
  return SITES.map(
    (site) =>
      `<option value="${site.id}" ${currentId === site.id ? "selected" : ""}>${site.label} · ${site.flow}</option>`,
  ).join("");
}