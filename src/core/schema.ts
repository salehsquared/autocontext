import { z } from "zod";
import { ruleSchema } from "../policy/rules.js";

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
  semantic_fingerprint: z
    .string()
    .regex(/^[0-9a-f]{12}$/)
    .optional()
    .describe("Semantic fingerprint (12-hex sha256) over exported API, imports, and policy facts"),
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

  // Typed policy rules (T4). Subtree-scoped: rules declared in this directory
  // apply to every descendant directory. Evaluated by `context validate --policy`.
  rules: z.array(ruleSchema).optional()
    .describe("Typed policy rules enforced by `context validate --policy`"),
}).strict();

export { ruleSchema, type Rule } from "../policy/rules.js";

// --- verify: block (T9) ---

const verifyCommandObjectSchema = z.object({
  command: z.string().describe("Shell command to execute"),
  cwd: z.string().optional().describe("Working directory relative to project root (defaults to resolved scope)"),
  timeout_seconds: z.number().int().positive().optional().describe("Per-command timeout (default: 600)"),
  env: z.record(z.string(), z.string()).optional().describe("Extra env vars merged into process.env"),
  artifact: z.string().optional().describe("Path to JSON/XML the runner produces; if absent, parser reads stdout"),
  parser: z.enum([
    "vitest-json",
    "jest-json",
    "junit-xml",
    "go-test-json",
    "tsc",
    "eslint-json",
    "istanbul-summary",
    "pytest-cov",
    "exit-code",
  ]).optional().describe("Override auto-detected parser"),
}).strict();

const verifyCommandSchema = z.union([z.string(), verifyCommandObjectSchema]);

const verifyScopeOverrideSchema = z.object({
  test: verifyCommandSchema.optional(),
  typecheck: verifyCommandSchema.optional(),
  lint: verifyCommandSchema.optional(),
  build: verifyCommandSchema.optional(),
  coverage: verifyCommandSchema.optional(),
}).strict();

const verifyBlockSchema = z.object({
  test: verifyCommandSchema.optional(),
  typecheck: verifyCommandSchema.optional(),
  lint: verifyCommandSchema.optional(),
  build: verifyCommandSchema.optional(),
  coverage: verifyCommandSchema.optional(),
  default_timeout_seconds: z.number().int().positive().optional(),
  scope_overrides: z.record(z.string(), verifyScopeOverrideSchema).optional(),
}).strict();

// --- Config file schema (.context.config.yaml) ---

export const agentsFormatEnum = z.enum(["agents", "claude", "copilot", "cursor"]);

export const agentsBlockSchema = z.object({
  formats: z.array(agentsFormatEnum).optional()
    .describe("Which agent instruction files to emit/update. Defaults: auto-detect existing, else ['agents']."),
}).strict();

export const configSchema = z.object({
  provider: z.enum(["anthropic", "openai", "google", "ollama"]).describe("LLM provider"),
  model: z.string().optional().describe("Model ID override"),
  api_key_env: z.string().optional().describe("Env var name for API key"),
  ignore: z.array(z.string()).optional().describe("Additional directories to ignore"),
  max_depth: z.number().int().optional().describe("Max directory depth for scanning"),
  mode: z.enum(["lean", "full"]).optional().describe("Default generation mode (lean omits files/interfaces)"),
  min_tokens: z.number().int().optional()
    .describe("Minimum estimated tokens for a directory to get a .context.yaml (default: 4096)"),
  verify: verifyBlockSchema.optional()
    .describe("Commands the `context verify` command runs to populate evidence"),
  agents: agentsBlockSchema.optional()
    .describe("Which agent instruction files to emit (AGENTS / CLAUDE / Copilot / Cursor)"),
});

export type VerifyCommand = z.infer<typeof verifyCommandSchema>;
export type VerifyBlock = z.infer<typeof verifyBlockSchema>;
export type VerifyKind = "test" | "typecheck" | "lint" | "build" | "coverage";

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

export const DEFAULT_MAINTENANCE =
  "Read-only visit: don't modify this file. Changed code here? Update `summary`, `decisions`, `constraints`; run `context rehash` (never edit `fingerprint`). No secrets.";

export const FULL_MAINTENANCE =
  "Read-only visit: don't modify this file. Changed code here? Update `summary`, `files`, `interfaces`, `current_state`; run `context rehash` (never edit `fingerprint`). No secrets.";
