import { join } from "node:path";
import type { ScanResult } from "../../core/scanner.js";
import { readIfExists, statIfExists } from "./shared.js";

const MAX_ENTRIES = 30;

/** List of config filenames we recognize. Each entry may carry a cheap
 *  fact-extractor that runs only when the file is present. */
interface Candidate {
  filename: string | RegExp;
  fact?: (content: string) => string | null;
}

const CANDIDATES: Candidate[] = [
  { filename: "tsconfig.json", fact: tsconfigFact },
  { filename: /^tsconfig\..+\.json$/, fact: tsconfigFact },
  { filename: "vite.config.ts" },
  { filename: "vite.config.js" },
  { filename: "vite.config.mjs" },
  { filename: "webpack.config.ts" },
  { filename: "webpack.config.js" },
  { filename: "webpack.config.cjs" },
  { filename: "webpack.config.mjs" },
  { filename: "rollup.config.ts" },
  { filename: "rollup.config.js" },
  { filename: "rollup.config.mjs" },
  { filename: "esbuild.config.ts" },
  { filename: "esbuild.config.js" },
  { filename: "esbuild.config.mjs" },
  { filename: "tsup.config.ts" },
  { filename: "tsup.config.js" },
  { filename: ".eslintrc" },
  { filename: ".eslintrc.json" },
  { filename: ".eslintrc.yaml" },
  { filename: ".eslintrc.yml" },
  { filename: ".eslintrc.js" },
  { filename: ".eslintrc.cjs" },
  { filename: "eslint.config.js" },
  { filename: "eslint.config.mjs" },
  { filename: "eslint.config.cjs" },
  { filename: ".prettierrc" },
  { filename: ".prettierrc.json" },
  { filename: ".prettierrc.yaml" },
  { filename: ".prettierrc.yml" },
  { filename: ".prettierrc.js" },
  { filename: "prettier.config.js" },
  { filename: "prettier.config.cjs" },
  { filename: ".editorconfig" },
  { filename: "Dockerfile" },
  { filename: /^Dockerfile\..+$/ },
  { filename: "docker-compose.yml" },
  { filename: "docker-compose.yaml" },
  { filename: "compose.yml" },
  { filename: "compose.yaml" },
  { filename: "Makefile" },
  { filename: "GNUmakefile" },
  { filename: "turbo.json" },
  { filename: "nx.json" },
  { filename: "pnpm-workspace.yaml" },
  { filename: "lerna.json" },
  { filename: ".nvmrc", fact: (c) => `(node: ${c.split("\n")[0].trim()})` },
  { filename: ".tool-versions" },
  { filename: ".python-version", fact: (c) => `(python: ${c.split("\n")[0].trim()})` },
  { filename: "pyproject.toml" },
  { filename: "Cargo.toml" },
  { filename: "go.mod" },
  { filename: ".gitignore" },
  { filename: ".contextignore" },
  { filename: "biome.json" },
  { filename: "biome.jsonc" },
  { filename: "deno.json" },
  { filename: "deno.jsonc" },
  { filename: "svelte.config.js" },
  { filename: "svelte.config.ts" },
  { filename: "next.config.js" },
  { filename: "next.config.mjs" },
  { filename: "next.config.ts" },
  { filename: "nuxt.config.ts" },
  { filename: "nuxt.config.js" },
  { filename: "astro.config.mjs" },
  { filename: "astro.config.ts" },
  { filename: "astro.config.js" },
  { filename: "remix.config.js" },
  { filename: "tailwind.config.ts" },
  { filename: "tailwind.config.js" },
  { filename: "tailwind.config.cjs" },
  { filename: "tailwind.config.mjs" },
  { filename: "postcss.config.js" },
  { filename: "postcss.config.cjs" },
  { filename: "postcss.config.mjs" },
];

const LOCKFILES = [
  "bun.lockb",
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
];

export async function extractConfig(scanResult: ScanResult): Promise<string[]> {
  const out = new Set<string>();

  // Lockfile → explicit "Lockfile: <name>".
  for (const lf of LOCKFILES) {
    if (await statIfExists(join(scanResult.path, lf))) {
      out.add(`Lockfile: ${lf}`);
    }
  }

  // Fixed-name candidates.
  for (const cand of CANDIDATES) {
    if (typeof cand.filename !== "string") continue;
    const full = join(scanResult.path, cand.filename);
    if (!(await statIfExists(full))) continue;
    const fact = cand.fact ? await applyFact(full, cand.fact) : null;
    out.add(fact ? `${cand.filename} ${fact}` : cand.filename);
  }

  // Regex candidates — walk known files from the scan result only.
  for (const cand of CANDIDATES) {
    if (typeof cand.filename === "string") continue;
    const re = cand.filename;
    for (const filename of scanResult.files) {
      if (!re.test(filename)) continue;
      const full = join(scanResult.path, filename);
      const fact = cand.fact ? await applyFact(full, cand.fact) : null;
      out.add(fact ? `${filename} ${fact}` : filename);
    }
  }

  return [...out].sort().slice(0, MAX_ENTRIES);
}

async function applyFact(
  path: string,
  fact: (content: string) => string | null,
): Promise<string | null> {
  const raw = await readIfExists(path);
  if (!raw) return null;
  try {
    return fact(raw);
  } catch {
    return null;
  }
}

function tsconfigFact(content: string): string | null {
  try {
    const parsed = JSON.parse(stripJsonComments(content));
    const strict = parsed?.compilerOptions?.strict;
    if (typeof strict === "boolean") {
      return `(strict: ${strict ? "true" : "false"})`;
    }
    return null;
  } catch {
    return null;
  }
}

// tsconfig.json frequently has JSONC comments.
function stripJsonComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}
