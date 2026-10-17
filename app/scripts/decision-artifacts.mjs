#!/usr/bin/env node
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import dagre from "@dagrejs/dagre";
import { getActiveRuleVersion, loadRulePack, evaluateChecklistWithTrace, validateAnswerPatch } from "../src/checklist.js";
import { createChecklistMachine, runtimeLogic, predicates, ENGINE_VERSION, IMPLEMENTATION_HASH, hash } from "../src/decision-machine.js";

const appDir = fileURLToPath(new URL("../", import.meta.url));
const xml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const js = (value) => JSON.stringify(value).replaceAll("<", "\\u003c");

export function decisionGraph(pack) {
  const machine = createChecklistMachine(pack);
  return {
    initial: pack.machine.initial,
    nodes: Object.values(machine.states).map((state) => {
      const entry = state.config.entry;
      const actions = Array.isArray(entry) ? entry : entry ? [entry] : [];
      return { id: state.key, ...state.meta,
        taskIds: actions.filter((action) => action.type === "addTasks").flatMap((action) => action.params.ids),
        noteIds: actions.filter((action) => action.type === "addNotes").flatMap((action) => action.params.ids) };
    }),
    edges: Object.values(machine.states).flatMap((state) => (state.always ?? []).flatMap((transition, index) =>
      (transition.target ?? []).map((target) => ({ source: state.key, target: target.key, index,
        guard: typeof transition.guard === "object" ? transition.guard : transition.guard ? { type: transition.guard } : null })))),
  };
}

function edgeLabel(edge, pack) {
  const { type, params = {} } = edge.guard ?? {};
  if (!type) return "否则／继续";
  const question = pack.questionGroups.flatMap((group) => group.questions).find((q) => q.id === params.field);
  const label = (value) => question?.options?.find((option) => option.value === value)?.label ?? value;
  if (type === "equals") return `${params.field} = ${label(params.value)}`;
  if (type === "oneOf") return `${params.field} ∈ ${params.values.map(label).join(" / ")}`;
  return { answered: "已提供答案", before: "进入日期早于离开日期", allEqual: "申请路径符合", inconsistentSpouse: "配偶担保与婚姻状态冲突",
    guardianAbroadReview: "需同意文件且监护人在境外", otherSponsorReview: "无业且非配偶担保" }[type] ?? type;
}

function wrap(text, width = 18) {
  const chars = Array.from(text);
  return Array.from({ length: Math.ceil(chars.length / width) }, (_, index) => chars.slice(index * width, (index + 1) * width).join(""));
}

export function renderSvg(graph, pack, execution) {
  const layout = new dagre.graphlib.Graph({ multigraph: true });
  layout.setGraph({ rankdir: "TB", nodesep: 60, ranksep: 65, marginx: 35, marginy: 35 });
  layout.setDefaultEdgeLabel(() => ({}));
  for (const node of graph.nodes) {
    const lines = wrap(node.title ?? node.id);
    if (node.taskIds?.length) lines.push(`材料任务 × ${node.taskIds.length}`);
    layout.setNode(node.id, { width: 260, height: Math.max(65, lines.length * 20 + 26), lines });
  }
  graph.edges.forEach((edge, index) => {
    const lines = wrap(edgeLabel(edge, pack), 20);
    layout.setEdge(edge.source, edge.target, { width: 200, height: lines.length * 16 + 8, lines }, String(index));
  });
  dagre.layout(layout);
  const visited = new Set(execution.path);
  const traversed = new Set(execution.transitions.map((edge) => `${edge.source}:${edge.target}`));
  const dimensions = layout.graph();
  const edges = graph.edges.map((edge, index) => {
    const position = layout.edge(edge.source, edge.target, String(index));
    const points = position.points.map((point) => `${point.x},${point.y}`).join(" ");
    const active = traversed.has(`${edge.source}:${edge.target}`);
    return `<g class="edge${active ? " traversed" : ""}"><polyline points="${points}" marker-end="url(#arrow)"/><text x="${position.x}" y="${position.y - (position.lines.length - 1) * 8}">${position.lines.map((line, n) => `<tspan x="${position.x}" dy="${n ? 16 : 0}">${xml(line)}</tspan>`).join("")}</text></g>`;
  }).join("\n");
  const nodes = graph.nodes.map((node) => {
    const p = layout.node(node.id);
    const current = node.id === execution.nodeId;
    return `<g class="node ${xml(node.kind ?? "")}${visited.has(node.id) ? " visited" : ""}${current ? " current" : ""}" data-node="${xml(node.id)}" tabindex="0"><title>${xml(node.id)}</title><rect x="${p.x - p.width / 2}" y="${p.y - p.height / 2}" width="${p.width}" height="${p.height}" rx="${node.kind === "decision" ? 3 : 13}"/><text x="${p.x}" y="${p.y - (p.lines.length - 1) * 10}">${p.lines.map((line, n) => `<tspan x="${p.x}" dy="${n ? 20 : 0}">${xml(line)}</tspan>`).join("")}</text></g>`;
  }).join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${dimensions.width}" height="${dimensions.height}" viewBox="0 0 ${dimensions.width} ${dimensions.height}" role="img" aria-label="冰岛签证 XState 决策图"><style>text{font-family:system-ui,'Noto Sans CJK SC',sans-serif;text-anchor:middle;dominant-baseline:middle;fill:#172033}.edge polyline{fill:none;stroke:#a7b2c3;stroke-width:1.7}.edge text{font-size:12;paint-order:stroke;stroke:#fff;stroke-width:5;stroke-linejoin:round}.edge.traversed polyline{stroke:#168368;stroke-width:3}.node rect{fill:#f6f8fc;stroke:#7b8ba6;stroke-width:1.5}.node text{font-size:14}.node.decision rect{fill:#eef0ff}.node.tasks rect{fill:#e7f5ef}.node.outcome rect{fill:#f8e8e8}.node.visited rect{stroke:#168368;stroke-width:3}.node.current rect{stroke:#c48012;fill:#fff0cd;stroke-width:4}.node.selected rect{stroke:#2254de;stroke-width:4}.node{cursor:pointer}</style><defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#7b8ba6"/></marker></defs><rect width="100%" height="100%" fill="white"/>${edges}${nodes}</svg>`;
}

function renderHtml(svg, graph, pack, execution) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>冰岛签证 XState 决策图</title><style>body{margin:0;font:15px system-ui,sans-serif;color:#172033;background:#f6f8fc}header{padding:16px 24px;background:white;border-bottom:1px solid #d9e0ea}h1{font-size:22px;margin:0 0 8px}.muted{font-size:13px;color:#526079}button,select{font:inherit;padding:7px 12px;border:1px solid #c1cad8;border-radius:6px;background:white;margin:3px}main{display:grid;grid-template-columns:minmax(0,1fr) 340px;height:calc(100vh - 160px)}#viewport{overflow:auto;background:white}aside{overflow:auto;padding:16px;border-left:1px solid #d9e0ea}pre{white-space:pre-wrap;word-break:break-word;font-size:12px}#viewport svg{display:block}a{color:#2254de}@media(max-width:800px){main{grid-template-columns:1fr;height:auto}#viewport{height:70vh}aside{border:0}}</style><header><h1>冰岛签证 XState 决策图</h1><div class="muted">${xml(pack.version)} · XState ${ENGINE_VERSION} · ${graph.nodes.length} 个节点 · 模型 ${execution.modelHash.slice(0, 12)}</div><div><button id="zoomout">缩小</button><button id="zoomin">放大</button><button id="fit">适应宽度</button><select id="path" aria-label="执行路径"><option value="">定位执行节点</option>${execution.path.map((id, index) => `<option value="${xml(id)}">${index + 1}. ${xml(graph.nodes.find((node) => node.id === id)?.title ?? id)}</option>`).join("")}</select></div><div class="muted">绿色：本次经过的路径；橙色：本次停留节点。点击节点查看问题、材料引用及判断结果。未提供输入时停在第一题。</div></header><main><section id="viewport">${svg}</section><aside><h2 style="font-size:17px">节点详情</h2><div id="details">点击图中的节点。</div><details><summary>本次完整结构化输入</summary><pre id="answers"></pre></details></aside></main><script>const graph=${js(graph)},pack=${js(pack)},run=${js(execution)};const svg=document.querySelector('svg'),viewport=document.querySelector('#viewport');const nativeWidth=Number(svg.getAttribute('width')),nativeHeight=Number(svg.getAttribute('height'));let scale=1;function zoom(value){scale=Math.max(.08,Math.min(3,value));svg.style.width=nativeWidth*scale+'px';svg.style.height=nativeHeight*scale+'px'}function fit(){zoom(viewport.clientWidth/nativeWidth)}function select(id){for(const node of svg.querySelectorAll('[data-node]'))node.classList.toggle('selected',node.dataset.node===id);const node=graph.nodes.find(n=>n.id===id);if(!node)return;const details={node,question:pack.questionGroups.flatMap(g=>g.questions).find(q=>q.id===node.questionId),tasks:pack.tasks.filter(t=>node.taskIds?.includes(t.id)),conditions:run.conditions.filter(c=>c.nodeId===id),branches:graph.edges.filter(e=>e.source===id),visited:run.path.includes(id),current:run.nodeId===id};const pre=document.createElement('pre');pre.textContent=JSON.stringify(details,null,2);document.querySelector('#details').replaceChildren(pre)}for(const node of svg.querySelectorAll('[data-node]')){node.addEventListener('click',()=>select(node.dataset.node));node.addEventListener('keydown',e=>{if(e.key==='Enter')select(node.dataset.node)})}document.querySelector('#answers').textContent=JSON.stringify(run.input,null,2);document.querySelector('#path').addEventListener('change',e=>{select(e.target.value);const node=Array.from(svg.querySelectorAll('[data-node]')).find(n=>n.dataset.node===e.target.value);node?.scrollIntoView({block:'center',inline:'center'})});document.querySelector('#zoomin').onclick=()=>zoom(scale*1.25);document.querySelector('#zoomout').onclick=()=>zoom(scale/1.25);document.querySelector('#fit').onclick=fit;fit();select(run.nodeId);</script></html>`;
}

export function portableMachine(pack, answers = {}) {
  const functions = Object.entries(predicates).map(([name, fn]) => `${JSON.stringify(name)}: ${fn.toString()}`).join(",\n");
  return `// Generated from the server's executable XState model. Paste into open-source Stately Sketch.\nimport { setup, assign } from 'xstate';\nconst predicates = {${functions}};\n${runtimeLogic.toString()}\nconst definition = ${JSON.stringify(pack.machine, null, 2)};\nconst exampleAnswers = ${JSON.stringify(answers, null, 2)};\nexport const machine = setup(runtimeLogic()).createMachine({...definition, context: ({ input }) => ({ answers: input?.answers ?? exampleAnswers, taskIds: [], noteIds: [] })});\n`;
}

export async function writeDecisionArtifacts(pack, execution, outputDir) {
  const graph = decisionGraph(pack);
  const svg = renderSvg(graph, pack, execution);
  const mermaid = ["flowchart TD", ...graph.nodes.map((node) => `  ${node.id}["${(node.title ?? node.id).replaceAll('"', "'").replaceAll("\n", " ")}"]`),
    ...graph.edges.map((edge) => `  ${edge.source} -->|"${edgeLabel(edge, pack).replaceAll('"', "'")}"| ${edge.target}`)].join("\n") + "\n";
  await mkdir(outputDir, { recursive: true });
  const contents = { "iceland.svg": svg, "iceland.html": renderHtml(svg, graph, pack, execution), "iceland.mmd": mermaid,
    "iceland.machine.json": JSON.stringify(pack.machine, null, 2) + "\n", "iceland.xstate.mjs": portableMachine(pack, execution.input), "iceland.trace.json": JSON.stringify(execution, null, 2) + "\n" };
  for (const [name, content] of Object.entries(contents)) await writeFile(join(outputDir, name), content, { mode: 0o600 });
  return { nodes: graph.nodes.length, edges: graph.edges.length, outputDir };
}

export async function main(argv = process.argv.slice(2)) {
  const options = {};
  const allowed = new Set(["--answers", "--out", "--version", "--application", "--evaluation", "--data"]);
  for (let i = 0; i < argv.length; i += 2) {
    if (!allowed.has(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`Unknown or incomplete option: ${argv[i]}`);
    options[argv[i].slice(2)] = argv[i + 1];
  }
  if (options.answers && options.application) throw new Error("Choose --answers or --application");
  if ((options.evaluation || options.data) && !options.application) throw new Error("--evaluation/--data require --application");
  let answers = options.answers ? JSON.parse(await readFile(options.answers, "utf8")) : {};
  let version = options.version ?? getActiveRuleVersion();
  let saved;
  if (options.application) {
    const records = JSON.parse(await readFile(options.data ?? process.env.VISA_HELPER_DATA_FILE ?? join(appDir, "data/applications.json"), "utf8"));
    const record = records[options.application];
    saved = options.evaluation ? record?.evaluations?.find((run) => run.id === options.evaluation) : record?.evaluations?.at(-1);
    if (!saved) throw new Error("Saved evaluation not found; choose an application with an input history");
    if (options.version && options.version !== saved.ruleVersion) throw new Error("Replay must use the recorded rule version");
    answers = saved.input; version = saved.ruleVersion;
  }
  const pack = loadRulePack(version);
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) throw new Error("Answers must be a JSON object");
  if (Object.keys(answers).length) validateAnswerPatch(answers, version);
  if (saved && (saved.modelHash !== hash(pack) || saved.engineVersion !== ENGINE_VERSION || saved.implementationHash !== IMPLEMENTATION_HASH)) throw new Error("Replay version mismatch: use the archived model and implementation from the recorded release");
  const { result, execution } = evaluateChecklistWithTrace(answers, version);
  if (saved && (!isDeepStrictEqual(saved.output, result) || !isDeepStrictEqual(saved.path, execution.path))) throw new Error("Replay differs from saved output or path");
  const output = resolve(options.out ?? join(appDir, options.answers || saved ? ".local/decision-graph" : "../docs/decision-graph"));
  const summary = await writeDecisionArtifacts(pack, saved ?? execution, output);
  console.log(JSON.stringify({ ...summary, engine: "xstate", engineVersion: ENGINE_VERSION, model: execution.modelHash.slice(0, 12), status: result.status, currentNode: execution.nodeId, replay: saved ? "matched" : "not_requested" }));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
