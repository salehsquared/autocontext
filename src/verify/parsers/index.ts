import type { Parser, ParserId } from "./types.js";
import type { VerifyKind } from "../../core/schema.js";
import { vitestJsonParser, jestJsonParser } from "./vitest-json.js";
import { junitXmlParser } from "./junit-xml.js";
import { goTestJsonParser } from "./go-test-json.js";
import { tscParser } from "./tsc.js";
import { eslintJsonParser } from "./eslint-json.js";
import { istanbulSummaryParser, pytestCovParser } from "./coverage.js";
import { exitCodeParser } from "./exit-code.js";

export const PARSERS: Record<ParserId, Parser> = {
  "vitest-json": vitestJsonParser,
  "jest-json": jestJsonParser,
  "junit-xml": junitXmlParser,
  "go-test-json": goTestJsonParser,
  tsc: tscParser,
  "eslint-json": eslintJsonParser,
  "istanbul-summary": istanbulSummaryParser,
  "pytest-cov": pytestCovParser,
  "exit-code": exitCodeParser,
};

export const DEFAULT_PARSER_BY_KIND: Record<VerifyKind, ParserId> = {
  test: "vitest-json",
  typecheck: "tsc",
  lint: "eslint-json",
  coverage: "istanbul-summary",
  build: "exit-code",
};

/**
 * Pick a parser. Precedence:
 *   1. explicit `command.parser`
 *   2. heuristic match against the command string
 *   3. default for the kind
 */
export function pickParser(
  kind: VerifyKind,
  explicit: ParserId | undefined,
  commandString: string,
): ParserId {
  if (explicit) return explicit;
  const cmd = commandString.toLowerCase();
  if (kind === "test") {
    if (cmd.includes("jest")) return "jest-json";
    if (cmd.includes("vitest")) return "vitest-json";
    if (cmd.includes("go test")) return "go-test-json";
    if (cmd.includes("pytest") || cmd.includes("junit") || cmd.includes("surefire")) return "junit-xml";
  }
  if (kind === "lint" && cmd.includes("eslint")) return "eslint-json";
  if (kind === "typecheck" && cmd.includes("tsc")) return "tsc";
  if (kind === "coverage") {
    if (cmd.includes("pytest") || cmd.includes("--cov")) return "pytest-cov";
    return "istanbul-summary";
  }
  return DEFAULT_PARSER_BY_KIND[kind];
}
