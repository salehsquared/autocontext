import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { AUTOCONTEXT_DIR } from "../index/paths.js";

const ENTRY = `${AUTOCONTEXT_DIR}/`;

export type EnsureResult =
  | { action: "no-gitignore" }
  | { action: "already-present" }
  | { action: "appended" };

/**
 * Idempotently ensure `.autocontext/` is gitignored at `rootPath/.gitignore`.
 *
 * - If the project has no `.gitignore`, we do NOT create one. Respects the
 *   zero-setup promise; init will emit a one-line notice so the user knows
 *   to add it themselves if/when they git-init.
 * - Otherwise we append a single entry if it isn't already listed.
 */
export async function ensureAutocontextGitignored(
  rootPath: string,
): Promise<EnsureResult> {
  const gitignore = join(rootPath, ".gitignore");
  if (!existsSync(gitignore)) return { action: "no-gitignore" };

  const raw = await readFile(gitignore, "utf8");
  if (hasAutocontextEntry(raw)) return { action: "already-present" };

  const prefix = raw.length > 0 && !raw.endsWith("\n") ? "\n" : "";
  await writeFile(gitignore, `${raw}${prefix}${ENTRY}\n`);
  return { action: "appended" };
}

/**
 * Pure predicate — does the given .gitignore content already match `.autocontext`?
 * Exported so `context doctor` can verify without touching the filesystem.
 */
export function hasAutocontextEntry(gitignoreContent: string): boolean {
  for (const rawLine of gitignoreContent.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const normalized = line.replace(/\/+$/, "");
    if (
      normalized === AUTOCONTEXT_DIR ||
      normalized === `/${AUTOCONTEXT_DIR}`
    ) {
      return true;
    }
  }
  return false;
}
