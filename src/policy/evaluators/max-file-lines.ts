import { compileGlob, matchGlob } from "../glob.js";
import type { MaxFileLinesRule } from "../rules.js";
import type { RuleEvaluationInput, Violation } from "../types.js";
import { fileInScope } from "../scope.js";

export async function evaluateMaxFileLines(
  input: RuleEvaluationInput,
): Promise<Violation[]> {
  const rule = input.rule as MaxFileLinesRule;
  const excludeGlob = rule.exclude ? compileGlob(rule.exclude) : null;
  const violations: Violation[] = [];

  for (const file of input.ctx.sourceFiles) {
    if (!fileInScope(file, input.ruleScope)) continue;
    if (excludeGlob && matchGlob(file, excludeGlob)) continue;
    let lines: number;
    try {
      lines = await input.ctx.fileLineCount(file);
    } catch {
      continue;
    }
    if (lines > rule.value) {
      violations.push({
        rule_kind: "max_file_lines",
        scope: input.ruleScope,
        severity: "error",
        rule_index: input.ruleIndex,
        file,
        message:
          rule.message ??
          `max_file_lines: ${file} has ${lines} lines (limit ${rule.value})`,
      });
    }
  }

  violations.sort((a, b) => (a.file! < b.file! ? -1 : a.file! > b.file! ? 1 : 0));
  return violations;
}
