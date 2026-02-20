import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import type { ScanResult } from "../core/scanner.js";

/**
 * Detect external dependencies from package manifests in a directory.
 * Tries package.json, requirements.txt, Cargo.toml, go.mod in order.
 * Returns first match. No inheritance from parent directories.
 */
export async function detectExternalDeps(dirPath: string): Promise<string[]> {
  // Try package.json
  try {
    const raw = await readFile(join(dirPath, "package.json"), "utf-8");
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    const deps: string[] = [];

    const prodDeps = pkg.dependencies as Record<string, unknown> | undefined;
    if (prodDeps && typeof prodDeps === "object") {
      for (const [name, version] of Object.entries(prodDeps)) {
        if (typeof version === "string") {
          deps.push(`${name} ${version}`);
        } else if (version && typeof version === "object" && "version" in version) {
          deps.push(`${name} ${(version as Record<string, unknown>).version}`);
        } else {
          deps.push(name);
        }
      }
    }

    const devDeps = pkg.devDependencies as Record<string, unknown> | undefined;
    if (devDeps && typeof devDeps === "object") {
      for (const [name, version] of Object.entries(devDeps)) {
        if (typeof version === "string") {
          deps.push(`${name} ${version} (dev)`);
        } else if (version && typeof version === "object" && "version" in version) {
          deps.push(`${name} ${(version as Record<string, unknown>).version} (dev)`);
        } else {
          deps.push(`${name} (dev)`);
        }
      }
    }

    if (deps.length > 0) return deps.slice(0, 30);
  } catch { /* no package.json */ }

  // Try requirements.txt
  try {
    const content = await readFile(join(dirPath, "requirements.txt"), "utf-8");
    const deps: string[] = [];
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      // Parse: package==version, package>=version, package~=version, bare package
      const match = trimmed.match(/^([a-zA-Z0-9_.-]+)\s*([><=!~]+\s*.+)?/);
      if (match) {
        const name = match[1];
        const version = match[2]?.trim();
        deps.push(version ? `${name} ${version}` : name);
      }
    }
    if (deps.length > 0) return deps.slice(0, 30);
  } catch { /* no requirements.txt */ }

  // Try Cargo.toml
  try {
    const content = await readFile(join(dirPath, "Cargo.toml"), "utf-8");
    const deps: string[] = [];
    // Match [dependencies] section until next [section]
    const depSection = content.match(/\[dependencies\]\n([\s\S]*?)(?=\n\[|$)/);
    if (depSection) {
      for (const line of depSection[1].split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        // name = "version" or name = { version = "..." }
        const simple = trimmed.match(/^([a-zA-Z0-9_-]+)\s*=\s*"(.+)"/);
        if (simple) {
          deps.push(`${simple[1]} ${simple[2]}`);
          continue;
        }
        const complex = trimmed.match(/^([a-zA-Z0-9_-]+)\s*=\s*\{.*version\s*=\s*"([^"]+)"/);
        if (complex) {
          deps.push(`${complex[1]} ${complex[2]}`);
        }
      }
    }
    if (deps.length > 0) return deps.slice(0, 30);
  } catch { /* no Cargo.toml */ }

  // Try go.mod
  try {
    const content = await readFile(join(dirPath, "go.mod"), "utf-8");
    const deps: string[] = [];
    // Match require ( ... ) block
    const requireBlock = content.match(/require\s*\(\n([\s\S]*?)\)/);
    if (requireBlock) {
      for (const line of requireBlock[1].split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("//")) continue;
        const match = trimmed.match(/^(\S+)\s+(\S+)/);
        if (match) {
          deps.push(`${match[1]} ${match[2]}`);
        }
      }
    }
    // Also check single-line require (only if no block found)
    if (!requireBlock) {
      const singleRequires = content.matchAll(/^require\s+(\S+)\s+(\S+)/gm);
      for (const match of singleRequires) {
        deps.push(`${match[1]} ${match[2]}`);
      }
    }
    if (deps.length > 0) return deps.slice(0, 30);
  } catch { /* no go.mod */ }

  return [];
}

/**
 * Detect internal dependencies from import statements in source files.
 * Only captures relative imports (starting with ./ or ../).
 * Returns sorted, deduplicated list of import paths. Cap at 20.
 */
export async function detectInternalDeps(scanResult: ScanResult): Promise<string[]> {
  const imports = new Set<string>();

  for (const filename of scanResult.files) {
    const ext = extname(filename).toLowerCase();
    if (![".ts", ".tsx", ".js", ".jsx", ".py", ".rs"].includes(ext)) continue;

    let content: string;
    try {
      content = await readFile(join(scanResult.path, filename), "utf-8");
    } catch {
      continue;
    }

    // Strip comments to avoid matching import-like patterns in documentation
    const stripped = stripDepsComments(content, ext);

    if ([".ts", ".tsx", ".js", ".jsx"].includes(ext)) {
      // ES import: import ... from "./..."
      const esImports = stripped.matchAll(/import\s+(?:[\s\S]*?)\s+from\s+["'](\.[^"']+)["']/g);
      for (const match of esImports) {
        imports.add(match[1]);
      }
      // require("./...")
      const cjsImports = stripped.matchAll(/require\(["'](\.[^"']+)["']\)/g);
      for (const match of cjsImports) {
        imports.add(match[1]);
      }
    } else if (ext === ".py") {
      // from .foo import bar (relative imports only)
      const pyImports = stripped.matchAll(/from\s+(\.[a-zA-Z0-9_.]+)\s+import/g);
      for (const match of pyImports) {
        imports.add(match[1]);
      }
    } else if (ext === ".rs") {
      // use crate::module
      const rsImports = stripped.matchAll(/use\s+crate::([a-zA-Z0-9_]+)/g);
      for (const match of rsImports) {
        imports.add(`crate::${match[1]}`);
      }
    }
  }

  return [...imports].sort().slice(0, 20);
}

function stripDepsComments(content: string, ext: string): string {
  if ([".ts", ".tsx", ".js", ".jsx", ".rs"].includes(ext)) {
    return content
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
  }
  if (ext === ".py") {
    return content.replace(/#.*$/gm, "");
  }
  return content;
}
