/**
 * 站点 detector：URL → SiteProfile。
 *
 * 跟 sites.ts 的注册表配套使用。本文件只做 URL 模式匹配 + view 选择，
 * 注册表本身（id/label/country/flow/...）在 sites.ts。
 */

import { SITES, type SiteProfile, type ViewId } from "./sites";

/** 把当前 URL 解析成一个 SiteProfile 或 null（未登记）。 */
export function matchSite(url: string): SiteProfile | null {
  for (const s of SITES) {
    if (s.urlPatterns.some((re) => re.test(url))) return s;
  }
  return null;
}

/** 取对应的 view id（找不到则 fallback 到 form-assist）。 */
export function defaultViewFor(site: SiteProfile | null): ViewId {
  return site?.defaultView ?? "form-assist";
}