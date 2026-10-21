import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { PDFDocument, PDFHexString, StandardFonts } from "pdf-lib";

export const schengenPdf = JSON.parse(readFileSync(new URL("../config/forms/iceland-schengen-en-cn-2025-03.json", import.meta.url), "utf8"));
const original = readFileSync(new URL(`../config/forms/${schengenPdf.file}`, import.meta.url));
if (createHash("sha256").update(original).digest("hex") !== schengenPdf.sha256) throw new Error("Official PDF template fingerprint mismatch");
const catalogHash = createHash("sha256").update(JSON.stringify(schengenPdf)).digest("hex");
export const schengenPdfRelease = { taskId: schengenPdf.taskId, templateId: schengenPdf.id,
  templateHash: catalogHash, sourceHash: schengenPdf.sha256 };
const nativeNames = schengenPdf.fields.flatMap((f) => f.pdfName ? [f.pdfName] : f.options.map((o) => o.pdfName));
const publicField = ({ pdfName, checkbox, options, ...field }) => ({ ...field,
  ...(options ? { options: options.map(({ value, label }) => ({ value, label })) } : {}), pdf: true });
export function formFieldCatalog(definition) {
  if (definition.id !== schengenPdf.taskId) return definition.fields;
  const fields = new Map(definition.fields.map((f) => [f.id, f]));
  for (const f of schengenPdf.fields) fields.set(f.id, { ...fields.get(f.id), ...publicField(f),
    group: fields.get(f.parentId)?.group ?? "stay" });
  return [...fields.values()];
}
const normalized = (value) => String(value).trim().toLowerCase();
function optionFor(field, value) {
  return field.options.find((o) => [o.value, o.label].some((v) => normalized(v) === normalized(value)));
}
function parsedValue(field, value) {
  if (field.type === "text") return { value };
  const parts = field.type === "multi_choice" ? value.split("|") : [value];
  const options = parts.map((v) => optionFor(field, v));
  if (options.some((o) => !o)) return { error: "请按此字段目录中的选项值填写；多个旅行目的使用 | 分隔。" };
  return { value: field.type === "multi_choice" ? options.map((o) => o.value).join("|") : options[0].value };
}
export function prefillState(guide, data) {
  const known = new Map(guide.map((f) => [f.id, f]));
  const fields = schengenPdf.fields.map((f) => {
    const raw = data.fields[f.id] ?? known.get(f.id)?.value ?? null;
    const parsed = raw === null ? {} : parsedValue(f, raw);
    // The original explicitly requires English; preserve passport spellings and
    // ask for confirmed transliteration instead of silently dropping characters.
    const error = parsed.error ?? (f.type === "text" && raw !== null && /[^\x20-\x7e\xa0-\xff\n\r\t]/.test(raw)
      ? "原表要求英文填写，请提供或确认英文写法；不要直接填入中文或说明文字。" : null);
    return { id: f.id, value: error ? null : parsed.value ?? null, valueStatus: raw === null ? "missing" : error ? "needs_correction"
      : data.fields[f.id] !== undefined ? "provided" : "from_application", ...(error ? { issue: error } : {}) };
  });
  return { templateId: schengenPdf.id, templateHash: catalogHash, sourceHash: schengenPdf.sha256,
    fillMode: data.fillMode ?? "assisted", fields, filledCount: fields.filter((f) => f.value !== null).length,
    issues: [...fields.filter((f) => f.issue).map(({ id, issue }) => ({ fieldId: id, message: issue })),
      ...["17", "29", "32", "33"].filter((id) => data.fields[id]).map((fieldId) => ({ fieldId,
        message: "此项为旧版汇总内容，未直接写入原PDF；请按细分字段确认信息，或在原表中补充。" }))],
    manualFields: schengenPdf.manualFields,
    instruction: "字段含义及选项见fieldCatalog中pdf:true的项目，fields只返回对应值与状态。默认由GPT复用已确认资料，按适用条件收集缺项；姓名按护照，日期按日-月-年。仅为适用项追问，可随时先下载部分预填PDF，不编造、不把未知写成否或不适用。用户选择manual时只解释填写方法，不强制收集个人资料。生成文件不是填妥、核对或签字确认。" };
}
function fitFont(field, value, font) {
  const rect = field.acroField.getWidgets()[0].getRectangle(), width = rect.width - 4, height = rect.height - 2;
  for (let size = 10; size >= 7; size -= .5) {
    let lines = 0;
    for (const line of value.split(/\r?\n/)) {
      let current = "";
      for (const word of line.split(/\s+/)) {
        if (font.widthOfTextAtSize(word, size) > width) { lines = Infinity; break; }
        const next = current ? `${current} ${word}` : word;
        if (font.widthOfTextAtSize(next, size) > width) { lines++; current = word; } else current = next;
      }
      lines++;
    }
    if (lines * size * 1.2 <= height) return size;
  }
  return null;
}
export async function renderPrefilledPdf(flow) {
  if (flow.taskId !== schengenPdf.taskId || flow.prefill?.templateHash !== catalogHash) throw new Error("PDF task/template mismatch");
  const pdf = await PDFDocument.load(original), form = pdf.getForm();
  const actual = form.getFields().map((f) => f.getName()).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...nativeNames].sort()) || pdf.getPageCount() !== schengenPdf.pages) throw new Error("Official PDF field inventory changed");
  const font = await pdf.embedFont(StandardFonts.Helvetica), issues = [...flow.prefill.issues], written = [];
  for (const value of flow.prefill.fields) {
    const f = { ...schengenPdf.fields.find((field) => field.id === value.id), ...value };
    if (f.value === null) continue;
    if (f.type === "text") {
      const field = form.getTextField(f.pdfName);
      let size;
      try { size = fitFont(field, f.value, font); } catch { size = null; }
      if (!size) { issues.push({ fieldId: f.id, message: "内容超出原表可读空间或字体不支持，请确认英文写法、适当精简或在原表中补充。" }); continue; }
      field.enableMultiline(); field.setFontSize(size); field.setText(f.value);
    } else if (f.type === "multi_choice") {
      const selected = new Set(f.value.split("|"));
      for (const option of f.options) { const box = form.getCheckBox(option.pdfName); selected.has(option.value) ? box.check() : box.uncheck(); }
    } else {
      const option = optionFor(f, f.value);
      if (f.checkbox) { const box = form.getCheckBox(f.pdfName); option.pdfValue ? box.check() : box.uncheck(); }
      else {
        const group = form.getRadioGroup(f.pdfName);
        // This official template has duplicate/mismatched /Opt labels (including
        // two "Female" exports). Use its verified widget on-values as exports so
        // selecting one option cannot accidentally select another widget.
        group.acroField.setOpt(group.acroField.getOnValues().map((v) => PDFHexString.fromText(v.decodeText())));
        group.select(option.pdfValue);
      }
    }
    written.push(f.id);
  }
  // Keep fields editable for user corrections; generate appearances for printing.
  form.updateFieldAppearances(font);
  const bytes = await pdf.save({ updateFieldAppearances: false });
  return { bytes, written, issues };
}
