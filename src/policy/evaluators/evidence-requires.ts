import type { EvidenceRequiresRule } from "../rules.js";
import type { RuleEvaluationInput, Violation } from "../types.js";
import { dirInScope } from "../scope.js";

type Field = "test_status" | "typecheck" | "lint_status" | "coverage_min";
const FIELD_ORDER: Field[] = ["test_status", "typecheck", "lint_status", "coverage_min"];

export async function evaluateEvidenceRequires(
  input: RuleEvaluationInput,
): Promise<Violation[]> {
  const rule = input.rule as EvidenceRequiresRule;
  const required: Partial<Record<Field, string | number>> = {};
  if (rule.test_status) required.test_status = rule.test_status;
  if (rule.typecheck) required.typecheck = rule.typecheck;
  if (rule.lint_status) required.lint_status = rule.lint_status;
  if (rule.coverage_min !== undefined) required.coverage_min = rule.coverage_min;

  const violations: Violation[] = [];
  const scopes = [...input.ctx.contexts.keys()].filter((s) =>
    dirInScope(s, input.ruleScope),
  );
  scopes.sort();

  for (const scope of scopes) {
    const ctxFile = input.ctx.contexts.get(scope)!;
    const evidence = ctxFile.evidence;
    if (!evidence) {
      violations.push({
        rule_kind: "evidence_requires",
        scope: input.ruleScope,
        severity: "error",
        rule_index: input.ruleIndex,
        file: scope,
        message:
          rule.message ??
          `evidence_requires: scope ${scope} has no evidence block`,
      });
      continue;
    }

    for (const field of FIELD_ORDER) {
      const want = required[field];
      if (want === undefined) continue;
      const got = field === "coverage_min" ? evidence.coverage_percent : (evidence as Record<string, unknown>)[field];
      if (!satisfied(field, want, got)) {
        const actual = got === undefined ? "missing" : String(got);
        violations.push({
          rule_kind: "evidence_requires",
          scope: input.ruleScope,
          severity: "error",
          rule_index: input.ruleIndex,
          file: scope,
          message:
            rule.message ??
            `evidence_requires: scope ${scope} fails ${field} (${actual} vs required ${want})`,
        });
      }
    }
  }

  violations.sort((a, b) => {
    const af = a.file ?? "";
    const bf = b.file ?? "";
    if (af !== bf) return af < bf ? -1 : 1;
    return 0;
  });
  return violations;
}

function satisfied(field: Field, want: string | number, got: unknown): boolean {
  if (field === "coverage_min") {
    return typeof got === "number" && got >= (want as number);
  }
  return got === want;
}
