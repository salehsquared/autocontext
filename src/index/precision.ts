import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { buildIndex } from "./builder.js";
import { toFileId } from "./paths.js";
import type { FileId } from "./types.js";

/** One row in a fixture's `expected.json`. */
export interface ExpectedCase {
  name: string;
  source_file: string;
  expected_references: {
    target_file: string;
    target_symbol: string;
    count: number;
  }[];
  notes?: string;
}

export interface ExpectedFixture {
  cases: ExpectedCase[];
}

export interface PrecisionReport {
  perCase: {
    name: string;
    source_file: string;
    expected: number;
    actual: number;
    truePositives: number;
    falsePositives: number;
    falseNegatives: number;
  }[];
  totals: {
    expected: number;
    actual: number;
    truePositives: number;
    falsePositives: number;
    falseNegatives: number;
    precision: number; // |actual ∩ expected| / |actual|; 1.0 when actual = 0
    recall: number; // |actual ∩ expected| / |expected|; 1.0 when expected = 0
  };
}

/**
 * Run the T1-B analyzer against a precision fixture and compare its
 * references to the fixture's expected labels. Matching is
 * (target_file, target_symbol) pairs; `count` is summed per pair and
 * compared against the expected count.
 */
export async function measurePrecision(
  fixtureRoot: string,
): Promise<PrecisionReport> {
  const expected = JSON.parse(
    await readFile(join(fixtureRoot, "expected.json"), "utf8"),
  ) as ExpectedFixture;

  const sourceFiles = await collectSourceFiles(fixtureRoot);
  const result = await buildIndex(fixtureRoot, sourceFiles);

  // Group actual references: map source file → (target_file, target_symbol) → count.
  type Key = string; // `${target_file}::${target_symbol}`
  const actualByFile = new Map<FileId, Map<Key, number>>();

  const fileById = new Map<string, (typeof result.files)[number]>();
  for (const fr of result.files) fileById.set(fr.file, fr);

  for (const fr of result.files) {
    const byKey = new Map<Key, number>();
    for (const ref of fr.references) {
      const target = findSymbolById(fileById, ref.symbol_id);
      if (!target) continue;
      const key = `${target.file}::${target.name}`;
      byKey.set(key, (byKey.get(key) ?? 0) + 1);
    }
    actualByFile.set(fr.file, byKey);
  }

  let totalExpected = 0;
  let totalActual = 0;
  let totalTp = 0;
  let totalFp = 0;
  let totalFn = 0;
  const perCase: PrecisionReport["perCase"] = [];

  for (const c of expected.cases) {
    const fileId = toFileId(c.source_file);
    const expectedByKey = new Map<Key, number>();
    for (const er of c.expected_references) {
      const key = `${toFileId(er.target_file)}::${er.target_symbol}`;
      expectedByKey.set(key, (expectedByKey.get(key) ?? 0) + er.count);
    }
    const actualByKey = actualByFile.get(fileId) ?? new Map<Key, number>();

    let expectedSum = 0;
    let actualSum = 0;
    let tp = 0;
    const keys = new Set<Key>([...expectedByKey.keys(), ...actualByKey.keys()]);
    for (const k of keys) {
      const exp = expectedByKey.get(k) ?? 0;
      const act = actualByKey.get(k) ?? 0;
      expectedSum += exp;
      actualSum += act;
      tp += Math.min(exp, act);
    }
    const fp = Math.max(0, actualSum - tp);
    const fn = Math.max(0, expectedSum - tp);

    perCase.push({
      name: c.name,
      source_file: c.source_file,
      expected: expectedSum,
      actual: actualSum,
      truePositives: tp,
      falsePositives: fp,
      falseNegatives: fn,
    });

    totalExpected += expectedSum;
    totalActual += actualSum;
    totalTp += tp;
    totalFp += fp;
    totalFn += fn;
  }

  return {
    perCase,
    totals: {
      expected: totalExpected,
      actual: totalActual,
      truePositives: totalTp,
      falsePositives: totalFp,
      falseNegatives: totalFn,
      precision: totalActual === 0 ? 1 : totalTp / totalActual,
      recall: totalExpected === 0 ? 1 : totalTp / totalExpected,
    },
  };
}

function findSymbolById(
  fileById: Map<string, { symbols: { id: string; name: string; file: string }[] }>,
  symbolId: string,
): { file: string; name: string } | null {
  const hash = symbolId.indexOf("#");
  if (hash <= 0) return null;
  const file = symbolId.slice(0, hash);
  const rec = fileById.get(file);
  if (!rec) return null;
  for (const s of rec.symbols) {
    if (s.id === symbolId) return { file: s.file, name: s.name };
  }
  return null;
}

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".py"]);

async function collectSourceFiles(root: string): Promise<FileId[]> {
  const out: FileId[] = [];
  await walk(root, "", out);
  return out.sort();

  async function walk(absDir: string, relDir: string, acc: FileId[]) {
    const entries = await readdir(absDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const absChild = join(absDir, entry.name);
      const relChild = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(absChild, relChild, acc);
        continue;
      }
      if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        acc.push(relChild);
      }
    }
  }
}
