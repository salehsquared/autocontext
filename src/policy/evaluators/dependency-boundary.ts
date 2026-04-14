import { compileGlob, matchGlob } from "../glob.js";
import type { DependencyBoundaryRule } from "../rules.js";
import type { RuleEvaluationInput, Violation } from "../types.js";
import { sortImportViolations } from "./forbid-import.js";
import { fileInScope } from "../scope.js";

export async function evaluateDependencyBoundary(
  input: RuleEvaluationInput,
): Promise<Violation[]> {
  const rule = input.rule as DependencyBoundaryRule;
  const fromGlob = compileGlob(rule.from);
  const allowedGlob = compileGlob(rule.allowed_to);
  const violations: Violation[] = [];
  const allowedList = rule.allowed_to.join(", ");

  for await (const edge of input.ctx.index.scanImports()) {
    if (!fileInScope(edge.from, input.ruleScope)) continue;
    if (!matchGlob(edge.from, fromGlob)) continue;
    const target = edge.resolved_to ?? edge.raw;
    if (matchGlob(target, allowedGlob)) continue;
    violations.push({
      rule_kind: "dependency_boundary",
      scope: input.ruleScope,
      severity: "error",
      rule_index: input.ruleIndex,
      file: edge.from,
      line: edge.line,
      to: target,
      message:
        rule.message ??
        `dependency_boundary: ${edge.from} imports ${target}, which is not in allowed_to [${allowedList}]`,
    });
  }

  return sortImportViolations(violations);
}
