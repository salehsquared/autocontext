import { z } from "zod";

// --- Shared field schemas ---

const fileEntrySchema = z.object({
  name: z.string().describe("Filename relative to this directory"),
  purpose: z.string().describe("One-line description of what this file does"),
  test_file: z.string().optional().describe("Associated test file (heuristic, may be wrong for non-colocated test layouts)"),
});

const interfaceEntrySchema = z.object({
  name: z.string().describe("API endpoint, function signature, or CLI command"),
  description: z.string().describe("What this interface does"),
});

const decisionEntrySchema = z.object({
  what: z.string().describe("The decision that was made"),
  why: z.string().describe("Why this decision was made"),
  tradeoff: z.string().optional().describe("Known tradeoffs of this decision"),
});

const dependencySchema = z.object({
  internal: z.array(z.string()).optional().describe("Internal module dependencies"),
  external: z.array(z.string()).optional().describe("External package dependencies"),
});

const currentStateSchema = z.object({
  working: z.array(z.string()).optional().describe("Things that are working"),
  broken: z.array(z.string()).optional().describe("Things that are broken"),
  in_progress: z.array(z.string()).optional().describe("Things in progress"),
});

const subdirectoryEntrySchema = z.object({
  name: z.string().describe("Subdirectory name (with trailing /)"),
  summary: z.string().describe("One-line summary of what this subdirectory contains"),
});

const importEntrySchema = z.object({
  path: z.string().describe("Relative import path (matches dependencies.internal entry)"),
  symbols: z.array(z.string()).describe("Imported symbol names, sorted alphabetically"),
});

const internalEntrySchema = z.object({
  name: z.string().describe("Symbol name"),
  kind: z.enum(["function", "class", "interface", "type", "constant", "enum"]),
  file: z.string().describe("Source filename within this directory"),
});

// --- Root-only: project metadata ---

const projectSchema = z.object({
  name: z.string().describe("Project name"),
  description: z.string().describe("One-line project description"),
  language: z.string().describe("Primary language"),
  framework: z.string().optional().describe("Primary framework"),
  package_manager: z.string().optional().describe("Package manager used"),
});

const structureEntrySchema = z.object({
  path: z.string().describe("Relative path from project root"),
  summary: z.string().describe("One-line summary"),
});

// --- Evidence schema ---

const evidenceSchema = z.object({
  collected_at: z.string().describe("ISO 8601 timestamp of evidence collection"),
  commit_sha: z.string().optional().describe("Git commit SHA at time of evidence collection"),
  test_status: z.enum(["passing", "failing", "unknown"]).optional(),
  test_count: z.number().int().optional(),
  failing_tests: z.array(z.string()).optional(),
  test_tool: z.string().optional().describe("Test runner that produced the artifact (e.g. vitest, jest, pytest)"),
  typecheck: z.enum(["clean", "errors", "unknown"]).optional(),
  typecheck_tool: z.string().optional().describe("Type checker that produced the artifact (e.g. tsc, mypy)"),
  lint_status: z.enum(["clean", "errors", "unknown"]).optional(),
  lint_tool: z.string().optional().describe("Linter that produced the artifact (e.g. eslint, ruff)"),
  coverage_percent: z.number().min(0).max(100).optional().describe("Line coverage percentage"),
}).strict();

// --- Constants (must precede schema definitions that reference them) ---

export const SCHEMA_VERSION = 1;

// --- Main .context.yaml schema (directory-level) ---

export const contextSchema = z.object({
  // Required fields
  version: z.literal(SCHEMA_VERSION).describe("Schema version (must be 1)"),
  last_updated: z.string().describe("ISO 8601 timestamp"),
  fingerprint: z.string().describe("Short hash of directory contents"),
  scope: z.string().describe("Relative path from project root"),
  summary: z.string().describe("1-3 sentence description of this directory"),
  files: z.array(fileEntrySchema).optional().describe("Files in this directory"),
  maintenance: z.string().describe("Self-describing update instruction for LLMs"),

  // Optional fields
  interfaces: z.array(interfaceEntrySchema).optional(),
  decisions: z.array(decisionEntrySchema).optional(),
  constraints: z.array(z.string()).optional(),
  dependencies: dependencySchema.optional(),
  current_state: currentStateSchema.optional(),
  subdirectories: z.array(subdirectoryEntrySchema).optional(),
  environment: z.array(z.string()).optional(),
  testing: z.array(z.string()).optional(),
  todos: z.array(z.string()).optional(),
  data_models: z.array(z.string()).optional(),
  events: z.array(z.string()).optional(),
  config: z.array(z.string()).optional(),
  exports: z.array(z.string()).optional()
    .describe("Compact method signatures and API surface"),
  imports: z.array(importEntrySchema).optional()
    .describe("Symbol-level import bindings from relative imports"),
  internals: z.array(internalEntrySchema).optional()
    .describe("Non-exported top-level declarations (full mode only)"),

  // Root-only fields (optional, only present in root .context.yaml)
  project: projectSchema.optional(),
  structure: z.array(structureEntrySchema).optional(),

  // Provenance and evidence
  derived_fields: z.array(z.string()).optional()
    .describe("Field paths that were machine-derived (high confidence)"),
  evidence: evidenceSchema.optional()
    .describe("Machine-collected code health evidence"),
}).strict();

// --- Config file schema (.context.config.yaml) ---

export const configSchema = z.object({
  provider: z.enum(["anthropic", "openai", "google", "ollama"]).describe("LLM provider"),
  model: z.string().optional().describe("Model ID override"),
  api_key_env: z.string().optional().describe("Env var name for API key"),
  ignore: z.array(z.string()).optional().describe("Additional directories to ignore"),
  max_depth: z.number().int().optional().describe("Max directory depth for scanning"),
  mode: z.enum(["lean", "full"]).optional().describe("Default generation mode (lean omits files/interfaces)"),
  min_tokens: z.number().int().optional()
    .describe("Minimum estimated tokens for a directory to get a .context.yaml (default: 4096)"),
});

// --- Types ---

export type ContextFile = z.infer<typeof contextSchema>;
export type ConfigFile = z.infer<typeof configSchema>;
export type FileEntry = z.infer<typeof fileEntrySchema>;
export type InterfaceEntry = z.infer<typeof interfaceEntrySchema>;
export type DecisionEntry = z.infer<typeof decisionEntrySchema>;
export type SubdirectoryEntry = z.infer<typeof subdirectoryEntrySchema>;
export type ProjectMeta = z.infer<typeof projectSchema>;
export type StructureEntry = z.infer<typeof structureEntrySchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
export type ImportEntry = z.infer<typeof importEntrySchema>;
export type InternalEntry = z.infer<typeof internalEntrySchema>;

// --- Constants ---

export const CONTEXT_FILENAME = ".context.yaml";
export const CONFIG_FILENAME = ".context.config.yaml";

// --- Default maintenance instruction ---

export const DEFAULT_MAINTENANCE = `If you modify files in this directory, update this .context.yaml to reflect
your changes. Update the summary, and any decisions or constraints that changed.
Do NOT update the fingerprint manually — run \`context rehash\` or it will be
updated automatically on the next \`context status\` check.
If you only read files in this directory, do not modify this file.
Do not include secrets, API keys, passwords, or PII in this file.`;

export const FULL_MAINTENANCE = `If you modify files in this directory, update this .context.yaml to reflect
your changes. Update the files list, interfaces, and current_state sections.
Do NOT update the fingerprint manually — run \`context rehash\` or it will be
updated automatically on the next \`context status\` check.
If you only read files in this directory, do not modify this file.
Do not include secrets, API keys, passwords, or PII in this file.`;
