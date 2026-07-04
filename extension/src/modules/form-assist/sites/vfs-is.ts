/**
 * vfs-is: 冰岛 · VFS Global 渲染。
 *
 * Phase B 占位 — 简单文案。Phase D 接 RPC 后改成真填表逻辑。
 */

import type { SiteProfile } from "../../../shared/sites";

export function render(rootEl: HTMLElement, _site: SiteProfile | null): void {
  rootEl.innerHTML = `
    <div style="font-size:13px">
      <div><b>冰岛 · VFS Global</b> · <span style="color:var(--muted)">申根短期签证（C 類）填表伴行</span></div>
      <div style="margin-top:8px;color:var(--muted)">
        vfs-is 占位 — Phase D 接 RPC 后填入字段推荐。
      </div>
      <ul style="margin-top:8px">
        <li>点击 VFS 表单字段 → content script 抓 <code>{label, type}</code></li>
        <li>service worker 在 console 打 <code>field-focus</code></li>
        <li>本 view 实时收到并展示</li>
      </ul>
    </div>
  `;
}