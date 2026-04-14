import type { Parser, ParserResult } from "./types.js";
import type { Evidence } from "../../core/schema.js";

/**
 * Catch-all for the `build` kind. No structured output; success is implicit.
 * On non-zero exit, the orchestrator decides whether to promote the failure
 * into a typecheck fallback (§4.9 of the plan).
 */
export const exitCodeParser: Parser = (input): ParserResult => {
  const warnings: string[] = [];
  const evidence: Partial<Evidence> = {};
  if (input.spawn.exitCode !== 0) {
    warnings.push(`command exited ${input.spawn.exitCode ?? "null"}`);
  }
  return { evidence, warnings };
};
