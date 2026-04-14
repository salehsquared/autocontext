import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  generateAgentsMd,
  generateAgentsSection,
  generateClaudeMd,
  generateCopilotInstructions,
  generateCursorRule,
  detectAgentsAction,
  applyAgentsSection,
  ALL_AGENTS_FORMATS,
  type AgentsEntry,
  type AgentsFormat,
} from "../generator/markdown.js";

export const AGENTS_FILENAME = "AGENTS.md";
export const CLAUDE_FILENAME = "CLAUDE.md";
export const COPILOT_PATH = ".github/copilot-instructions.md";
export const CURSOR_PATH = ".cursor/rules/autocontext.mdc";

/** Per-format relative path from project root. */
export function formatPath(format: AgentsFormat): string {
  switch (format) {
    case "agents": return AGENTS_FILENAME;
    case "claude": return CLAUDE_FILENAME;
    case "copilot": return COPILOT_PATH;
    case "cursor": return CURSOR_PATH;
  }
}

/**
 * Read AGENTS.md from project root. Returns null if not found.
 *
 * Kept for back-compat with callers that only know the legacy AGENTS.md.
 */
export async function readAgentsMd(rootPath: string): Promise<string | null> {
  return readAgentsFile(rootPath, "agents");
}

/** Read any format file; null if missing. */
async function readAgentsFile(rootPath: string, format: AgentsFormat): Promise<string | null> {
  try {
    return await readFile(join(rootPath, formatPath(format)), "utf-8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/**
 * Write AGENTS.md to project root.
 */
export async function writeAgentsMd(rootPath: string, content: string): Promise<void> {
  await writeFile(join(rootPath, AGENTS_FILENAME), content, "utf-8");
}

/** Write any format file, creating parent dirs if needed. */
async function writeAgentsFile(rootPath: string, format: AgentsFormat, content: string): Promise<void> {
  const target = join(rootPath, formatPath(format));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf-8");
}

export type AgentsAction = "created" | "appended" | "replaced" | "skipped";

export interface AgentsUpdateResult {
  format: AgentsFormat;
  path: string;
  action: AgentsAction;
}

/**
 * Orchestrate AGENTS.md creation/update at the project root.
 * Kept for back-compat; new code should use `updateAgentsFiles`.
 */
export async function updateAgentsMd(
  rootPath: string,
  entries: AgentsEntry[],
  projectName: string,
): Promise<AgentsAction> {
  const [result] = await updateAgentsFiles(rootPath, entries, projectName, ["agents"]);
  return result.action;
}

/**
 * Update one or more agent-format files. Markdown formats (AGENTS / CLAUDE /
 * Copilot) use the marker-based merge that preserves surrounding user content.
 * Cursor's .mdc file is owned entirely — no merge.
 */
export async function updateAgentsFiles(
  rootPath: string,
  entries: AgentsEntry[],
  projectName: string,
  formats: readonly AgentsFormat[],
): Promise<AgentsUpdateResult[]> {
  const out: AgentsUpdateResult[] = [];
  for (const format of formats) {
    const action = await updateOneFormat(rootPath, entries, projectName, format);
    out.push({ format, path: formatPath(format), action });
  }
  return out;
}

async function updateOneFormat(
  rootPath: string,
  entries: AgentsEntry[],
  projectName: string,
  format: AgentsFormat,
): Promise<AgentsAction> {
  if (format === "cursor") {
    const target = join(rootPath, formatPath(format));
    const fresh = generateCursorRule(entries);
    const existing = await readAgentsFile(rootPath, "cursor");
    if (existing === fresh) return "skipped";
    await writeAgentsFile(rootPath, "cursor", fresh);
    return existing === null ? "created" : "replaced";
  }

  const existing = await readAgentsFile(rootPath, format);
  const newSection = generateAgentsSection(entries);
  const action = detectAgentsAction(existing, newSection);

  if (action === "create") {
    const content =
      format === "agents" ? generateAgentsMd(projectName, entries)
      : format === "claude" ? generateClaudeMd(projectName, entries)
      : generateCopilotInstructions(projectName, entries);
    await writeAgentsFile(rootPath, format, content);
    return "created";
  }

  if (action === "skip") return "skipped";

  const updated = applyAgentsSection(existing!, newSection, action);
  await writeAgentsFile(rootPath, format, updated);
  return action === "append" ? "appended" : "replaced";
}

/**
 * Detect agent-file formats a project already uses. Used to default
 * multi-format emission without creating new top-level files for clients
 * the user doesn't use.
 */
export function detectExistingAgentsFormats(rootPath: string): AgentsFormat[] {
  const out: AgentsFormat[] = [];
  for (const format of ALL_AGENTS_FORMATS) {
    if (existsSync(join(rootPath, formatPath(format)))) out.push(format);
  }
  // Also treat a `.cursor/` dir (without our file yet) as opt-in.
  if (!out.includes("cursor") && existsSync(join(rootPath, ".cursor"))) {
    out.push("cursor");
  }
  return out;
}

/** Parse `--agents-format` CLI argument. */
export function parseAgentsFormats(raw: string | undefined): AgentsFormat[] | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "all") return [...ALL_AGENTS_FORMATS];
  if (trimmed === "none" || trimmed === "") return [];
  const parts = trimmed.split(",").map((s) => s.trim()).filter(Boolean);
  const valid = new Set<string>(ALL_AGENTS_FORMATS);
  const out: AgentsFormat[] = [];
  for (const p of parts) {
    if (!valid.has(p)) {
      throw new Error(`Unknown agent format: "${p}". Valid: ${ALL_AGENTS_FORMATS.join(", ")}, all, none.`);
    }
    if (!out.includes(p as AgentsFormat)) out.push(p as AgentsFormat);
  }
  return out;
}

/**
 * Resolve the effective format list using the full precedence chain:
 * CLI flag → config.agents.formats → detect existing → default ["agents"].
 */
export function resolveAgentsFormats(
  rootPath: string,
  cliFormats: AgentsFormat[] | undefined,
  configFormats: readonly AgentsFormat[] | undefined,
): AgentsFormat[] {
  if (cliFormats !== undefined) return [...cliFormats];
  if (configFormats && configFormats.length > 0) return [...configFormats];
  const detected = detectExistingAgentsFormats(rootPath);
  if (detected.length > 0) return detected;
  return ["agents"];
}
