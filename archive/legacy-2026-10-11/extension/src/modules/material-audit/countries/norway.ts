/**
 * Norway 审核渲染。
 *
 * Phase B 占位 — 简单文案。Phase D 接 RPC 后实装。
 */

import type { SiteProfile } from "../../../shared/sites";

export function render(rootEl: HTMLElement, _site: SiteProfile | null): void {
  rootEl.innerHTML = `
    <div style="font-size:13px">
      <div><b>挪威</b> · <span style="color:var(--muted)">UDI 居留许可 / VFS 签证审核</span></div>
      <div style="margin-top:8px;color:var(--muted)">
        Norway 占位 — Phase D 接 RPC 后:UDI 用 checklist-NO.json;VFS 用 checklist-NO.json (VFS)。
      </div>
    </div>
  `;
}