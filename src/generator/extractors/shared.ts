import { readFile, stat } from "node:fs/promises";

/** Return file contents, or `null` if the file is missing / unreadable. */
export async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** True iff `stat()` succeeds — presence check that never throws. */
export async function statIfExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Strip comments that could contain false-positive extractor signals.
 *  Handles `/* ... *\/`, `//`, and `#` comments. Keeps string literals
 *  intact — the extractors apply their own line-level guards. */
export function stripComments(content: string, ext: string): string {
  const lang = languageClass(ext);
  let out = content;
  if (lang === "c-like") {
    out = out.replace(/\/\*[\s\S]*?\*\//g, "");
    out = out.replace(/(^|[^:])\/\/.*$/gm, "$1");
  } else if (lang === "python") {
    out = out.replace(/(^|[^$])#.*$/gm, "$1");
  }
  return out;
}

function languageClass(ext: string): "c-like" | "python" | "other" {
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".go", ".rs"].includes(ext)) {
    return "c-like";
  }
  if (ext === ".py" || ext === ".pyi") return "python";
  return "other";
}
