import { join } from "node:path";
import type { ScanResult } from "../../core/scanner.js";
import { readIfExists, statIfExists } from "./shared.js";

const MAX_ENTRIES = 15;

/**
 * Detect test-related facts at a given scope. At non-root scopes we only emit
 * what's locally discoverable (colocated test files, `tests/` subdir) —
 * root-level `Framework: vitest` is noise in every nested directory.
 */
export async function extractTesting(scanResult: ScanResult): Promise<string[]> {
  const out = new Set<string>();
  await collectFromPackageJson(scanResult, out);
  await collectFromPython(scanResult, out);
  await collectFromGo(scanResult, out);
  await collectFromRust(scanResult, out);
  await collectConventions(scanResult, out);
  return [...out].sort().slice(0, MAX_ENTRIES);
}

async function collectFromPackageJson(scan: ScanResult, out: Set<string>): Promise<void> {
  const pkgPath = join(scan.path, "package.json");
  const raw = await readIfExists(pkgPath);
  if (!raw) return;
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return;
  }

  const deps = {
    ...((pkg.dependencies as Record<string, string> | undefined) ?? {}),
    ...((pkg.devDependencies as Record<string, string> | undefined) ?? {}),
  };
  const detect = (name: string, label: string) => {
    if (name in deps) out.add(`Framework: ${label}`);
  };
  detect("vitest", "vitest");
  detect("jest", "jest");
  detect("mocha", "mocha");
  detect("ava", "ava");
  detect("@playwright/test", "playwright");
  detect("cypress", "cypress");

  const pm = await detectPackageManager(scan.path);
  const scripts = (pkg.scripts as Record<string, string> | undefined) ?? {};
  let count = 0;
  for (const key of Object.keys(scripts).sort()) {
    if (!/^(test|tests?(?::[a-z0-9-]+)?|e2e|coverage|check|typecheck|lint)$/.test(key)) continue;
    const command = key === "test" ? `${pm} test` : `${pm} run ${key}`;
    out.add(`Command: ${command}`);
    if (++count >= 6) break;
  }

  for (const fname of [
    "vitest.config.ts",
    "vitest.config.js",
    "vitest.config.mjs",
    "jest.config.ts",
    "jest.config.js",
    "jest.config.mjs",
    "jest.config.cjs",
    "jest.config.json",
    "playwright.config.ts",
    "playwright.config.js",
  ]) {
    if (await statIfExists(join(scan.path, fname))) out.add(`Config: ${fname}`);
  }
}

async function detectPackageManager(dir: string): Promise<string> {
  if (await statIfExists(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (await statIfExists(join(dir, "yarn.lock"))) return "yarn";
  if (await statIfExists(join(dir, "bun.lockb"))) return "bun";
  return "npm";
}

async function collectFromPython(scan: ScanResult, out: Set<string>): Promise<void> {
  if (await statIfExists(join(scan.path, "pytest.ini"))) {
    out.add("Framework: pytest");
    out.add("Config: pytest.ini");
  }
  const pyproject = await readIfExists(join(scan.path, "pyproject.toml"));
  if (pyproject && /\[tool\.pytest\.ini_options\]/.test(pyproject)) {
    out.add("Framework: pytest");
    out.add("Config: pyproject.toml [tool.pytest]");
  }
  if (pyproject && /"pytest"/.test(pyproject)) {
    out.add("Framework: pytest");
  }
  if (await statIfExists(join(scan.path, "tox.ini"))) {
    out.add("Runner: tox");
  }
  const hasUnittestLike = scan.files.some((f) => /^test_.+\.py$|_test\.py$/.test(f));
  if (hasUnittestLike && ![...out].some((x) => x.startsWith("Framework:"))) {
    out.add("Framework: unittest (inferred)");
  }
}

async function collectFromGo(scan: ScanResult, out: Set<string>): Promise<void> {
  if (await statIfExists(join(scan.path, "go.mod"))) {
    out.add("Runner: go test ./...");
  }
  if (scan.files.some((f) => /_test\.go$/.test(f))) {
    out.add("Conventions: *_test.go colocated");
  }
}

async function collectFromRust(scan: ScanResult, out: Set<string>): Promise<void> {
  const cargo = await readIfExists(join(scan.path, "Cargo.toml"));
  if (!cargo) return;
  out.add("Runner: cargo test");
  if (/\[dev-dependencies\][\s\S]*?\bproptest\b/.test(cargo)) {
    out.add("Framework: proptest");
  }
  if (/\[dev-dependencies\][\s\S]*?\bcriterion\b/.test(cargo)) {
    out.add("Runner: criterion (bench)");
  }
}

async function collectConventions(scan: ScanResult, out: Set<string>): Promise<void> {
  if (scan.files.some((f) => /\.(test|spec)\.\w+$/.test(f))) {
    out.add("Conventions: *.test / *.spec colocated");
  }
  for (const child of scan.children) {
    const name = child.relativePath.split("/").pop() ?? "";
    if (name === "tests" || name === "__tests__" || name === "spec") {
      out.add(`Conventions: tests live in ${name}/`);
    }
  }
}
