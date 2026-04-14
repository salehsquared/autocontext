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

/**
 * TS/JS static-analysis pass for T1-B. Parses a single source file and
 * returns symbols + import edges + "tentative" references whose target
 * `symbol_id` still needs to be resolved against the whole-project symbol
 * table (done in the builder's second pass — see builder.ts).
 *
 * Precision boundary (import-bound only). The walker never emits a reference
 * for:
 *   - free identifier uses that aren't bound by a tracked import,
 *   - member-access reads (`ns.foo` — tree-sitter treats `foo` as
 *     `property_identifier`, which we never capture),
 *   - namespace imports (`import * as m` — deliberately excluded from the
 *     binding table so `m.foo` uses never land),
 *   - re-exports (`export { X } from "./y"` — kind=reexport edges don't bind
 *     names locally).
 */

// tree-sitter types are awkward to import directly — keep them loose.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TSNode = any;

export type AnalysisMode = "ast" | "parse_error" | "fallback";

export interface TentativeReference {
  /** The file the reference occurs in. */
  fromFile: FileId;
  /** ImportEdge.raw that bound the local name; pairs with fromFile to locate the edge. */
  importRaw: string;
  /** Name in the source module (post-alias). `"default"` for default imports. */
  remoteName: string;
  span: Span;
  type_only: boolean;
}

export interface AnalysisOutput {
  symbols: IndexSymbol[];
  imports: ImportEdge[];
  tentativeReferences: TentativeReference[];
  analysisMode: AnalysisMode;
}

const WASM_BY_EXT: Record<string, string> = {
  ".ts": "tree-sitter-typescript.wasm",
  ".tsx": "tree-sitter-typescript.wasm",
  ".js": "tree-sitter-javascript.wasm",
  ".jsx": "tree-sitter-javascript.wasm",
};

const SUPPORTED_EXTS = Object.keys(WASM_BY_EXT);

export function isTsLike(ext: string): boolean {
  return SUPPORTED_EXTS.includes(ext);
}

export async function analyzeTsLike(
  content: string,
  fileId: FileId,
  ext: string,
): Promise<AnalysisOutput> {
  const wasm = WASM_BY_EXT[ext];
  if (!wasm) return emptyOutput("fallback");

  if (!existsSync(join(getGrammarsDir(), wasm))) return emptyOutput("fallback");

  const loaded = await loadTreeSitter();
  if (!loaded) return emptyOutput("fallback");

  const parser = await getParser();
  const language = await getLanguage(wasm);
  parser.setLanguage(language);

  let tree;
  try {
    tree = parser.parse(content);
  } catch {
    return emptyOutput("parse_error");
  }
  if (!tree) return emptyOutput("parse_error");

  const root = tree.rootNode;
  const lang = ext.slice(1); // "ts" | "tsx" | "js" | "jsx"

  const symbols = extractSymbols(root, fileId, ext, lang, language);
  const { imports, reexportRefs } = extractImports(root, fileId);
  const bindings = buildBindingTable(imports);
  const tentativeReferences = [
    ...extractReferences(root, fileId, bindings),
    ...reexportRefs,
  ];

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

function extractSymbols(
  root: TSNode,
  fileId: FileId,
  ext: string,
  lang: string,
  language: unknown,
): IndexSymbol[] {
  const config = ALL_DECL_CONFIGS[ext];
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

      // TS/JS: skip `let`/`var` declarations; only `const` counts as "constant".
      if (kind === "constant") {
        const lexDecl = nameNode.parent?.parent;
        if (lexDecl?.type === "lexical_declaration") {
          const keyword = lexDecl.child(0);
          if (keyword?.text !== "const") continue;
        }
      }

      seen.add(dedup);

      const declNode = enclosingDeclNode(nameNode);
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
        exported: isInsideExport(nameNode),
        span,
        signature: extractSignature(nameNode, kind, name),
        lang,
      });
    }
  }

  // Synthesize a "default" symbol for each default export.
  for (const stmt of root.namedChildren as TSNode[]) {
    if (stmt.type !== "export_statement") continue;
    if (!hasDefaultKeyword(stmt)) continue;

    const offset = stmt.startIndex;
    const key = `default@${offset}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      id: `${fileId}#default@${offset}`,
      file: fileId,
      name: "default",
      kind: inferDefaultKind(stmt),
      exported: true,
      span: {
        startLine: stmt.startPosition.row + 1,
        endLine: stmt.endPosition.row + 1,
        nameByteOffset: offset,
      },
      lang,
    });
  }

  return out;
}

function extractSignature(
  nameNode: TSNode,
  kind: SymbolKind,
  name: string,
): string | undefined {
  const parent = nameNode.parent;
  if (!parent) return undefined;
  const text: string = parent.text;

  if (parent.type === "function_declaration" || parent.type === "generator_function_declaration") {
    const brace = text.indexOf("{");
    const sig = brace >= 0 ? text.slice(0, brace) : text;
    return sig.replace(/^export\s+(default\s+)?/, "").replace(/\s+/g, " ").trim();
  }
  if (parent.type === "class_declaration") return `class ${name}`;
  if (parent.type === "interface_declaration") return `interface ${name}`;
  if (parent.type === "type_alias_declaration") return `type ${name}`;
  if (parent.type === "enum_declaration") return `enum ${name}`;
  if (parent.type === "variable_declarator") {
    // `const foo: Type = ...` — keep the LHS type annotation.
    const eq = text.indexOf("=");
    const lhs = eq >= 0 ? text.slice(0, eq) : text;
    return lhs.replace(/\s+/g, " ").trim();
  }
  return undefined;
}

function enclosingDeclNode(nameNode: TSNode): TSNode {
  // Walk up to the nearest "declaration" node so the Span covers the whole thing.
  const DECL_NODES = new Set([
    "function_declaration",
    "generator_function_declaration",
    "class_declaration",
    "interface_declaration",
    "type_alias_declaration",
    "enum_declaration",
    "variable_declarator",
    "lexical_declaration",
    "export_statement",
  ]);
  let cur: TSNode | null = nameNode.parent;
  let best: TSNode = nameNode;
  while (cur) {
    if (DECL_NODES.has(cur.type)) best = cur;
    // Stop at program boundary.
    if (cur.type === "program") break;
    cur = cur.parent;
  }
  return best;
}

function isInsideExport(node: TSNode): boolean {
  let p: TSNode | null = node.parent;
  while (p) {
    if (p.type === "export_statement") return true;
    if (p.type === "program") return false;
    p = p.parent;
  }
  return false;
}

function hasDefaultKeyword(stmt: TSNode): boolean {
  for (let i = 0; i < stmt.childCount; i++) {
    const c = stmt.child(i);
    if (c && c.type === "default") return true;
  }
  return false;
}

function inferDefaultKind(stmt: TSNode): SymbolKind {
  for (const c of stmt.namedChildren as TSNode[]) {
    if (c.type === "function_declaration" || c.type === "generator_function_declaration") {
      return "function";
    }
    if (c.type === "class_declaration") return "class";
  }
  return "variable";
}

// =============================================================================
// Imports
// =============================================================================

const WORD_RE = /^\w+$/;

function extractImports(
  root: TSNode,
  fileId: FileId,
): { imports: ImportEdge[]; reexportRefs: TentativeReference[] } {
  const imports: ImportEdge[] = [];
  const reexportRefs: TentativeReference[] = [];
  for (const stmt of root.namedChildren as TSNode[]) {
    if (stmt.type === "import_statement") {
      const edge = parseStaticImport(stmt, fileId);
      if (edge) imports.push(edge);
    } else if (stmt.type === "export_statement") {
      const parsed = parseReexport(stmt, fileId);
      if (parsed) {
        imports.push(parsed.edge);
        reexportRefs.push(...parsed.refs);
      }
    }
  }
  return { imports, reexportRefs };
}

function parseStaticImport(stmt: TSNode, fileId: FileId): ImportEdge | null {
  const source = stmt.childForFieldName("source");
  if (!source) return null;
  const raw = stripStringLiteral(source.text);
  if (raw === null) return null;

  const clause = findNamedChild(stmt, "import_clause");
  const symbols: string[] = [];

  if (!clause) {
    symbols.push("(side-effect)");
  } else {
    for (const c of clause.namedChildren as TSNode[]) {
      if (c.type === "identifier") {
        symbols.push(`default as ${c.text}`);
      } else if (c.type === "namespace_import") {
        const ident = findNamedChild(c, "identifier");
        if (ident) symbols.push(`* as ${ident.text}`);
      } else if (c.type === "named_imports") {
        for (const spec of c.namedChildren as TSNode[]) {
          if (spec.type !== "import_specifier") continue;
          symbols.push(specifierText(spec));
        }
      }
    }
  }

  return {
    from: fileId,
    raw,
    resolved_to: null,
    symbols,
    kind: "static",
    line: stmt.startPosition.row + 1,
  };
}

function parseReexport(
  stmt: TSNode,
  fileId: FileId,
): { edge: ImportEdge; refs: TentativeReference[] } | null {
  const source = stmt.childForFieldName("source");
  if (!source) return null;
  const raw = stripStringLiteral(source.text);
  if (raw === null) return null;

  const symbols: string[] = [];
  const refs: TentativeReference[] = [];
  const clause = findNamedChild(stmt, "export_clause");
  if (clause) {
    for (const spec of clause.namedChildren as TSNode[]) {
      if (spec.type !== "export_specifier") continue;
      symbols.push(specifierText(spec));
      // One-hop re-export: count the specifier site itself as a reference to
      // the remote symbol (per fixture's README, matches T2 impact analysis).
      const nameNode = spec.childForFieldName("name");
      if (!nameNode) continue;
      refs.push({
        fromFile: fileId,
        importRaw: raw,
        remoteName: nameNode.text,
        span: {
          startLine: nameNode.startPosition.row + 1,
          endLine: nameNode.endPosition.row + 1,
          nameByteOffset: nameNode.startIndex,
        },
        type_only: false,
      });
    }
  } else {
    symbols.push("*");
    // Wildcard re-export: edge is emitted, but we don't know the symbol set,
    // so no references are produced (consistent with v1's import-bound scope).
  }

  const edge: ImportEdge = {
    from: fileId,
    raw,
    resolved_to: null,
    symbols,
    kind: "reexport",
    line: stmt.startPosition.row + 1,
  };
  return { edge, refs };
}

function specifierText(spec: TSNode): string {
  const nameNode = spec.childForFieldName("name");
  const aliasNode = spec.childForFieldName("alias");
  const name = nameNode?.text ?? spec.namedChild(0)?.text ?? "";
  if (aliasNode && aliasNode.text !== name) {
    return `${name} as ${aliasNode.text}`;
  }
  return name;
}

function findNamedChild(node: TSNode, type: string): TSNode | null {
  for (const c of node.namedChildren as TSNode[]) {
    if (c.type === type) return c;
  }
  return null;
}

function stripStringLiteral(text: string): string | null {
  const match = text.match(/^["'`](.*)["'`]$/s);
  return match ? match[1] : null;
}

// =============================================================================
// Binding table
// =============================================================================

export interface LocalBinding {
  importRaw: string;
  remoteName: string;
  typeOnly: boolean;
}

function buildBindingTable(imports: ImportEdge[]): Map<string, LocalBinding> {
  const table = new Map<string, LocalBinding>();
  for (const edge of imports) {
    if (edge.kind === "reexport") continue;
    for (const sym of edge.symbols) {
      if (sym === "(side-effect)") continue;
      // `* as ns` — namespace binding. Deferred (v1 can't resolve member access).
      if (sym.startsWith("* as ")) continue;
      // `default as foo` — local `foo` → remote `default`.
      const defaultMatch = sym.match(/^default as (\w+)$/);
      if (defaultMatch) {
        table.set(defaultMatch[1], {
          importRaw: edge.raw,
          remoteName: "default",
          typeOnly: false,
        });
        continue;
      }
      // `X as Y` — local `Y` → remote `X`.
      const aliasMatch = sym.match(/^(\w+) as (\w+)$/);
      if (aliasMatch) {
        table.set(aliasMatch[2], {
          importRaw: edge.raw,
          remoteName: aliasMatch[1],
          typeOnly: false,
        });
        continue;
      }
      // Plain `A`.
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

const SCOPE_INTRO = new Set([
  "function_declaration",
  "function_expression",
  "generator_function_declaration",
  "generator_function",
  "arrow_function",
  "method_definition",
  "method_signature",
]);

const DECLARATION_PARENT_TYPES = new Set([
  "import_specifier",
  "export_specifier",
  "import_clause",
  "namespace_import",
  "required_parameter",
  "optional_parameter",
  "rest_pattern",
  "shorthand_property_identifier_pattern",
  "object_assignment_pattern",
]);

const NAME_FIELD_DECLARATION_PARENT_TYPES = new Set([
  "variable_declarator",
  "function_declaration",
  "function_expression",
  "generator_function_declaration",
  "generator_function",
  "class_declaration",
  "class",
  "interface_declaration",
  "type_alias_declaration",
  "enum_declaration",
  "method_definition",
  "method_signature",
  "property_signature",
  "public_field_definition",
  "labeled_statement",
]);

function isDeclarationIdentifier(node: TSNode): boolean {
  const p = node.parent;
  if (!p) return false;

  if (DECLARATION_PARENT_TYPES.has(p.type)) return true;

  if (NAME_FIELD_DECLARATION_PARENT_TYPES.has(p.type)) {
    const nameChild = p.childForFieldName("name");
    if (nameChild && nameChild.startIndex === node.startIndex) return true;
  }

  // Bare-identifier arrow param: `x => x`.
  if (p.type === "arrow_function") {
    const first = p.namedChild(0);
    if (first && first.startIndex === node.startIndex) return true;
  }

  return false;
}

interface ScopeFrame {
  shadowed: Set<string>;
}

function extractReferences(
  root: TSNode,
  fileId: FileId,
  bindings: Map<string, LocalBinding>,
): TentativeReference[] {
  if (bindings.size === 0) return [];

  const refs: TentativeReference[] = [];
  const stack: ScopeFrame[] = [{ shadowed: new Set() }];

  function walk(node: TSNode): void {
    // Declarations visible in the CURRENT (enclosing) scope: functions and
    // classes hoist up to the enclosing lexical scope, `const`/`let` is added
    // linearly as we walk past them.
    recordLocalBinding(node, stack[stack.length - 1], bindings);

    const opens = SCOPE_INTRO.has(node.type);
    if (opens) {
      stack.push({ shadowed: new Set() });
      collectParams(node, stack[stack.length - 1]);
    }

    if (
      (node.type === "identifier" || node.type === "type_identifier") &&
      !isDeclarationIdentifier(node)
    ) {
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
          type_only: node.type === "type_identifier",
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

function recordLocalBinding(
  node: TSNode,
  frame: ScopeFrame,
  bindings: Map<string, LocalBinding>,
): void {
  // We only care about names that could shadow an imported binding.
  if (node.type === "variable_declarator") {
    const nameNode = node.childForFieldName("name");
    if (nameNode && nameNode.type === "identifier") {
      if (bindings.has(nameNode.text)) frame.shadowed.add(nameNode.text);
    }
    return;
  }
  if (
    node.type === "function_declaration" ||
    node.type === "generator_function_declaration" ||
    node.type === "class_declaration"
  ) {
    const nameNode = node.childForFieldName("name");
    if (nameNode) {
      if (bindings.has(nameNode.text)) frame.shadowed.add(nameNode.text);
    }
  }
}

function collectParams(scopeNode: TSNode, frame: ScopeFrame): void {
  // arrow_function bare param: `x => …`.
  const bare = scopeNode.childForFieldName("parameter");
  if (bare && bare.type === "identifier") frame.shadowed.add(bare.text);

  const params = scopeNode.childForFieldName("parameters");
  if (!params) return;
  for (const c of params.namedChildren as TSNode[]) {
    if (c.type === "identifier") {
      frame.shadowed.add(c.text);
      continue;
    }
    if (c.type === "required_parameter" || c.type === "optional_parameter") {
      const pat = c.childForFieldName("pattern");
      if (pat && pat.type === "identifier") frame.shadowed.add(pat.text);
      continue;
    }
    if (c.type === "rest_pattern") {
      const ident = c.namedChild(0);
      if (ident && ident.type === "identifier") frame.shadowed.add(ident.text);
    }
  }
}

function isShadowed(name: string, stack: ScopeFrame[]): boolean {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i].shadowed.has(name)) return true;
  }
  return false;
}
