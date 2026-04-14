import { readFile, stat } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import { parse } from "yaml";
import type { LLMProvider } from "../providers/index.js";
import type { ScanResult } from "../core/scanner.js";
import type { ContextFile } from "../core/schema.js";
import { SCHEMA_VERSION, DEFAULT_MAINTENANCE, FULL_MAINTENANCE, contextSchema } from "../core/schema.js";
import { computeFingerprint } from "../core/fingerprint.js";
import { SYSTEM_PROMPT, LEAN_SYSTEM_PROMPT, buildUserPrompt } from "./prompts.js";
import { detectExternalDeps, detectInternalDeps } from "./dependencies.js";
import { detectImportBindings } from "./imports.js";
import { detectInternals } from "./internals.js";
import { collectBasicEvidence } from "./evidence.js";
import { detectExportSignaturesAST } from "./ast.js";
import { detectExportsWithFallback, extractOneSignature } from "./static.js";

/**
 * Generate a .context.yaml using an LLM provider.
 * Reads file contents, sends them to the LLM, and parses the structured output.
 */
export async function generateLLMContext(
  provider: LLMProvider,
  scanResult: ScanResult,
  childContexts: Map<string, ContextFile>,
  options?: { evidence?: boolean; mode?: "lean" | "full" },
): Promise<ContextFile> {
  const mode = options?.mode ?? "lean";
  const isFull = mode === "full";

  // Read file contents
  const fileContents = new Map<string, string>();
  for (const filename of scanResult.files) {
    try {
      const content = await readFile(join(scanResult.path, filename), "utf-8");
      fileContents.set(filename, content);
    } catch {
      // Skip unreadable files
    }
  }

  const isRoot = scanResult.relativePath === ".";
  const preDetectedDeps = isFull ? await detectExternalDeps(scanResult.path) : [];
  const userPrompt = buildUserPrompt(scanResult, fileContents, childContexts, isRoot, preDetectedDeps, mode);

  // Call LLM
  const systemPrompt = isFull ? SYSTEM_PROMPT : LEAN_SYSTEM_PROMPT;
  const rawResponse = await provider.generate(systemPrompt, userPrompt);

  // Strip markdown fences if present
  const yamlStr = rawResponse
    .replace(/^```ya?ml\n?/m, "")
    .replace(/\n?```\s*$/m, "")
    .trim();

  // Parse and merge with required fields
  const llmOutput = parse(yamlStr) as Record<string, unknown>;
  const fingerprint = await computeFingerprint(scanResult.path);

  const context: ContextFile = {
    version: SCHEMA_VERSION,
    last_updated: new Date().toISOString(),
    fingerprint,
    scope: scanResult.relativePath,
    summary: (llmOutput.summary as string) ?? `Directory: ${scanResult.relativePath}`,
    maintenance: isFull ? FULL_MAINTENANCE : DEFAULT_MAINTENANCE,
  };

  // Files: only in full mode
  if (isFull) {
    context.files = (llmOutput.files as ContextFile["files"]) ?? [];
  }

  // Merge optional fields from LLM output
  // Always merge high-value fields (decisions, constraints)
  if (llmOutput.decisions) context.decisions = llmOutput.decisions as ContextFile["decisions"];
  if (llmOutput.constraints) context.constraints = llmOutput.constraints as ContextFile["constraints"];

  // Full-mode-only fields
  if (isFull) {
    if (llmOutput.interfaces) context.interfaces = llmOutput.interfaces as ContextFile["interfaces"];
    if (llmOutput.current_state) context.current_state = llmOutput.current_state as ContextFile["current_state"];
    if (llmOutput.dependencies) context.dependencies = llmOutput.dependencies as ContextFile["dependencies"];
  }

  if (llmOutput.project) context.project = llmOutput.project as ContextFile["project"];
  if (llmOutput.structure) context.structure = llmOutput.structure as ContextFile["structure"];

  // Add subdirectories from scan (more reliable than LLM guessing)
  if (scanResult.children.length > 0) {
    context.subdirectories = scanResult.children.map((child) => ({
      name: basename(child.relativePath) + "/",
      summary: childContexts.get(child.path)?.summary
        ?? `Contains ${child.files.length} source files`,
    }));
  }

  // Root-level: ensure project and structure always present
  if (scanResult.relativePath === ".") {
    if (!context.project) {
      context.project = {
        name: basename(scanResult.path) || "unknown",
        description: "Project root",
        language: "unknown",
      };
    }
    if (!context.structure) {
      context.structure = scanResult.children.map((child) => ({
        path: child.relativePath,
        summary: childContexts.get(child.path)?.summary
          ?? `Contains ${child.files.length} source files`,
      }));
    }
  }

  // Overlay machine-derived dependencies (more reliable than LLM guessing)
  const internalDeps = await detectInternalDeps(scanResult);

  if (preDetectedDeps.length > 0) {
    context.dependencies = context.dependencies ?? {};
    context.dependencies.external = preDetectedDeps;
  }
  if (internalDeps.length > 0) {
    context.dependencies = context.dependencies ?? {};
    context.dependencies.internal = internalDeps;
  }

  // Overlay machine-derived exports (more reliable than LLM guessing)
  const exportSigs = await extractExportSignatures(scanResult, fileContents);
  if (exportSigs.length > 0) {
    context.exports = exportSigs;
  }

  // Overlay machine-derived import bindings (both lean and full)
  const importBindings = await detectImportBindings(scanResult);
  if (importBindings.length > 0) {
    context.imports = importBindings;
  }

  // Overlay machine-derived internals (full mode only)
  if (isFull) {
    const internals = await detectInternals(scanResult);
    if (internals.length > 0) {
      context.internals = internals;
    }
  }

  // Overlay lightweight T5-A extractors — static extraction is authoritative
  // for these fields, so any LLM output is overwritten.
  const { extractEnvironment } = await import("./extractors/environment.js");
  const { extractTesting } = await import("./extractors/testing.js");
  const { extractTodos } = await import("./extractors/todos.js");
  const { extractConfig } = await import("./extractors/config.js");
  const { extractDataModels } = await import("./extractors/data-models.js");
  const { extractEvents } = await import("./extractors/events.js");
  const envVars = await extractEnvironment(scanResult);
  if (envVars.length > 0) context.environment = envVars;
  else delete context.environment;
  const testingEntries = await extractTesting(scanResult);
  if (testingEntries.length > 0) context.testing = testingEntries;
  else delete context.testing;
  const todoEntries = await extractTodos(scanResult);
  if (todoEntries.length > 0) context.todos = todoEntries;
  else delete context.todos;
  const configEntries = await extractConfig(scanResult);
  if (configEntries.length > 0) context.config = configEntries;
  else delete context.config;
  const dataModels = await extractDataModels(scanResult);
  if (dataModels.length > 0) context.data_models = dataModels;
  else delete context.data_models;
  const eventsEntries = await extractEvents(scanResult);
  if (eventsEntries.length > 0) context.events = eventsEntries;
  else delete context.events;

  // Collect evidence (per-directory, opt-in)
  if (options?.evidence) {
    // Compute newest source file mtime for staleness comparison
    let newestMtimeMs: number | undefined;
    for (const filename of scanResult.files) {
      try {
        const s = await stat(join(scanResult.path, filename));
        if (newestMtimeMs === undefined || s.mtimeMs > newestMtimeMs) {
          newestMtimeMs = s.mtimeMs;
        }
      } catch {
        // skip unreadable files
      }
    }
    const evidence = await collectBasicEvidence(scanResult.path, newestMtimeMs);
    if (evidence) context.evidence = evidence;
  }

  // Build derived_fields (only fields that came from static analysis, not LLM)
  const derivedFields = ["version", "last_updated", "fingerprint", "scope"];
  if (preDetectedDeps.length > 0) derivedFields.push("dependencies.external");
  if (internalDeps.length > 0) derivedFields.push("dependencies.internal");
  if (context.exports) derivedFields.push("exports");
  if (context.imports) derivedFields.push("imports");
  if (context.internals) derivedFields.push("internals");
  if (context.subdirectories) derivedFields.push("subdirectories");
  if (context.project) derivedFields.push("project");
  if (context.evidence) derivedFields.push("evidence");
  if (context.environment) derivedFields.push("environment");
  if (context.testing) derivedFields.push("testing");
  if (context.todos) derivedFields.push("todos");
  if (context.config) derivedFields.push("config");
  if (context.data_models) derivedFields.push("data_models");
  if (context.events) derivedFields.push("events");
  context.derived_fields = derivedFields;

  // Validate against schema — if it fails, fall back to a minimal valid context
  const result = contextSchema.safeParse(context);
  if (!result.success) {
    console.warn(`Warning: LLM output for ${scanResult.relativePath} failed validation, using minimal context`);
    const fallback: ContextFile = {
      version: SCHEMA_VERSION,
      last_updated: new Date().toISOString(),
      fingerprint,
      scope: scanResult.relativePath,
      summary: (llmOutput.summary as string) ?? `Directory: ${scanResult.relativePath}`,
      maintenance: isFull ? FULL_MAINTENANCE : DEFAULT_MAINTENANCE,
    };
    if (isFull) {
      fallback.files = scanResult.files.map((f) => ({ name: f, purpose: "Source file" }));
    }
    if (scanResult.relativePath === ".") {
      fallback.project = {
        name: basename(scanResult.path) || "unknown",
        description: "Project root",
        language: "unknown",
      };
      if (scanResult.children.length > 0) {
        fallback.structure = scanResult.children.map((child) => ({
          path: child.relativePath,
          summary: childContexts.get(child.path)?.summary
            ?? `Contains ${child.files.length} source files`,
        }));
      }
    }
    return fallback;
  }

  return result.data;
}

const SIGNATURE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs"]);

async function extractExportSignatures(
  scanResult: ScanResult,
  fileContents: Map<string, string>,
): Promise<string[]> {
  const signatures: string[] = [];

  for (const filename of scanResult.files) {
    const ext = extname(filename).toLowerCase();
    if (!SIGNATURE_EXTENSIONS.has(ext)) continue;

    const content = fileContents.get(filename);
    if (!content) continue;

    // Try AST-first
    const astSigs = await detectExportSignaturesAST(content, ext);
    if (astSigs) {
      for (const { signature } of astSigs) {
        if (!signatures.includes(signature)) signatures.push(signature);
      }
      continue;
    }

    // Regex fallback
    const names = await detectExportsWithFallback(content, ext);
    for (const name of names) {
      const sig = extractOneSignature(content, name, ext);
      if (sig && !signatures.includes(sig)) signatures.push(sig);
    }
  }

  return signatures.slice(0, 25);
}
