import { readFileSync } from "node:fs";
const template = readFileSync(new URL("../public/templates/material-guide.html", import.meta.url), "utf8");
export const escapeHtml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
export function renderMaterialGuideHtml(flow) {
  const e = escapeHtml;
  const fields = flow.guide.map((field) => `<section class="item"><h2>${e(field.label)}</h2>${field.value !== null
    ? `<div class="value">${e(field.value)}</div><p class="hint">${e(field.guidance)}</p>` : `<p class="hint">待补充：${e(field.guidance)}</p>`}</section>`).join("\n");
  let itinerary = "";
  if (flow.document.template === "itinerary") {
    const rows = flow.travelDates.map((date) => flow.data.rows.find((row) => row.date === date) ?? { date });
    const cell = (value, missing) => value ? `<div class="value">${e(value)}</div>` : `<span class="hint">待补充：${e(missing)}</span>`;
    itinerary = `<h2>逐日旅行计划</h2><table><thead><tr><th>日期</th><th>地点</th><th>安排</th><th>交通</th><th>住宿</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${e(row.date)}</td><td>${cell(row.location, "当天实际地点")}</td><td>${cell(row.plan, "当天确认的旅行安排")}</td><td>${cell(row.transport, "需要移动时的真实交通安排")}</td><td>${cell(row.accommodation, "按真实预订填写；未定需确认")}</td></tr>`).join("")}</tbody></table>`;
  }
  const values = { title: e(flow.document.title), fields, itinerary,
    notice: [flow.needsRecheck ? "资料已变化，需要重新核对。" : "", ...flow.automaticChecks.filter(({ status }) => status === "fail").map(({ guidance }) => guidance)].filter(Boolean).map((text) => `<p class="notice">待处理：${e(text)}</p>`).join(""),
    acquisition: flow.acquisition.map((text) => `<p>${e(text)}</p>`).join(""), checks: flow.checkCatalog.map(({ label }) => `<p>□ ${e(label)}</p>`).join("") };
  return template.replace(/\{\{(title|notice|fields|itinerary|acquisition|checks)\}\}/g, (_, key) => values[key]);
}
