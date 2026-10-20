"""Convert rule evidence into UI annotations; never invent missing coordinates."""
from ..audit_rules.schemas import AuditRule
from .decisions import Annotation, RuleDecision


def build_annotations(rule: AuditRule, decision: RuleDecision) -> list[Annotation]:
    if decision.status not in {"FAIL", "WARNING"}:
        return []
    if rule.annotation_scope == "global" or not decision.evidence:
        return [Annotation(rule_id=rule.id, scope="global", message=decision.reason)]
    annotations = []
    for evidence in decision.evidence:
        page = evidence.page if rule.annotation_scope != "document" else None
        region = evidence.region if page and rule.annotation_scope == "region" else None
        annotations.append(Annotation(
            rule_id=rule.id, material_id=evidence.material_id,
            scope="region" if region else ("page" if page else "document"),
            page=page, region=region, message=evidence.explanation,
        ))
    return annotations
