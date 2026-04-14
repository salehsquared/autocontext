import type { IndexStore } from "../../src/index/store.js";
import type {
  DirEdge,
  FileFingerprint,
  FileId,
  ImportEdge,
  IndexManifest,
  IndexSymbol,
  Reference,
} from "../../src/index/types.js";

/**
 * In-memory IndexStore for policy tests. Only implements the readers that
 * evaluators actually call — writer and incremental-planning methods are
 * stubbed to throw so unexpected use surfaces loudly.
 */
export interface MemoryIndexSeed {
  symbols?: IndexSymbol[];
  imports?: ImportEdge[];
  references?: Reference[];
  dirEdges?: DirEdge[];
}

export function createMemoryIndexStore(seed: MemoryIndexSeed = {}): IndexStore {
  const symbols = seed.symbols ?? [];
  const imports = seed.imports ?? [];
  const references = seed.references ?? [];
  const dirEdges = seed.dirEdges ?? [];
  const manifest: IndexManifest = {
    index_version: 1,
    autocontext_version: "test",
    project_root: "/test",
    last_full_build: "2026-04-13T00:00:00Z",
    file_count: 0,
    grammar_hashes: {},
  };

  const notImpl = (name: string) => async () => {
    throw new Error(`MemoryIndexStore: ${name} not implemented`);
  };

  return {
    manifest,
    close: async () => {},
    writeFile: notImpl("writeFile") as never,
    dropFile: notImpl("dropFile") as never,
    recomputeDirEdges: notImpl("recomputeDirEdges") as never,
    writeManifest: notImpl("writeManifest") as never,
    diffAgainstDisk: notImpl("diffAgainstDisk") as never,
    getFileSymbols: async (file: FileId) => symbols.filter((s) => s.file === file),
    getFileImports: async (file: FileId) => imports.filter((i) => i.from === file),
    getFileFingerprint: async (_file: FileId): Promise<FileFingerprint | null> => null,
    findSymbolsByName: async (name, scope) => {
      let results = symbols.filter((s) => s.name === name);
      if (scope?.file) results = results.filter((s) => s.file === scope.file);
      if (scope?.dir) {
        const prefix = scope.dir === "." ? "" : `${scope.dir}/`;
        results = results.filter((s) => s.file === prefix || s.file.startsWith(prefix) || scope.dir === ".");
      }
      return results;
    },
    getSymbol: async (id) => symbols.find((s) => s.id === id) ?? null,
    getReferencesTo: async (symbolId) =>
      references.filter((r) => r.symbol_id === symbolId),
    getReferencesFrom: async (file) => references.filter((r) => r.file === file),
    scanImports: async function* (_filter) {
      for (const edge of imports) {
        yield edge;
      }
    },
    getDirEdges: async () => dirEdges,
    getImporters: async (file) => {
      const seen = new Set<FileId>();
      for (const edge of imports) {
        if (edge.resolved_to === file) seen.add(edge.from);
      }
      return [...seen];
    },
    getImportees: async (file) => {
      const seen = new Set<FileId>();
      for (const edge of imports) {
        if (edge.from === file && edge.resolved_to) seen.add(edge.resolved_to);
      }
      return [...seen];
    },
  };
}
