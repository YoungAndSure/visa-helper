/**
 * Material audit UI state machine.
 *
 * Raw File objects stay in browser memory. Only user-reviewed safe material objects
 * can be sent to /material-audit/run.
 */
import { analyzeFilesLocally, buildSafePackageFromAnalysis, renderPdfReadOnly, validateSafePackage } from "./privacy.js?v=two-level-audit-v7";

const API = "";
const $ = (selector) => document.querySelector(selector);

const el = {
  health: $("#health"),
  healthText: $("#health .health__text"),
  wsCountry: $("#wsCountry"),
  picker: $("#picker"),
  pickerStep: $("#pickerStep"),
  filelist: $("#filelist"),
  materialsDir: $("#materialsDir"),
  levelOneBtn: $("#levelOneBtn"),
  levelOneStatus: $("#levelOneStatus"),
  privacyBtn: $("#privacyBtn"),
  privacyStatus: $("#privacyStatus"),
  privacyStatusBar: $("#privacyStatusBar"),
  confirmAllBtn: $("#confirmAllBtn"),
  runBtn: $("#runBtn"),
  runStatus: $("#runStatus"),
  checklistMeta: $("#checklistMeta"),
  checklist: $("#checklist"),
  previewArea: $("#previewArea"),
  previewEmpty: $("#previewEmpty"),
  levelOneSummary: $("#levelOneSummary"),
  levelOneResults: $("#levelOneResults"),
  levelOneEmpty: $("#levelOneEmpty"),
  privacyBadge: $("#privacyBadge"),
  privacySummary: $("#privacySummary"),
  privacyEmpty: $("#privacyEmpty"),
  privacyMaterial: $("#privacyMaterial"),
  privacyMaterialRef: $("#privacyMaterialRef"),
  privacyMaterialTitle: $("#privacyMaterialTitle"),
  privacyReviewState: $("#privacyReviewState"),
  privacyRedactions: $("#privacyRedactions"),
  privacyContent: $("#privacyContent"),
  privacyValidation: $("#privacyValidation"),
  confirmMaterialBtn: $("#confirmMaterialBtn"),
  agentTrace: $("#agentTrace"),
  summary: $("#summary"),
  warnings: $("#warnings"),
  results: $("#results"),
  reportWrap: $("#reportWrap"),
  reportRaw: $("#reportRaw"),
  resultsEmpty: $("#resultsEmpty"),
  countrySelect: $("#country"),
};

let checklistIndex = new Map();
let currentFiles = [];
let activeFileIdx = -1;
let previewObjectUrl = null;
let localAudit = null;
let safePackage = null;
let levelOneProcessing = false;
let privacyProcessing = false;
let previewGeneration = 0;
const reviewedMaterialIds = new Set();

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (character) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]
  );
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function shortDesc(description) {
  if (!description) return "";
  const lines = description.split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => /[一-龥]/.test(line)) || lines[0] || description;
}

function fileIcon(name) {
  const extension = (name.split(".").pop() || "").toLowerCase();
  if (["jpg", "jpeg", "png", "gif", "webp", "bmp"].includes(extension)) return "🖼";
  if (extension === "pdf") return "📕";
  if (["doc", "docx"].includes(extension)) return "📄";
  if (["xls", "xlsx"].includes(extension)) return "📊";
  if (["zip", "rar", "7z"].includes(extension)) return "🗜";
  return "📎";
}

function previewKind(file) {
  if (file.type.startsWith("image/")) return "image";
  if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) return "pdf";
  return null;
}

async function api(path, options) {
  const response = await fetch(API + path, options);
  if (!response.ok) {
    let detail = response.statusText;
    try { detail = (await response.json()).detail ?? detail; } catch {}
    throw new Error(`${response.status} ${detail}`);
  }
  return response.json();
}

const stages = {
  intro: document.querySelector('[data-stage="intro"]'),
  country: document.querySelector('[data-stage="country"]'),
  work: document.querySelector('[data-stage="work"]'),
};

function goto(stageName) {
  document.body.classList.toggle("is-workspace", stageName === "work");
  Object.entries(stages).forEach(([name, stage]) => {
    stage.classList.toggle("is-active", name === stageName);
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function switchTab(name) {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("tab--active", tab.dataset.tab === name);
  });
  document.querySelectorAll(".tabpane").forEach((pane) => {
    pane.classList.toggle("tabpane--active", pane.id === `tab-${name}`);
  });
  el.privacyStatusBar.hidden = name !== "privacy";
  if (name === "privacy") renderPrivacyMaterial(activeFileIdx);
  renderFileList();
}

async function checkHealth() {
  try {
    const health = await api("/healthz");
    const llm = health.llm_available ? "LLM 已配置" : "LLM 未配置（走 mock）";
    el.healthText.textContent = `后端在线 · ${llm}`;
    el.health.className = "health health--ok";
  } catch {
    el.healthText.textContent = "后端离线";
    el.health.className = "health health--down";
  }
}

async function loadChecklist(country) {
  el.checklist.innerHTML = "";
  el.checklistMeta.textContent = "加载中…";
  checklistIndex = new Map();
  try {
    const data = await api(`/material-audit/checklist?country=${encodeURIComponent(country)}`);
    el.checklistMeta.innerHTML =
      `<b>${escapeHtml(data.country)}</b> · 共 ${data.items.length} 项要求` +
      (data.source ? ` · <span class="muted">来源 ${escapeHtml(data.source)}</span>` : "");
    for (const item of data.items) {
      checklistIndex.set(item.id, item);
      const row = document.createElement("li");
      const keywords = (item.match_keywords || []).join(", ");
      row.innerHTML = `${escapeHtml(shortDesc(item.description))}` +
        (keywords ? `<span class="kw">关键词：${escapeHtml(keywords)}</span>` : "");
      el.checklist.appendChild(row);
    }
  } catch (error) {
    el.checklistMeta.textContent = `加载清单失败：${error.message}`;
  }
}

function setPrivacyBadge(mode, text) {
  el.privacyBadge.className = `privacy-badge privacy-badge--${mode}`;
  el.privacyBadge.textContent = text;
}

function updateWorkflowSteps() {
  const hasFiles = currentFiles.length > 0;
  const hasLevelOneAudit = Boolean(localAudit);
  const hasSafePackage = Boolean(safePackage);
  const allConfirmed = Boolean(safePackage?.privacy?.user_reviewed);
  el.pickerStep.classList.toggle("is-current", !hasFiles);
  el.pickerStep.classList.toggle("is-complete", hasFiles);
  el.levelOneBtn.classList.toggle("is-current", hasFiles && !hasLevelOneAudit && !levelOneProcessing);
  el.levelOneBtn.classList.toggle("is-complete", hasLevelOneAudit);
  el.privacyBtn.classList.toggle("is-current", hasLevelOneAudit && !hasSafePackage && !privacyProcessing);
  el.privacyBtn.classList.toggle("is-complete", hasSafePackage);
  el.runBtn.classList.toggle("is-current", allConfirmed);
  el.runBtn.classList.toggle("is-complete", Boolean(el.results.innerHTML));
  el.levelOneBtn.disabled = !hasFiles || levelOneProcessing || hasLevelOneAudit;
  el.privacyBtn.disabled = !hasLevelOneAudit || privacyProcessing || hasSafePackage;
  el.confirmAllBtn.disabled = !hasSafePackage || allConfirmed;
  el.runBtn.disabled = !allConfirmed;
}

function revokePreviewUrl() {
  if (previewObjectUrl) {
    URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = null;
  }
}

function resetPrivacyState() {
  localAudit = null;
  safePackage = null;
  reviewedMaterialIds.clear();
  el.privacyMaterial.hidden = true;
  el.privacyEmpty.hidden = false;
  el.privacySummary.innerHTML = "";
  el.privacyValidation.textContent = "";
  el.privacyValidation.className = "privacy-validation";
  el.privacyStatus.textContent = "";
  el.levelOneStatus.textContent = "";
  el.levelOneStatus.classList.remove("runstatus--err");
  el.levelOneSummary.innerHTML = "";
  el.levelOneResults.innerHTML = "";
  el.levelOneEmpty.style.display = "";
  setPrivacyBadge("idle", "尚未处理");
  updateWorkflowSteps();
  renderFileList();
}

function resetWorkspace() {
  previewGeneration += 1;
  revokePreviewUrl();
  currentFiles = [];
  activeFileIdx = -1;
  el.picker.value = "";
  el.filelist.innerHTML = "";
  el.materialsDir.textContent = "尚未选择";
  el.previewArea.innerHTML = "";
  el.previewEmpty.style.display = "";
  el.results.innerHTML = "";
  el.agentTrace.innerHTML = "";
  el.warnings.innerHTML = "";
  el.summary.innerHTML = "";
  el.reportWrap.hidden = true;
  el.resultsEmpty.style.display = "";
  el.runStatus.textContent = "";
  resetPrivacyState();
}

function onPick() {
  currentFiles = Array.from(el.picker.files || []);
  el.filelist.innerHTML = "";
  el.previewArea.innerHTML = "";
  el.previewEmpty.style.display = "";
  activeFileIdx = -1;
  resetPrivacyState();
  updateWorkflowSteps();

  if (!currentFiles.length) return;

  const relativePath = currentFiles[0].webkitRelativePath || "";
  el.materialsDir.textContent = relativePath.split("/")[0] || "已选择本地文件";

  renderFileList();
  selectFile(0, "preview");
  updateWorkflowSteps();
}

function renderFileList() {
  el.filelist.innerHTML = "";
  currentFiles.forEach((file, index) => {
    const material = safePackage?.materials?.[index];
    const confirmed = material && reviewedMaterialIds.has(material.material_id);
    const row = document.createElement("li");
    row.dataset.idx = String(index);
    row.classList.toggle("is-active", index === activeFileIdx);
    row.innerHTML =
      `<button class="file-main" type="button" title="${escapeHtml(file.webkitRelativePath || file.name)}">` +
      `<span class="file-icon">${fileIcon(file.name)}</span>` +
      `<span class="file-name">${escapeHtml(file.webkitRelativePath || file.name)}</span>` +
      `<span class="file-size">${confirmed ? "已确认 ✓" : humanSize(file.size)}</span></button>`;
    row.querySelector(".file-main").addEventListener("click", () => selectFile(index, "preview"));
    el.filelist.appendChild(row);
  });
}

function renderLevelOneAudit(audit) {
  const analyses = audit?.analyses || [];
  const findings = analyses.flatMap((item) => item.findings || []);
  const warnings = findings.filter((item) => item.status === "warning").length;
  const failures = findings.filter((item) => item.status === "fail").length;
  el.levelOneEmpty.style.display = "none";
  el.levelOneSummary.innerHTML = [
    `<span class="chip">文件 <b>${analyses.length}</b></span>`,
    `<span class="chip">提示 <b>${warnings}</b></span>`,
    `<span class="chip">问题 <b>${failures}</b></span>`,
    `<span class="chip">原始材料上传 <b>0</b></span>`,
  ].join("");
  el.levelOneResults.innerHTML = analyses.map((analysis, index) => {
    const file = currentFiles[index];
    const textLength = analysis.text?.length || 0;
    const items = (analysis.findings || []).map((finding) =>
      `<div class="level-one-finding level-one-finding--${escapeHtml(finding.status)}">${escapeHtml(finding.message)}</div>`
    ).join("");
    return `<article class="level-one-card"><header><b>${escapeHtml(file?.webkitRelativePath || file?.name || `文件 ${index + 1}`)}</b>` +
      `<span>${textLength ? `提取 ${textLength} 个字符` : "未提取到文本"}</span></header>${items}</article>`;
  }).join("");
}

async function runLevelOneAudit() {
  if (!currentFiles.length || levelOneProcessing) return;
  levelOneProcessing = true;
  updateWorkflowSteps();
  el.levelOneStatus.textContent = "本地识别中…";
  el.levelOneStatus.classList.remove("runstatus--err");
  switchTab("level-one");
  try {
    localAudit = await analyzeFilesLocally(
      currentFiles,
      el.countrySelect.value,
      ({ current, total, label }) => {
        el.levelOneStatus.textContent = `${label} · ${current}/${total}`;
      },
    );
    renderLevelOneAudit(localAudit);
    el.levelOneStatus.textContent = "一级审核完成，原始内容未离开本机。";
  } catch (error) {
    localAudit = null;
    el.levelOneStatus.textContent = `一级审核失败：${error.message}`;
    el.levelOneStatus.classList.add("runstatus--err");
  } finally {
    levelOneProcessing = false;
    updateWorkflowSteps();
  }
}

async function selectFile(index, targetTab = "preview") {
  if (index < 0 || index >= currentFiles.length) return;
  activeFileIdx = index;
  switchTab(targetTab);
  if (targetTab === "privacy") return;

  const generation = ++previewGeneration;
  revokePreviewUrl();
  const file = currentFiles[index];
  const kind = previewKind(file);
  el.previewEmpty.style.display = "none";
  el.previewArea.innerHTML = "";

  const body = document.createElement("div");
  body.className = "preview__body";
  if (kind === "image") {
    previewObjectUrl = URL.createObjectURL(file);
    body.innerHTML = `<img src="${previewObjectUrl}" alt="${escapeHtml(file.name)}" />`;
  } else if (kind === "pdf") {
    body.innerHTML = `<div class="preview__placeholder">正在生成只读预览…</div>`;
    try {
      await renderPdfReadOnly(file, body, {
        isCurrent: () => generation === previewGeneration,
      });
    } catch (error) {
      if (generation === previewGeneration) {
        body.innerHTML = `<div class="preview__placeholder">PDF 预览失败：${escapeHtml(error.message)}</div>`;
      }
    }
  } else {
    body.innerHTML = `<div class="preview__placeholder"><span class="icon">${fileIcon(file.name)}</span>` +
      `<div>此文件类型不支持在浏览器内预览</div>` +
      `<div style="font-size:12px;margin-top:4px;">当前版本不会读取或发送它的二进制内容。</div></div>`;
  }
  el.previewArea.appendChild(body);
}

function renderPrivacySummary(packageValue) {
  const materials = packageValue?.materials || [];
  const redactions = materials.reduce(
    (total, material) => total + (material.redactions || []).reduce((sum, item) => sum + item.count, 0),
    0,
  );
  el.privacySummary.innerHTML = [
    ["材料对象", materials.length],
    ["已确认", reviewedMaterialIds.size],
    ["隐私替换", redactions],
  ].map(([label, value]) => `<div class="privacy-stat">${label}<b>${value}</b></div>`).join("");
}

function renderPrivacyContent(material) {
  el.privacyContent.innerHTML = "";
  const blocks = material.content_blocks?.length
    ? material.content_blocks
    : [
      ...(material.text ? [{ type: "text", text: material.text }] : []),
      ...(material.images || []).map((image) => ({ type: "image", image })),
    ];

  if (!blocks.length) {
    el.privacyContent.innerHTML = `<div class="privacy-content__empty">当前没有可安全发送的内容。扫描件与未擦除图片暂不会发送。</div>`;
    return;
  }

  blocks.forEach((block, blockIndex) => {
    if (block.type === "text") {
      const textarea = document.createElement("textarea");
      textarea.className = "privacy-content__text";
      textarea.rows = 8;
      textarea.spellcheck = false;
      textarea.value = block.text;
      textarea.dataset.blockIndex = String(blockIndex);
      textarea.setAttribute("aria-label", "脱敏后的文本内容");
      textarea.addEventListener("input", markCurrentMaterialDirty);
      el.privacyContent.appendChild(textarea);
      return;
    }

    const image = block.image;
    const imageBlock = document.createElement("div");
    imageBlock.className = "privacy-content__image";
    if (image.included && typeof image.content === "string" && image.content.startsWith("data:image/")) {
      const preview = document.createElement("img");
      preview.src = image.content;
      preview.alt = "脱敏后的材料图片";
      imageBlock.appendChild(preview);
    } else {
      imageBlock.innerHTML = `<span class="icon">🖼</span><b>图片暂未发送</b><span>等待后续接入图片隐私擦除能力</span>`;
    }
    el.privacyContent.appendChild(imageBlock);
  });
}

function renderPrivacyMaterial(index) {
  const material = safePackage?.materials?.[index];
  if (!material) {
    el.privacyMaterial.hidden = true;
    el.privacyEmpty.hidden = false;
    return;
  }

  const file = currentFiles[index];
  const confirmed = reviewedMaterialIds.has(material.material_id);
  el.privacyEmpty.hidden = true;
  el.privacyMaterial.hidden = false;
  el.privacyMaterialRef.textContent = material.material_id;
  el.privacyMaterialTitle.textContent = file?.webkitRelativePath || file?.name || `材料 ${index + 1}`;
  el.privacyReviewState.textContent = confirmed ? "已确认" : "待确认";
  el.privacyReviewState.className = `privacy-badge ${confirmed ? "privacy-badge--ready" : "privacy-badge--review"}`;
  el.privacyRedactions.innerHTML = (material.redactions || []).length
    ? material.redactions.map((item) =>
      `<span class="redaction-chip">${escapeHtml(item.type)} <b>${item.count}</b></span>`
    ).join("")
    : `<span class="muted">未发现可自动识别的文本隐私</span>`;
  renderPrivacyContent(material);
  el.privacyValidation.textContent = confirmed
    ? "✓ 此文件对应的安全材料对象已确认。原文件未被修改。"
    : "请逐块核对内容；确认后，后端只会收到这个安全材料对象。";
  el.privacyValidation.className = `privacy-validation ${confirmed ? "is-ok" : ""}`;
}

function markCurrentMaterialDirty() {
  const material = safePackage?.materials?.[activeFileIdx];
  if (!material) return;
  const textBlocks = [...el.privacyContent.querySelectorAll(".privacy-content__text")];
  for (const textarea of textBlocks) {
    const block = material.content_blocks?.[Number(textarea.dataset.blockIndex)];
    if (block?.type === "text") block.text = textarea.value;
  }
  if (textBlocks.length) material.text = textBlocks.map((textarea) => textarea.value).join("\n\n");
  reviewedMaterialIds.delete(material.material_id);
  safePackage.privacy.user_reviewed = false;
  el.runBtn.disabled = true;
  setPrivacyBadge("review", `${reviewedMaterialIds.size}/${safePackage.materials.length} 已确认`);
  el.privacyReviewState.textContent = "有未确认修改";
  el.privacyReviewState.className = "privacy-badge privacy-badge--review";
  el.privacyValidation.textContent = "当前材料已修改，请重新确认。";
  el.privacyValidation.className = "privacy-validation";
  renderPrivacySummary(safePackage);
  renderFileList();
  updateWorkflowSteps();
}

function confirmCurrentMaterial() {
  const material = safePackage?.materials?.[activeFileIdx];
  if (!material) return;
  markCurrentMaterialDirty();
  reviewedMaterialIds.add(material.material_id);
  safePackage.country = el.countrySelect.value;
  safePackage.privacy.user_reviewed = reviewedMaterialIds.size === safePackage.materials.length;
  const errors = validateSafePackage(safePackage);
  if (errors.length) {
    reviewedMaterialIds.delete(material.material_id);
    safePackage.privacy.user_reviewed = false;
    el.privacyValidation.innerHTML = errors.map((error) => `• ${escapeHtml(error)}`).join("<br>");
    el.privacyValidation.className = "privacy-validation is-error";
    setPrivacyBadge("error", "需要修正");
    return;
  }

  const allConfirmed = safePackage.privacy.user_reviewed;
  setPrivacyBadge(allConfirmed ? "ready" : "review", allConfirmed ? "全部确认，可发送" : `${reviewedMaterialIds.size}/${safePackage.materials.length} 已确认`);
  el.runBtn.disabled = !allConfirmed;
  renderPrivacySummary(safePackage);
  renderPrivacyMaterial(activeFileIdx);
  renderFileList();
  updateWorkflowSteps();
}

function confirmAllMaterials() {
  if (!safePackage?.materials?.length) return;
  markCurrentMaterialDirty();
  const errors = validateSafePackage(safePackage);
  if (errors.length) {
    el.privacyValidation.innerHTML = errors.map((error) => `• ${escapeHtml(error)}`).join("<br>");
    el.privacyValidation.className = "privacy-validation is-error";
    setPrivacyBadge("error", "需要修正");
    return;
  }
  reviewedMaterialIds.clear();
  safePackage.materials.forEach((material) => reviewedMaterialIds.add(material.material_id));
  safePackage.privacy.user_reviewed = true;
  setPrivacyBadge("ready", "全部确认，可发送");
  renderPrivacySummary(safePackage);
  renderPrivacyMaterial(activeFileIdx);
  renderFileList();
  updateWorkflowSteps();
}

async function processPrivacy() {
  if (!localAudit || privacyProcessing) return;
  privacyProcessing = true;
  el.privacyBtn.disabled = true;
  el.runBtn.disabled = true;
  setPrivacyBadge("working", "本地处理中…");
  el.privacyStatus.classList.remove("runstatus--err");
  switchTab("privacy");

  try {
    el.privacyStatus.textContent = "正在擦除一级审核文本中的隐私…";
    const draft = buildSafePackageFromAnalysis(localAudit);
    safePackage = draft;
    reviewedMaterialIds.clear();
    renderPrivacySummary(draft);
    renderPrivacyMaterial(activeFileIdx < 0 ? 0 : activeFileIdx);
    renderFileList();
    setPrivacyBadge("review", `0/${draft.materials.length} 已确认`);
    el.privacyStatus.textContent = "安全材料已生成，请逐个核对或一键确认。";
  } catch (error) {
    safePackage = null;
    setPrivacyBadge("error", "处理失败");
    el.privacyStatus.textContent = `隐私处理失败：${error.message}`;
    el.privacyStatus.classList.add("runstatus--err");
  } finally {
    privacyProcessing = false;
    updateWorkflowSteps();
  }
}

async function runAudit() {
  if (!safePackage || !safePackage.privacy?.user_reviewed) {
    el.runStatus.textContent = "请先完成隐私擦除，并逐个确认安全材料。";
    el.runStatus.classList.add("runstatus--err");
    switchTab("privacy");
    return;
  }

  el.runBtn.disabled = true;
  el.runStatus.textContent = "Agent 审核中…";
  el.runStatus.classList.remove("runstatus--err");
  switchTab("results");
  try {
    const data = await api("/material-audit/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        country: safePackage.country,
        visa_type: safePackage.visa_type,
        materials: safePackage.materials,
        privacy: safePackage.privacy,
        review_scopes: ["checklist", "risk"],
        use_llm: false,
      }),
    });
    renderResults(data);
    el.runStatus.textContent = `完成 · 共 ${data.summary.total} 项`;
  } catch (error) {
    el.runStatus.textContent = `审核失败：${error.message}`;
    el.runStatus.classList.add("runstatus--err");
  } finally {
    el.runBtn.disabled = !safePackage?.privacy?.user_reviewed;
    updateWorkflowSteps();
  }
}

function renderResults(data) {
  const summary = data.summary;
  el.resultsEmpty.style.display = "none";
  el.agentTrace.innerHTML = (data.agent_trace || []).length
    ? `<div class="agent-trace__title">Agent 执行流程</div><div class="agent-trace__steps">` +
      data.agent_trace.map((step) =>
        `<div class="agent-step agent-step--${escapeHtml(step.status)}">` +
        `<span>${escapeHtml(step.name)}</span><b>${escapeHtml(step.status)}</b>` +
        `<small>${escapeHtml(step.detail || "")}</small></div>`
      ).join("") + `</div>`
    : "";
  el.summary.innerHTML = [
    `<span class="chip">合计 <b>${summary.total}</b></span>`,
    `<span class="chip">通过 <b>${summary.PASS}</b></span>`,
    `<span class="chip">警告 <b>${summary.WARNING}</b></span>`,
    `<span class="chip">未通过 <b>${summary.FAIL}</b></span>`,
    `<span class="chip">不适用 <b>${summary.N_A}</b></span>`,
  ].join("");
  el.warnings.innerHTML = (summary.warnings || [])
    .map((warning) => `<div class="banner">${escapeHtml(warning)}</div>`).join("");
  el.results.innerHTML = (data.results || []).map((result) => {
    const checklistItem = checklistIndex.get(result.item_id);
    const description = checklistItem ? shortDesc(checklistItem.description) : `第 ${result.item_id} 项`;
    const files = result.matched?.length
      ? `<span class="files">📎 ${result.matched.map(escapeHtml).join(", ")}</span>` : "";
    const llm = (result.llm_checks || []).map((check) =>
      `<span class="llm">🤖 ${escapeHtml(check.value)} · ${escapeHtml(check.rationale)}</span>`
    ).join("");
    const badgeClass = result.status === "N/A" ? "NA" : result.status;
    return `<div class="row"><div class="row__id">${result.item_id}</div>` +
      `<div class="row__desc">${escapeHtml(description)}${files}${llm}</div>` +
      `<span class="badge badge--${badgeClass}">${escapeHtml(result.status)}</span></div>`;
  }).join("");

  if (data.markdown_report) {
    el.reportWrap.hidden = false;
    el.reportRaw.textContent = data.markdown_report;
  } else {
    el.reportWrap.hidden = true;
  }
}

document.querySelectorAll("[data-action]").forEach((button) => {
  button.addEventListener("click", () => {
    const action = button.dataset.action;
    if (action === "go-country") goto("country");
    else if (action === "go-intro") goto("intro");
    else if (action === "back-country") {
      resetWorkspace();
      goto("country");
    } else if (action === "start") {
      const labels = { IS: "冰岛", NO: "挪威" };
      el.wsCountry.textContent = labels[el.countrySelect.value] || el.countrySelect.value;
      resetWorkspace();
      loadChecklist(el.countrySelect.value);
      goto("work");
    }
  });
});

el.picker.addEventListener("change", onPick);
el.levelOneBtn.addEventListener("click", runLevelOneAudit);
el.privacyBtn.addEventListener("click", processPrivacy);
el.confirmAllBtn.addEventListener("click", confirmAllMaterials);
el.confirmMaterialBtn.addEventListener("click", confirmCurrentMaterial);
el.runBtn.addEventListener("click", runAudit);
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => switchTab(tab.dataset.tab));
});
window.addEventListener("beforeunload", revokePreviewUrl);

checkHealth();
