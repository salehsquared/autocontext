import { readdir, stat, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { CONTEXT_FILENAME, CONFIG_FILENAME } from "./schema.js";

// Directories always ignored
const ALWAYS_IGNORE = new Set([
  "node_modules",
  ".git",
  ".autocontext",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  "target",       // Rust/Java
  "vendor",       // Go/PHP/Ruby
  "obj",          // C#/.NET
  "_build",       // Elixir/C
  "Pods",         // iOS CocoaPods
  "bower_components",
  ".cache",
  "coverage",
  ".turbo",
  ".vercel",
  ".svelte-kit",
  "_site",        // Jekyll/static site generators
  "storybook-static",
  "tmp",
  "temp",
]);

// File extensions considered "source code"
const SOURCE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".pyi",
  ".rs",
  ".go",
  ".java", ".kt", ".kts",
  ".c", ".cpp", ".cc", ".h", ".hpp",
  ".cs",
  ".rb",
  ".php",
  ".swift",
  ".scala",
  ".ex", ".exs",
  ".hs",
  ".lua",
  ".r", ".R",
  ".sql",
  ".sh", ".bash", ".zsh",
  ".yaml", ".yml", ".json", ".toml", ".xml", ".html", ".css", ".scss",
  ".md", ".mdx", ".txt", ".rst",
  ".vue", ".svelte",
  ".tf", ".hcl",
  ".dockerfile",
  ".graphql", ".gql",
  ".proto",
]);

// Config/project files that count as meaningful even without a source extension
const MEANINGFUL_FILES = new Set([
  "Dockerfile",
  "docker-compose.yaml",
  "docker-compose.yml",
  "Makefile",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "Gemfile",
  "Rakefile",
  "CMakeLists.txt",
]);

export interface ScanResult {
  /** Absolute path to the directory */
  path: string;
  /** Relative path from project root */
  relativePath: string;
  /** Source files found directly in this directory */
  files: string[];
  /** Whether a .context.yaml already exists */
  hasContext: boolean;
  /** Child directories that also qualify */
  children: ScanResult[];
}

export interface ScanOptions {
  maxDepth?: number;
  extraIgnore?: string[];
}

/**
 * Scan a project directory tree and find all directories that should
 * have .context.yaml files. Returns a tree of ScanResults.
 */
export async function scanProject(
  rootPath: string,
  options: ScanOptions = {},
): Promise<ScanResult> {
  const gitignorePatterns = await loadGitignore(rootPath);
  const contextIgnorePatterns = await loadContextIgnore(rootPath);
  const allIgnore = [
    ...gitignorePatterns,
    ...contextIgnorePatterns,
    ...(options.extraIgnore ?? []),
  ];

  return scanDir(rootPath, rootPath, 0, options.maxDepth ?? 10, allIgnore);
}

async function scanDir(
  dirPath: string,
  rootPath: string,
  depth: number,
  maxDepth: number,
  ignorePatterns: string[],
): Promise<ScanResult> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const relPath = relative(rootPath, dirPath) || ".";

  const files: string[] = [];
  const childDirs: ScanResult[] = [];
  let hasContext = false;

  for (const entry of entries) {
    if (entry.name === CONTEXT_FILENAME) {
      hasContext = true;
      continue;
    }

    if (entry.name === CONFIG_FILENAME) continue;

    if (entry.isDirectory()) {
      const entryRelativePath = relPath === "."
        ? entry.name
        : `${relPath}/${entry.name}`;

      if (ALWAYS_IGNORE.has(entry.name)) continue;
      if (entry.name.startsWith(".") && entry.name !== ".") continue;
      if (isIgnored(entryRelativePath, ignorePatterns)) continue;

      if (depth < maxDepth) {
        const childResult = await scanDir(
          join(dirPath, entry.name),
          rootPath,
          depth + 1,
          maxDepth,
          ignorePatterns,
        );
        // Include child if it has files or meaningful children
        if (childResult.files.length > 0 || childResult.children.length > 0) {
          childDirs.push(childResult);
        }
      }
    } else if (entry.isFile()) {
      if (isSourceFile(entry.name)) {
        files.push(entry.name);
      }
    }
  }

  files.sort();

  return {
    path: dirPath,
    relativePath: relPath,
    files,
    hasContext,
    children: childDirs,
  };
}

function isSourceFile(filename: string): boolean {
  if (MEANINGFUL_FILES.has(filename)) return true;
  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex === -1) return false;
  return SOURCE_EXTENSIONS.has(filename.substring(dotIndex).toLowerCase());
}

function isIgnored(relativeDirPath: string, patterns: string[]): boolean {
  const normalizedPath = normalizePath(relativeDirPath);
  const segments = normalizedPath.split("/").filter(Boolean);

  let ignored = false;

  for (const rawPattern of patterns) {
    if (!rawPattern) continue;

    const negated = rawPattern.startsWith("!");
    const pattern = normalizePattern(negated ? rawPattern.slice(1) : rawPattern);
    if (!pattern) continue;

    const matched = matchPattern(normalizedPath, segments, pattern);
    if (matched) {
      ignored = !negated;
    }
  }

  return ignored;
}

function normalizePath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/$/, "");
}

function normalizePattern(pattern: string): string {
  return normalizePath(pattern.trim()).replace(/^\//, "");
}

function matchPattern(path: string, segments: string[], pattern: string): boolean {
  // Path pattern (e.g. src/generated, packages/*/dist)
  if (pattern.includes("/")) {
    return globPathRegex(pattern).test(path);
  }

  // Segment pattern (e.g. dist, *.cache) should match any segment.
  const segmentRegex = globSegmentRegex(pattern);
  return segments.some((segment) => segmentRegex.test(segment));
}

function globSegmentRegex(pattern: string): RegExp {
  return new RegExp(`^${globToRegexBody(pattern, false)}$`);
}

function globPathRegex(pattern: string): RegExp {
  return new RegExp(`^${globToRegexBody(pattern, true)}$`);
}

function globToRegexBody(pattern: string, allowPathSeparators: boolean): string {
  let out = "";

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];

    if (char === "*") {
      const isDoubleStar = pattern[index + 1] === "*";
      if (isDoubleStar && allowPathSeparators) {
        out += ".*";
        index += 1;
      } else {
        out += "[^/]*";
      }
      continue;
    }

    if (char === "?") {
      out += "[^/]";
      continue;
    }

    if ("\\^$+?.()|{}[]".includes(char)) {
      out += `\\${char}`;
      continue;
    }

    out += char;
  }

  return out;
}

async function loadGitignore(rootPath: string): Promise<string[]> {
  try {
    const content = await readFile(join(rootPath, ".gitignore"), "utf-8");
    return parseIgnoreFile(content);
  } catch {
    return [];
  }
}

async function loadContextIgnore(rootPath: string): Promise<string[]> {
  try {
    const content = await readFile(join(rootPath, ".contextignore"), "utf-8");
    return parseIgnoreFile(content);
  } catch {
    return [];
  }
}

function parseIgnoreFile(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

/**
 * Group a ScanResult tree by depth, deepest-first (bottom-up).
 * Within each layer, all directories are siblings — no parent-child dependencies.
 * Safe for parallel processing within each layer.
 */
export function groupByDepth(root: ScanResult): ScanResult[][] {
  const groups = new Map<number, ScanResult[]>();

  function walk(node: ScanResult, depth: number) {
    const group = groups.get(depth) ?? [];
    group.push(node);
    groups.set(depth, group);
    for (const child of node.children) {
      walk(child, depth + 1);
    }
  }

  walk(root, 0);

  if (groups.size === 0) return [];

  const maxDepth = Math.max(...groups.keys());
  const result: ScanResult[][] = [];
  for (let d = maxDepth; d >= 0; d--) {
    if (groups.has(d)) result.push(groups.get(d)!);
  }
  return result;
}

/**
 * Flatten a ScanResult tree into a list, bottom-up order
 * (children before parents, for generation ordering).
 */
export function flattenBottomUp(result: ScanResult): ScanResult[] {
  const flat: ScanResult[] = [];

  function walk(node: ScanResult) {
    for (const child of node.children) {
      walk(child);
    }
    flat.push(node);
  }

  walk(result);
  return flat;
}
