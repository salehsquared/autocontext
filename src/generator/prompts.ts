import { relative, basename } from "node:path";
import type { ScanResult } from "../core/scanner.js";
import type { ContextFile } from "../core/schema.js";

/**
 * Bump whenever SYSTEM_PROMPT, LEAN_SYSTEM_PROMPT, or buildUserPrompt
 * changes in a way that could alter LLM output for the same directory
 * inputs. Monotonically increasing; never reuse old values. T7's LLM
 * cache includes this in its key, so a bump invalidates all entries.
 */
export const PROMPT_TEMPLATE_VERSION = 1;

export const SYSTEM_PROMPT = `You are a technical documentation generator. Your job is to analyze source code files and produce structured YAML documentation for a .context.yaml file.

Rules:
- Be factual and precise. Describe what the code DOES, not what it might do.
- Keep summaries to 1-3 sentences.
- File purposes should be one concise line.
- Interface descriptions should be clear and actionable.
- Only include decisions/constraints/current_state if you can identify them from the code.
- Do NOT include secrets, API keys, passwords, or PII.
- Output ONLY valid YAML — no markdown fences, no explanatory text.
- Follow the exact field structure shown in the user prompt.
- The following fields are machine-derived and will be overlaid automatically. Do NOT generate them:
  dependencies.external, dependencies.internal, imports, internals, derived_fields, evidence, subdirectories, version, last_updated, fingerprint, scope, maintenance
- Focus your analysis on narrative fields: summary, files[].purpose, interfaces[].description, decisions, constraints, current_state`;

export const LEAN_SYSTEM_PROMPT = `You are a technical documentation generator producing lean .context.yaml routing files.

Rules:
- Focus on SUMMARY, DECISIONS, and CONSTRAINTS only.
- Summary: 1-3 precise sentences describing what this directory does and its role.
- Decisions: only non-obvious architectural choices that cannot be inferred from reading the code.
- Constraints: only hard rules that a developer must know.
- Do NOT list files, interfaces, or dependencies — those are redundant with source code.
- Output ONLY valid YAML — no markdown fences, no explanatory text.
- Do NOT include secrets, API keys, passwords, or PII.`;

export function buildUserPrompt(
  scanResult: ScanResult,
  fileContents: Map<string, string>,
  childContexts: Map<string, ContextFile>,
  isRoot: boolean,
  externalDeps?: string[],
  mode: "lean" | "full" = "lean",
): string {
  let prompt = `Analyze the following directory and generate a .context.yaml for it.

Directory: ${scanResult.relativePath}
`;

  // Add file contents
  prompt += `\n--- Files in this directory ---\n`;
  for (const filename of scanResult.files) {
    const content = fileContents.get(filename);
    if (content) {
      // Truncate very large files
      const truncated = content.length > 8000
        ? content.substring(0, 8000) + "\n... (truncated)"
        : content;
      prompt += `\n### ${filename}\n\`\`\`\n${truncated}\n\`\`\`\n`;
    }
  }

  // Add child context summaries (immediate children only)
  if (childContexts.size > 0) {
    const immediateChildren: Array<[string, ContextFile]> = [];
    for (const [childPath, ctx] of childContexts) {
      const rel = relative(scanResult.path, childPath);
      // Immediate child: no separators, not empty, not escaping upward
      if (!rel || rel.startsWith("..") || rel.includes("/") || rel.includes("\\")) continue;
      immediateChildren.push([childPath, ctx]);
    }

    if (immediateChildren.length > 0) {
      prompt += `\n--- Subdirectory summaries ---\n`;
      for (const [childPath, ctx] of immediateChildren) {
        const dirName = basename(childPath);
        prompt += `- ${dirName}/: ${ctx.summary}\n`;
      }
    }
  }

  // Add pre-detected external dependencies as context
  if (externalDeps && externalDeps.length > 0) {
    prompt += `\n--- External dependencies (detected from manifest) ---\n`;
    for (const dep of externalDeps) {
      prompt += `- ${dep}\n`;
    }
  }

  // Specify output format
  if (mode === "full") {
    prompt += `
--- Output format ---
Generate YAML with these fields (dependencies, subdirectories, and other machine-derived fields are handled automatically — do NOT include them):

summary: |
  <1-3 sentence description of what this directory does>

files:
  - name: "<filename>"
    purpose: "<one-line purpose>"

interfaces:  # only if there are public APIs, functions, endpoints
  - name: "<function/endpoint name>"
    description: "<what it does>"

decisions:  # only if you can identify non-obvious architectural choices
  - what: "<decision>"
    why: "<reasoning>"
    tradeoff: "<known tradeoff>"

constraints:  # only if there are hard rules
  - "<constraint>"

current_state:  # only if things are clearly in progress or broken
  working:
    - "<what works>"
  broken:
    - "<what's broken>"
  in_progress:
    - "<what's being worked on>"
`;
  } else {
    prompt += `
--- Output format ---
Generate lean YAML with ONLY these fields (all other fields are machine-derived — do NOT include them):

summary: |
  <1-3 sentence description of what this directory does>

decisions:  # only if you can identify non-obvious architectural choices
  - what: "<decision>"
    why: "<reasoning>"
    tradeoff: "<known tradeoff>"

constraints:  # only if there are hard rules
  - "<constraint>"
`;
  }

  if (isRoot) {
    prompt += `
This is the PROJECT ROOT. Also include:

project:
  name: "<project name>"
  description: "<one-line description>"
  language: "<primary language>"
  framework: "<primary framework if any>"
  package_manager: "<package manager>"

structure:
  - path: "<subdir path>"
    summary: "<one-line summary>"
`;
  }

  prompt += `\nOmit any optional sections that don't apply. Output ONLY the YAML, nothing else.`;

  return prompt;
}
