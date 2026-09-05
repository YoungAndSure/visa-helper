import { createAuditTools } from "./local-audit-tools.js";
import { builtInLocalAuditRules } from "./local-audit-rules.js";

const RESULT_STATUSES = new Set(["pass", "fail", "warning", "skipped", "unavailable", "error"]);

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function validateRules(rules) {
  const ids = new Set();
  for (const rule of rules) {
    if (!rule?.id || !rule?.title || typeof rule.run !== "function") {
      throw new TypeError("每条一级审核规则都必须提供 id、title 和 run(context, tools)。");
    }
    if (ids.has(rule.id)) throw new TypeError(`一级审核规则 ID 重复：${rule.id}`);
    ids.add(rule.id);
  }
}

function normalizeRuleResult(rule, result, durationMs) {
  const status = RESULT_STATUSES.has(result?.status) ? result.status : "error";
  return {
    rule_id: rule.id,
    rule_version: rule.version || "0.0.0",
    title: rule.title,
    status,
    reason: result?.reason || (status === "error" ? "规则返回了无效结果。" : "规则已执行。"),
    checked_items: Array.isArray(result?.checked_items) ? result.checked_items : [],
    matched_document_ids: Array.isArray(result?.matched_document_ids) ? result.matched_document_ids : [],
    evidence: Array.isArray(result?.evidence) ? result.evidence : [],
    duration_ms: durationMs,
  };
}

function summarize(results) {
  const summary = {
    total: results.length,
    pass: 0,
    fail: 0,
    warning: 0,
    skipped: 0,
    unavailable: 0,
    error: 0,
  };
  for (const result of results) summary[result.status] += 1;
  return summary;
}

export function createLocalAuditContext({ country, visaType, checklist = [], preprocessing }) {
  if (preprocessing?.schema_version !== "local-document-context/v1") {
    throw new TypeError("一级审核只能接收 local-document-context/v1 预处理结果。");
  }
  return deepFreeze({
    schema_version: "local-audit-context/v1",
    country,
    visa_type: visaType,
    checklist: [...checklist],
    documents: [...preprocessing.documents],
    preprocessing: {
      created_at: preprocessing.created_at,
      processed_locally: preprocessing.processed_locally,
      raw_files_uploaded: preprocessing.raw_files_uploaded,
    },
  });
}

export async function runLocalAuditRules(
  context,
  { rules = builtInLocalAuditRules, tools = createAuditTools(), onProgress = () => {} } = {},
) {
  validateRules(rules);
  const results = [];
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    onProgress({ current: index, total: rules.length, label: `执行规则：${rule.title}` });
    const startedAt = performance.now();
    try {
      if (typeof rule.appliesTo === "function" && !rule.appliesTo(context)) {
        results.push(normalizeRuleResult(rule, {
          status: "skipped",
          reason: "当前国家或签证类型不适用此规则。",
        }, performance.now() - startedAt));
        continue;
      }
      const result = await rule.run(context, tools);
      results.push(normalizeRuleResult(rule, result, performance.now() - startedAt));
    } catch (error) {
      results.push(normalizeRuleResult(rule, {
        status: "error",
        reason: `规则执行失败：${error instanceof Error ? error.message : String(error)}`,
      }, performance.now() - startedAt));
    }
  }
  onProgress({ current: rules.length, total: rules.length, label: "本地一级审核完成" });
  return {
    schema_version: "local-audit-result/v1",
    created_at: new Date().toISOString(),
    context,
    rule_results: results,
    summary: summarize(results),
  };
}
