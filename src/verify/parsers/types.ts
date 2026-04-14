import type { Evidence } from "../../core/schema.js";
import type { SpawnResult } from "../runner.js";

export type ParserId =
  | "vitest-json"
  | "jest-json"
  | "junit-xml"
  | "go-test-json"
  | "tsc"
  | "eslint-json"
  | "istanbul-summary"
  | "pytest-cov"
  | "exit-code";

export interface ParserInput {
  spawn: SpawnResult;
  /** Content of `artifact` file when configured, else undefined. */
  artifactText?: string;
  /** Working directory the command ran in. Parsers may resolve secondary files. */
  cwd: string;
}

export interface ParserResult {
  evidence: Partial<Evidence>;
  warnings: string[];
}

export type Parser = (input: ParserInput) => ParserResult;
