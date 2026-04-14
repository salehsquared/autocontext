import { compileGlob, matchGlob } from "../glob.js";
import type { ForbidImportRule } from "../rules.js";
import type { RuleEvaluationInput, Violation } from "../types.js";
import { fileInScope } from "../scope.js";

export async function evaluateForbidImport(
  input: RuleEvaluationInput,
): Promise<Violation[]> {
  const rule = input.rule as ForbidImportRule;
  const fromGlob = compileGlob(rule.from);
  const toGlob = compileGlob(rule.to);
  const violations: Violation[] = [];

  for await (const edge of input.ctx.index.scanImports()) {
    if (!fileInScope(edge.from, input.ruleScope)) continue;
    if (!matchGlob(edge.from, fromGlob)) continue;
    const target = edge.resolved_to ?? edge.raw;
    if (!matchGlob(target, toGlob)) continue;
    violations.push({
      rule_kind: "forbid_import",
      scope: input.ruleScope,
      severity: "error",
      rule_index: input.ruleIndex,
      file: edge.from,
      line: edge.line,
      to: target,
      message:
        rule.message ??
        `forbid_import: ${edge.from} imports ${target} (matches forbidden pattern)`,
    });
  }

  return sortImportViolations(violations);
}

export function sortImportViolations(vs: Violation[]): Violation[] {
  return vs.sort((a, b) => {
    const af = a.file ?? "";
    const bf = b.file ?? "";
    if (af !== bf) return af < bf ? -1 : 1;
    const al = a.line ?? 0;
    const bl = b.line ?? 0;
    if (al !== bl) return al - bl;
    const at = a.to ?? "";
    const bt = b.to ?? "";
    return at < bt ? -1 : at > bt ? 1 : 0;
  });
}
