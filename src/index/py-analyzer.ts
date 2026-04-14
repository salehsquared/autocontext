import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  ALL_DECL_CONFIGS,
  getGrammarsDir,
  getLanguage,
  getParser,
  getQuery,
  loadTreeSitter,
} from "../generator/ast.js";
import type {
  FileId,
  ImportEdge,
  IndexSymbol,
  Span,
  SymbolKind,
} from "./types.js";
import type {
  AnalysisMode,
  AnalysisOutput,
  LocalBinding,
  TentativeReference,
} from "./ts-analyzer.js";

/**
 * Python static-analysis pass for T1-B.
 *
 * Scope rules (v1): function_definition, class_definition, and lambda each
 * introduce a new scope. Local assignments + parameters + nested function /
 * class names are collected into the current scope; a name in any frame
 * masks the import-bound reference.
 *
 * Explicitly out of scope (documented in the honest status table):
 *   - module-name references through `import X` (case_03 in the fixture),
 *   - `from X import *` followed by use of an arbitrary name (case_05),
 *   - `__all__` inspection for re-export ordering,
 *   - `importlib.import_module`, conditional imports.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TSNode = any;

const WASM = "tree-sitter-python.wasm";

export function isPython(ext: string): boolean {
  return ext === ".py";
}

export async function analyzePython(
  content: string,
  fileId: FileId,
): Promise<AnalysisOutput> {
  if (!existsSync(join(getGrammarsDir(), WASM))) return emptyOutput("fallback");

  const loaded = await loadTreeSitter();
  if (!loaded) return emptyOutput("fallback");

  const parser = await getParser();
  const language = await getLanguage(WASM);
  parser.setLanguage(language);

  let tree;
  try {
    tree = parser.parse(content);
  } catch {
    return emptyOutput("parse_error");
  }
  if (!tree) return emptyOutput("parse_error");

  const root = tree.rootNode;

  const symbols = extractPySymbols(root, fileId, language);
  const imports = extractPyImports(root, fileId);
  const bindings = buildPyBindingTable(imports);
  const tentativeReferences = extractPyReferences(root, fileId, bindings);

  return { symbols, imports, tentativeReferences, analysisMode: "ast" };
}

function emptyOutput(analysisMode: AnalysisMode): AnalysisOutput {
  return {
    symbols: [],
    imports: [],
    tentativeReferences: [],
    analysisMode,
  };
}

// =============================================================================
// Symbols
// =============================================================================

function extractPySymbols(
  root: TSNode,
  fileId: FileId,
  language: unknown,
): IndexSymbol[] {
  const config = ALL_DECL_CONFIGS[".py"];
  if (!config) return [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const query = getQuery(language as any, config.query);
  const matches = query.matches(root);

  const out: IndexSymbol[] = [];
  const seen = new Set<string>();

  for (const match of matches) {
    for (const cap of match.captures) {
      const kind = cap.name as SymbolKind;
      const nameNode: TSNode = cap.node;
      const name: string = nameNode.text;
      const offset: number = nameNode.startIndex;
      const dedup = `${name}@${offset}`;
      if (seen.has(dedup)) continue;
      seen.add(dedup);

      const declNode = pyEnclosingDecl(nameNode);
      const span: Span = {
        startLine: declNode.startPosition.row + 1,
        endLine: declNode.endPosition.row + 1,
        nameByteOffset: offset,
      };

      out.push({
        id: `${fileId}#${name}@${offset}`,
        file: fileId,
        name,
        kind,
        exported: !name.startsWith("_"),
        span,
        lang: "py",
      });
    }
  }

  // Class-level nested symbols would require class-body traversal; v1 honors
  // "module-scope only" and matches the existing behavior of ast.ts.

  return out;
}

function pyEnclosingDecl(nameNode: TSNode): TSNode {
  const DECL_NODES = new Set([
    "function_definition",
    "class_definition",
    "decorated_definition",
  ]);
  let cur: TSNode | null = nameNode.parent;
  let best: TSNode = nameNode;
  while (cur) {
    if (DECL_NODES.has(cur.type)) best = cur;
    if (cur.type === "module") break;
    cur = cur.parent;
  }
  return best;
}

// =============================================================================
// Imports
// =============================================================================

function extractPyImports(root: TSNode, fileId: FileId): ImportEdge[] {
  const out: ImportEdge[] = [];
  for (const stmt of root.namedChildren as TSNode[]) {
    if (stmt.type === "import_from_statement") {
      const edge = parseFromImport(stmt, fileId);
      if (edge) out.push(edge);
    } else if (stmt.type === "import_statement") {
      out.push(...parseBareImport(stmt, fileId));
    }
  }
  return out;
}

function parseFromImport(stmt: TSNode, fileId: FileId): ImportEdge | null {
  const moduleNode = stmt.childForFieldName("module_name");
  if (!moduleNode) return null;
  const raw = moduleNode.text;
  const line = stmt.startPosition.row + 1;

  const symbols: string[] = [];
  for (const c of stmt.namedChildren as TSNode[]) {
    if (c.startIndex === moduleNode.startIndex) continue;
    if (c.type === "dotted_name") {
      symbols.push(c.text);
    } else if (c.type === "aliased_import") {
      const nameField = c.childForFieldName("name");
      const aliasField = c.childForFieldName("alias");
      if (!nameField) continue;
      const name = nameField.text;
      const alias = aliasField?.text;
      symbols.push(alias && alias !== name ? `${name} as ${alias}` : name);
    } else if (c.type === "wildcard_import") {
      symbols.push("*");
    }
  }

  return {
    from: fileId,
    raw,
    resolved_to: null,
    symbols,
    kind: "py_from",
    line,
  };
}

function parseBareImport(stmt: TSNode, fileId: FileId): ImportEdge[] {
  const line = stmt.startPosition.row + 1;
  const out: ImportEdge[] = [];
  for (const c of stmt.namedChildren as TSNode[]) {
    if (c.type === "dotted_name") {
      out.push({
        from: fileId,
        raw: c.text,
        resolved_to: null,
        symbols: ["(module)"],
        kind: "py_from",
        line,
      });
    } else if (c.type === "aliased_import") {
      const nameField = c.childForFieldName("name");
      const aliasField = c.childForFieldName("alias");
      if (!nameField) continue;
      const raw = nameField.text;
      const alias = aliasField?.text ?? raw;
      out.push({
        from: fileId,
        raw,
        resolved_to: null,
        symbols: [`(module) as ${alias}`],
        kind: "py_from",
        line,
      });
    }
  }
  return out;
}

// =============================================================================
// Bindings
// =============================================================================

const WORD_RE = /^\w+$/;

function buildPyBindingTable(imports: ImportEdge[]): Map<string, LocalBinding> {
  const table = new Map<string, LocalBinding>();
  for (const edge of imports) {
    for (const sym of edge.symbols) {
      if (sym === "*") continue;
      if (sym === "(module)") continue;
      if (sym.startsWith("(module) as ")) continue;

      const aliasMatch = sym.match(/^(\w+) as (\w+)$/);
      if (aliasMatch) {
        table.set(aliasMatch[2], {
          importRaw: edge.raw,
          remoteName: aliasMatch[1],
          typeOnly: false,
        });
        continue;
      }
      if (WORD_RE.test(sym)) {
        table.set(sym, { importRaw: edge.raw, remoteName: sym, typeOnly: false });
      }
    }
  }
  return table;
}

// =============================================================================
// Reference walker
// =============================================================================

const PY_SCOPE_INTRO = new Set([
  "function_definition",
  "class_definition",
  "lambda",
]);

const PY_SIMPLE_DECL_PARENTS = new Set([
  "import_from_statement",
  "import_statement",
  "aliased_import",
  "dotted_name",
  "wildcard_import",
  "parameters",
  "lambda_parameters",
  "typed_parameter",
  "default_parameter",
  "typed_default_parameter",
]);

const PY_NAME_FIELD_DECL_PARENTS = new Set([
  "function_definition",
  "class_definition",
]);

function isPyDeclarationIdentifier(node: TSNode): boolean {
  const p = node.parent;
  if (!p) return false;

  if (PY_SIMPLE_DECL_PARENTS.has(p.type)) return true;

  if (PY_NAME_FIELD_DECL_PARENTS.has(p.type)) {
    const nameChild = p.childForFieldName("name");
    if (nameChild && nameChild.startIndex === node.startIndex) return true;
  }

  if (p.type === "assignment") {
    const lhs = p.childForFieldName("left");
    if (lhs && lhs.startIndex === node.startIndex) return true;
  }

  if (p.type === "keyword_argument") {
    const nameChild = p.childForFieldName("name");
    if (nameChild && nameChild.startIndex === node.startIndex) return true;
  }

  // Attribute RHS: `foo.bar` — the `bar` identifier.
  if (p.type === "attribute") {
    const attrChild = p.childForFieldName("attribute");
    if (attrChild && attrChild.startIndex === node.startIndex) return true;
  }

  return false;
}

interface ScopeFrame {
  shadowed: Set<string>;
}

function extractPyReferences(
  root: TSNode,
  fileId: FileId,
  bindings: Map<string, LocalBinding>,
): TentativeReference[] {
  if (bindings.size === 0) return [];

  const refs: TentativeReference[] = [];
  const stack: ScopeFrame[] = [{ shadowed: new Set() }];

  function walk(node: TSNode): void {
    pyRecordLocalBinding(node, stack[stack.length - 1], bindings);

    const opens = PY_SCOPE_INTRO.has(node.type);
    if (opens) {
      stack.push({ shadowed: new Set() });
      pyCollectParams(node, stack[stack.length - 1]);
    }

    if (node.type === "identifier" && !isPyDeclarationIdentifier(node)) {
      const name: string = node.text;
      const binding = bindings.get(name);
      if (binding && !isShadowed(name, stack)) {
        refs.push({
          fromFile: fileId,
          importRaw: binding.importRaw,
          remoteName: binding.remoteName,
          span: {
            startLine: node.startPosition.row + 1,
            endLine: node.endPosition.row + 1,
            nameByteOffset: node.startIndex,
          },
          type_only: false,
        });
      }
    }

    for (const child of node.children as TSNode[]) {
      walk(child);
    }

    if (opens) stack.pop();
  }

  walk(root);
  return refs;
}

function pyRecordLocalBinding(
  node: TSNode,
  frame: ScopeFrame,
  bindings: Map<string, LocalBinding>,
): void {
  if (node.type === "assignment") {
    const lhs = node.childForFieldName("left");
    if (lhs && lhs.type === "identifier" && bindings.has(lhs.text)) {
      frame.shadowed.add(lhs.text);
    }
    return;
  }
  if (
    node.type === "function_definition" ||
    node.type === "class_definition"
  ) {
    const nameNode = node.childForFieldName("name");
    if (nameNode && bindings.has(nameNode.text)) {
      frame.shadowed.add(nameNode.text);
    }
  }
}

function pyCollectParams(scopeNode: TSNode, frame: ScopeFrame): void {
  const params =
    scopeNode.childForFieldName("parameters") ??
    findChild(scopeNode, "lambda_parameters");
  if (!params) return;
  for (const c of params.namedChildren as TSNode[]) {
    if (c.type === "identifier") {
      frame.shadowed.add(c.text);
      continue;
    }
    if (
      c.type === "typed_parameter" ||
      c.type === "default_parameter" ||
      c.type === "typed_default_parameter"
    ) {
      const nameNode =
        c.childForFieldName("name") ?? findChild(c, "identifier");
      if (nameNode) frame.shadowed.add(nameNode.text);
    }
  }
}

function findChild(node: TSNode, type: string): TSNode | null {
  for (const c of node.namedChildren as TSNode[]) {
    if (c.type === type) return c;
  }
  return null;
}

function isShadowed(name: string, stack: ScopeFrame[]): boolean {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].shadowed.has(name)) return true;
  }
  return false;
}
