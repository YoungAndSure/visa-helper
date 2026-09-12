/**
 * Material audit UI state machine.
 *
 * Raw File objects stay in browser memory. Only user-reviewed safe material objects
 * can be sent to /material-audit/run.
 */
import { createLocalAuditContext, runLocalAuditRules } from "./local-audit-engine.js?v=plugin-audit-v1";
import {
  LOCAL_RECOGNITION_PIPELINE_VERSION,
  preprocessFilesLocally,
  renderPdfReadOnly,
} from "./local-recognition.js?v=document-context-v3";
import {
  buildSafePackage,
  countRedactions,
  exportRedactedMaterial,
  prepareRedactionWorkspace,
  renderRedactionEditor,
  validateSafePackage,
} from "./privacy.js?v=selection-preview-v3";
import { filterSelectedFiles } from "./file-filter.js?v=ignored-files-v1";
import { clearWorkspaceSession, restoreWorkspaceSession, saveWorkspaceFiles, saveWorkspaceState } from "./workspace-session.js?v=workspace-resume-v1";
import { createFrontendDebugRun } from "./frontend-debug.js?v=realtime-debug-v2";
import { fetchChecklist } from "./checklist-loader.js";

const API = "";
const $ = (selector) => document.querySelector(selector);

const el = {
  health: $("#health"),
  healthText: $("#health .health__text"),
  wsCountry: $("#wsCountry"),
  picker: $("#picker"),
  pickerStep: $("#pickerStep"),
  preprocessingStatus: $("#preprocessingStatus"),
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
  checklistRetry: $("#checklistRetry"),
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
let checklistItems = [];
let checklistLoadPromise = Promise.resolve();
let checklistController = null;
let checklistReady = false;
let currentFiles = [];
let activeFileIdx = -1;
let previewObjectUrl = null;
let preprocessing = null;
let localAudit = null;
let redactionWorkspace = null;
let safePackage = null;
let preprocessingProcessing = false;
let levelOneProcessing = false;
let privacyProcessing = false;
let previewGeneration = 0;
let redactionRenderGeneration = 0;
let activeTabName = "checklist";
let auditResult = null;
let restoringWorkspace = false;
let saveTimer = null;
let localDebugRun = null;
let privacyDebugRun = null;
const reviewedMaterialIds = new Set();

const pageDebugRun = createFrontendDebugRun("page", {
  url: window.location.href,
  user_agent: navigator.userAgent,
});
window.addEventListener("error", (event) => {
  pageDebugRun.log("window.error", {
    message: event.message,
    source: event.filename,
    line: event.lineno,
    column: event.colno,
    error: event.error,
  }, "error", event.message);
});
window.addEventListener("unhandledrejection", (event) => {
  pageDebugRun.log("window.unhandledrejection", { reason: event.reason }, "error", String(event.reason || ""));
});

function selectedFileDebugDetails() {
  return currentFiles.map((file, index) => ({
    index,
    name: file.name,
    relative_path: file.webkitRelativePath || file.name,
    media_type: file.type || "application/octet-stream",
    size: file.size,
    last_modified: file.lastModified || null,
  }));
}

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

function workspaceSnapshot() {
  return {
    version: 3,
    country: el.countrySelect.value,
    activeTabName,
    activeFileIdx,
    materialsDir: el.materialsDir.textContent,
    preprocessing,
    localAudit,
    redactionWorkspace,
    safePackage,
    reviewedMaterialIds: [...reviewedMaterialIds],
    auditResult,
  };
}

function queueWorkspaceSave() {
  if (restoringWorkspace || !stages.work.classList.contains("is-active")) return;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveWorkspaceState(workspaceSnapshot()).catch((error) => {
      console.warn("无法保存本地审核会话", error);
    });
  }, 120);
}

function switchTab(name) {
  activeTabName = name;
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("tab--active", tab.dataset.tab === name);
  });
  document.querySelectorAll(".tabpane").forEach((pane) => {
    pane.classList.toggle("tabpane--active", pane.id === `tab-${name}`);
  });
  el.privacyStatusBar.hidden = name !== "privacy";
  if (name === "privacy") void renderPrivacyMaterial(activeFileIdx);
  renderFileList();
  queueWorkspaceSave();
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
  checklistController?.abort();
  const controller = new AbortController();
  checklistController = controller;
  checklistReady = false;
  el.checklistRetry.hidden = true;
  el.checklistRetry.disabled = true;
  el.checklist.innerHTML = "";
  el.checklistMeta.textContent = "加载中…";
  checklistIndex = new Map();
  checklistItems = [];
  try {
    const data = await fetchChecklist(country, {
      signal: controller.signal,
      onAttempt: (attempt, total) => {
        el.checklistMeta.textContent = attempt === 1 ? "加载中…" : `清单暂未加载成功，正在重试（${attempt}/${total}）…`;
      },
    });
    if (controller.signal.aborted) return;
    checklistReady = true;
    checklistItems = data.items || [];
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
    if (controller.signal.aborted) return;
    el.checklistMeta.textContent = "尝试 3 次后仍无法加载清单，请确认后端服务在线，然后点击重试。";
    el.checklistRetry.hidden = false;
    el.checklistRetry.disabled = false;
    pageDebugRun.log("checklist.failed", { country, error }, "warning");
  }
}

function setPrivacyBadge(mode, text) {
  el.privacyBadge.className = `privacy-badge privacy-badge--${mode}`;
  el.privacyBadge.textContent = text;
}

function updateWorkflowSteps() {
  const hasPreprocessing = Boolean(preprocessing);
  const hasLevelOneAudit = Boolean(localAudit);
  const hasSafePackage = Boolean(safePackage);
  const allConfirmed = Boolean(safePackage?.privacy?.user_reviewed);
  el.pickerStep.classList.toggle("is-current", !hasPreprocessing);
  el.pickerStep.classList.toggle("is-complete", hasPreprocessing);
  el.levelOneBtn.classList.toggle("is-current", hasPreprocessing && !hasLevelOneAudit && !levelOneProcessing);
  el.levelOneBtn.classList.toggle("is-complete", hasLevelOneAudit);
  el.privacyBtn.classList.toggle("is-current", hasLevelOneAudit && !hasSafePackage && !privacyProcessing);
  el.privacyBtn.classList.toggle("is-complete", hasSafePackage);
  el.runBtn.classList.toggle("is-current", allConfirmed);
  el.runBtn.classList.toggle("is-complete", Boolean(el.results.innerHTML));
  el.picker.disabled = preprocessingProcessing;
  el.levelOneBtn.disabled = !hasPreprocessing || preprocessingProcessing || levelOneProcessing || hasLevelOneAudit;
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

function resetProcessingState() {
  preprocessing = null;
  localAudit = null;
  redactionWorkspace = null;
  safePackage = null;
  reviewedMaterialIds.clear();
  el.privacyMaterial.hidden = true;
  el.privacyEmpty.hidden = false;
  el.privacySummary.innerHTML = "";
  el.privacyValidation.textContent = "";
  el.privacyValidation.className = "privacy-validation";
  el.privacyStatus.textContent = "";
  el.preprocessingStatus.textContent = "";
  el.preprocessingStatus.classList.remove("runstatus--err");
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
  window.clearTimeout(saveTimer);
  saveTimer = null;
  previewGeneration += 1;
  revokePreviewUrl();
  currentFiles = [];
  auditResult = null;
  activeTabName = "checklist";
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
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("tab--active", tab.dataset.tab === "checklist");
  });
  document.querySelectorAll(".tabpane").forEach((pane) => {
    pane.classList.toggle("tabpane--active", pane.id === "tab-checklist");
  });
  el.privacyStatusBar.hidden = true;
  resetProcessingState();
}

async function onPick() {
  currentFiles = filterSelectedFiles(el.picker.files);
  el.filelist.innerHTML = "";
  el.previewArea.innerHTML = "";
  el.previewEmpty.style.display = "";
  activeFileIdx = -1;
  resetProcessingState();
  updateWorkflowSteps();

  if (!currentFiles.length) return;

  const relativePath = currentFiles[0].webkitRelativePath || "";
  el.materialsDir.textContent = relativePath.split("/")[0] || "已选择本地文件";

  renderFileList();
  selectFile(0, "preview");
  updateWorkflowSteps();
  try {
    await saveWorkspaceFiles(currentFiles);
  } catch (error) {
    el.levelOneStatus.textContent = "无法保存刷新恢复副本；本次可以继续，但刷新后需要重新选择文件夹。";
    el.levelOneStatus.classList.add("runstatus--err");
    console.warn("无法保存本地文件会话", error);
  }
  queueWorkspaceSave();
  await runLocalPreprocessing();
}

async function runLocalPreprocessing() {
  if (!currentFiles.length || preprocessingProcessing) return;
  const preprocessingDebugRun = createFrontendDebugRun("local-preprocessing", {
    country: el.countrySelect.value,
    file_count: currentFiles.length,
    files: selectedFileDebugDetails(),
  });
  preprocessingProcessing = true;
  preprocessing = null;
  localAudit = null;
  redactionWorkspace = null;
  safePackage = null;
  el.preprocessingStatus.textContent = "正在读取并预处理本地材料…";
  el.preprocessingStatus.classList.remove("runstatus--err");
  updateWorkflowSteps();
  try {
    preprocessing = await preprocessFilesLocally(currentFiles, {
      onProgress: ({ current, total, label }) => {
        el.preprocessingStatus.textContent = `${label} · ${current}/${total}`;
      },
      debugLog: preprocessingDebugRun.log,
    });
    el.preprocessingStatus.textContent = "材料预处理完成，可运行本地审核。";
    preprocessingDebugRun.finish({
      document_count: preprocessing.documents.length,
      pipeline_version: preprocessing.pipeline_version,
    });
    queueWorkspaceSave();
  } catch (error) {
    preprocessingDebugRun.fail(error);
    preprocessing = null;
    el.preprocessingStatus.textContent = `材料预处理失败：${error.message}`;
    el.preprocessingStatus.classList.add("runstatus--err");
  } finally {
    preprocessingProcessing = false;
    updateWorkflowSteps();
  }
}

function renderFileList() {
  el.filelist.innerHTML = "";
  currentFiles.forEach((file, index) => {
    const material = redactionWorkspace?.materials?.[index];
    const confirmed = material && reviewedMaterialIds.has(material.material_id);
    const row = document.createElement("li");
    row.dataset.idx = String(index);
    row.classList.toggle("is-active", index === activeFileIdx);
    row.innerHTML =
      `<button class="file-main" type="button" title="${escapeHtml(file.webkitRelativePath || file.name)}">` +
      `<span class="file-icon">${fileIcon(file.name)}</span>` +
      `<span class="file-name">${escapeHtml(file.webkitRelativePath || file.name)}</span>` +
      `<span class="file-size">${confirmed ? "已确认 ✓" : humanSize(file.size)}</span></button>`;
    row.querySelector(".file-main").addEventListener("click", () => {
      const targetTab = activeTabName === "privacy" && safePackage ? "privacy" : "preview";
      selectFile(index, targetTab);
    });
    el.filelist.appendChild(row);
  });
}

function renderLevelOneAudit(audit) {
  const documents = audit?.context?.documents || [];
  const results = audit?.rule_results || [];
  const summary = audit?.summary || {};
  const documentNames = new Map(documents.map((document) => [document.document_id, document.local_name]));
  el.levelOneEmpty.style.display = "none";
  el.levelOneSummary.innerHTML = [
    `<span class="chip">文件 <b>${documents.length}</b></span>`,
    `<span class="chip">规则 <b>${results.length}</b></span>`,
    `<span class="chip">通过 <b>${summary.pass || 0}</b></span>`,
    `<span class="chip">问题 <b>${(summary.fail || 0) + (summary.error || 0)}</b></span>`,
    `<span class="chip">待补能力 <b>${summary.unavailable || 0}</b></span>`,
    `<span class="chip">原始材料上传 <b>0</b></span>`,
  ].join("");
  el.levelOneResults.innerHTML = results.map((result) => {
    const checkedItems = result.checked_items?.length
      ? `<div class="level-one-checked">已执行：${result.checked_items.map(escapeHtml).join("；")}</div>` : "";
    const matchedNames = (result.matched_document_ids || [])
      .map((documentId) => documentNames.get(documentId) || documentId);
    const matched = matchedNames.length
      ? `<div class="level-one-matched">关联材料：${matchedNames.map(escapeHtml).join("、")}</div>` : "";
    return `<article class="level-one-card"><header><b>${escapeHtml(result.title)}</b>` +
      `<span>${escapeHtml(result.rule_id)} · v${escapeHtml(result.rule_version)}</span></header>` +
      `<div class="level-one-finding level-one-finding--${escapeHtml(result.status)}">${escapeHtml(result.reason)}</div>` +
      `${checkedItems}${matched}</article>`;
  }).join("");
}

async function runLevelOneAudit() {
  if (!preprocessing || levelOneProcessing) return;
  localDebugRun = createFrontendDebugRun("local-audit", {
    country: el.countrySelect.value,
    document_count: preprocessing.documents.length,
    pipeline_version: preprocessing.pipeline_version,
  });
  levelOneProcessing = true;
  updateWorkflowSteps();
  el.levelOneStatus.textContent = "正在运行本地审核规则…";
  el.levelOneStatus.classList.remove("runstatus--err");
  switchTab("level-one");
  try {
    await checklistLoadPromise;
    if (!checklistReady) throw new Error("要求清单尚未加载成功，请在「要求清单」页点击重新加载清单。");
    const country = el.countrySelect.value;
    const context = createLocalAuditContext({
      country,
      visaType: country === "IS" ? "schengen-tourism" : "unknown",
      checklist: checklistItems,
      preprocessing,
    });
    localAudit = await runLocalAuditRules(context, {
      onProgress: ({ current, total, label }) => {
        el.levelOneStatus.textContent = `${label} · ${current}/${total}`;
      },
    });
    localDebugRun.log("rules.completed", {
      summary: localAudit.summary,
      rules: localAudit.rule_results.map((result) => ({
        rule_id: result.rule_id,
        status: result.status,
        duration_ms: result.duration_ms,
        reason: result.reason,
      })),
    });
    renderLevelOneAudit(localAudit);
    el.levelOneStatus.textContent = "本地审核完成，原始内容未离开本机。";
    localDebugRun.finish({ summary: localAudit.summary });
    queueWorkspaceSave();
  } catch (error) {
    localDebugRun.fail(error);
    localAudit = null;
    el.levelOneStatus.textContent = `本地审核失败：${error.message}`;
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
  queueWorkspaceSave();
}

function renderPrivacySummary(workspace) {
  const materials = workspace?.materials || [];
  const redactions = countRedactions(workspace);
  el.privacySummary.innerHTML = [
    ["安全文件", materials.length],
    ["已确认", reviewedMaterialIds.size],
    ["打码区域", redactions],
  ].map(([label, value]) => `<div class="privacy-stat">${label}<b>${value}</b></div>`).join("");
}

async function renderPrivacyMaterial(index) {
  const generation = ++redactionRenderGeneration;
  const material = redactionWorkspace?.materials?.[index];
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
  const automatic = material.pages.reduce((sum, page) => sum + page.redactions.filter((item) => item.source === "automatic").length, 0);
  const manual = material.pages.reduce((sum, page) => sum + page.redactions.filter((item) => item.source === "manual").length, 0);
  el.privacyRedactions.innerHTML = `<span class="redaction-chip">自动识别 <b>${automatic}</b></span><span class="redaction-chip">手动涂抹 <b>${manual}</b></span>`;
  el.privacyContent.innerHTML = `<div class="preview__placeholder">正在加载脱敏编辑器…</div>`;
  const renderStartedAt = performance.now();
  privacyDebugRun?.log("redaction-editor.render.started", {
    file_name: file?.name,
    file_index: index,
    page_count: material.pages.length,
  });
  try {
    await renderRedactionEditor(material, file, el.privacyContent, {
      onChange: markCurrentMaterialDirty,
      isCurrent: () => generation === redactionRenderGeneration,
    });
    privacyDebugRun?.log("redaction-editor.render.completed", {
      file_name: file?.name,
      file_index: index,
      duration_ms: performance.now() - renderStartedAt,
    });
  } catch (error) {
    privacyDebugRun?.log("redaction-editor.render.failed", {
      file_name: file?.name,
      file_index: index,
      duration_ms: performance.now() - renderStartedAt,
      error,
    }, "error");
    if (generation === redactionRenderGeneration) {
      el.privacyContent.innerHTML = `<div class="privacy-content__empty">脱敏编辑器加载失败：${escapeHtml(error.message)}</div>`;
    }
  }
  if (generation !== redactionRenderGeneration) return;
  el.privacyValidation.textContent = material.processing_error || (confirmed
    ? "✓ 脱敏副本已生成并确认；原文件没有被修改。"
    : "请核对所有黑色遮挡；有遗漏时直接拖动画框，然后确认当前材料。自动识别不能保证覆盖全部隐私。" );
  el.privacyValidation.className = `privacy-validation ${confirmed ? "is-ok" : ""}`;
}

function markCurrentMaterialDirty() {
  const material = redactionWorkspace?.materials?.[activeFileIdx];
  if (!material) return;
  reviewedMaterialIds.delete(material.material_id);
  safePackage = buildSafePackage(redactionWorkspace, false);
  el.runBtn.disabled = true;
  setPrivacyBadge("review", `${reviewedMaterialIds.size}/${redactionWorkspace.materials.length} 已确认`);
  el.privacyReviewState.textContent = "有未确认修改";
  el.privacyReviewState.className = "privacy-badge privacy-badge--review";
  el.privacyValidation.textContent = "涂抹区域已修改，请重新生成并确认脱敏副本。";
  el.privacyValidation.className = "privacy-validation";
  renderPrivacySummary(redactionWorkspace);
  renderFileList();
  updateWorkflowSteps();
  queueWorkspaceSave();
}

async function confirmCurrentMaterial() {
  const material = redactionWorkspace?.materials?.[activeFileIdx];
  if (!material) return;
  el.confirmMaterialBtn.disabled = true;
  el.privacyValidation.textContent = "正在把遮挡烧录进新的脱敏文件…";
  try {
    await exportRedactedMaterial(material, currentFiles[activeFileIdx], {
      debugLog: privacyDebugRun?.log,
    });
    reviewedMaterialIds.add(material.material_id);
  } catch (error) {
    reviewedMaterialIds.delete(material.material_id);
    el.privacyValidation.textContent = `生成失败：${error.message}`;
    el.privacyValidation.className = "privacy-validation is-error";
    return;
  } finally {
    el.confirmMaterialBtn.disabled = false;
  }
  const allConfirmed = reviewedMaterialIds.size === redactionWorkspace.materials.length;
  safePackage = buildSafePackage(redactionWorkspace, allConfirmed);
  const errors = validateSafePackage(safePackage);
  if (errors.length) {
    reviewedMaterialIds.delete(material.material_id);
    safePackage = buildSafePackage(redactionWorkspace, false);
    el.privacyValidation.innerHTML = errors.map((error) => `• ${escapeHtml(error)}`).join("<br>");
    el.privacyValidation.className = "privacy-validation is-error";
    setPrivacyBadge("error", "需要修正");
    return;
  }

  setPrivacyBadge(allConfirmed ? "ready" : "review", allConfirmed ? "全部确认，可发送" : `${reviewedMaterialIds.size}/${safePackage.materials.length} 已确认`);
  el.runBtn.disabled = !allConfirmed;
  if (allConfirmed) {
    privacyDebugRun?.finish({
      material_count: redactionWorkspace.materials.length,
      redaction_count: countRedactions(redactionWorkspace),
    });
  }
  renderPrivacySummary(redactionWorkspace);
  void renderPrivacyMaterial(activeFileIdx);
  renderFileList();
  updateWorkflowSteps();
  queueWorkspaceSave();
}

async function confirmAllMaterials() {
  if (!redactionWorkspace?.materials?.length) return;
  el.confirmAllBtn.disabled = true;
  setPrivacyBadge("working", "正在生成脱敏文件…");
  reviewedMaterialIds.clear();
  for (let index = 0; index < redactionWorkspace.materials.length; index += 1) {
    const material = redactionWorkspace.materials[index];
    try {
      el.privacyStatus.textContent = `正在生成脱敏文件 ${index + 1}/${redactionWorkspace.materials.length}…`;
      await exportRedactedMaterial(material, currentFiles[index], {
        debugLog: privacyDebugRun?.log,
      });
      reviewedMaterialIds.add(material.material_id);
    } catch (error) {
      safePackage = buildSafePackage(redactionWorkspace, false);
      setPrivacyBadge("error", "需要修正");
      el.privacyValidation.textContent = `${currentFiles[index]?.name || material.material_id}：${error.message}`;
      el.privacyValidation.className = "privacy-validation is-error";
      updateWorkflowSteps();
      return;
    }
  }
  safePackage = buildSafePackage(redactionWorkspace, true);
  const errors = validateSafePackage(safePackage);
  if (errors.length) {
    safePackage.privacy.user_reviewed = false;
    setPrivacyBadge("error", "需要修正");
    el.privacyValidation.innerHTML = errors.map((error) => `• ${escapeHtml(error)}`).join("<br>");
    el.privacyValidation.className = "privacy-validation is-error";
    updateWorkflowSteps();
    return;
  }
  setPrivacyBadge("ready", "全部确认，可发送");
  el.privacyStatus.textContent = "所有脱敏副本已生成并确认。";
  privacyDebugRun?.finish({
    material_count: redactionWorkspace.materials.length,
    redaction_count: countRedactions(redactionWorkspace),
  });
  renderPrivacySummary(redactionWorkspace);
  void renderPrivacyMaterial(activeFileIdx);
  renderFileList();
  updateWorkflowSteps();
  queueWorkspaceSave();
}

async function processPrivacy() {
  if (!localAudit || privacyProcessing) return;
  privacyDebugRun = createFrontendDebugRun("privacy-redaction", {
    country: el.countrySelect.value,
    file_count: currentFiles.length,
    files: selectedFileDebugDetails(),
  });
  privacyProcessing = true;
  el.privacyBtn.disabled = true;
  el.runBtn.disabled = true;
  setPrivacyBadge("working", "本地处理中…");
  el.privacyStatus.classList.remove("runstatus--err");
  switchTab("privacy");

  try {
    el.privacyStatus.textContent = "正在本机识别 PDF/JPG 中的隐私区域…";
    redactionWorkspace = await prepareRedactionWorkspace(localAudit, currentFiles, {
      onProgress: ({ label }) => { el.privacyStatus.textContent = label; },
      debugLog: privacyDebugRun.log,
    });
    safePackage = buildSafePackage(redactionWorkspace, false);
    reviewedMaterialIds.clear();
    renderPrivacySummary(redactionWorkspace);
    await renderPrivacyMaterial(activeFileIdx < 0 ? 0 : activeFileIdx);
    renderFileList();
    setPrivacyBadge("review", `0/${redactionWorkspace.materials.length} 已确认`);
    el.privacyStatus.textContent = "自动识别完成，请核对黑色遮挡并补充涂抹。";
    privacyDebugRun.log("automatic-redaction.completed", {
      material_count: redactionWorkspace.materials.length,
      redaction_count: countRedactions(redactionWorkspace),
    });
  } catch (error) {
    privacyDebugRun.fail(error);
    redactionWorkspace = null;
    safePackage = null;
    setPrivacyBadge("error", "处理失败");
    el.privacyStatus.textContent = `隐私处理失败：${error.message}`;
    el.privacyStatus.classList.add("runstatus--err");
  } finally {
    privacyProcessing = false;
    updateWorkflowSteps();
    queueWorkspaceSave();
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
  el.runStatus.textContent = "远端 Agent 审核中…";
  el.runStatus.classList.remove("runstatus--err");
  switchTab("results");
  try {
    const data = await api("/material-audit/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schema_version: safePackage.schema_version,
        country: safePackage.country,
        visa_type: safePackage.visa_type,
        materials: safePackage.materials,
        privacy: safePackage.privacy,
        review_scopes: ["checklist", "risk"],
        use_llm: false,
      }),
    });
    renderResults(data);
    auditResult = data;
    el.runStatus.textContent = `完成 · 共 ${data.summary.total} 项`;
    queueWorkspaceSave();
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

async function restoreSavedWorkspace() {
  restoringWorkspace = true;
  let restartPreprocessing = false;
  try {
    const restored = await restoreWorkspaceSession();
    if (!restored) return;
    const { state, files } = restored;
    currentFiles = filterSelectedFiles(files);
    const restoredAudit = state.localAudit || null;
    const restoredPreprocessing = state.preprocessing || restoredAudit?.context?.preprocessing || null;
    const currentPreprocessing = restoredPreprocessing?.schema_version === "local-document-context/v1"
      && restoredPreprocessing.pipeline_version === LOCAL_RECOGNITION_PIPELINE_VERSION;
    const staleRecognition = Boolean(restoredPreprocessing) && !currentPreprocessing;
    preprocessing = currentPreprocessing ? restoredPreprocessing : null;
    const currentAuditSchema = restoredAudit?.schema_version === "local-audit-result/v1" && currentPreprocessing;
    localAudit = currentAuditSchema ? restoredAudit : null;
    redactionWorkspace = currentAuditSchema && state.redactionWorkspace?.schema_version === "local-redaction-workspace/v1"
      ? state.redactionWorkspace : null;
    safePackage = redactionWorkspace && state.safePackage?.schema_version === "privacy-files/v1"
      ? state.safePackage : null;
    auditResult = currentAuditSchema ? (state.auditResult || null) : null;
    activeFileIdx = Math.min(Math.max(state.activeFileIdx ?? 0, 0), Math.max(currentFiles.length - 1, 0));
    reviewedMaterialIds.clear();
    if (currentAuditSchema) {
      (state.reviewedMaterialIds || []).forEach((id) => reviewedMaterialIds.add(id));
    }
    el.countrySelect.value = state.country || "IS";
    const labels = { IS: "冰岛", NO: "挪威" };
    el.wsCountry.textContent = labels[el.countrySelect.value] || el.countrySelect.value;
    el.materialsDir.textContent = state.materialsDir || "已恢复本地材料";
    checklistLoadPromise = loadChecklist(el.countrySelect.value);
    await checklistLoadPromise;
    goto("work");
    renderFileList();
    if (preprocessing) {
      el.preprocessingStatus.textContent = "已恢复材料预处理结果。";
    } else if (staleRecognition) {
      el.preprocessingStatus.textContent = "识别模块已升级，请重新选择材料文件夹并预处理。";
      el.preprocessingStatus.classList.add("runstatus--err");
    }
    if (localAudit) {
      renderLevelOneAudit(localAudit);
      el.levelOneStatus.textContent = "已恢复本地审核结果。";
    }
    if (safePackage && redactionWorkspace) {
      renderPrivacySummary(redactionWorkspace);
      const allConfirmed = Boolean(safePackage.privacy?.user_reviewed);
      setPrivacyBadge(allConfirmed ? "ready" : "review", allConfirmed ? "全部确认，可发送" : `${reviewedMaterialIds.size}/${safePackage.materials.length} 已确认`);
      el.privacyStatus.textContent = "已恢复脱敏文件，请继续核对。";
    }
    if (auditResult) renderResults(auditResult);
    updateWorkflowSteps();
    const restoredTab = currentAuditSchema && ["checklist", "preview", "level-one", "privacy", "results"].includes(state.activeTabName)
      ? state.activeTabName : (currentFiles.length ? "preview" : "checklist");
    if (currentFiles.length && restoredTab === "preview") await selectFile(activeFileIdx, "preview");
    else switchTab(restoredTab);
    if (!currentFiles.length) {
      el.levelOneStatus.textContent = "审核页面已恢复，但浏览器未能恢复文件；请重新选择材料文件夹。";
      el.levelOneStatus.classList.add("runstatus--err");
    } else if (!preprocessing) {
      restartPreprocessing = true;
      el.preprocessingStatus.textContent = "上次预处理未完成，正在从本地副本重新开始…";
    }
  } catch (error) {
    console.warn("无法恢复本地审核会话", error);
  } finally {
    restoringWorkspace = false;
    if (restartPreprocessing) void runLocalPreprocessing();
  }
}

document.querySelectorAll("[data-action]").forEach((button) => {
  button.addEventListener("click", async () => {
    const action = button.dataset.action;
    if (action === "go-country") goto("country");
    else if (action === "go-intro") goto("intro");
    else if (action === "back-country") {
      await clearWorkspaceSession();
      resetWorkspace();
      goto("country");
    } else if (action === "start") {
      await clearWorkspaceSession();
      const labels = { IS: "冰岛", NO: "挪威" };
      el.wsCountry.textContent = labels[el.countrySelect.value] || el.countrySelect.value;
      resetWorkspace();
      checklistLoadPromise = loadChecklist(el.countrySelect.value);
      goto("work");
      queueWorkspaceSave();
    }
  });
});

el.picker.addEventListener("change", onPick);
el.checklistRetry.addEventListener("click", () => {
  checklistLoadPromise = loadChecklist(el.countrySelect.value);
});
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
restoreSavedWorkspace();
