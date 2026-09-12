"""Rule-driven orchestration; store, judge and annotation mapper are separate."""
from __future__ import annotations
import logging
import time

from ...shared.llm import llm_available
from ..audit_rules.store import RuleStore
from .annotations import build_annotations
from .rule_agent import Judge, LLMRuleAgent, validate_evidence
from .schemas import AgentStep, RunItemResult, RunRequest, RunResponse, RunSummary

log = logging.getLogger("material_audit.agent")


class AuditAgent:
    def __init__(self, store: RuleStore | None = None, judge: Judge | None = None):
        self.store = store or RuleStore()
        self.judge = judge or LLMRuleAgent()

    def run(self, req: RunRequest) -> RunResponse:
        trace = [AgentStep(name="privacy_intake", status="completed", detail=f"收到 {len(req.materials)} 份用户确认的脱敏文件")]
        try:
            ruleset = self.store.load(req.country, req.visa_type)
        except Exception as error:
            log.warning("rule_load.failed country=%s error_type=%s", req.country, type(error).__name__)
            return self._empty(req, trace, "规则库校验失败，请管理员检查已发布规则。")
        if ruleset is None:
            return self._empty(req, trace, "未找到该国家和签证类型的已发布规则。")
        rules = [rule for rule in ruleset.rules if rule.enabled and not rule.requires_private_data and rule.review_scope in req.review_scopes]
        trace.append(AgentStep(name="rule_load", status="completed", detail=f"版本 {ruleset.version}，选中 {len(rules)} 条规则"))
        unavailable = not req.use_llm or not llm_available()
        warnings = []
        if unavailable:
            warnings.append("模型未启用或未配置：未执行远端判断，WARNING 不代表材料通过或不合格。")
        if not rules:
            warnings.append("当前审核范围没有可执行规则，不能据此判断材料通过。")
        missing_scopes = set(req.review_scopes) - {rule.review_scope for rule in rules}
        if missing_scopes:
            warnings.append("以下请求范围尚无可执行规则：" + ", ".join(sorted(missing_scopes)))
        if ruleset.version.startswith("checklist-"):
            warnings.append("尚无独立发布规则，当前逐项使用已有 Checklist 原文；不代表规则已完备。")
        results = []
        for index, rule in enumerate(rules, 1):
            started = time.monotonic()
            log.info("rule.started country=%s version=%s rule=%s", req.country, ruleset.version, rule.id)
            result = RunItemResult(item_id=index, rule_id=rule.id, title=rule.title,
                                   review_scope=rule.review_scope, status="WARNING")
            if unavailable or not req.materials:
                result.execution_status = "skipped"
                result.details = "未执行：模型未启用或未配置。" if unavailable else "未执行：没有脱敏材料。"
            else:
                try:
                    decision = self.judge.evaluate(rule, req.materials)
                    validate_evidence(decision, req.materials)
                    if rule.review_scope == "risk" and decision.status == "FAIL":
                        decision = decision.model_copy(update={"status": "WARNING"})
                    result.status = decision.status
                    result.details = decision.reason
                    result.checked_items = decision.checked_items
                    result.confidence = decision.confidence
                    result.evidence = decision.evidence
                    result.matched = list(dict.fromkeys(next(m.source_ref for m in req.materials if m.material_id == e.material_id) for e in decision.evidence))
                    result.annotations = build_annotations(rule, decision)
                except Exception as error:
                    # Provider errors may contain file data; never log their repr/body.
                    log.warning("rule.failed rule=%s error_type=%s", rule.id, type(error).__name__)
                    result.status = "ERROR"
                    result.execution_status = "failed"
                    result.details = "模型调用失败或返回结果不合法；本条未完成，请重试或人工核查。"
            result.duration_ms = round((time.monotonic() - started) * 1000, 2)
            results.append(result)
            log.info("rule.finished rule=%s status=%s duration_ms=%s", rule.id, result.status, result.duration_ms)
        summary = RunSummary(total=len(results), warnings=warnings)
        for result in results:
            name = "N_A" if result.status == "N/A" else result.status
            setattr(summary, name, getattr(summary, name) + 1)
        if summary.ERROR:
            summary.warnings.append(f"{summary.ERROR} 条规则执行失败，本报告不完整。")
        trace.extend([
            AgentStep(name="rule_review", status="failed" if summary.ERROR else ("skipped" if all(r.execution_status == "skipped" for r in results) else "completed"), detail=f"逐规则执行，失败 {summary.ERROR} 条"),
            AgentStep(name="annotations", status="completed", detail="按规则范围映射问题位置；模型坐标尚未人工核实"),
            AgentStep(name="report", status="completed", detail="已汇总规则结果；以单条执行状态判断审核是否完成"),
        ])
        lines = [f"# 材料审核报告（{req.country} / {req.visa_type}）", f"规则版本：{ruleset.version}", *[f"> {warning}" for warning in summary.warnings]]
        for result in results:
            lines.extend([f"\n## {result.rule_id} — {result.status}", result.title, result.details])
        return RunResponse(country=req.country, visa_type=req.visa_type, rule_set_version=ruleset.version,
                           results=results, summary=summary, agent_trace=trace, markdown_report="\n\n".join(lines))

    @staticmethod
    def _empty(req, trace, message):
        trace.append(AgentStep(name="rule_load", status="failed", detail=message))
        return RunResponse(country=req.country, visa_type=req.visa_type, results=[],
                           summary=RunSummary(total=0, warnings=[message]), agent_trace=trace)
