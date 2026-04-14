import { posix } from "node:path";
import type { IndexStore } from "../index/store.js";
import type { IndexSymbol } from "../index/types.js";
import type { BenchTask } from "./types.js";
import { seededSample } from "./tasks.js";

const MAX_FIND_DEFINITION_TASKS_DEFAULT = 5;
const MAX_FIND_CALLERS_TASKS_DEFAULT = 5;
const MIN_CALLER_REFS = 2;
const MAX_CALLER_REFS = 20;

export interface GenerateSymbolTasksInput {
  index: IndexStore;
  /** Indexer version recorded in provenance. */
  indexVersion: number;
  /** Maximum `find-definition` tasks to synthesize. */
  maxDefinitionTasks?: number;
  /** Maximum `find-callers` tasks to synthesize. */
  maxCallerTasks?: number;
  seed?: number;
}

export interface SymbolTaskOutput {
  findDefinitionTasks: BenchTask[];
  findCallersTasks: BenchTask[];
}

/**
 * Synthesize ground-truth for find-definition and find-callers from the T1
 * index alone. Respects the T1 precision boundary: we never claim more than
 * import-bound references can verify.
 */
export async function generateSymbolTasks(
  input: GenerateSymbolTasksInput,
): Promise<SymbolTaskOutput> {
  const seed = input.seed ?? 42;
  const maxDef = input.maxDefinitionTasks ?? MAX_FIND_DEFINITION_TASKS_DEFAULT;
  const maxCallers = input.maxCallerTasks ?? MAX_FIND_CALLERS_TASKS_DEFAULT;

  // Collect every exported symbol with a unique name. We can't call
  // "scanSymbols" (not on the store) — iterate file-imports seam instead.
  const byName = new Map<string, IndexSymbol[]>();
  // We don't have a bulk scan; walk known files via dir edges and file symbols.
  // Cheap approach: use the manifest's file_count is unreliable; we collect
  // via imports' `from`/`resolved_to` union.
  const seenFiles = new Set<string>();
  for await (const edge of input.index.scanImports()) {
    seenFiles.add(edge.from);
    if (edge.resolved_to) seenFiles.add(edge.resolved_to);
  }

  for (const file of seenFiles) {
    const syms = await input.index.getFileSymbols(file);
    for (const s of syms) {
      if (!s.exported) continue;
      if (s.file.endsWith(".d.ts")) continue;
      if (!s.name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(s.name)) continue;
      const list = byName.get(s.name) ?? [];
      list.push(s);
      byName.set(s.name, list);
    }
  }

  const unique: IndexSymbol[] = [];
  for (const [, list] of byName) {
    if (list.length === 1) unique.push(list[0]);
  }
  unique.sort((a, b) => a.name.localeCompare(b.name));

  const chosenDefs = seededSample(unique, maxDef, seed);
  const findDefinitionTasks: BenchTask[] = chosenDefs.map((s) => ({
    id: `find-definition:${s.name}`,
    category: "find-definition",
    question: `In this repository, which file defines the symbol \`${s.name}\`? Answer with the project-relative path only.`,
    scoring: "target_hit",
    expected: [s.file],
    source_scope: posix.dirname(s.file) === "." ? "." : posix.dirname(s.file),
    ground_truth_provenance: {
      source: "t1_symbols",
      precision_class: "authoritative",
      recall_class: "exhaustive",
      t1_index_version: input.indexVersion,
    },
  }));

  const callerCandidates: Array<{ sym: IndexSymbol; refFiles: string[] }> = [];
  for (const s of unique) {
    const refs = await input.index.getReferencesTo(s.id);
    const files = [...new Set(refs.map((r) => r.file))].sort();
    if (files.length >= MIN_CALLER_REFS && files.length <= MAX_CALLER_REFS) {
      callerCandidates.push({ sym: s, refFiles: files });
    }
  }
  callerCandidates.sort((a, b) => a.sym.name.localeCompare(b.sym.name));

  const chosenCallers = seededSample(callerCandidates, maxCallers, seed ^ 0x9e3779b1);
  const findCallersTasks: BenchTask[] = chosenCallers.map(({ sym, refFiles }) => ({
    id: `find-callers:${sym.name}`,
    category: "find-callers",
    question: `Which files in this repository import the symbol \`${sym.name}\`? List project-relative paths, one per line. If none, answer 'none'.`,
    scoring: "file_set_f1",
    expected: refFiles,
    source_scope: posix.dirname(sym.file) === "." ? "." : posix.dirname(sym.file),
    ground_truth_provenance: {
      source: "t1_references",
      precision_class: "import_bound",
      recall_class: "imperfect",
      t1_index_version: input.indexVersion,
    },
  }));

  return { findDefinitionTasks, findCallersTasks };
}
