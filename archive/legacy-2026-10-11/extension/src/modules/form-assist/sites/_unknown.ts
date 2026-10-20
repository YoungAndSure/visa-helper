/**
 * form-assist 兜底:URL 命中了一个 site id 但对应文件不存在,或用户手动选了一个空值。
 */

import type { SiteProfile } from "../../../shared/sites";

export function render(rootEl: HTMLElement, _site: SiteProfile | null): void {
  rootEl.innerHTML = `
    <div style="color:var(--muted);font-size:13px">
      未匹配站点 — 在上方选择 site 进入填表流程即可（"自动" 模式只在 URL 命中已注册 site 时有效）。
    </div>
  `;
}