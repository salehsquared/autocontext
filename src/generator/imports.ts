import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import type { ScanResult } from "../core/scanner.js";
import type { ImportEntry } from "../core/schema.js";

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".py", ".rs"];
const JS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];
const MAX_IMPORTS = 20;

/**
 * Detect symbol-level import bindings from relative imports in source files.
 * Merges symbols across files importing the same path.
 * Returns sorted, deduplicated entries. Cap at 20 (aligned with dependencies.internal).
 */
export async function detectImportBindings(scanResult: ScanResult): Promise<ImportEntry[]> {
  // path -> Set<symbol>
  const bindings = new Map<string, Set<string>>();

  for (const filename of scanResult.files) {
    const ext = extname(filename).toLowerCase();
    if (!SOURCE_EXTENSIONS.includes(ext)) continue;

    let content: string;
    try {
      content = await readFile(join(scanResult.path, filename), "utf-8");
    } catch {
      continue;
    }

    // Strip comments to avoid matching import-like patterns in documentation
    const stripped = stripComments(content, ext);

    if (JS_EXTENSIONS.includes(ext)) {
      extractJSImports(stripped, bindings);
    } else if (ext === ".py") {
      extractPythonImports(stripped, bindings);
    } else if (ext === ".rs") {
      extractRustImports(stripped, bindings);
    }
  }

  // Build sorted entries
  const entries: ImportEntry[] = [];
  for (const [path, symbols] of bindings) {
    entries.push({
      path,
      symbols: [...symbols].sort(),
    });
  }

  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries.slice(0, MAX_IMPORTS);
}

function addBinding(bindings: Map<string, Set<string>>, path: string, symbol: string): void {
  let set = bindings.get(path);
  if (!set) {
    set = new Set();
    bindings.set(path, set);
  }
  set.add(symbol);
}

// --- JS/TS extraction ---

function extractJSImports(content: string, bindings: Map<string, Set<string>>): void {
  // Named imports: import { A, B } from "./path"
  // Also handles: import type { A } from "./path"
  //               import { type A, B } from "./path"
  const namedRe = /import\s+(?:type\s+)?{([^}]*)}\s+from\s+["'](\.[^"']+)["']/gs;
  for (const match of content.matchAll(namedRe)) {
    const path = match[2];
    parseNamedSymbols(match[1], bindings, path);
  }

  // Combined default + named: import Foo, { A, B } from "./path"
  const combinedRe = /import\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*,\s*{([^}]*)}\s+from\s+["'](\.[^"']+)["']/gs;
  for (const match of content.matchAll(combinedRe)) {
    if (match[1] === "type") continue;
    addBinding(bindings, match[3], `default as ${match[1]}`);
    parseNamedSymbols(match[2], bindings, match[3]);
  }

  // Default import: import Foo from "./path"
  const defaultRe = /import\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s+from\s+["'](\.[^"']+)["']/g;
  for (const match of content.matchAll(defaultRe)) {
    // Skip if "type" keyword matched as default name
    if (match[1] === "type") continue;
    addBinding(bindings, match[2], `default as ${match[1]}`);
  }

  // Namespace import: import * as Foo from "./path"
  const nsRe = /import\s+\*\s+as\s+(\w+)\s+from\s+["'](\.[^"']+)["']/g;
  for (const match of content.matchAll(nsRe)) {
    addBinding(bindings, match[2], `* as ${match[1]}`);
  }

  // Side-effect import: import "./path" (semicolon optional for no-semicolon styles)
  const sideEffectRe = /import\s+["'](\.[^"']+)["']\s*;?/g;
  for (const match of content.matchAll(sideEffectRe)) {
    addBinding(bindings, match[1], "(side-effect)");
  }

  // Re-export: export { A, B } from "./path"
  const reExportRe = /export\s+{([^}]*)}\s+from\s+["'](\.[^"']+)["']/gs;
  for (const match of content.matchAll(reExportRe)) {
    parseNamedSymbols(match[1], bindings, match[2]);
  }

  // CJS destructured require: const { A, B } = require("./path")
  const cjsRe = /(?:const|let|var)\s+{([^}]*)}\s*=\s*require\(["'](\.[^"']+)["']\)/gs;
  for (const match of content.matchAll(cjsRe)) {
    parseNamedSymbols(match[1], bindings, match[2]);
  }

  // CJS default require: const Foo = require("./path")
  const cjsDefaultRe = /(?:const|let|var)\s+(\w+)\s*=\s*require\(["'](\.[^"']+)["']\)/g;
  for (const match of content.matchAll(cjsDefaultRe)) {
    // Only if not already captured by destructured require
    if (!match[0].includes("{")) {
      addBinding(bindings, match[2], `default as ${match[1]}`);
    }
  }
}

function parseNamedSymbols(clause: string, bindings: Map<string, Set<string>>, path: string): void {
  const parts = clause.split(",");
  for (const part of parts) {
    const trimmed = part.trim().replace(/^type\s+/, "");
    if (!trimmed) continue;

    // Handle "A as B" aliases
    const aliasMatch = trimmed.match(/^(\w+)\s+as\s+(\w+)$/);
    if (aliasMatch) {
      addBinding(bindings, path, `${aliasMatch[1]} as ${aliasMatch[2]}`);
    } else {
      const nameMatch = trimmed.match(/^(\w+)$/);
      if (nameMatch) {
        addBinding(bindings, path, nameMatch[1]);
      }
    }
  }
}

// --- Python extraction ---

function extractPythonImports(content: string, bindings: Map<string, Set<string>>): void {
  // Parenthesized multi-line: from .module import (\n  A,\n  B\n)
  const pyMultiRe = /from\s+(\.[a-zA-Z0-9_.]+)\s+import\s+\(([\s\S]*?)\)/g;
  for (const match of content.matchAll(pyMultiRe)) {
    parsePythonSymbols(match[1], match[2], bindings);
  }

  // Single-line: from .module import A, B, C  /  from .module import *
  const pyRe = /from\s+(\.[a-zA-Z0-9_.]+)\s+import\s+([^(\n].*)$/gm;
  for (const match of content.matchAll(pyRe)) {
    parsePythonSymbols(match[1], match[2], bindings);
  }
}

function parsePythonSymbols(path: string, clause: string, bindings: Map<string, Set<string>>): void {
  const importClause = clause.trim();

  if (importClause === "*") {
    addBinding(bindings, path, "*");
    return;
  }

  const parts = importClause.split(",");
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    const aliasMatch = trimmed.match(/^(\w+)\s+as\s+(\w+)$/);
    if (aliasMatch) {
      addBinding(bindings, path, `${aliasMatch[1]} as ${aliasMatch[2]}`);
    } else {
      const nameMatch = trimmed.match(/^(\w+)$/);
      if (nameMatch) {
        addBinding(bindings, path, nameMatch[1]);
      }
    }
  }
}

// --- Rust extraction ---

function extractRustImports(content: string, bindings: Map<string, Set<string>>): void {
  // use crate::module::{A, B}
  const groupRe = /use\s+crate::([a-zA-Z0-9_]+)::\{([^}]*)\}/gs;
  for (const match of content.matchAll(groupRe)) {
    const path = `crate::${match[1]}`;
    const parts = match[2].split(",");
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;

      const aliasMatch = trimmed.match(/^(\w+)\s+as\s+(\w+)$/);
      if (aliasMatch) {
        addBinding(bindings, path, `${aliasMatch[1]} as ${aliasMatch[2]}`);
      } else if (/^\w+$/.test(trimmed)) {
        addBinding(bindings, path, trimmed);
      }
    }
  }

  // use crate::module::Item (single import)
  const singleRe = /use\s+crate::([a-zA-Z0-9_]+)::([A-Za-z0-9_]+)\s*;/g;
  for (const match of content.matchAll(singleRe)) {
    const path = `crate::${match[1]}`;
    addBinding(bindings, path, match[2]);
  }

  // use crate::module (bare module import, no specific item)
  const bareRe = /use\s+crate::([a-zA-Z0-9_]+)\s*;/g;
  for (const match of content.matchAll(bareRe)) {
    addBinding(bindings, `crate::${match[1]}`, "(module)");
  }
}

// --- Comment stripping ---

function stripComments(content: string, ext: string): string {
  if ([".ts", ".tsx", ".js", ".jsx"].includes(ext)) {
    // Remove block comments (/* ... */), then line comments (// ...)
    return content
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
  }
  if (ext === ".py") {
    // Remove # line comments (leave string contents, good enough for imports)
    return content.replace(/#.*$/gm, "");
  }
  if (ext === ".rs") {
    // Remove block comments (/* ... */), then line comments (// ...)
    return content
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
  }
  return content;
}
