import type { ContextFile } from "../core/schema.js";

/** Marker comments for idempotent section management in AGENTS-style files. */
export const AGENTS_SECTION_START = "<!-- autocontext:agents-section -->";
export const AGENTS_SECTION_END = "<!-- autocontext:agents-section-end -->";

export interface AgentsEntry {
  scope: string;
  summary: string;
}

/** Emitter targets. `agents`/`claude`/`copilot` share the markdown body and
 * wrap it for their convention. `cursor` emits a `.mdc` rule file that we own
 * outright (no user content to merge around). */
export type AgentsFormat = "agents" | "claude" | "copilot" | "cursor";
export const ALL_AGENTS_FORMATS: readonly AgentsFormat[] = ["agents", "claude", "copilot", "cursor"];

/**
 * Escape characters that break markdown table cells.
 */
export function escapeSummary(text: string): string {
  return text
    .replace(/\|/g, "\\|")
    .replace(/`/g, "\\`")
    .replace(/\r?\n/g, " ");
}

/** Restrict entries to the root plus first-level directories. Prevents the
 *  "30-row table that duplicates list_contexts" bloat on large repos. */
function topLevelEntries(entries: AgentsEntry[]): AgentsEntry[] {
  return entries.filter((e) => e.scope === "." || !e.scope.includes("/"));
}

function buildDirectoryTable(entries: AgentsEntry[]): string {
  const rows = entries.map((e) => {
    const dir = e.scope === "." ? "`.` (root)" : `\`${e.scope}\``;
    return `| ${dir} | ${escapeSummary(e.summary)} |`;
  });
  return [
    "| Directory | Summary |",
    "|-----------|---------|",
    ...rows,
  ].join("\n");
}

/**
 * The single canonical instruction body. All markdown formats share this;
 * cursor's .mdc file uses the same text under its own frontmatter.
 *
 * Designed for: minimum tokens, maximum actionable detail. Agents read this
 * once per session, so every line must earn its place.
 */
function buildAutocontextBody(entries: AgentsEntry[]): string {
  const map = buildDirectoryTable(topLevelEntries(entries));
  return `## autocontext

**autocontext is your map of this codebase.** Before you grep, before you open random files, query here — every directory has a \`.context.yaml\` summarizing its purpose, architectural decisions, and sometimes a \`rules:\` block that is mechanically enforced. Parsing these files by hand is the wrong move; use the tools below.

### Routing
- **MCP** (\`context serve\`): \`list_contexts\` / \`search_context\` → find; \`query_context\` → read; \`find_definition\` / \`find_references\` / \`find_related\` / \`impact\` → navigate; \`check_policies\` → enforce; \`build_context_pack\` → token-budgeted brief; \`explain_staleness\` / \`check_freshness\` / \`aggregate_evidence\` → state.
- **CLI** (no MCP): \`context show <dir>\`, \`context impact <file>\`, \`context validate --policy\`, \`context pack --query "..."\`, \`context verify\`, \`context status\`.

### Before an edit
1. \`impact <file>\` (MCP) or \`context impact <file>\` — know the blast radius.
2. Read the enclosing scope's \`decisions\`, \`constraints\`, and \`rules:\`. Honor them.
3. If the scope is \`semantic_stale\`, call \`explain_staleness\` before trusting the summary.

### Before a commit
1. \`context validate --policy\` — fix violations, don't bypass.
2. \`context regen --semantic-stale\` — regenerates only scopes whose symbols actually changed.

### Do not
- Edit \`.context.yaml\` by hand unless code structure changed; \`context regen\` handles it.
- Strip \`decisions\`, \`constraints\`, or \`rules:\` — these are user-authored and never auto-generated.
- Invent rules outside the 7 kinds: \`forbid_import\`, \`require_import\`, \`require_export\`, \`max_file_lines\`, \`require_test_file\`, \`dependency_boundary\`, \`evidence_requires\`.

### Freshness (4 states)
\`fresh\` · \`cosmetic_stale\` (whitespace only — ignore) · \`semantic_stale\` (symbols changed — likely regen) · \`missing\`.

### Top-level map
${map}

Full index: \`list_contexts\` (MCP) or \`context status\`.`;
}

/**
 * Generate the autocontext section content (between markers, inclusive).
 * Shared markdown body for AGENTS / CLAUDE / Copilot files.
 */
export function generateAgentsSection(entries: AgentsEntry[]): string {
  return `${AGENTS_SECTION_START}\n${buildAutocontextBody(entries)}\n${AGENTS_SECTION_END}`;
}

/**
 * Generate a complete AGENTS.md file (for new files).
 */
export function generateAgentsMd(
  projectName: string,
  entries: AgentsEntry[],
): string {
  const normalized = projectName.trim() || "this project";
  return `# AGENTS.md

> How to navigate this codebase. Read this before grepping or opening files —
> autocontext (below) has the map.
> Project: ${normalized}

${generateAgentsSection(entries)}
`;
}

/** CLAUDE.md — same body, different intro line. Claude Code reads this. */
export function generateClaudeMd(
  projectName: string,
  entries: AgentsEntry[],
): string {
  const normalized = projectName.trim() || "this project";
  return `# CLAUDE.md

> How to navigate this codebase. Read this before grepping or opening files —
> autocontext (below) has the map.
> Project: ${normalized}

${generateAgentsSection(entries)}
`;
}

/** .github/copilot-instructions.md — GitHub Copilot convention. */
export function generateCopilotInstructions(
  projectName: string,
  entries: AgentsEntry[],
): string {
  const normalized = projectName.trim() || "this project";
  return `# Copilot instructions

> How to navigate this codebase. Read this before grepping or opening files —
> autocontext (below) has the map.
> Project: ${normalized}

${generateAgentsSection(entries)}
`;
}

/** .cursor/rules/autocontext.mdc — Cursor rule file with MDC frontmatter.
 *  We own this file entirely; no user content to merge around. */
export function generateCursorRule(entries: AgentsEntry[]): string {
  return `---
description: autocontext — the map of this codebase (read before grepping)
globs: ["**/*"]
alwaysApply: true
---

${buildAutocontextBody(entries)}
`;
}

/**
 * Determine what action to take with a markdown agent file (AGENTS / CLAUDE /
 * Copilot). Cursor rule files are owned outright — callers overwrite directly.
 *
 * Handles malformed marker states deterministically:
 * - Start without end → "replace" (replace from start to EOF)
 * - End without start → "append" (ignore orphaned end marker)
 * - Duplicate markers → use first start and first end after it
 */
export function detectAgentsAction(
  existingContent: string | null,
  newSection: string,
): "create" | "append" | "replace" | "skip" {
  if (existingContent === null) return "create";

  const startIdx = existingContent.indexOf(AGENTS_SECTION_START);
  if (startIdx === -1) return "append";

  const endIdx = existingContent.indexOf(AGENTS_SECTION_END, startIdx);

  if (endIdx === -1) {
    return "replace";
  }

  const existingSection = existingContent.slice(
    startIdx,
    endIdx + AGENTS_SECTION_END.length,
  );

  return existingSection === newSection ? "skip" : "replace";
}

/**
 * Apply the agents section to existing markdown content (AGENTS / CLAUDE /
 * Copilot). "append" adds at end, "replace" swaps between markers.
 */
export function applyAgentsSection(
  existingContent: string,
  newSection: string,
  action: "append" | "replace",
): string {
  if (action === "append") {
    return existingContent.trimEnd() + "\n\n" + newSection + "\n";
  }

  const startIdx = existingContent.indexOf(AGENTS_SECTION_START);
  if (startIdx === -1) {
    return existingContent.trimEnd() + "\n\n" + newSection + "\n";
  }

  const endIdx = existingContent.indexOf(AGENTS_SECTION_END, startIdx);

  const before = existingContent.slice(0, startIdx);
  const after = endIdx === -1
    ? ""
    : existingContent.slice(endIdx + AGENTS_SECTION_END.length);

  return before + newSection + after;
}

// Intentional re-export: `ContextFile` used to leak from here via the old
// imports. Callers don't need it from this module, but tests reference it.
export type { ContextFile };
