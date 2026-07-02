/**
 * Site 注册表：URL → site profile → 默认 view。
 *
 * 这是框架的"路由表"。每个 entry 表示"这类网页应该加载哪条 visa 流程"。
 * 内容脚本只在 *.vfsglobal.com 注入，但侧边栏自己能从 chrome.tabs 拿 URL，
 * 所以挪威 UDI / 其他站点也能被识别（前提是 manifest 的 host_permissions 里加白）。
 *
 * 后续针对每个站点加新逻辑时：在 SITES 数组里加一条 + 在 sidepanel/views/
 * 下加对应的渲染组件即可，不用再动路由本身。
 */

export type ViewId = "form-assist" | "material-audit" | "settings";

export type SiteProfile = {
  /** 唯一 id，例如 'vfs-is'、'udi-no'。 */
  id: string;
  /** 给人看的中文标签：'冰岛 · VFS Global'。 */
  label: string;
  /** 给 badge 用的 2-letter 国家码：'IS' / 'NO'。 */
  country: string;
  /** 流程类型。 */
  flow: "visa" | "residence" | "work" | "citizenship";
  /** 匹配 URL 的正则列表，命中任意一条即视为同一 site。 */
  urlPatterns: RegExp[];
  /** 该 site 默认打开侧边栏的哪个 view。 */
  defaultView: ViewId;
  /** 在 view 顶部显示的副标题（流程名 + 步骤）。 */
  contextHint: string;
};

/**
 * 顺序敏感：更具体的 pattern 放前面。当前 vfsglobal 域名按国家分子域名，
 * 但 URL 里通常带国家短码路径（/iceland, /norway …）或子域名（is.vfsglobal.com），
 * 先按路径再按主机兜底。
 */
export const SITES: SiteProfile[] = [
  {
    id: "vfs-is",
    label: "冰岛 · VFS Global",
    country: "IS",
    flow: "visa",
    defaultView: "form-assist",
    contextHint: "申根短期签证（C 類）填表伴行",
    urlPatterns: [
      /vfsglobal\.com\/[^/]*\/iceland/i,
      /^https?:\/\/is\.vfsglobal\.com/i,
    ],
  },
  {
    id: "udi-no",
    label: "挪威 · UDI",
    country: "NO",
    flow: "residence",
    defaultView: "form-assist",
    contextHint: "居留许可申请表逐项解释",
    urlPatterns: [
      /^https?:\/\/(www\.)?udi\.no\//i,
    ],
  },
  {
    id: "vfs-no",
    label: "挪威 · VFS Global",
    country: "NO",
    flow: "visa",
    defaultView: "form-assist",
    contextHint: "挪威 VFS 表单伴行",
    urlPatterns: [vfsglobalFor("norway", "no")],
  },
];

/**
 * 工具函数：帮常见 vfsglobal URL 拼一个 RegExp。
 * vfsglobal 在某些国家用子域名（is.vfsglobal.com），另一些用路径（/norway）。
 */
function vfsglobalFor(
  slug: string,
  cc: string,
): RegExp {
  return new RegExp(
    `vfsglobal\\.com[^/]*\\/(?:[a-z-]+\\/)?${slug}|${cc}\\.vfsglobal\\.com`,
    "i",
  );
}

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
