/**
 * vfs-no: 挪威 · VFS Global 渲染。
 */

import type { SiteProfile } from "../../../shared/sites";

export function render(rootEl: HTMLElement, _site: SiteProfile | null): void {
  rootEl.innerHTML = `
    <div style="font-size:13px">
      <div><b>挪威 · VFS Global</b> · <span style="color:var(--muted)">挪威 VFS 表单伴行</span></div>
      <div style="margin-top:8px;color:var(--muted)">
        vfs-no 占位 — Phase D 接 RPC 后改成真填表逻辑。
      </div>
    </div>
  `;
}