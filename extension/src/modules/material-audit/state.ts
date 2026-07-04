/**
 * material-audit 模块内部 state。
 */
import type { ShellContext } from "../../shared/types";
import type { SiteProfile } from "../../shared/sites";

export type MaterialAuditState = {
  ctx: ShellContext;
  /** 用户手动选的国家;永远手动,初始 null */
  auditCountryId: string | null;
  /** 拉过的 checklist 缓存(Phase D 接 RPC 时再用) */
  checklistCache: Record<string, unknown>;
};

export function createState(ctx: ShellContext): MaterialAuditState {
  return {
    ctx,
    auditCountryId: null,
    checklistCache: {},
  };
}

export function effectiveCountry(s: MaterialAuditState): SiteProfile | null {
  if (!s.auditCountryId) return null;
  return SITES_FIND_BY_ID(s.auditCountryId);
}

import { SITES } from "../../shared/sites";
function SITES_FIND_BY_ID(id: string): SiteProfile | null {
  return SITES.find((x) => x.id === id) ?? null;
}