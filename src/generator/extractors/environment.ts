import { extname, join } from "node:path";
import type { ScanResult } from "../../core/scanner.js";
import { readIfExists, stripComments } from "./shared.js";

const ENV_NAME_RE = /^[A-Z][A-Z0-9_]*$/;
const SKIP_COMMON = new Set([
  "PATH",
  "HOME",
  "PWD",
  "USER",
  "SHELL",
  "TERM",
  "LANG",
  "TMPDIR",
]);
const MAX_ENTRIES = 50;

const JS_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

const JS_PATTERNS: RegExp[] = [
  /\bprocess\.env\.([A-Z][A-Z0-9_]*)\b/g,
  /\bprocess\.env\[["']([A-Z][A-Z0-9_]*)["']\]/g,
  /\bimport\.meta\.env\.([A-Z][A-Z0-9_]*)\b/g,
  /\bBun\.env\.([A-Z][A-Z0-9_]*)\b/g,
  /\bDeno\.env\.get\(["']([A-Z][A-Z0-9_]*)["']\)/g,
];

const PY_PATTERNS: RegExp[] = [
  /\bos\.environ\[["']([A-Z][A-Z0-9_]*)["']\]/g,
  /\bos\.environ\.get\(["']([A-Z][A-Z0-9_]*)["'](?:\s*,[^)]*)?\)/g,
  /\bos\.getenv\(["']([A-Z][A-Z0-9_]*)["'](?:\s*,[^)]*)?\)/g,
];

const GO_PATTERNS: RegExp[] = [
  /\bos\.Getenv\(["']([A-Z][A-Z0-9_]*)["']\)/g,
  /\bos\.LookupEnv\(["']([A-Z][A-Z0-9_]*)["']\)/g,
];

const RUST_PATTERNS: RegExp[] = [
  /\bstd::env::var\(["']([A-Z][A-Z0-9_]*)["']\)/g,
  /\benv!\(["']([A-Z][A-Z0-9_]*)["']\)/g,
];

const TEST_FILE_RE = /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs)$/;

/**
 * Scan a directory's source files for environment-variable references.
 * Returns sorted, deduped, trimmed list of names (no values). Test files are
 * excluded — tests commonly poke env vars the production code doesn't care
 * about.
 */
export async function extractEnvironment(scanResult: ScanResult): Promise<string[]> {
  const found = new Set<string>();

  for (const filename of scanResult.files) {
    if (TEST_FILE_RE.test(filename)) continue;
    const ext = extname(filename).toLowerCase();
    const patterns = patternsFor(ext);
    if (patterns.length === 0) continue;
    const raw = await readIfExists(join(scanResult.path, filename));
    if (!raw) continue;
    const stripped = stripComments(raw, ext);
    for (const re of patterns) {
      for (const m of stripped.matchAll(re)) {
        const name = m[1];
        if (accept(name)) found.add(name);
      }
    }
  }

  // .env.example / .env.template probe — authoritative signal.
  for (const name of ["/.env.example", "/.env.template"]) {
    const raw = await readIfExists(scanResult.path + name);
    if (!raw) continue;
    for (const line of raw.split(/\r?\n/)) {
      const clean = line.replace(/#.*$/, "").trim();
      const eq = clean.indexOf("=");
      if (eq <= 0) continue;
      const key = clean.slice(0, eq).trim();
      if (accept(key)) found.add(key);
    }
  }

  return [...found].sort().slice(0, MAX_ENTRIES);
}

function patternsFor(ext: string): RegExp[] {
  if (JS_EXT.has(ext)) return JS_PATTERNS;
  if (ext === ".py" || ext === ".pyi") return PY_PATTERNS;
  if (ext === ".go") return GO_PATTERNS;
  if (ext === ".rs") return RUST_PATTERNS;
  return [];
}

function accept(name: string): boolean {
  if (!ENV_NAME_RE.test(name)) return false;
  if (name.length < 2 || name.length > 64) return false;
  if (SKIP_COMMON.has(name)) return false;
  return true;
}
