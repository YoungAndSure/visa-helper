/**
 * 材料审核前端页面逻辑（原生 JS，无构建）。
 *
 * 由 FastAPI 挂在 /ui 下同源提供，所以 API 走相对路径、无 CORS 问题。
 *
 * 隐私原则：用户选的材料文件只在浏览器本地读取，不上传文件本身；
 * 发给后端的只有国家、目录名、use_llm 等元信息。
 *
 * 三屏渐进式布局：
 *   intro   → 产品介绍
 *   country → 单选国家
 *   work    → 左选文件 / 右上 checklist + 文件预览 + 审核结果 三 tab 切换
 */

const API = "";
const $ = (sel) => document.querySelector(sel);

const el = {
  health: $("#health"),
  healthText: $("#health .health__text"),

  // 工作区
  wsCountry: $("#wsCountry"),
  picker: $("#picker"),
  filelist: $("#filelist"),
  materialsDir: $("#materialsDir"),
  useLlm: $("#useLlm"),
  runBtn: $("#runBtn"),
  runStatus: $("#runStatus"),

  // 右侧 tabpane
  checklistMeta: $("#checklistMeta"),
  checklist: $("#checklist"),
  previewArea: $("#previewArea"),
  previewEmpty: $("#previewEmpty"),
  summary: $("#summary"),
  warnings: $("#warnings"),
  results: $("#results"),
  reportWrap: $("#reportWrap"),
  reportRaw: $("#reportRaw"),
  resultsEmpty: $("#resultsEmpty"),

  // 国家选择（第二屏）
  countrySelect: $("#country"),
};

let checklistIndex = new Map();   // item.id → item
let currentFiles = [];            // 当前 picker 里的 File[]（webkitRelativePath 完整）
let activeFileIdx = -1;           // 当前预览文件索引
let previewObjectUrl = null;      // 当前 blob URL（切文件时 revoke）

// ---------- 工具 ----------
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}
function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
function shortDesc(description) {
  if (!description) return "";
  const lines = description.split("\n").map((s) => s.trim()).filter(Boolean);
  const zh = lines.find((l) => /[一-龥]/.test(l));
  return zh || lines[0] || description;
}
function fileIcon(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (["jpg", "jpeg", "png", "gif", "webp", "bmp"].includes(ext)) return "🖼";
  if (ext === "pdf") return "📕";
  if (["doc", "docx"].includes(ext)) return "📄";
  if (["xls", "xlsx"].includes(ext)) return "📊";
  if (["zip", "rar", "7z"].includes(ext)) return "🗜";
  return "📎";
}
function fileIsPreviewable(file) {
  if (file.type.startsWith("image/")) return "image";
  if (file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) return "pdf";
  return null;
}

async function api(path, opts) {
  const res = await fetch(API + path, opts);
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail ?? detail; } catch {}
    throw new Error(`${res.status} ${detail}`);
  }
  return res.json();
}

// ---------- 阶段切换 ----------
const stages = {
  intro: document.querySelector('[data-stage="intro"]'),
  country: document.querySelector('[data-stage="country"]'),
  work: document.querySelector('[data-stage="work"]'),
};
function goto(stageName) {
  Object.entries(stages).forEach(([name, elx]) => {
    elx.classList.toggle("is-active", name === stageName);
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ---------- 健康检查 ----------
async function checkHealth() {
  try {
    const h = await api("/healthz");
    const llm = h.llm_available ? "LLM 已配置" : "LLM 未配置(走 mock)";
    el.healthText.textContent = `后端在线 · ${llm}`;
    el.health.className = "health health--ok";
  } catch {
    el.healthText.textContent = "后端离线";
    el.health.className = "health health--down";
  }
}

// ---------- 加载 checklist ----------
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
      const li = document.createElement("li");
      const kw = (item.match_keywords || []).join(", ");
      li.innerHTML =
        `${escapeHtml(shortDesc(item.description))}` +
        (kw ? `<span class="kw">关键词：${escapeHtml(kw)}</span>` : "");
      el.checklist.appendChild(li);
    }
  } catch (e) {
    el.checklistMeta.textContent = `加载清单失败：${e.message}`;
  }
}

// ---------- 文件选择 ----------
function onPick() {
  currentFiles = Array.from(el.picker.files || []);
  el.filelist.innerHTML = "";
  el.runBtn.disabled = currentFiles.length === 0;
  el.previewArea.innerHTML = "";
  el.previewEmpty.style.display = "";
  activeFileIdx = -1;

  if (!currentFiles.length) return;

  // 回填顶层目录
  const rel = currentFiles[0].webkitRelativePath || "";
  const topDir = rel.split("/")[0];
  if (topDir && !el.materialsDir.value) el.materialsDir.value = topDir;

  currentFiles.forEach((f, idx) => {
    const li = document.createElement("li");
    li.dataset.idx = String(idx);
    li.innerHTML =
      `<span class="file-icon">${fileIcon(f.name)}</span>` +
      `<span class="file-name" title="${escapeHtml(f.webkitRelativePath || f.name)}">${escapeHtml(f.webkitRelativePath || f.name)}</span>` +
      `<span class="file-size">${humanSize(f.size)}</span>`;
    li.addEventListener("click", () => selectFile(idx));
    el.filelist.appendChild(li);
  });

  // 自动选第一个并切到预览 tab
  selectFile(0);
  switchTab("preview");
}

function selectFile(idx) {
  if (idx < 0 || idx >= currentFiles.length) return;
  activeFileIdx = idx;

  // 高亮当前项
  el.filelist.querySelectorAll("li").forEach((li, i) => {
    li.classList.toggle("is-active", i === idx);
  });

  // 释放上一个 blob URL
  if (previewObjectUrl) {
    URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = null;
  }

  const f = currentFiles[idx];
  const previewable = fileIsPreviewable(f);
  el.previewEmpty.style.display = "none";

  // 顶部 meta + 主体
  el.previewArea.innerHTML = "";
  const meta = document.createElement("div");
  meta.className = "preview__meta";
  meta.innerHTML =
    `<span>${fileIcon(f.name)}</span>` +
    `<b>${escapeHtml(f.webkitRelativePath || f.name)}</b>` +
    `<span style="margin-left:auto;color:var(--muted)">${humanSize(f.size)} · ${escapeHtml(f.type || "未知类型")}</span>`;
  el.previewArea.appendChild(meta);

  const body = document.createElement("div");
  body.className = "preview__body";
  if (previewable === "image") {
    const url = URL.createObjectURL(f);
    previewObjectUrl = url;
    body.innerHTML = `<img src="${url}" alt="${escapeHtml(f.name)}" />`;
  } else if (previewable === "pdf") {
    const url = URL.createObjectURL(f);
    previewObjectUrl = url;
    body.innerHTML = `<iframe src="${url}" title="${escapeHtml(f.name)}"></iframe>`;
  } else {
    body.innerHTML =
      `<div class="preview__placeholder">` +
      `<span class="icon">${fileIcon(f.name)}</span>` +
      `<div>此文件类型不支持在浏览器内预览</div>` +
      `<div style="font-size:12px;margin-top:4px;">文件已读取，提交审核时会作为元信息一并发送给后端。</div>` +
      `</div>`;
  }
  el.previewArea.appendChild(body);
}

// ---------- tabs ----------
function switchTab(name) {
  document.querySelectorAll(".tab").forEach((t) =>
    t.classList.toggle("tab--active", t.dataset.tab === name)
  );
  document.querySelectorAll(".tabpane").forEach((p) =>
    p.classList.toggle("tabpane--active", p.id === `tab-${name}`)
  );
}

// ---------- 运行审核 ----------
async function runAudit() {
  const country = el.countrySelect.value;
  const materials_dir = el.materialsDir.value.trim();
  if (!materials_dir) {
    el.runStatus.textContent = "请填写材料目录。";
    el.runStatus.classList.add("runstatus--err");
    return;
  }
  el.runBtn.disabled = true;
  el.runStatus.textContent = "审核中…";
  el.runStatus.classList.remove("runstatus--err");
  switchTab("results");
  try {
    const data = await api("/material-audit/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ country, materials_dir, use_llm: el.useLlm.checked }),
    });
    renderResults(data);
    el.runStatus.textContent = `完成 · 共 ${data.summary.total} 项`;
  } catch (e) {
    el.runStatus.textContent = `审核失败：${e.message}`;
    el.runStatus.classList.add("runstatus--err");
  } finally {
    el.runBtn.disabled = currentFiles.length === 0;
  }
}

function renderResults(data) {
  const s = data.summary;
  el.resultsEmpty.style.display = "none";

  el.summary.innerHTML = [
    `<span class="chip">合计 <b>${s.total}</b></span>`,
    `<span class="chip">通过 <b>${s.PASS}</b></span>`,
    `<span class="chip">警告 <b>${s.WARNING}</b></span>`,
    `<span class="chip">未通过 <b>${s.FAIL}</b></span>`,
    `<span class="chip">不适用 <b>${s.N_A}</b></span>`,
  ].join("");

  el.warnings.innerHTML = (s.warnings || [])
    .map((w) => `<div class="banner">${escapeHtml(w)}</div>`)
    .join("");

  el.results.innerHTML = (data.results || [])
    .map((r) => {
      const item = checklistIndex.get(r.item_id);
      const desc = item ? shortDesc(item.description) : `第 ${r.item_id} 项`;
      const files = r.matched && r.matched.length
        ? `<span class="files">📎 ${r.matched.map(escapeHtml).join(", ")}</span>`
        : "";
      const llm = (r.llm_checks || [])
        .map((c) => `<span class="llm">🤖 ${escapeHtml(c.value)} · ${escapeHtml(c.rationale)}</span>`)
        .join("");
      const badgeClass = r.status === "N/A" ? "NA" : r.status;
      return `<div class="row">
        <div class="row__id">${r.item_id}</div>
        <div class="row__desc">${escapeHtml(desc)}${files}${llm}</div>
        <span class="badge badge--${badgeClass}">${escapeHtml(r.status)}</span>
      </div>`;
    })
    .join("");

  if (data.markdown_report) {
    el.reportWrap.hidden = false;
    el.reportRaw.textContent = data.markdown_report;
  } else {
    el.reportWrap.hidden = true;
  }
}

// ---------- 绑定 ----------
document.querySelectorAll("[data-action]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const action = btn.dataset.action;
    if (action === "go-country") goto("country");
    else if (action === "go-intro") goto("intro");
    else if (action === "back-country") {
      goto("country");
      // 清空工作区
      el.filelist.innerHTML = "";
      el.previewArea.innerHTML = "";
      el.previewEmpty.style.display = "";
      el.results.innerHTML = "";
      el.warnings.innerHTML = "";
      el.summary.innerHTML = "";
      el.runBtn.disabled = true;
      currentFiles = [];
      activeFileIdx = -1;
      if (previewObjectUrl) { URL.revokeObjectURL(previewObjectUrl); previewObjectUrl = null; }
    }
    else if (action === "start") {
      const labels = { IS: "冰岛", NO: "挪威" };
      el.wsCountry.textContent = labels[el.countrySelect.value] || el.countrySelect.value;
      loadChecklist(el.countrySelect.value);
      goto("work");
    }
  });
});

el.picker.addEventListener("change", onPick);
el.runBtn.addEventListener("click", runAudit);
document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => switchTab(t.dataset.tab))
);

// ---------- init ----------
checkHealth();