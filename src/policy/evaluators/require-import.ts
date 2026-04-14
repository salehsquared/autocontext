import { compileGlob, matchGlob } from "../glob.js";
import type { RequireImportRule } from "../rules.js";
import type { RuleEvaluationInput, Violation } from "../types.js";
import { sortImportViolations } from "./forbid-import.js";
import { fileInScope } from "../scope.js";

export async function evaluateRequireImport(
  input: RuleEvaluationInput,
): Promise<Violation[]> {
  const rule = input.rule as RequireImportRule;
  const fromGlob = compileGlob(rule.from);
  const toGlob = compileGlob(rule.to);

  const matchingFiles = input.ctx.sourceFiles.filter(
    (f) => fileInScope(f, input.ruleScope) && matchGlob(f, fromGlob),
  );
  if (matchingFiles.length === 0) return [];

  const satisfiedFiles = new Set<string>();
  for await (const edge of input.ctx.index.scanImports()) {
    if (satisfiedFiles.has(edge.from)) continue;
    if (!fileInScope(edge.from, input.ruleScope)) continue;
    if (!matchGlob(edge.from, fromGlob)) continue;
    const target = edge.resolved_to ?? edge.raw;
    if (matchGlob(target, toGlob)) {
      satisfiedFiles.add(edge.from);
    }
  }

  const toLabel = Array.isArray(rule.to) ? rule.to.join(" | ") : rule.to;
  const violations: Violation[] = [];
  for (const file of matchingFiles) {
    if (satisfiedFiles.has(file)) continue;
    violations.push({
      rule_kind: "require_import",
      scope: input.ruleScope,
      severity: "error",
      rule_index: input.ruleIndex,
      file,
      message:
        rule.message ??
        `require_import: ${file} is missing a required import matching ${toLabel}`,
    });
  }

  return sortImportViolations(violations);
}
