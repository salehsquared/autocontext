import { join } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Lazy imports — only loaded when tree-sitter is actually used
let Parser: typeof import("web-tree-sitter").Parser | null = null;
let Language: typeof import("web-tree-sitter").Language | null = null;
let QueryClass: typeof import("web-tree-sitter").Query | null = null;

interface LanguageConfig {
  wasmFile: string;
  query: string;
  /** Post-filter: only keep names matching this regex (e.g. Go uppercase exports) */
  nameFilter?: RegExp;
}

const LANGUAGE_CONFIGS: Record<string, LanguageConfig> = {
  ".ts": {
    wasmFile: "tree-sitter-typescript.wasm",
    query: `
      (export_statement (function_declaration name: (identifier) @name))
      (export_statement (lexical_declaration (variable_declarator name: (identifier) @name)))
      (export_statement (type_alias_declaration name: (type_identifier) @name))
      (export_statement (interface_declaration name: (type_identifier) @name))
      (export_statement (class_declaration name: (type_identifier) @name))
      (export_statement (export_clause (export_specifier name: (identifier) @name)))
    `,
  },
  ".tsx": {
    wasmFile: "tree-sitter-typescript.wasm",
    query: `
      (export_statement (function_declaration name: (identifier) @name))
      (export_statement (lexical_declaration (variable_declarator name: (identifier) @name)))
      (export_statement (type_alias_declaration name: (type_identifier) @name))
      (export_statement (interface_declaration name: (type_identifier) @name))
      (export_statement (class_declaration name: (type_identifier) @name))
      (export_statement (export_clause (export_specifier name: (identifier) @name)))
    `,
  },
  ".js": {
    wasmFile: "tree-sitter-javascript.wasm",
    query: `
      (export_statement (function_declaration name: (identifier) @name))
      (export_statement (lexical_declaration (variable_declarator name: (identifier) @name)))
      (export_statement (class_declaration name: (identifier) @name))
      (export_statement (export_clause (export_specifier name: (identifier) @name)))
    `,
  },
  ".jsx": {
    wasmFile: "tree-sitter-javascript.wasm",
    query: `
      (export_statement (function_declaration name: (identifier) @name))
      (export_statement (lexical_declaration (variable_declarator name: (identifier) @name)))
      (export_statement (class_declaration name: (identifier) @name))
      (export_statement (export_clause (export_specifier name: (identifier) @name)))
    `,
  },
  ".py": {
    wasmFile: "tree-sitter-python.wasm",
    query: `
      (module (function_definition name: (identifier) @name))
      (module (decorated_definition (function_definition name: (identifier) @name)))
      (module (class_definition name: (identifier) @name))
      (module (decorated_definition (class_definition name: (identifier) @name)))
    `,
    nameFilter: /^[^_]/,
  },
  ".go": {
    wasmFile: "tree-sitter-go.wasm",
    query: `
      (function_declaration name: (identifier) @name)
      (method_declaration name: (field_identifier) @name)
      (type_declaration (type_spec name: (type_identifier) @name))
    `,
    nameFilter: /^[A-Z]/,
  },
  ".rs": {
    wasmFile: "tree-sitter-rust.wasm",
    query: `
      (function_item (visibility_modifier) name: (identifier) @name)
      (struct_item (visibility_modifier) name: (type_identifier) @name)
      (enum_item (visibility_modifier) name: (type_identifier) @name)
      (trait_item (visibility_modifier) name: (type_identifier) @name)
    `,
  },
};

// --- All top-level declarations (for internals extraction) ---
// These queries capture ALL declarations at module scope, both exported and non-exported.
// The caller subtracts exports (from detectExportsAST) to derive internals.
// Capture names indicate the kind: @function, @constant, @class, @type, @interface, @enum.

interface AllDeclsConfig {
  wasmFile: string;
  query: string;
}

/** @internal — exposed for the index analyzer. */
export const ALL_DECL_CONFIGS: Record<string, AllDeclsConfig> = {
  ".ts": {
    wasmFile: "tree-sitter-typescript.wasm",
    query: `
      (program (function_declaration name: (identifier) @function))
      (program (export_statement (function_declaration name: (identifier) @function)))
      (program (lexical_declaration (variable_declarator name: (identifier) @constant)))
      (program (export_statement (lexical_declaration (variable_declarator name: (identifier) @constant))))
      (program (class_declaration name: (type_identifier) @class))
      (program (export_statement (class_declaration name: (type_identifier) @class)))
      (program (type_alias_declaration name: (type_identifier) @type))
      (program (export_statement (type_alias_declaration name: (type_identifier) @type)))
      (program (interface_declaration name: (type_identifier) @interface))
      (program (export_statement (interface_declaration name: (type_identifier) @interface)))
      (program (enum_declaration name: (identifier) @enum))
      (program (export_statement (enum_declaration name: (identifier) @enum)))
    `,
  },
  ".tsx": {
    wasmFile: "tree-sitter-typescript.wasm",
    query: `
      (program (function_declaration name: (identifier) @function))
      (program (export_statement (function_declaration name: (identifier) @function)))
      (program (lexical_declaration (variable_declarator name: (identifier) @constant)))
      (program (export_statement (lexical_declaration (variable_declarator name: (identifier) @constant))))
      (program (class_declaration name: (type_identifier) @class))
      (program (export_statement (class_declaration name: (type_identifier) @class)))
      (program (type_alias_declaration name: (type_identifier) @type))
      (program (export_statement (type_alias_declaration name: (type_identifier) @type)))
      (program (interface_declaration name: (type_identifier) @interface))
      (program (export_statement (interface_declaration name: (type_identifier) @interface)))
      (program (enum_declaration name: (identifier) @enum))
      (program (export_statement (enum_declaration name: (identifier) @enum)))
    `,
  },
  ".js": {
    wasmFile: "tree-sitter-javascript.wasm",
    query: `
      (program (function_declaration name: (identifier) @function))
      (program (export_statement (function_declaration name: (identifier) @function)))
      (program (lexical_declaration (variable_declarator name: (identifier) @constant)))
      (program (export_statement (lexical_declaration (variable_declarator name: (identifier) @constant))))
      (program (class_declaration name: (identifier) @class))
      (program (export_statement (class_declaration name: (identifier) @class)))
    `,
  },
  ".jsx": {
    wasmFile: "tree-sitter-javascript.wasm",
    query: `
      (program (function_declaration name: (identifier) @function))
      (program (export_statement (function_declaration name: (identifier) @function)))
      (program (lexical_declaration (variable_declarator name: (identifier) @constant)))
      (program (export_statement (lexical_declaration (variable_declarator name: (identifier) @constant))))
      (program (class_declaration name: (identifier) @class))
      (program (export_statement (class_declaration name: (identifier) @class)))
    `,
  },
  ".py": {
    wasmFile: "tree-sitter-python.wasm",
    query: `
      (module (function_definition name: (identifier) @function))
      (module (decorated_definition (function_definition name: (identifier) @function)))
      (module (class_definition name: (identifier) @class))
      (module (decorated_definition (class_definition name: (identifier) @class)))
    `,
  },
  ".go": {
    wasmFile: "tree-sitter-go.wasm",
    query: `
      (function_declaration name: (identifier) @function)
      (method_declaration name: (field_identifier) @function)
      (type_declaration (type_spec name: (type_identifier) @type))
    `,
  },
  ".rs": {
    wasmFile: "tree-sitter-rust.wasm",
    query: `
      (function_item name: (identifier) @function)
      (struct_item name: (type_identifier) @type)
      (enum_item name: (type_identifier) @enum)
      (trait_item name: (type_identifier) @interface)
    `,
  },
};

// Singleton parser and language cache
let parserInstance: InstanceType<typeof import("web-tree-sitter").Parser> | null = null;
const languageCache = new Map<string, InstanceType<typeof import("web-tree-sitter").Language>>();
const queryCache = new Map<string, InstanceType<typeof import("web-tree-sitter").Query>>();

/** @internal — see loadTreeSitter doc. */
export function getGrammarsDir(): string {
  const thisDir = typeof import.meta.dirname === "string"
    ? import.meta.dirname
    : fileURLToPath(new URL(".", import.meta.url));
  return join(thisDir, "../../grammars");
}

/**
 * Internal — exposed so the local code index (src/index/) can reuse the same
 * parser/language/query caches. Do NOT add new callers outside of the index
 * unless you really need the primitives; prefer the higher-level helpers in
 * this module.
 */
export async function loadTreeSitter(): Promise<boolean> {
  if (Parser) return true;
  try {
    const mod = await import("web-tree-sitter");
    Parser = mod.Parser;
    Language = mod.Language;
    QueryClass = mod.Query;
    await Parser.init();
    return true;
  } catch {
    return false;
  }
}

/** @internal — see loadTreeSitter doc. */
export async function getParser(): Promise<InstanceType<typeof import("web-tree-sitter").Parser>> {
  if (parserInstance) return parserInstance;
  if (!Parser) throw new Error("tree-sitter not loaded");
  parserInstance = new Parser();
  return parserInstance;
}

/** @internal — see loadTreeSitter doc. */
export async function getLanguage(wasmFile: string): Promise<InstanceType<typeof import("web-tree-sitter").Language>> {
  if (languageCache.has(wasmFile)) return languageCache.get(wasmFile)!;
  if (!Language) throw new Error("tree-sitter not loaded");
  const wasmPath = join(getGrammarsDir(), wasmFile);
  const lang = await Language.load(wasmPath);
  languageCache.set(wasmFile, lang);
  return lang;
}

/** @internal — see loadTreeSitter doc. */
export function getQuery(lang: InstanceType<typeof import("web-tree-sitter").Language>, queryStr: string): InstanceType<typeof import("web-tree-sitter").Query> {
  if (queryCache.has(queryStr)) return queryCache.get(queryStr)!;
  if (!QueryClass) throw new Error("tree-sitter not loaded");
  const q = new QueryClass(lang, queryStr);
  queryCache.set(queryStr, q);
  return q;
}

/**
 * Detect exports from source code using tree-sitter AST parsing.
 * Returns null if tree-sitter is not available or the language is unsupported,
 * signaling the caller to use the regex fallback.
 */
export async function detectExportsAST(
  content: string,
  ext: string,
): Promise<string[] | null> {
  const config = LANGUAGE_CONFIGS[ext];
  if (!config) return null;

  const grammarsDir = getGrammarsDir();
  if (!existsSync(join(grammarsDir, config.wasmFile))) return null;

  try {
    const loaded = await loadTreeSitter();
    if (!loaded) return null;

    const parser = await getParser();
    const language = await getLanguage(config.wasmFile);
    parser.setLanguage(language);

    const tree = parser.parse(content);
    if (!tree) return null;
    const query = getQuery(language, config.query);
    const matches = query.matches(tree.rootNode);

    const exports: string[] = [];
    for (const match of matches) {
      for (const capture of match.captures) {
        if (capture.name === "name") {
          const name = capture.node.text;
          if (config.nameFilter && !config.nameFilter.test(name)) continue;
          if (!exports.includes(name)) {
            exports.push(name);
          }
        }
      }
    }

    return exports;
  } catch {
    return null;
  }
}

/**
 * Detect export signatures using tree-sitter AST parsing.
 * Uses parent node text for reliable multiline/generic extraction.
 * Returns null if tree-sitter is not available or unsupported.
 */
export async function detectExportSignaturesAST(
  content: string,
  ext: string,
): Promise<{ name: string; signature: string }[] | null> {
  const config = LANGUAGE_CONFIGS[ext];
  if (!config) return null;

  const grammarsDir = getGrammarsDir();
  if (!existsSync(join(grammarsDir, config.wasmFile))) return null;

  try {
    const loaded = await loadTreeSitter();
    if (!loaded) return null;

    const parser = await getParser();
    const language = await getLanguage(config.wasmFile);
    parser.setLanguage(language);

    const tree = parser.parse(content);
    if (!tree) return null;
    const query = getQuery(language, config.query);
    const matches = query.matches(tree.rootNode);

    const results: { name: string; signature: string }[] = [];
    const seen = new Set<string>();

    for (const match of matches) {
      for (const capture of match.captures) {
        if (capture.name !== "name") continue;
        const name = capture.node.text;
        if (config.nameFilter && !config.nameFilter.test(name)) continue;
        if (seen.has(name)) continue;
        seen.add(name);

        const signature = extractSignatureFromNode(capture.node, ext);
        results.push({ name, signature });
      }
    }

    return results;
  } catch {
    return null;
  }
}

function extractSignatureFromNode(
  nameNode: { text: string; parent: { type: string; text: string } | null },
  ext: string,
): string {
  const name = nameNode.text;
  const parent = nameNode.parent;
  if (!parent) return name;

  const parentType = parent.type;
  const parentText = parent.text;

  // TypeScript / JavaScript
  if ([".ts", ".tsx", ".js", ".jsx"].includes(ext)) {
    if (parentType === "function_declaration") {
      return cleanFunctionSignature(parentText, "ts");
    }
    if (parentType === "type_alias_declaration") return `type ${name}`;
    if (parentType === "interface_declaration") return `interface ${name}`;
    if (parentType === "class_declaration") return `class ${name}`;
    if (parentType === "variable_declarator") {
      // Try to get type annotation: `name: Type = ...`
      const typeMatch = parentText.match(new RegExp(`^${escapeRegex(name)}\\s*:\\s*([^=]+?)\\s*=`));
      if (typeMatch) return `${name}: ${typeMatch[1].trim()}`;
      return name;
    }
    // export_specifier (re-export) — just the name
    return name;
  }

  // Python
  if (ext === ".py") {
    if (parentType === "function_definition") {
      return cleanFunctionSignature(parentText, "py");
    }
    if (parentType === "class_definition") return `class ${name}`;
    return name;
  }

  // Go
  if (ext === ".go") {
    if (parentType === "function_declaration" || parentType === "method_declaration") {
      return cleanFunctionSignature(parentText, "go");
    }
    if (parentType === "type_spec") return `type ${name}`;
    return name;
  }

  // Rust
  if (ext === ".rs") {
    if (parentType === "function_item") {
      return cleanFunctionSignature(parentText, "rs");
    }
    if (parentType === "struct_item") return `struct ${name}`;
    if (parentType === "enum_item") return `enum ${name}`;
    if (parentType === "trait_item") return `trait ${name}`;
    return name;
  }

  return name;
}

function cleanFunctionSignature(text: string, lang: "ts" | "py" | "go" | "rs"): string {
  // Strip body: everything from opening brace/colon onward
  let sig: string;

  if (lang === "py") {
    // Python: take up to the colon that ends the def line
    // Match: `def name(params) -> ReturnType:`
    const match = text.match(/^(def\s+\w+\s*\([^)]*\)(?:\s*->\s*[^:]+)?)\s*:/s);
    sig = match ? match[1] : text.split("\n")[0].replace(/:$/, "");
  } else {
    // TS/JS/Go/Rust: take up to opening `{`
    const braceIdx = text.indexOf("{");
    sig = braceIdx >= 0 ? text.substring(0, braceIdx) : text;
  }

  // Clean up: remove export/pub/async keywords from start, normalize whitespace
  sig = sig
    .replace(/^export\s+(default\s+)?/, "")
    .replace(/^pub(\s*\(crate\))?\s+/, "")
    .replace(/\s+/g, " ")
    .trim();

  return sig;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface TopLevelDecl {
  name: string;
  kind: string;
}

/**
 * Detect ALL top-level declarations using tree-sitter AST parsing.
 * Returns all module-scope declarations with their kind, regardless of export status.
 * Caller can subtract exports (from detectExportsAST) to derive internals.
 * Returns null if tree-sitter is not available or the language is unsupported.
 *
 * For TS/JS: skips `let`/`var` declarations (only `const` → "constant").
 * For Rust: includes all items (both pub and non-pub).
 */
export async function detectAllTopLevelAST(
  content: string,
  ext: string,
): Promise<TopLevelDecl[] | null> {
  const config = ALL_DECL_CONFIGS[ext];
  if (!config) return null;

  const grammarsDir = getGrammarsDir();
  if (!existsSync(join(grammarsDir, config.wasmFile))) return null;

  try {
    const loaded = await loadTreeSitter();
    if (!loaded) return null;

    const parser = await getParser();
    const language = await getLanguage(config.wasmFile);
    parser.setLanguage(language);

    const tree = parser.parse(content);
    if (!tree) return null;
    const query = getQuery(language, config.query);
    const matches = query.matches(tree.rootNode);

    const results: TopLevelDecl[] = [];
    const seen = new Set<string>();

    for (const match of matches) {
      for (const capture of match.captures) {
        const kind = capture.name; // capture name = kind (function, constant, class, etc.)
        const name = capture.node.text;

        if (seen.has(name)) continue;

        // TS/JS: skip let/var declarations, only keep const
        if (kind === "constant") {
          const lexDecl = capture.node.parent?.parent;
          if (lexDecl?.type === "lexical_declaration") {
            const keyword = lexDecl.child(0);
            if (keyword?.text !== "const") continue;
          }
        }

        // Rust: skip items with visibility_modifier (those are public/exported)
        if (ext === ".rs") {
          const parentNode = capture.node.parent;
          if (parentNode) {
            let hasVisibility = false;
            for (let i = 0; i < parentNode.childCount; i++) {
              if (parentNode.child(i)?.type === "visibility_modifier") {
                hasVisibility = true;
                break;
              }
            }
            if (hasVisibility) continue;
          }
        }

        seen.add(name);
        results.push({ name, kind });
      }
    }

    return results;
  } catch {
    return null;
  }
}

/** Check if tree-sitter WASM can load and grammars are available. */
export async function isTreeSitterAvailable(): Promise<boolean> {
  try {
    const loaded = await loadTreeSitter();
    if (!loaded) return false;
    const grammarsDir = getGrammarsDir();
    return existsSync(join(grammarsDir, "tree-sitter-typescript.wasm"));
  } catch {
    return false;
  }
}
