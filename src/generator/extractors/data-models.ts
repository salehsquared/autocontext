import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { ScanResult } from "../../core/scanner.js";
import {
  getGrammarsDir,
  getLanguage,
  getParser,
  getQuery,
  loadTreeSitter,
} from "../ast.js";

/**
 * `data_models` extractor (T5-B). Emits human-readable strings of the form
 *   `<kind> <Name> { field1: type1, field2: type2, … }`
 * for TypeScript interfaces / object-shaped type aliases / classes and Python
 * dataclasses / BaseModel / NamedTuple subclasses. Precision over recall:
 * empty types / marker classes are skipped, and untyped Python classes
 * without dataclass markers are ignored.
 *
 * Returns sorted + deduped + capped (20 models per scope).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TSNode = any;

const MAX_MODELS = 20;
const MAX_FIELDS = 8;
const MAX_TYPE_LEN = 40;

interface ExtractedModel {
  kind: "interface" | "type" | "class" | "dataclass";
  name: string;
  fields: Array<{ name: string; type: string }>;
  file: string;
  order: number;
}

export async function extractDataModels(scanResult: ScanResult): Promise<string[]> {
  const loaded = await loadTreeSitter();
  if (!loaded) return [];

  const models: ExtractedModel[] = [];
  let orderCounter = 0;

  for (const filename of scanResult.files) {
    const ext = extname(filename).toLowerCase();
    const abs = join(scanResult.path, filename);
    if (ext === ".ts" || ext === ".tsx") {
      const found = await extractTypeScript(abs, filename);
      for (const m of found) {
        m.order = orderCounter++;
        models.push(m);
      }
    } else if (ext === ".py") {
      const found = await extractPython(abs, filename);
      for (const m of found) {
        m.order = orderCounter++;
        models.push(m);
      }
    }
  }

  const sorted = models
    .sort((a, b) =>
      a.file === b.file ? a.order - b.order : a.file.localeCompare(b.file),
    )
    .slice(0, MAX_MODELS);

  return sorted.map(renderModel);
}

function renderModel(m: ExtractedModel): string {
  const shown = m.fields.slice(0, MAX_FIELDS);
  const remainder = m.fields.length - shown.length;
  const parts = shown.map((f) => `${f.name}: ${clipType(f.type)}`);
  if (remainder > 0) parts.push(`\u2026+${remainder} more`);
  const body = parts.length > 0 ? `{ ${parts.join(", ")} }` : "{}";
  return `${m.kind} ${m.name} ${body}`;
}

function clipType(t: string): string {
  const compact = t.replace(/\s+/g, " ").trim();
  if (compact.length <= MAX_TYPE_LEN) return compact;
  // Prefer the outermost constructor name when the source wraps a complex
  // expression in `Array<…>` / `Map<…, …>` etc.
  const constructor = compact.match(/^([A-Za-z0-9_$]+)<|^([A-Za-z0-9_$]+)\(/);
  if (constructor) return (constructor[1] ?? constructor[2]) as string;
  return compact.slice(0, MAX_TYPE_LEN) + "\u2026";
}

// =============================================================================
// TypeScript
// =============================================================================

async function extractTypeScript(
  abs: string,
  relName: string,
): Promise<ExtractedModel[]> {
  const grammarsDir = getGrammarsDir();
  if (!existsSync(join(grammarsDir, "tree-sitter-typescript.wasm"))) return [];

  let content: string;
  try {
    content = await readFile(abs, "utf8");
  } catch {
    return [];
  }

  const parser = await getParser();
  const lang = await getLanguage("tree-sitter-typescript.wasm");
  parser.setLanguage(lang);
  const tree = parser.parse(content);
  if (!tree) return [];

  const out: ExtractedModel[] = [];
  let orderIdx = 0;
  for (const stmt of tree.rootNode.namedChildren as TSNode[]) {
    const node = unwrapExport(stmt);

    if (node.type === "interface_declaration") {
      const name = node.childForFieldName("name")?.text;
      const body = node.childForFieldName("body");
      if (!name || !body) continue;
      const fields = collectObjectTypeFields(body);
      if (fields.length === 0) continue;
      out.push({ kind: "interface", name, fields, file: relName, order: orderIdx++ });
      continue;
    }

    if (node.type === "type_alias_declaration") {
      const name = node.childForFieldName("name")?.text;
      const value = node.childForFieldName("value");
      if (!name || !value || value.type !== "object_type") continue;
      const fields = collectObjectTypeFields(value);
      if (fields.length === 0) continue;
      out.push({ kind: "type", name, fields, file: relName, order: orderIdx++ });
      continue;
    }

    if (node.type === "class_declaration") {
      const name = node.childForFieldName("name")?.text;
      const body = node.childForFieldName("body");
      if (!name || !body) continue;
      const fields = collectClassFields(body);
      if (fields.length === 0) continue;
      out.push({ kind: "class", name, fields, file: relName, order: orderIdx++ });
    }
  }
  return out;
}

function unwrapExport(node: TSNode): TSNode {
  if (node.type === "export_statement") {
    for (const c of node.namedChildren as TSNode[]) {
      if (
        c.type === "interface_declaration" ||
        c.type === "type_alias_declaration" ||
        c.type === "class_declaration"
      ) {
        return c;
      }
    }
  }
  return node;
}

function collectObjectTypeFields(body: TSNode): Array<{ name: string; type: string }> {
  const out: Array<{ name: string; type: string }> = [];
  for (const child of body.namedChildren as TSNode[]) {
    if (child.type !== "property_signature") continue;
    const nameNode = child.childForFieldName("name");
    const typeNode = child.childForFieldName("type");
    if (!nameNode) continue;
    const name = nameNode.text;
    const rawType = typeNode ? typeNode.text.replace(/^:\s*/, "") : "unknown";
    out.push({ name, type: rawType || "unknown" });
  }
  return out;
}

function collectClassFields(body: TSNode): Array<{ name: string; type: string }> {
  const out: Array<{ name: string; type: string }> = [];
  for (const child of body.namedChildren as TSNode[]) {
    if (child.type !== "public_field_definition" && child.type !== "field_definition") continue;
    const nameNode = child.childForFieldName("name");
    const typeNode = child.childForFieldName("type");
    if (!nameNode) continue;
    out.push({
      name: nameNode.text,
      type: typeNode ? typeNode.text.replace(/^:\s*/, "") : "unknown",
    });
  }
  return out;
}

// =============================================================================
// Python
// =============================================================================

async function extractPython(
  abs: string,
  relName: string,
): Promise<ExtractedModel[]> {
  const grammarsDir = getGrammarsDir();
  if (!existsSync(join(grammarsDir, "tree-sitter-python.wasm"))) return [];

  let content: string;
  try {
    content = await readFile(abs, "utf8");
  } catch {
    return [];
  }

  const parser = await getParser();
  const lang = await getLanguage("tree-sitter-python.wasm");
  parser.setLanguage(lang);
  const tree = parser.parse(content);
  if (!tree) return [];

  const query = getQuery(
    lang,
    `(module (class_definition
        name: (identifier) @class.name
        body: (block) @class.body))
     (module (decorated_definition
        (decorator) @deco
        (class_definition
          name: (identifier) @class.name
          body: (block) @class.body)))`,
  );
  const matches = query.matches(tree.rootNode);

  const seen = new Set<string>();
  const out: ExtractedModel[] = [];
  let orderIdx = 0;

  for (const match of matches) {
    let nameNode: TSNode | undefined;
    let bodyNode: TSNode | undefined;
    const decorators: TSNode[] = [];
    for (const cap of match.captures) {
      if (cap.name === "class.name") nameNode = cap.node;
      if (cap.name === "class.body") bodyNode = cap.node;
      if (cap.name === "deco") decorators.push(cap.node);
    }
    if (!nameNode || !bodyNode) continue;
    const name = nameNode.text;
    if (name.startsWith("_")) continue;
    if (seen.has(name)) continue;
    seen.add(name);

    const isDataclass = decorators.some((d) => /@\s*(dataclasses\.)?dataclass\b/.test(d.text));
    const isAttrs = decorators.some((d) => /@\s*attr(s)?\.(define|frozen|s)\b/.test(d.text));
    const classNode = nameNode.parent;
    const bases = classNode?.childForFieldName("superclasses")?.text ?? "";
    const isBaseModel = /\b(BaseModel|BaseSettings|NamedTuple|TypedDict)\b/.test(bases);

    const fields = collectPythonFields(bodyNode);
    const kind = isDataclass || isAttrs ? "dataclass" : isBaseModel ? "class" : null;
    if (!kind) {
      // Fall back: only include if at least one PEP 526 field exists.
      if (fields.length === 0) continue;
      out.push({ kind: "class", name, fields, file: relName, order: orderIdx++ });
      continue;
    }
    if (fields.length === 0) continue;
    out.push({ kind, name, fields, file: relName, order: orderIdx++ });
  }
  return out;
}

function collectPythonFields(body: TSNode): Array<{ name: string; type: string }> {
  const out: Array<{ name: string; type: string }> = [];
  for (const stmt of body.namedChildren as TSNode[]) {
    if (stmt.type !== "expression_statement") continue;
    const first = stmt.namedChild(0);
    if (!first) continue;
    if (first.type !== "assignment") continue;
    const nameNode = first.childForFieldName("left");
    const typeNode = first.childForFieldName("type");
    if (!nameNode || !typeNode) continue; // PEP 526 typed assignments only
    if (nameNode.type !== "identifier") continue;
    out.push({ name: nameNode.text, type: typeNode.text });
  }
  return out;
}
