import type { RuleKind } from "../rules.js";
import type { RuleEvaluator } from "../types.js";
import { evaluateForbidImport } from "./forbid-import.js";
import { evaluateRequireImport } from "./require-import.js";
import { evaluateRequireExport } from "./require-export.js";
import { evaluateMaxFileLines } from "./max-file-lines.js";
import { evaluateRequireTestFile } from "./require-test-file.js";
import { evaluateDependencyBoundary } from "./dependency-boundary.js";
import { evaluateEvidenceRequires } from "./evidence-requires.js";

export const evaluators: Record<RuleKind, RuleEvaluator> = {
  forbid_import: evaluateForbidImport,
  require_import: evaluateRequireImport,
  require_export: evaluateRequireExport,
  max_file_lines: evaluateMaxFileLines,
  require_test_file: evaluateRequireTestFile,
  dependency_boundary: evaluateDependencyBoundary,
  evidence_requires: evaluateEvidenceRequires,
};
