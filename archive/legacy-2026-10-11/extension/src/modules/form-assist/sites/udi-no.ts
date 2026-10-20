/**
 * udi-no: 挪威 · UDI 渲染。
 *
 * Phase B 占位 — 简单文案。Phase D 接 RPC 后改成真填表逻辑。
 */

import type { SiteProfile } from "../../../shared/sites";

export function render(rootEl: HTMLElement, _site: SiteProfile | null): void {
  rootEl.innerHTML = `
    <div style="font-size:13px">
      <div><b>挪威 · UDI</b> · <span style="color:var(--muted)">居留许可申请表逐项解释</span></div>
      <div style="margin-top:8px;color:var(--muted)">
        udi-no 占位 — Phase D 接 RPC 后改成"按字段标签查 Søknad 文档解释 + 给建议值"。
      </div>
    </div>
  `;
}