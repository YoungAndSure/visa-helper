/**
 * form-assist 模块内部 state。
 *
 * 不导出给外部（除了 mount/unmount/onUrlChanged/onFieldFocus 这几个入口）。
 * 跨模块读取通过 ShellContext.detectedSite 拿。
 */
import type { FieldDescriptor, ShellContext } from "../../shared/types";
import type { SiteProfile } from "../../shared/sites";

export type FormAssistState = {
  ctx: ShellContext;
  /** 内部:用户手动选的 site;null = 跟随 ctx.detectedSite */
  formAssistSiteId: string | null;
  /** 内部:最近一次 focus 事件 */
  lastFocused: FieldDescriptor | null;
};

export function createState(ctx: ShellContext): FormAssistState {
  return {
    ctx,
    formAssistSiteId: null,
    lastFocused: null,
  };
}

export function effectiveSite(s: FormAssistState): SiteProfile | null {
  if (s.formAssistSiteId) {
    // 不缓存,每次现查(SITES 是 const 数组,开销可忽略)
    return SITES_FIND_BY_ID(s.formAssistSiteId);
  }
  return s.ctx.detectedSite;
}

import { SITES } from "../../shared/sites";
function SITES_FIND_BY_ID(id: string): SiteProfile | null {
  return SITES.find((x) => x.id === id) ?? null;
}