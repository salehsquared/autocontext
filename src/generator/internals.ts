import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { detectAllTopLevelAST, detectExportsAST } from "./ast.js";
import type { ScanResult } from "../core/scanner.js";
import type { InternalEntry } from "../core/schema.js";

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs"];
const MAX_INTERNALS = 20;

/**
 * Detect non-exported top-level declarations using tree-sitter.
 * AST-only — no regex fallback. If tree-sitter is unavailable for a file, it's skipped.
 * Skips .d.ts files (declaration files have no internals).
 *
 * Approach: detectAllTopLevelAST (all decls) - detectExportsAST (exported decls) = internals
 */
export async function detectInternals(scanResult: ScanResult): Promise<InternalEntry[]> {
  const entries: InternalEntry[] = [];

  for (const filename of scanResult.files) {
    // Skip .d.ts declaration files
    if (filename.endsWith(".d.ts")) continue;

    const ext = extname(filename).toLowerCase();
    if (!SOURCE_EXTENSIONS.includes(ext)) continue;

    let content: string;
    try {
      content = await readFile(join(scanResult.path, filename), "utf-8");
    } catch {
      continue;
    }

    // Get ALL top-level declarations via tree-sitter
    const allDecls = await detectAllTopLevelAST(content, ext);
    if (!allDecls || allDecls.length === 0) continue;

    // Get exported names via tree-sitter
    const exports = await detectExportsAST(content, ext);
    const exportSet = new Set(exports ?? []);

    // Internals = all - exports
    for (const decl of allDecls) {
      if (exportSet.has(decl.name)) continue;

      entries.push({
        name: decl.name,
        kind: decl.kind as InternalEntry["kind"],
        file: filename,
      });
    }
  }

  // Sort by (file, appearance order within file)
  // Since we iterate files in order and declarations appear in order from tree-sitter,
  // the entries are already in (file, appearance) order. Just cap.
  return entries.slice(0, MAX_INTERNALS);
}
