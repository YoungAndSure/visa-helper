/**
 * material-audit 兜底。
 */

import type { SiteProfile } from "../../../shared/sites";

export function render(rootEl: HTMLElement, _site: SiteProfile | null): void {
  rootEl.innerHTML = `
    <div style="color:var(--muted);font-size:13px">
      请在上方选择要审核的国家。
    </div>
  `;
}