import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { renderMaterialGuideHtml } from "./material-guide.js";

const escapeHtml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
const schengenTemplate = readFileSync(new URL("../public/templates/schengen-guide.html", import.meta.url), "utf8");

function renderSchengenPages(flow) {
  const catalog = new Map(flow.guide.map((field) => [field.id, field]));
  const field = (id, { sub = false, size = "" } = {}) => {
    const entry = catalog.get(id);
    if (!entry) throw new Error(`Missing Schengen field ${id}`);
    const hasValue = entry.value !== null;
    return `<${sub ? "div" : "section"} id="field-${id.replaceAll(".", "-")}" data-field-id="${id}" class="${sub ? "subfield" : "cell full"} ${size}">
      <div class="field-label"><a href="#field-${id.replaceAll(".", "-")}">${id === "signature" ? "签字区" : id.split(".")[0] + "."}</a> ${escapeHtml(entry.label)}</div>
      <div class="write-area ${hasValue ? "known" : ""}">${hasValue ? escapeHtml(entry.value) : "________________________"}</div>
      ${hasValue ? '<span class="known-label">已确认填写内容 · 请对照原表</span>' : ""}
      <p class="prompt">${hasValue ? "填写提示：" : "请填写："}${escapeHtml(entry.guidance)}</p>
    </${sub ? "div" : "section"}>`;
  };
  const row = (content) => `<div class="row">${content}</div>`;
  const fields = (ids) => ids.map((id) => row(field(String(id), { size: [7, 9, 10, 12, 17, 18, 22, 23, 28, 29, 30, 31, 32, 33].includes(id) ? "medium" : "" }))).join("");
  const heading = (page, title, photo = false) => `<header class="page-heading"><div><span class="tag">VISA HELPER · 填写对照指引</span><h2>申根签证申请 · ${title}</h2><p>与官方原表第${page}页对应</p></div>${photo ? '<div class="photo">照片位置<br>按原表要求贴附</div>' : ""}</header>`;
  const sheet = (page, title, body, photo = false) => `<article class="sheet" id="page-${page}" data-page="${page}">${heading(page, title, photo)}${body}<footer class="footer">第 ${page} / 4 页 · 填写对照</footer></article>`;
  const first = `<div class="page-one"><div class="form-grid">${fields(Array.from({ length: 16 }, (_, i) => i + 1))}</div><aside class="official"><strong>签证机关专用区域</strong><p>申请人无需填写。</p><p>原表右侧由受理机构记录申请、材料及决定信息。</p></aside></div>`;
  const entries = `<section class="cell full"><div class="field-label">27. 入境次数及首次抵离日期</div>${field("27.entries", { sub: true })}<div class="subfields">${field("27.arrival", { sub: true })}${field("27.departure", { sub: true })}</div></section>`;
  const second = `<div class="form-grid">${fields([17, 18, 19, 20, 21, 22, 23, 24, 25, 26])}${row(entries)}${fields([28, 29])}</div>`;
  const costs = `<section class="cell full"><div class="field-label">32. 旅费、生活费承担与支付方式</div><div class="costs"><div>本人承担<br>核对本人资金证明和支付方式。</div><div>他人承担<br>核对资助人的身份、承担范围及资金证明。</div></div>${field("32", { sub: true })}</section>`;
  const third = `<div class="form-grid">${fields([30, 31])}${row(costs)}${fields([33])}</div><p class="prompt">本页末尾的费用及医疗保险声明请在原始PDF中阅读、核对。</p>`;
  const fourth = `<section class="declaration"><h3>个人信息、真实申报与离境声明</h3><p>原表第4页上半部分是英文和中文声明区。请在原始PDF中阅读完整条款，包括个人信息及生物信息处理、如实申报以及按签证条件出行和离境等内容。</p><p>这里保留声明区的位置，提示你对照原文阅读；不要跳过原表声明。</p></section><section class="signature" id="signature-area"><div>地点及日期<div class="sign-space"></div><p class="prompt">填写实际签署地点和日期。</p></div><div>申请人签字<div class="sign-space"></div><p class="prompt">本人签字；适用时按原表要求由亲权人或监护人代签。</p></div></section><div class="form-grid">${row(field("signature"))}</div>`;
  return sheet(1, "身份与旅行证件", first, true) + sheet(2, "联系、职业与行程", second) + sheet(3, "住宿、资金与填表人", third) + sheet(4, "声明与签字", fourth);
}

export function renderGuideHtml(flow) {
  if (flow.document?.template && flow.document.template !== "schengen") return renderMaterialGuideHtml(flow);
  const values = { FORM_URL: escapeHtml(flow.source.formUrl), PAGES: renderSchengenPages(flow),
    NOTICE: flow.needsRecheck ? '<p class="notice">申请资料有变化，以下内容需要重新核对。</p>' : "" };
  return schengenTemplate.replace(/\{\{(FORM_URL|PAGES|NOTICE)\}\}/g, (_, key) => values[key]);
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
    if (!this.baseUrl || !flow.guide || !flow.document) return null;
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
