import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { createTmpDir, cleanupTmpDir } from "../helpers.js";
import { openIndex } from "../../src/index/store.js";
import { INDEX_VERSION } from "../../src/index/version.js";
import {
  fingerprintsPath,
  manifestPath,
  shardPath,
} from "../../src/index/paths.js";
import { computeFileFingerprint } from "../../src/index/fingerprint.js";
import type {
  ImportEdge,
  IndexSymbol,
  Reference,
} from "../../src/index/types.js";

let root: string;

beforeEach(async () => {
  root = await createTmpDir();
});

afterEach(async () => {
  await cleanupTmpDir(root);
});

function sampleSymbols(file: string): IndexSymbol[] {
  return [
    {
      id: `${file}#alpha@0`,
      file,
      name: "alpha",
      kind: "function",
      exported: true,
      span: { startLine: 1, endLine: 5, nameByteOffset: 0 },
      signature: "function alpha(): void",
      lang: "ts",
    },
    {
      id: `${file}#beta@20`,
      file,
      name: "beta",
      kind: "constant",
      exported: false,
      span: { startLine: 7, endLine: 7, nameByteOffset: 20 },
      lang: "ts",
    },
  ];
}

function sampleImports(file: string): ImportEdge[] {
  return [
    {
      from: file,
      raw: "./util",
      resolved_to: "src/util.ts",
      symbols: ["helper"],
      kind: "static",
      line: 1,
    },
  ];
}

function sampleReferences(file: string, targetId: string): Reference[] {
  return [
    {
      symbol_id: targetId,
      file,
      span: { startLine: 3, endLine: 3, nameByteOffset: 40 },
      via_import: { from: file, raw: "./util" },
      kind: "identifier_use",
    },
  ];
}

async function seedFile(absRoot: string, rel: string, body: string) {
  const full = join(absRoot, rel);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, body);
  return computeFileFingerprint(full, rel);
}

describe("NdjsonIndexStore", () => {
  it("writes a fresh manifest when none exists", async () => {
    const store = await openIndex(root);
    try {
      expect(store.manifest.index_version).toBe(INDEX_VERSION);
      expect(store.manifest.project_root).toBe(root);
      expect(store.manifest.file_count).toBe(0);
    } finally {
      await store.close();
    }
    expect(existsSync(manifestPath(root))).toBe(true);
  });

  it("writeFile round-trips symbols, imports, references, and fingerprint", async () => {
    const store = await openIndex(root);
    try {
      const fp = await seedFile(root, "src/a.ts", "export function alpha() {}\n");
      const symbols = sampleSymbols("src/a.ts");
      const imports = sampleImports("src/a.ts");
      const references = sampleReferences("src/a.ts", "src/util.ts#helper@0");

      await store.writeFile({
        file: "src/a.ts",
        symbols,
        imports,
        references,
        fingerprint: fp,
      });

      expect(await store.getFileSymbols("src/a.ts")).toHaveLength(2);
      expect(await store.getFileImports("src/a.ts")).toEqual(imports);
      expect(await store.getReferencesFrom("src/a.ts")).toEqual(references);
      expect(await store.getFileFingerprint("src/a.ts")).toEqual(fp);

      const readBack = await store.findSymbolsByName("alpha");
      expect(readBack.map((s) => s.id)).toEqual([symbols[0].id]);

      const resolved = await store.getSymbol(symbols[0].id);
      expect(resolved?.name).toBe("alpha");
    } finally {
      await store.close();
    }
  });

  it("writing a file twice leaves no stale rows from the first version", async () => {
    const store = await openIndex(root);
    try {
      const fp = await seedFile(root, "src/a.ts", "v1");
      await store.writeFile({
        file: "src/a.ts",
        symbols: sampleSymbols("src/a.ts"),
        imports: sampleImports("src/a.ts"),
        references: [],
        fingerprint: fp,
      });

      const fp2 = await seedFile(root, "src/a.ts", "v2");
      const v2Symbols: IndexSymbol[] = [
        {
          id: "src/a.ts#gamma@0",
          file: "src/a.ts",
          name: "gamma",
          kind: "function",
          exported: true,
          span: { startLine: 1, endLine: 1, nameByteOffset: 0 },
          lang: "ts",
        },
      ];
      await store.writeFile({
        file: "src/a.ts",
        symbols: v2Symbols,
        imports: [],
        references: [],
        fingerprint: fp2,
      });

      const symbols = await store.getFileSymbols("src/a.ts");
      expect(symbols.map((s) => s.name)).toEqual(["gamma"]);
      expect(await store.getFileImports("src/a.ts")).toEqual([]);

      // Assert no stale rows left on disk either.
      const raw = await readFile(shardPath(root, "symbols", "src"), "utf8");
      const lines = raw.split("\n").filter((l) => l.length > 0);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]).name).toBe("gamma");
    } finally {
      await store.close();
    }
  });

  it("dropFile removes every row keyed on the file", async () => {
    const store = await openIndex(root);
    try {
      const fpA = await seedFile(root, "src/a.ts", "a");
      const fpB = await seedFile(root, "src/b.ts", "b");
      await store.writeFile({
        file: "src/a.ts",
        symbols: sampleSymbols("src/a.ts"),
        imports: sampleImports("src/a.ts"),
        references: [],
        fingerprint: fpA,
      });
      await store.writeFile({
        file: "src/b.ts",
        symbols: sampleSymbols("src/b.ts"),
        imports: sampleImports("src/b.ts"),
        references: [],
        fingerprint: fpB,
      });

      await store.dropFile("src/a.ts");

      expect(await store.getFileSymbols("src/a.ts")).toEqual([]);
      expect(await store.getFileImports("src/a.ts")).toEqual([]);
      expect(await store.getFileFingerprint("src/a.ts")).toBeNull();

      // b.ts survives.
      expect((await store.getFileSymbols("src/b.ts")).length).toBeGreaterThan(0);
      expect(await store.getFileFingerprint("src/b.ts")).not.toBeNull();

      // Also verify fingerprints.ndjson has only b's row.
      const raw = await readFile(fingerprintsPath(root), "utf8");
      const lines = raw.split("\n").filter((l) => l.length > 0);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]).file).toBe("src/b.ts");
    } finally {
      await store.close();
    }
  });

  it("recomputeDirEdges derives weights from resolved imports", async () => {
    const store = await openIndex(root);
    try {
      const imports: ImportEdge[] = [
        {
          from: "src/commands/a.ts",
          raw: "../core/x",
          resolved_to: "src/core/x.ts",
          symbols: ["x"],
          kind: "static",
          line: 1,
        },
        {
          from: "src/commands/a.ts",
          raw: "../core/y",
          resolved_to: "src/core/y.ts",
          symbols: ["y"],
          kind: "static",
          line: 2,
        },
        {
          from: "src/commands/a.ts",
          raw: "external-pkg",
          resolved_to: null,
          symbols: ["pkg"],
          kind: "static",
          line: 3,
        },
      ];
      await store.writeFile({
        file: "src/commands/a.ts",
        symbols: [],
        imports,
        references: [],
        fingerprint: await seedFile(root, "src/commands/a.ts", "x"),
      });
      await store.recomputeDirEdges();

      const edges = await store.getDirEdges();
      expect(edges).toEqual([
        { from_dir: "src/commands", to_dir: "src/core", weight: 2 },
      ]);
    } finally {
      await store.close();
    }
  });

  it("diffAgainstDisk classifies added, unchanged, changed, and removed files", async () => {
    const store = await openIndex(root);
    try {
      const fpA = await seedFile(root, "src/a.ts", "one");
      const fpB = await seedFile(root, "src/b.ts", "two");
      await store.writeFile({
        file: "src/a.ts",
        symbols: [],
        imports: [],
        references: [],
        fingerprint: fpA,
      });
      await store.writeFile({
        file: "src/b.ts",
        symbols: [],
        imports: [],
        references: [],
        fingerprint: fpB,
      });

      // Mutate b.ts on disk.
      await writeFile(join(root, "src/b.ts"), "two-point-five");
      // Introduce a new file c.ts on disk.
      await seedFile(root, "src/c.ts", "three");

      const diff = await store.diffAgainstDisk(root, [
        "src/a.ts",
        "src/b.ts",
        "src/c.ts",
      ]);

      expect(diff.unchanged).toEqual(["src/a.ts"]);
      expect(diff.changed).toEqual(["src/b.ts"]);
      expect(diff.added).toEqual(["src/c.ts"]);
      expect(diff.removed).toEqual([]);

      // Now drop b.ts from the candidate set → should show up as removed.
      const diff2 = await store.diffAgainstDisk(root, ["src/a.ts"]);
      expect(diff2.removed.sort()).toEqual(["src/b.ts"]);
    } finally {
      await store.close();
    }
  });

  it("getImporters and getImportees use the resolved edge set", async () => {
    const store = await openIndex(root);
    try {
      await store.writeFile({
        file: "src/commands/a.ts",
        symbols: [],
        imports: [
          {
            from: "src/commands/a.ts",
            raw: "../core/x",
            resolved_to: "src/core/x.ts",
            symbols: ["x"],
            kind: "static",
            line: 1,
          },
        ],
        references: [],
        fingerprint: await seedFile(root, "src/commands/a.ts", "a"),
      });
      await store.writeFile({
        file: "src/commands/b.ts",
        symbols: [],
        imports: [
          {
            from: "src/commands/b.ts",
            raw: "../core/x",
            resolved_to: "src/core/x.ts",
            symbols: ["x"],
            kind: "static",
            line: 1,
          },
        ],
        references: [],
        fingerprint: await seedFile(root, "src/commands/b.ts", "b"),
      });

      expect(await store.getImporters("src/core/x.ts")).toEqual([
        "src/commands/a.ts",
        "src/commands/b.ts",
      ]);
      expect(await store.getImportees("src/commands/a.ts")).toEqual([
        "src/core/x.ts",
      ]);
    } finally {
      await store.close();
    }
  });

  it("rebuilds when the stored manifest has a stale index_version", async () => {
    // Seed a store at the current version.
    const store = await openIndex(root);
    const fp = await seedFile(root, "src/a.ts", "content");
    await store.writeFile({
      file: "src/a.ts",
      symbols: sampleSymbols("src/a.ts"),
      imports: [],
      references: [],
      fingerprint: fp,
    });
    await store.close();

    // Tamper with the manifest to simulate a downgrade.
    const mPath = manifestPath(root);
    const manifest = JSON.parse(await readFile(mPath, "utf8"));
    manifest.index_version = 0;
    await writeFile(mPath, JSON.stringify(manifest));

    // Reopen with autoRebuild (default). The store should wipe and come back empty.
    const store2 = await openIndex(root);
    try {
      expect(store2.manifest.index_version).toBe(INDEX_VERSION);
      expect(await store2.getFileSymbols("src/a.ts")).toEqual([]);
      expect(await store2.getFileFingerprint("src/a.ts")).toBeNull();
    } finally {
      await store2.close();
    }
  });

  it("readOnly open without a rebuild surfaces a clear error", async () => {
    // Seed a store.
    const store = await openIndex(root);
    await store.close();

    // Bust the manifest to force a rebuild decision.
    await writeFile(manifestPath(root), JSON.stringify({ index_version: 0 }));

    await expect(
      openIndex(root, { readOnly: true, autoRebuild: false }),
    ).rejects.toThrow(/needs rebuild/i);
  });
});
