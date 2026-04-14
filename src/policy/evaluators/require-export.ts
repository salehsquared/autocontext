import type { RequireExportRule } from "../rules.js";
import type { RuleEvaluationInput, Violation } from "../types.js";
import { dirInScope } from "../scope.js";
import { dirname } from "node:path/posix";

export async function evaluateRequireExport(
  input: RuleEvaluationInput,
): Promise<Violation[]> {
  const rule = input.rule as RequireExportRule;
  const candidates = await input.ctx.index.findSymbolsByName(rule.name);
  const hit = candidates.some((sym) => {
    if (!sym.exported) return false;
    if (rule.symbol_kind && sym.kind !== rule.symbol_kind) return false;
    return dirInScope(dirname(sym.file), input.ruleScope);
  });

  if (hit) return [];
  const kindClause = rule.symbol_kind ? ` (kind ${rule.symbol_kind})` : "";
  return [
    {
      rule_kind: "require_export",
      scope: input.ruleScope,
      severity: "error",
      rule_index: input.ruleIndex,
      symbol: rule.name,
      message:
        rule.message ??
        `require_export: scope ${input.ruleScope} is missing exported symbol "${rule.name}"${kindClause}`,
    },
  ];
}
