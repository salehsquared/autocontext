import type { ContextFile } from "../core/schema.js";

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
