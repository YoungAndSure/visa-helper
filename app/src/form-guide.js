import { randomBytes } from "node:crypto";

const escapeHtml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");

export function renderGuideHtml(flow) {
  const fields = flow.guide.map((field) => `<section class="item"><small>${escapeHtml(field.reference)}</small>
    <h2>${escapeHtml(field.label)}</h2>${field.value !== null
      ? `<div class="value">${escapeHtml(field.value)}</div><p class="hint">填写提示：${escapeHtml(field.guidance)}</p>`
      : `<p>请填写：${escapeHtml(field.guidance)}</p>`}</section>`).join("\n");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="robots" content="noindex,nofollow"><meta name="referrer" content="no-referrer"><title>申根申请表填写对照页</title>
    <style>body{font:16px/1.65 system-ui,sans-serif;color:#172d36;background:white;max-width:850px;margin:auto;padding:24px}h1{font-size:1.6rem}h2{font-size:1.05rem;margin:4px 0 8px}.item{padding:14px 0;border-bottom:1px solid #dde5e8;break-inside:avoid}.value{background:#edf6f3;padding:12px;border-radius:8px;white-space:pre-wrap;overflow-wrap:anywhere}small,.hint{color:#596c77}.notice{background:#fff6dc;padding:12px;border-radius:8px}a{color:#176e65}@media print{body{font-size:11pt;padding:0}a{color:inherit}}</style></head><body>
    <h1>申请表填写对照页</h1><p>按原表编号对照填写。已有信息给出填写内容，其余项目说明需要填什么。请自行核对并填写原始 PDF；本页不是正式申请表。</p>
    ${flow.needsRecheck ? '<p class="notice">申请资料有变化，以下内容需要重新核对。</p>' : ""}
    <a href="${escapeHtml(flow.source.formUrl)}" rel="noreferrer">打开官方原始申请表 PDF</a>
    ${fields}<section class="item"><h2>填好后的自查</h2>${flow.checkCatalog.map((check) => `<p>□ ${escapeHtml(check.label)}</p>`).join("")}
    <p>□ 已填妥并由本人按要求签字</p></section>
    <p class="hint">这是生成时的填写指引。资料或任务进度变化后，请返回任务重新打开。可使用浏览器打印功能保存本页。</p>
    </body></html>`;
}

// Only unpredictable, short-lived links are exposed. Never log tokens or page contents.
export class GuideLinks {
  constructor({ baseUrl = process.env.VISA_HELPER_GUIDE_BASE_URL, allowHttp = process.env.VISA_HELPER_GUIDE_ALLOW_HTTP === "1", ttlMs = 15 * 60 * 1000, now = Date.now } = {}) {
    this.baseUrl = baseUrl; this.ttlMs = ttlMs; this.now = now; this.entries = new Map();
    if (baseUrl) {
      const url = new URL(baseUrl);
      if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
          !(url.protocol === "https:" || (url.protocol === "http:" && (allowHttp || ["127.0.0.1", "localhost"].includes(url.hostname))))) {
        throw new Error("VISA_HELPER_GUIDE_BASE_URL must be an HTTPS origin, or loopback HTTP for local tests.");
      }
      this.baseUrl = url.origin;
    }
  }
  create(application, flow) {
    if (!this.baseUrl || flow.taskId !== "schengen_form") return null;
    for (const [token, entry] of this.entries) if (entry.expiresAt <= this.now()) this.entries.delete(token);
    while (this.entries.size >= 200) this.entries.delete(this.entries.keys().next().value);
    const token = randomBytes(32).toString("base64url"), expiresAt = this.now() + this.ttlMs;
    this.entries.set(token, { applicationId: application.id, applicationRevision: application.revision,
      taskId: flow.taskId, taskRevision: flow.revision, expiresAt, html: renderGuideHtml(flow) });
    return { url: `${this.baseUrl}/guides/${token}`, expiresAt: new Date(expiresAt).toISOString() };
  }
}

export function createGuideHandler(store, links) {
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store, private");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const url = new URL(req.url ?? "/", "http://localhost");
    const match = url.pathname.match(/^\/guides\/([A-Za-z0-9_-]{43})$/);
    if (!match || url.search || !["GET", "HEAD"].includes(req.method)) { res.writeHead(404).end("Not found"); return; }
    const entry = links.entries.get(match[1]);
    if (!entry || entry.expiresAt <= links.now()) {
      if (entry) links.entries.delete(match[1]);
      res.writeHead(410, { "Content-Type": "text/plain; charset=utf-8" }).end("链接已过期，请返回申请表任务重新打开填写对照页。"); return;
    }
    try {
      const { application, taskFlow } = await store.advanceTask({ applicationId: entry.applicationId, taskId: entry.taskId });
      if (application.revision !== entry.applicationRevision || taskFlow.revision !== entry.taskRevision) {
        links.entries.delete(match[1]);
        res.writeHead(410, { "Content-Type": "text/plain; charset=utf-8" }).end("申请资料或任务已更新，请返回任务重新打开填写对照页。"); return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(req.method === "HEAD" ? undefined : entry.html);
    } catch {
      res.writeHead(410, { "Content-Type": "text/plain; charset=utf-8" }).end("这份填写指引已不可用，请返回申请表任务重新打开。");
    }
  };
}
