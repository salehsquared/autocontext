import type { IndexStore } from "../index/store.js";
import type { ContextFile } from "../core/schema.js";
import type { Rule, RuleKind } from "./rules.js";

export interface Violation {
  rule_kind: RuleKind;
  scope: string;
  message: string;
  file?: string;
  line?: number;
  symbol?: string;
  to?: string;
  severity: "error";
  rule_index: number;
}

export interface EvalContext {
  projectRoot: string;
  index: IndexStore;
  contexts: Map<string, ContextFile>;
  sourceFiles: string[];
  fileLineCount: (file: string) => Promise<number>;
}

export interface RuleEvaluationInput {
  rule: Rule;
  ruleScope: string;
  ruleIndex: number;
  ctx: EvalContext;
}

export type RuleEvaluator = (input: RuleEvaluationInput) => Promise<Violation[]>;
