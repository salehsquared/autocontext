import { z } from "zod";

const messageField = {
  message: z
    .string()
    .optional()
    .describe("Human-readable override for the default violation message."),
};

const stringOrNonEmptyArray = z
  .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
  .describe("Glob pattern, or non-empty array of patterns (leading '!' negates when inside an array).");

export const forbidImportRule = z
  .object({
    kind: z.literal("forbid_import"),
    from: stringOrNonEmptyArray,
    to: stringOrNonEmptyArray,
    ...messageField,
  })
  .strict();

export const requireImportRule = z
  .object({
    kind: z.literal("require_import"),
    from: stringOrNonEmptyArray,
    to: stringOrNonEmptyArray,
    ...messageField,
  })
  .strict();

export const requireExportRule = z
  .object({
    kind: z.literal("require_export"),
    name: z.string().min(1),
    symbol_kind: z
      .enum(["function", "class", "interface", "type", "constant", "enum"])
      .optional()
      .describe(
        "Optional symbol-kind filter. Named `symbol_kind` (not `kind`) to avoid collision with the rule discriminator.",
      ),
    ...messageField,
  })
  .strict();

export const maxFileLinesRule = z
  .object({
    kind: z.literal("max_file_lines"),
    value: z.number().int().positive(),
    exclude: z
      .array(z.string().min(1))
      .optional()
      .describe("Globs of files excluded from the limit (last-match-wins when negated)."),
    ...messageField,
  })
  .strict();

export const requireTestFileRule = z
  .object({
    kind: z.literal("require_test_file"),
    for: z.string().min(1).describe("Glob of source files that require a test file."),
    pattern: z
      .string()
      .min(1)
      .describe("Test file pattern. Supports {name} and {ext} placeholders. Example: '{name}.test.{ext}'."),
    ...messageField,
  })
  .strict();

export const dependencyBoundaryRule = z
  .object({
    kind: z.literal("dependency_boundary"),
    from: z.string().min(1),
    allowed_to: z.array(z.string().min(1)).min(1),
    ...messageField,
  })
  .strict();

export const evidenceRequiresRule = z
  .object({
    kind: z.literal("evidence_requires"),
    test_status: z.literal("passing").optional(),
    typecheck: z.literal("clean").optional(),
    lint_status: z.literal("clean").optional(),
    coverage_min: z.number().min(0).max(100).optional(),
    ...messageField,
  })
  .strict();

export const ruleSchema = z.discriminatedUnion("kind", [
  forbidImportRule,
  requireImportRule,
  requireExportRule,
  maxFileLinesRule,
  requireTestFileRule,
  dependencyBoundaryRule,
  evidenceRequiresRule,
]);

export type Rule = z.infer<typeof ruleSchema>;
export type ForbidImportRule = z.infer<typeof forbidImportRule>;
export type RequireImportRule = z.infer<typeof requireImportRule>;
export type RequireExportRule = z.infer<typeof requireExportRule>;
export type MaxFileLinesRule = z.infer<typeof maxFileLinesRule>;
export type RequireTestFileRule = z.infer<typeof requireTestFileRule>;
export type DependencyBoundaryRule = z.infer<typeof dependencyBoundaryRule>;
export type EvidenceRequiresRule = z.infer<typeof evidenceRequiresRule>;

export const RULE_KINDS = [
  "forbid_import",
  "require_import",
  "require_export",
  "max_file_lines",
  "require_test_file",
  "dependency_boundary",
  "evidence_requires",
] as const;

export type RuleKind = (typeof RULE_KINDS)[number];
