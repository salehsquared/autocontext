import { readFile, stat } from "node:fs/promises";
import { join, extname, basename } from "node:path";
import type { ScanResult } from "../core/scanner.js";
import type { ContextFile, FileEntry, SubdirectoryEntry } from "../core/schema.js";
import { SCHEMA_VERSION, DEFAULT_MAINTENANCE, FULL_MAINTENANCE } from "../core/schema.js";
import { computeFingerprint } from "../core/fingerprint.js";
import { detectExportsAST, detectExportSignaturesAST } from "./ast.js";
import { detectExternalDeps, detectInternalDeps } from "./dependencies.js";
import { detectImportBindings } from "./imports.js";
import { detectInternals } from "./internals.js";
import { collectBasicEvidence } from "./evidence.js";

export type SummarySource = "project" | "docstring" | "dirname" | "pattern" | "fallback";

/**
 * Generate a .context.yaml using static analysis only (no LLM).
 * Produces structural context: file listings, detected exports, basic metadata.
 */
export interface StaticContextResult {
  context: ContextFile;
  summarySource: SummarySource;
}

export async function generateStaticContext(
  scanResult: ScanResult,
  childContexts: Map<string, ContextFile>,
  options?: { evidence?: boolean; mode?: "lean" | "full" },
): Promise<StaticContextResult> {
  const mode = options?.mode ?? "lean";
  const isFull = mode === "full";

  // Files: only in full mode
  let files: FileEntry[] | undefined;
  if (isFull) {
    files = [];
    for (const filename of scanResult.files) {
      const purpose = await detectFilePurpose(join(scanResult.path, filename));
      const entry: FileEntry = { name: filename, purpose };
      const testFile = detectTestFile(filename, scanResult);
      if (testFile) entry.test_file = testFile;
      files.push(entry);
    }
  }

  const subdirectories: SubdirectoryEntry[] = [];
  for (const child of scanResult.children) {
    const childCtx = childContexts.get(child.path);
    subdirectories.push({
      name: basename(child.relativePath) + "/",
      summary: childCtx?.summary ?? `Contains ${child.files.length} source files`,
    });
  }

  const fingerprint = await computeFingerprint(scanResult.path);
  const now = new Date().toISOString();

  const isRoot = scanResult.relativePath === ".";

  // Detect project description for root summary
  let projectDescription: string | undefined;
  if (isRoot) {
    const meta = await detectProjectMeta(scanResult.path);
    if (meta?.description) projectDescription = meta.description;
  }

  const { summary, source: summarySource } = await buildSmartSummary(scanResult, isRoot, projectDescription);

  const context: ContextFile = {
    version: SCHEMA_VERSION,
    last_updated: now,
    fingerprint,
    scope: scanResult.relativePath,
    summary,
    maintenance: isFull ? FULL_MAINTENANCE : DEFAULT_MAINTENANCE,
  };

  if (files) {
    context.files = files;
  }

  if (subdirectories.length > 0) {
    context.subdirectories = subdirectories;
  }

  // Extract compact method signatures (both lean and full — high-value routing data)
  const exportSigs = await extractSignatures(scanResult);
  if (exportSigs.length > 0) {
    context.exports = exportSigs;
  }

  // Detect interfaces from exports (full mode only)
  if (isFull) {
    const interfaces = await detectInterfaces(scanResult);
    if (interfaces.length > 0) {
      context.interfaces = interfaces;
    }
  }

  // Detect dependencies (internal always, external full-only)
  const internalDeps = await detectInternalDeps(scanResult);
  const externalDeps = isFull ? await detectExternalDeps(scanResult.path) : [];
  if (externalDeps.length > 0 || internalDeps.length > 0) {
    context.dependencies = {};
    if (externalDeps.length > 0) context.dependencies.external = externalDeps;
    if (internalDeps.length > 0) context.dependencies.internal = internalDeps;
  }

  // Import bindings (both lean and full — high-value routing data)
  const importBindings = await detectImportBindings(scanResult);
  if (importBindings.length > 0) {
    context.imports = importBindings;
  }

  // Internals: non-exported declarations (full mode only)
  if (isFull) {
    const internals = await detectInternals(scanResult);
    if (internals.length > 0) {
      context.internals = internals;
    }
  }

  // Root-level: always add project metadata and structure
  if (isRoot) {
    context.project = (await detectProjectMeta(scanResult.path)) ?? {
      name: basename(scanResult.path) || "unknown",
      description: "Project root",
      language: "unknown",
    };
    context.structure = scanResult.children.map((child) => ({
      path: child.relativePath,
      summary: childContexts.get(child.path)?.summary
        ?? `Contains ${child.files.length} source files`,
    }));
  }

  // Collect evidence (per-directory, opt-in)
  if (options?.evidence) {
    // Compute newest source file mtime for staleness comparison
    let newestMtimeMs: number | undefined;
    for (const filename of scanResult.files) {
      try {
        const s = await stat(join(scanResult.path, filename));
        if (newestMtimeMs === undefined || s.mtimeMs > newestMtimeMs) {
          newestMtimeMs = s.mtimeMs;
        }
      } catch {
        // skip unreadable files
      }
    }
    const evidence = await collectBasicEvidence(scanResult.path, newestMtimeMs);
    if (evidence) context.evidence = evidence;
  }

  // Populate derived_fields
  const derivedFields: string[] = [
    "version", "last_updated", "fingerprint", "scope",
  ];
  if (isFull) {
    derivedFields.push("files");
    if (context.interfaces) derivedFields.push("interfaces");
  }
  if (context.exports) derivedFields.push("exports");
  if (context.dependencies?.external) derivedFields.push("dependencies.external");
  if (context.dependencies?.internal) derivedFields.push("dependencies.internal");
  if (context.imports) derivedFields.push("imports");
  if (context.internals) derivedFields.push("internals");
  if (context.subdirectories) derivedFields.push("subdirectories");
  if (context.project) derivedFields.push("project");
  if (context.structure) derivedFields.push("structure");
  if (context.evidence) derivedFields.push("evidence");
  context.derived_fields = derivedFields;

  return { context, summarySource };
}

// --- Smart summary generation ---

const DIRECTORY_PURPOSES: Record<string, string> = {
  src: "Source code.",
  lib: "Library modules.",
  core: "Core functionality.",
  commands: "CLI command implementations.",
  cmd: "CLI commands.",
  routes: "Route handlers.",
  controllers: "Request controllers.",
  services: "Business logic services.",
  handlers: "Event and request handlers.",
  middleware: "Middleware.",
  resolvers: "GraphQL resolvers.",
  models: "Data models.",
  entities: "Entity definitions.",
  schemas: "Schema definitions.",
  types: "Type definitions.",
  db: "Database layer.",
  migrations: "Database migrations.",
  components: "UI components.",
  views: "View templates.",
  pages: "Page components.",
  layouts: "Layout components.",
  utils: "Utility functions.",
  helpers: "Helper functions.",
  common: "Shared code.",
  config: "Configuration.",
  providers: "Provider implementations.",
  adapters: "Adapter implementations.",
  plugins: "Plugin implementations.",
  tests: "Test suite.",
  test: "Test suite.",
  __tests__: "Test suite.",
  spec: "Test specifications.",
  fixtures: "Test fixtures.",
  docs: "Documentation.",
  api: "API layer.",
  mcp: "MCP server integration.",
  hooks: "Lifecycle hooks.",
  generator: "Code generation.",
  internal: "Internal modules.",
  scripts: "Build and utility scripts.",
  assets: "Static assets.",
  styles: "Stylesheets.",
  i18n: "Internationalization.",
  locales: "Locale files.",
  templates: "Templates.",
  workers: "Background workers.",
  jobs: "Background jobs.",
  tasks: "Task definitions.",
  actions: "Action handlers.",
  reducers: "State reducers.",
  store: "State management.",
  stores: "State management.",
  context: "React context providers.",
  constants: "Constant definitions.",
  enums: "Enum definitions.",
  errors: "Error definitions.",
  exceptions: "Exception definitions.",
  validation: "Validation logic.",
  validators: "Validation logic.",
  auth: "Authentication and authorization.",
  security: "Security utilities.",
  crypto: "Cryptographic utilities.",
};

const ENTRY_FILES = [
  "__init__.py",
  "index.ts", "index.tsx", "index.js", "index.jsx",
  "mod.ts", "mod.rs", "lib.rs",
  "doc.go",
];

export async function buildSmartSummary(
  scanResult: ScanResult,
  isRoot: boolean,
  projectDescription?: string,
): Promise<{ summary: string; source: SummarySource }> {
  // 1. Project description (root only)
  if (isRoot && projectDescription && projectDescription !== "Project root") {
    return { summary: projectDescription, source: "project" };
  }

  // 2. Entry file docstring
  const docstring = await extractEntryDocstring(scanResult.path, scanResult.files);
  if (docstring) {
    return { summary: docstring, source: "docstring" };
  }

  // 3. Directory name heuristic
  const dirName = inferFromDirectoryName(scanResult.relativePath);
  if (dirName) {
    return { summary: dirName, source: "dirname" };
  }

  // 4. File pattern inference
  const pattern = inferFromFilePatterns(scanResult.files);
  if (pattern) {
    return { summary: pattern, source: "pattern" };
  }

  // 5. Minimal fallback
  return { summary: "Source directory.", source: "fallback" };
}

async function extractEntryDocstring(dirPath: string, files: string[]): Promise<string | null> {
  for (const entryFile of ENTRY_FILES) {
    if (!files.includes(entryFile)) continue;

    try {
      const content = await readFile(join(dirPath, entryFile), "utf-8");
      const lines = content.split("\n").slice(0, 30);
      const firstLines = lines.join("\n");

      // Python: """docstring""" or '''docstring'''
      if (entryFile === "__init__.py") {
        const pyMatch = firstLines.match(/^(?:\s*#[^\n]*\n)*\s*(?:"""|''')([\s\S]*?)(?:"""|''')/);
        if (pyMatch) {
          const doc = pyMatch[1].trim().split("\n")[0].trim();
          if (doc.length > 5 && doc.length < 200) return doc;
        }
      }

      // TypeScript/JavaScript: /** JSDoc */
      if (/\.[jt]sx?$/.test(entryFile)) {
        const jsdocMatch = firstLines.match(/\/\*\*\s*\n?\s*\*?\s*(.+?)(?:\n|\*\/)/);
        if (jsdocMatch) {
          const doc = jsdocMatch[1].trim().replace(/\*\/$/, "").trim();
          if (doc.length > 5 && doc.length < 200) return doc;
        }
      }

      // Go: // Package ... comments in doc.go
      if (entryFile === "doc.go") {
        const goMatch = firstLines.match(/\/\/\s*Package\s+\w+\s+(.*)/);
        if (goMatch) {
          const doc = goMatch[1].trim();
          if (doc.length > 5 && doc.length < 200) return doc;
        }
      }

      // Rust: //! module-level doc comments
      if (entryFile === "lib.rs" || entryFile === "mod.rs") {
        const rustLines = lines.filter((l) => l.startsWith("//!"));
        if (rustLines.length > 0) {
          const doc = rustLines[0].replace(/^\/\/!\s*/, "").trim();
          if (doc.length > 5 && doc.length < 200) return doc;
        }
      }
    } catch { /* skip */ }
  }
  return null;
}

function inferFromDirectoryName(relativePath: string): string | null {
  if (relativePath === ".") return null;
  const lastSegment = relativePath.split("/").pop()!.toLowerCase();
  return DIRECTORY_PURPOSES[lastSegment] ?? null;
}

function inferFromFilePatterns(files: string[]): string | null {
  if (files.length === 0) return null;

  const testFiles = files.filter((f) => /\.(test|spec)\.\w+$/.test(f));
  if (testFiles.length > 0 && testFiles.length >= files.length * 0.5) return "Test suite.";

  const cssFiles = files.filter((f) => /\.(css|scss|less|sass)$/.test(f));
  if (cssFiles.length > 0 && cssFiles.length >= files.length * 0.5) return "Stylesheets.";

  const sqlFiles = files.filter((f) => /\.sql$/.test(f));
  if (sqlFiles.length > 0 && sqlFiles.length >= files.length * 0.5) return "SQL scripts.";

  const mdFiles = files.filter((f) => /\.(md|mdx)$/.test(f));
  if (mdFiles.length > 0 && mdFiles.length >= files.length * 0.5) return "Documentation.";

  return null;
}

// --- Signature extraction ---

const SIGNATURE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs"]);

async function extractSignatures(scanResult: ScanResult): Promise<string[]> {
  const signatures: string[] = [];

  for (const filename of scanResult.files) {
    const ext = extname(filename).toLowerCase();
    if (!SIGNATURE_EXTENSIONS.has(ext)) continue;

    try {
      const content = await readFile(join(scanResult.path, filename), "utf-8");

      // Try AST-first for reliable multiline/generic extraction
      const astSigs = await detectExportSignaturesAST(content, ext);
      if (astSigs) {
        for (const { signature } of astSigs) {
          if (!signatures.includes(signature)) signatures.push(signature);
        }
        continue;
      }

      // Regex fallback
      const names = await detectExportsWithFallback(content, ext);
      for (const name of names) {
        const sig = extractOneSignature(content, name, ext);
        if (sig && !signatures.includes(sig)) signatures.push(sig);
      }
    } catch { /* skip */ }
  }

  return signatures.slice(0, 25); // cap to avoid bloat
}

export function extractOneSignature(content: string, name: string, ext: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  if ([".ts", ".tsx", ".js", ".jsx"].includes(ext)) {
    // function declaration: `export [async] function name(params): ReturnType {`
    const funcMatch = content.match(
      new RegExp(`export\\s+(?:default\\s+)?(?:async\\s+)?function\\s+${escapedName}\\s*(<[^>]*>)?\\s*\\([^)]*\\)(?:\\s*:\\s*[^{]+)?`, "m"),
    );
    if (funcMatch) {
      return funcMatch[0]
        .replace(/^export\s+(default\s+)?/, "")
        .replace(/\s+/g, " ")
        .trim();
    }

    // class declaration
    const classMatch = content.match(
      new RegExp(`export\\s+(?:default\\s+)?(?:abstract\\s+)?class\\s+${escapedName}`, "m"),
    );
    if (classMatch) return `class ${name}`;

    // type alias
    const typeMatch = content.match(
      new RegExp(`export\\s+type\\s+${escapedName}`, "m"),
    );
    if (typeMatch) return `type ${name}`;

    // interface
    const ifaceMatch = content.match(
      new RegExp(`export\\s+interface\\s+${escapedName}`, "m"),
    );
    if (ifaceMatch) return `interface ${name}`;

    // const/let
    const constMatch = content.match(
      new RegExp(`export\\s+(?:const|let)\\s+${escapedName}\\s*(?::\\s*([^=]+?))?\\s*=`, "m"),
    );
    if (constMatch && constMatch[1]) return `${name}: ${constMatch[1].trim()}`;

    return name;
  }

  if (ext === ".py") {
    // def name(params) -> ReturnType:
    const defMatch = content.match(
      new RegExp(`^(?:async\\s+)?def\\s+${escapedName}\\s*\\([^)]*\\)(?:\\s*->\\s*[^:]+)?`, "m"),
    );
    if (defMatch) return defMatch[0].trim();

    // class Name
    const classMatch = content.match(
      new RegExp(`^class\\s+${escapedName}`, "m"),
    );
    if (classMatch) return `class ${name}`;

    return name;
  }

  if (ext === ".go") {
    // func (receiver) Name(params) ReturnType {
    const funcMatch = content.match(
      new RegExp(`^func\\s+(?:\\([^)]*\\)\\s+)?${escapedName}\\s*\\([^)]*\\)[^{]*`, "m"),
    );
    if (funcMatch) return funcMatch[0].replace(/\s+/g, " ").trim();

    // type Name ...
    const typeMatch = content.match(
      new RegExp(`^type\\s+${escapedName}\\s+\\w+`, "m"),
    );
    if (typeMatch) return typeMatch[0].trim();

    return name;
  }

  if (ext === ".rs") {
    // pub [async] fn name(params) -> ReturnType {
    const fnMatch = content.match(
      new RegExp(`pub(?:\\s*\\(crate\\))?\\s+(?:async\\s+)?fn\\s+${escapedName}\\s*(?:<[^>]*>)?\\s*\\([^)]*\\)(?:\\s*->\\s*[^{]+)?`, "m"),
    );
    if (fnMatch) {
      return fnMatch[0]
        .replace(/^pub(\s*\(crate\))?\s+/, "")
        .replace(/\s+/g, " ")
        .trim();
    }

    // pub struct/enum/trait Name
    const typeMatch = content.match(
      new RegExp(`pub\\s+(?:struct|enum|trait)\\s+${escapedName}`, "m"),
    );
    if (typeMatch) return typeMatch[0].replace(/^pub\s+/, "").trim();

    return name;
  }

  return name;
}

async function detectFilePurpose(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase();
  const filename = basename(filePath);

  // Known config files
  const knownPurposes: Record<string, string> = {
    "package.json": "Node.js project configuration and dependencies",
    "tsconfig.json": "TypeScript compiler configuration",
    "pyproject.toml": "Python project configuration",
    "Cargo.toml": "Rust project configuration",
    "go.mod": "Go module definition",
    "Dockerfile": "Container build configuration",
    "docker-compose.yaml": "Multi-container orchestration",
    "docker-compose.yml": "Multi-container orchestration",
    "Makefile": "Build automation rules",
    ".gitignore": "Git ignore patterns",
    ".env.example": "Environment variable template",
    "README.md": "Project documentation",
    "LICENSE": "Project license",
  };

  if (knownPurposes[filename]) return knownPurposes[filename];

  // Try to detect from file content for source files
  if ([".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go"].includes(ext)) {
    try {
      const content = await readFile(filePath, "utf-8");
      const firstLines = content.split("\n").slice(0, 10).join("\n");

      // Check for file-level doc comments
      const docMatch = firstLines.match(/^(?:\/\*\*|"""|'''|\/\/\/)\s*\n?\s*(.+)/);
      if (docMatch) {
        return docMatch[1].trim().replace(/\*\/|"""|'''/, "").trim();
      }

      // Detect primary exports (tree-sitter with regex fallback)
      const exports = await detectExportsWithFallback(content, ext);
      if (exports.length > 0) {
        return `Exports: ${exports.slice(0, 3).join(", ")}${exports.length > 3 ? ` (+${exports.length - 3} more)` : ""}`;
      }
    } catch {
      // Can't read file, fall through
    }
  }

  // Fallback by extension
  const extPurposes: Record<string, string> = {
    ".ts": "TypeScript source file",
    ".tsx": "TypeScript React component",
    ".js": "JavaScript source file",
    ".jsx": "JavaScript React component",
    ".py": "Python source file",
    ".rs": "Rust source file",
    ".go": "Go source file",
    ".css": "Stylesheet",
    ".scss": "SASS stylesheet",
    ".html": "HTML template",
    ".sql": "SQL queries",
    ".sh": "Shell script",
    ".yaml": "YAML configuration",
    ".yml": "YAML configuration",
    ".json": "JSON data/configuration",
    ".md": "Documentation",
    ".test.ts": "Test file",
    ".spec.ts": "Test file",
  };

  // Check compound extensions first
  for (const [compoundExt, purpose] of Object.entries(extPurposes)) {
    if (filename.endsWith(compoundExt) && compoundExt.split(".").length > 2) {
      return purpose;
    }
  }

  return extPurposes[ext] ?? "Source file";
}

export async function detectExportsWithFallback(content: string, ext: string): Promise<string[]> {
  const astResult = await detectExportsAST(content, ext);
  if (astResult !== null) return astResult;
  return detectExportsFromContent(content, ext);
}

function detectExportsFromContent(content: string, ext: string): string[] {
  const exports: string[] = [];

  if ([".ts", ".tsx", ".js", ".jsx"].includes(ext)) {
    // export function/class/const/type/interface
    const exportRegex = /export\s+(?:default\s+)?(?:function|class|const|let|type|interface)\s+(\w+)/g;
    let match;
    while ((match = exportRegex.exec(content)) !== null) {
      exports.push(match[1]);
    }
  } else if (ext === ".py") {
    // def and class at module level (no indentation)
    const defRegex = /^(?:def|class)\s+(\w+)/gm;
    let match;
    while ((match = defRegex.exec(content)) !== null) {
      if (!match[1].startsWith("_")) {
        exports.push(match[1]);
      }
    }
  } else if (ext === ".go") {
    // Exported (capitalized) functions and types
    const goRegex = /^(?:func|type)\s+([A-Z]\w+)/gm;
    let match;
    while ((match = goRegex.exec(content)) !== null) {
      exports.push(match[1]);
    }
  }

  return exports;
}

async function detectInterfaces(scanResult: ScanResult): Promise<Array<{ name: string; description: string }>> {
  const interfaces: Array<{ name: string; description: string }> = [];

  for (const filename of scanResult.files) {
    const ext = extname(filename).toLowerCase();
    if (![".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs"].includes(ext)) continue;

    try {
      const content = await readFile(join(scanResult.path, filename), "utf-8");
      const exports = await detectExportsWithFallback(content, ext);

      for (const exp of exports.slice(0, 5)) {
        interfaces.push({
          name: exp,
          description: `Exported from ${filename}`,
        });
      }
    } catch {
      // Skip unreadable files
    }
  }

  return interfaces.slice(0, 15); // Cap at 15 to avoid bloat
}

async function detectProjectMeta(rootPath: string): Promise<ContextFile["project"] | null> {
  // Try package.json
  try {
    const pkg = JSON.parse(await readFile(join(rootPath, "package.json"), "utf-8"));
    return {
      name: pkg.name ?? "unknown",
      description: pkg.description ?? "Node.js project",
      language: "typescript",
      framework: detectFramework(pkg),
      package_manager: "npm",
    };
  } catch { /* not a Node project */ }

  // Try pyproject.toml
  try {
    const content = await readFile(join(rootPath, "pyproject.toml"), "utf-8");
    const nameMatch = content.match(/^name\s*=\s*"(.+)"/m);
    const descMatch = content.match(/^description\s*=\s*"(.+)"/m);
    return {
      name: nameMatch?.[1] ?? "unknown",
      description: descMatch?.[1] ?? "Python project",
      language: "python",
    };
  } catch { /* not a Python project */ }

  // Try Cargo.toml
  try {
    const content = await readFile(join(rootPath, "Cargo.toml"), "utf-8");
    const nameMatch = content.match(/^name\s*=\s*"(.+)"/m);
    return {
      name: nameMatch?.[1] ?? "unknown",
      description: "Rust project",
      language: "rust",
    };
  } catch { /* not a Rust project */ }

  // Try go.mod
  try {
    const content = await readFile(join(rootPath, "go.mod"), "utf-8");
    const moduleMatch = content.match(/^module\s+(.+)/m);
    return {
      name: moduleMatch?.[1]?.split("/").pop() ?? "unknown",
      description: "Go project",
      language: "go",
    };
  } catch { /* not a Go project */ }

  return null;
}

function detectFramework(pkg: Record<string, unknown>): string | undefined {
  const deps = {
    ...(pkg.dependencies as Record<string, string> | undefined),
    ...(pkg.devDependencies as Record<string, string> | undefined),
  };

  if (deps["next"]) return "next";
  if (deps["nuxt"]) return "nuxt";
  if (deps["@sveltejs/kit"]) return "sveltekit";
  if (deps["express"]) return "express";
  if (deps["fastify"]) return "fastify";
  if (deps["react"]) return "react";
  if (deps["vue"]) return "vue";
  if (deps["svelte"]) return "svelte";
  if (deps["@angular/core"]) return "angular";

  return undefined;
}

/**
 * Heuristic: detect the test file for a given source file.
 * Checks colocated patterns (foo.test.ts, foo.spec.ts) in same directory.
 * NOT included in derived_fields — this is a best-effort guess.
 */
function detectTestFile(filename: string, scanResult: ScanResult): string | undefined {
  // Skip test files themselves
  if (/\.(test|spec)\.\w+$/.test(filename)) return undefined;

  const ext = extname(filename);
  const base = filename.slice(0, -ext.length);

  // Check same directory for colocated tests
  for (const suffix of [".test", ".spec"]) {
    const candidate = `${base}${suffix}${ext}`;
    if (scanResult.files.includes(candidate)) {
      return candidate;
    }
  }

  // Check sibling tests/ or __tests__/ directories
  for (const child of scanResult.children) {
    const childDirName = basename(child.relativePath);
    if (childDirName === "tests" || childDirName === "__tests__") {
      for (const suffix of [".test", ".spec"]) {
        const candidate = `${base}${suffix}${ext}`;
        if (child.files.includes(candidate)) {
          return `${childDirName}/${candidate}`;
        }
      }
      // Also check without suffix (tests/foo.ts for foo.ts)
      if (child.files.includes(filename)) {
        return `${childDirName}/${filename}`;
      }
    }
  }

  return undefined;
}

// Re-export for consumers that imported from static.ts
export { collectBasicEvidence } from "./evidence.js";
