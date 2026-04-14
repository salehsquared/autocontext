import type { ContextFile } from "../core/schema.js";
import type { Pack } from "../pack/types.js";
import type { ImpactReport } from "../impact/impact.js";
import type { Violation } from "../policy/types.js";
import { formatPackMarkdown } from "../pack/format.js";

export const BENCH_SYSTEM_PROMPT = `You are an AI assistant helping a developer understand and work with a codebase.
Answer questions precisely based ONLY on the information provided.
If you don't have enough information to answer, say "I don't know".
Be specific — include exact file paths, package names, or module names when relevant.`;

const DEFAULT_README_SNIPPET_CHARS = 2_000;

export function buildReadmeSnippet(readme: string | null, maxChars = DEFAULT_README_SNIPPET_CHARS): string | null {
  if (!readme) return null;
  const trimmed = readme.trim();
  if (!trimmed) return null;
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}\n... [truncated ${trimmed.length - maxChars} chars]`;
}

export function buildBaselinePrompt(
  fileTree: string,
  readme: string | null,
  question: string,
  sourceScope?: string,
): string {
  const scopeLine = sourceScope ? ` centered on \`${sourceScope}/\`` : "";
  let prompt = `Here is scoped project information${scopeLine}:\n\nScoped file tree:\n${fileTree}\n`;
  if (readme) {
    prompt += `\nREADME excerpt:\n${readme}\n`;
  }
  prompt += `\nBased on this information, answer the following question:\n${question}`;
  return prompt;
}

export function buildContextPrompt(
  fileTree: string,
  contextFiles: Map<string, ContextFile>,
  question: string,
  sourceScope?: string,
): string {
  const scopeLine = sourceScope ? ` centered on \`${sourceScope}/\`` : "";
  let prompt = `Here is scoped project documentation${scopeLine}:\n\nScoped file tree:\n${fileTree}\n\nDirectory documentation:\n`;

  for (const [scope, ctx] of contextFiles) {
    prompt += `\n## ${scope}/\n`;
    prompt += `Summary: ${ctx.summary}\n`;
    if (ctx.exports && ctx.exports.length > 0) {
      prompt += `Exports: ${ctx.exports.join(", ")}\n`;
    }
    if (ctx.dependencies) {
      if (ctx.dependencies.internal && ctx.dependencies.internal.length > 0) {
        prompt += `Internal deps: ${ctx.dependencies.internal.join(", ")}\n`;
      }
      if (ctx.dependencies.external && ctx.dependencies.external.length > 0) {
        prompt += `External deps: ${ctx.dependencies.external.join(", ")}\n`;
      }
    }
    if (ctx.imports && ctx.imports.length > 0) {
      const shown = ctx.imports.slice(0, 5);
      const parts = shown.map(i => `${i.path} [${i.symbols.join(", ")}]`);
      const suffix = ctx.imports.length > 5 ? `, ... and ${ctx.imports.length - 5} more` : "";
      prompt += `Imports: ${parts.join(", ")}${suffix}\n`;
    }
    if (ctx.internals && ctx.internals.length > 0) {
      const shown = ctx.internals.slice(0, 5);
      const parts = shown.map(i => `${i.name} (${i.kind}, ${i.file})`);
      const suffix = ctx.internals.length > 5 ? `, ... and ${ctx.internals.length - 5} more` : "";
      prompt += `Internals: ${parts.join(", ")}${suffix}\n`;
    }
    if (ctx.files && ctx.files.length > 0) {
      prompt += `Files:\n`;
      for (const f of ctx.files) {
        prompt += `  - ${f.name}: ${f.purpose}\n`;
      }
    }
    if (ctx.subdirectories && ctx.subdirectories.length > 0) {
      prompt += `Subdirectories:\n`;
      for (const sub of ctx.subdirectories) {
        prompt += `  - ${sub.name}: ${sub.summary}\n`;
      }
    }
  }

  prompt += `\nBased on this project documentation, answer the following question:\n${question}`;
  return prompt;
}

/**
 * Pack arm — feed the model the ranked pack output as documentation.
 * Uses markdown format with section delimiters so the model sees the
 * same shape T3 produces for real integrations.
 */
export function buildPackPrompt(
  pack: Pack,
  question: string,
  sourceScope?: string,
): string {
  const scopeLine = sourceScope ? ` centered on \`${sourceScope}/\`` : "";
  const packMd = formatPackMarkdown(pack);
  return `Here is a retrieval-ranked project pack${scopeLine}:\n\n${packMd}\n\nBased on this pack, answer the following question:\n${question}`;
}

/**
 * Pack + impact arm — pack bodies plus the T2 impact-set summary.
 */
export function buildPackImpactPrompt(
  pack: Pack,
  impact: ImpactReport | null,
  question: string,
  sourceScope?: string,
): string {
  const base = buildPackPrompt(pack, question, sourceScope);
  if (!impact) return base;
  const lines: string[] = [];
  lines.push("\n## Impact set (T2 — import-bound references only)");
  lines.push(impact.caveat);
  if (impact.seeds.length > 0) {
    lines.push(`\nSeeds: ${impact.seeds.map((s) => s.symbol ? `${s.file}#${s.symbol}` : s.file).join(", ")}`);
  }
  if (impact.affected_scopes.length > 0) {
    lines.push("\nAffected scopes:");
    for (const s of impact.affected_scopes.slice(0, 20)) {
      lines.push(`  - ${s.scope} (hops ${s.min_hops}, ${s.file_count} file${s.file_count === 1 ? "" : "s"})`);
    }
    if (impact.affected_scopes.length > 20) {
      lines.push(`  … ${impact.affected_scopes.length - 20} more`);
    }
  }
  return `${base}\n\n${lines.join("\n")}`;
}

/**
 * Pack + policy arm — pack bodies plus the T4 violations whose scope
 * overlaps the pack's admitted scopes.
 */
export function buildPackPolicyPrompt(
  pack: Pack,
  violations: Violation[],
  question: string,
  sourceScope?: string,
): string {
  const base = buildPackPrompt(pack, question, sourceScope);
  if (violations.length === 0) return base;
  const lines: string[] = [];
  lines.push("\n## Policy violations (T4)");
  for (const v of violations.slice(0, 30)) {
    const loc = v.file ? (v.line ? `${v.file}:${v.line}` : v.file) : v.scope;
    lines.push(`  - [${v.rule_kind}] ${v.message} (${loc})`);
  }
  if (violations.length > 30) {
    lines.push(`  … ${violations.length - 30} more`);
  }
  return `${base}\n\n${lines.join("\n")}`;
}

export function buildJudgePrompt(
  question: string,
  response: string,
  referenceFacts: string[],
): string {
  return `You are evaluating an AI's answer about a codebase directory.

Question: ${question}
AI's response: ${response}

Reference facts (from source code analysis):
${referenceFacts.map((f) => `- ${f}`).join("\n")}

Rate accuracy:
0 = wrong or completely off-topic
1 = vague, generic, could apply to any directory
2 = partially correct, captures some specifics
3 = accurate and specific to actual directory contents

Respond with ONLY a single digit: 0, 1, 2, or 3.`;
}
