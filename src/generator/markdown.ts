import type { ContextFile } from "../core/schema.js";

/** Marker comments for idempotent section management in AGENTS.md */
export const AGENTS_SECTION_START = "<!-- autocontext:agents-section -->";
export const AGENTS_SECTION_END = "<!-- autocontext:agents-section-end -->";

export interface AgentsEntry {
  scope: string;
  summary: string;
}

/**
 * Escape characters that break markdown table cells.
 */
export function escapeSummary(text: string): string {
  return text
    .replace(/\|/g, "\\|")
    .replace(/`/g, "\\`")
    .replace(/\r?\n/g, " ");
}

/**
 * Build the directory index table rows.
 */
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
 * Generate the autocontext section content (between markers, inclusive).
 */
export function generateAgentsSection(entries: AgentsEntry[]): string {
  const table = buildDirectoryTable(entries);

  return `${AGENTS_SECTION_START}
## Project Context

This project uses [autocontext](https://github.com/salehsquared/autocontext) for structured codebase documentation.

**Every directory with source files contains a \`.context.yaml\` file.** It describes:

- What the directory contains and its purpose (summary)
- Architectural decisions and constraints (things you can't infer from code)
- Subdirectory routing (what's inside each subdirectory)

### How to Use Context Files

1. **Before exploring a directory**, read its \`.context.yaml\` summary to understand what it does
2. **Before modifying code**, check \`decisions\` and \`constraints\` for rationale and hard rules
3. **After modifying files**, update the summary if the directory's purpose changed
4. **To check freshness**, run \`context status\` — stale contexts may have outdated information

### Directory Index

${table}

### Maintenance

When you significantly change files in a directory, update its \`.context.yaml\`:
- Update \`summary\` if the directory's purpose shifted
- Update \`decisions\` if architectural choices changed
- Update \`constraints\` if hard rules changed

The \`maintenance\` field in each \`.context.yaml\` contains specific instructions.
${AGENTS_SECTION_END}`;
}

/**
 * Generate a complete AGENTS.md file (for new files).
 */
export function generateAgentsMd(
  projectName: string,
  entries: AgentsEntry[],
): string {
  const section = generateAgentsSection(entries);
  const normalizedProjectName = projectName.trim() || "this project";

  return `# AGENTS.md

> Instructions for AI coding agents working in this repository.
> Project: ${normalizedProjectName}

${section}
`;
}

/**
 * Determine what action to take with the AGENTS.md file.
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

  // Start marker found — find end marker after it
  const endIdx = existingContent.indexOf(AGENTS_SECTION_END, startIdx);

  if (endIdx === -1) {
    // Start without end — always replace (from start to EOF)
    return "replace";
  }

  // Extract existing section (start marker through end marker inclusive)
  const existingSection = existingContent.slice(
    startIdx,
    endIdx + AGENTS_SECTION_END.length,
  );

  return existingSection === newSection ? "skip" : "replace";
}

/**
 * Apply the agents section to existing AGENTS.md content.
 *
 * Handles malformed marker states:
 * - "append": adds section at end
 * - "replace": swaps content between markers; if end marker missing, replaces from start to EOF
 */
export function applyAgentsSection(
  existingContent: string,
  newSection: string,
  action: "append" | "replace",
): string {
  if (action === "append") {
    return existingContent.trimEnd() + "\n\n" + newSection + "\n";
  }

  // Replace mode
  const startIdx = existingContent.indexOf(AGENTS_SECTION_START);
  if (startIdx === -1) {
    // Shouldn't happen (detectAgentsAction would have returned "append"),
    // but handle defensively
    return existingContent.trimEnd() + "\n\n" + newSection + "\n";
  }

  const endIdx = existingContent.indexOf(AGENTS_SECTION_END, startIdx);

  const before = existingContent.slice(0, startIdx);
  const after = endIdx === -1
    ? ""  // No end marker — replace from start to EOF
    : existingContent.slice(endIdx + AGENTS_SECTION_END.length);

  return before + newSection + after;
}
