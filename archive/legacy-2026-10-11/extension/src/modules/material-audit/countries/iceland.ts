/**
 * Iceland 审核渲染。
 *
 * Phase B 占位 — 简单文案。Phase D 接 RPC 后改成调 /material-audit/run 跑真审核。
 */

import type { SiteProfile } from "../../../shared/sites";

export function render(rootEl: HTMLElement, _site: SiteProfile | null): void {
  rootEl.innerHTML = `
    <div style="font-size:13px">
      <div><b>冰岛</b> · <span style="color:var(--muted)">申根短期签证(C 類)审核</span></div>
      <div style="margin-top:8px;color:var(--muted)">
        Iceland 占位 — Phase D 接 RPC 后:按钮触发 <code>POST /material-audit/run</code> {country:IS, materials_dir:...},渲染结果。
      </div>
    </div>
  `;
}