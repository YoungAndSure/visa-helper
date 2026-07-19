/**
 * 材料审核前端页面逻辑（原生 JS，无构建）。
 *
 * 由 FastAPI 挂在 /ui 下同源提供，所以 API 走相对路径、无 CORS 问题。
 *
 * 隐私原则：用户选的材料文件只在浏览器本地读取（列文件名/大小做预览），
 * 不上传文件本身；发给后端的只有国家、目录名、use_llm 等元信息。
 * 真实审核逻辑目前是后端 fake，页面会显式提示「示例数据」。
 */

// 同源部署：base 留空即相对当前 host。
const API = "";

const $ = (sel) => document.querySelector(sel);

const el = {
  health: $("#health"),
  healthText: $("#health .health__text"),
  country: $("#country"),
  picker: $("#picker"),
  filelist: $("#filelist"),
  materialsDir: $("#materialsDir"),
  useLlm: $("#useLlm"),
  runBtn: $("#runBtn"),
  runStatus: $("#runStatus"),
  checklistMeta: $("#checklistMeta"),
  checklist: $("#checklist"),
  summary: $("#summary"),
  warnings: $("#warnings"),
  results: $("#results"),
  reportWrap: $("#reportWrap"),
  reportRaw: $("#reportRaw"),
  resultsEmpty: $("#resultsEmpty"),
};

// 当前国家的 checklist（id -> item），用于把审核结果 join 出要求描述。
let checklistIndex = new Map();

// ---------- 工具 ----------
function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function api(path, opts) {
  const res = await fetch(API + path, opts);
  if (!res.ok) {
    let detail = res.statusText;
    try {
      detail = (await res.json()).detail ?? detail;
    } catch {}
    throw new Error(`${res.status} ${detail}`);
  }
  return res.json();
}

// 取每条要求描述的第一行（中英混排，取更可读的一行）。
function shortDesc(description) {
  if (!description) return "";
  const lines = description.split("\n").map((s) => s.trim()).filter(Boolean);
  // 优先返回含中文的那行，否则第一行
  const zh = lines.find((l) => /[一-龥]/.test(l));
  return zh || lines[0] || description;
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
    el.checklistMeta.textContent =
      `${data.country} · 共 ${data.items.length} 项要求` +
      (data.source ? ` · 来源 ${data.source}` : "");
    for (const item of data.items) {
      checklistIndex.set(item.id, item);
      const li = document.createElement("li");
      const kw = (item.match_keywords || []).join(", ");
      li.innerHTML =
        `${escapeHtml(shortDesc(item.description))}` +
        (kw ? `<br><span class="kw">关键词：${escapeHtml(kw)}</span>` : "");
      el.checklist.appendChild(li);
    }
  } catch (e) {
    el.checklistMeta.textContent = `加载清单失败：${e.message}`;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}

// ---------- 选材料（本地读取，不上传） ----------
function onPick() {
  const files = Array.from(el.picker.files || []);
  el.filelist.innerHTML = "";
  if (!files.length) return;

  // 从 webkitRelativePath 推断顶层文件夹名，回填到 materialsDir。
  const rel = files[0].webkitRelativePath || "";
  const topDir = rel.split("/")[0];
  if (topDir && !el.materialsDir.value) el.materialsDir.value = topDir;

  const shown = files.slice(0, 200);
  for (const f of shown) {
    const li = document.createElement("li");
    const name = f.webkitRelativePath || f.name;
    li.innerHTML = `<span>${escapeHtml(name)}</span><span>${humanSize(f.size)}</span>`;
    el.filelist.appendChild(li);
  }
  if (files.length > shown.length) {
    const li = document.createElement("li");
    li.innerHTML = `<span>… 其余 ${files.length - shown.length} 个文件</span><span></span>`;
    el.filelist.appendChild(li);
  }
}

// ---------- 运行审核 ----------
async function runAudit() {
  const country = el.country.value;
  const materials_dir = el.materialsDir.value.trim();
  if (!materials_dir) {
    el.runStatus.textContent = "请先选材料文件夹或填写材料目录。";
    return;
  }
  el.runBtn.disabled = true;
  el.runStatus.textContent = "审核中…";
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
    el.runBtn.disabled = false;
  }
}

function renderResults(data) {
  const s = data.summary;
  el.resultsEmpty.style.display = "none";

  el.summary.innerHTML = [
    `<span class="chip">合计 <b>${s.total}</b></span>`,
    `<span class="chip chip--pass">通过 <b>${s.PASS}</b></span>`,
    `<span class="chip chip--warn">警告 <b>${s.WARNING}</b></span>`,
    `<span class="chip chip--fail">未通过 <b>${s.FAIL}</b></span>`,
    `<span class="chip chip--na">不适用 <b>${s.N_A}</b></span>`,
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

  // 切到 results tab 后，如果之前没结果，留个空态
  if ((data.results || []).length === 0 && !(s.warnings || []).length) {
    el.resultsEmpty.style.display = "";
  }
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

// ---------- 绑定 ----------
el.country.addEventListener("change", () => loadChecklist(el.country.value));
el.picker.addEventListener("change", onPick);
el.runBtn.addEventListener("click", runAudit);
document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => switchTab(t.dataset.tab))
);

// ---------- init ----------
checkHealth();
loadChecklist(el.country.value);
