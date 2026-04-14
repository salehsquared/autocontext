import type { Parser, ParserResult } from "./types.js";
import type { Evidence } from "../../core/schema.js";

export const tscParser: Parser = (input): ParserResult => {
  const warnings: string[] = [];
  const evidence: Partial<Evidence> = { typecheck_tool: "tsc" };
  const { exitCode, stdout, stderr } = input.spawn;
  if (exitCode === 0) {
    evidence.typecheck = "clean";
    return { evidence, warnings };
  }
  const text = `${stdout}\n${stderr}`;
  if (/error TS\d+:/.test(text)) {
    evidence.typecheck = "errors";
  } else {
    warnings.push("tsc exited non-zero but no TS error pattern was found");
    evidence.typecheck = "unknown";
  }
  return { evidence, warnings };
};
