import type { Pack } from "./types.js";

/** Markdown rendering with HTML comment delimiters so downstream tools can
 *  slice sections reliably. */
export function formatPackMarkdown(pack: Pack): string {
  const lines: string[] = [];
  lines.push(`<!-- autocontext:pack:meta -->`);
  lines.push(
    `<!-- seed=${pack.seed.kind} value=${JSON.stringify(pack.seed.value)} budget=${pack.budget} used=${pack.used_tokens} scopes=${pack.scopes.length} considered=${pack.metadata.n_scopes_considered} -->`,
  );
  if (pack.root) {
    lines.push("");
    lines.push(`<!-- autocontext:section:root -->`);
    lines.push(`# ${pack.root.scope === "." ? "(root)" : pack.root.scope}`);
    lines.push("");
    lines.push(pack.root.summary);
  }
  if (pack.scopes.length > 0) {
    lines.push("");
    lines.push(`<!-- autocontext:section:scopes -->`);
    for (const s of pack.scopes) {
      lines.push("");
      lines.push(s.rendered);
    }
  }
  if (pack.warnings.length > 0) {
    lines.push("");
    lines.push(`<!-- autocontext:section:warnings -->`);
    for (const w of pack.warnings) lines.push(`> \u26a0 ${w}`);
  }
  return lines.join("\n");
}

export function formatPackJson(pack: Pack): string {
  return JSON.stringify(pack, null, 2);
}
