import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cp, mkdir, readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTmpDir, cleanupTmpDir } from "../helpers.js";
import { openIndex } from "../../src/index/store.js";
import { buildIndex, commitBuild } from "../../src/index/builder.js";
import { computeImpact, type ImpactSeed } from "../../src/impact/impact.js";
import type { IndexStore } from "../../src/index/store.js";
import type { FileId, IndexSymbol } from "../../src/index/types.js";
import { toFileId } from "../../src/index/paths.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixtureRoot = join(repoRoot, "tests/fixtures/impact-labels");

interface Scenario {
  dir: string;
  name: string;
  expected: {
    seed_files: string[];
    expected_impact_directories: string[];
    expected_not_in_impact: string[];
    semantic_fingerprint_unchanged?: boolean;
  };
}

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await createTmpDir();
});

afterEach(async () => {
  await cleanupTmpDir(tmpRoot);
});

describe("change-impact precision on impact-labels fixture", () => {
  it("meets the precision and recall targets across every scenario", async () => {
    const scenarios = await loadScenarios();
    const perScenario: Array<{
      name: string;
      actual: string[];
      expected: string[];
      precision: number;
      recall: number;
    }> = [];
    let overallTp = 0;
    let overallFp = 0;
    let overallFn = 0;

    for (const scenario of scenarios) {
      const { actualDirs } = await runScenario(scenario);
      const expected = new Set(scenario.expected.expected_impact_directories);
      const actual = new Set(actualDirs);

      const tp = [...actual].filter((d) => expected.has(d)).length;
      const fp = [...actual].filter((d) => !expected.has(d)).length;
      const fn = [...expected].filter((d) => !actual.has(d)).length;
      overallTp += tp;
      overallFp += fp;
      overallFn += fn;

      const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
      const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
      perScenario.push({
        name: scenario.name,
        actual: [...actual].sort(),
        expected: [...expected].sort(),
        precision,
        recall,
      });

      for (const forbid of scenario.expected.expected_not_in_impact) {
        if (actual.has(forbid)) {
          throw new Error(
            `Scenario ${scenario.name}: ${forbid} flagged as impacted but fixture says it must NOT be. Full actual: ${JSON.stringify([...actual])}`,
          );
        }
      }
    }

    const totalPrecision = overallTp + overallFp === 0 ? 1 : overallTp / (overallTp + overallFp);
    const totalRecall = overallTp + overallFn === 0 ? 1 : overallTp / (overallTp + overallFn);
    if (totalPrecision < 0.9 || totalRecall < 0.7) {
      // eslint-disable-next-line no-console
      console.error("Impact precision breakdown:", JSON.stringify(perScenario, null, 2));
    }
    expect(totalPrecision).toBeGreaterThanOrEqual(0.9);
    expect(totalRecall).toBeGreaterThanOrEqual(0.7);
  });
});

/** Build the baseline index, overlay the scenario's modified/ tree, re-index,
 * compute changed exported symbols, run impact from those seeds. */
async function runScenario(scenario: Scenario): Promise<{ actualDirs: string[] }> {
  const work = join(tmpRoot, scenario.name);
  await mkdir(work, { recursive: true });
  await cp(join(fixtureRoot, "mini-project"), work, { recursive: true });

  const sourceFiles = await collectSourceFiles(work);

  // Pass 1: index baseline.
  const baselineSymbols = new Map<FileId, IndexSymbol[]>();
  {
    const store = await openIndex(work, { autoRebuild: true });
    try {
      const build = await buildIndex(work, sourceFiles);
      await commitBuild(store, build);
      for (const fr of build.files) baselineSymbols.set(fr.file, fr.symbols);
    } finally {
      await store.close();
    }
  }

  // Overlay modified files.
  await cp(join(scenario.dir, "modified"), work, { recursive: true });

  // Pass 2: re-index modified state.
  const modifiedSymbols = new Map<FileId, IndexSymbol[]>();
  const refreshedFiles = await collectSourceFiles(work);
  {
    const store = await openIndex(work, { autoRebuild: true });
    try {
      const build = await buildIndex(work, refreshedFiles);
      await commitBuild(store, build);
      for (const fr of build.files) modifiedSymbols.set(fr.file, fr.symbols);
    } finally {
      await store.close();
    }
  }

  // Compute changed exported symbols in each seed file.
  const seeds: ImpactSeed[] = [];
  for (const seedFile of scenario.expected.seed_files) {
    const id = toFileId(seedFile);
    const before = (baselineSymbols.get(id) ?? []).filter((s) => s.exported);
    const after = (modifiedSymbols.get(id) ?? []).filter((s) => s.exported);
    const beforeBy = new Map(before.map((s) => [s.name, s.signature]));
    const afterBy = new Map(after.map((s) => [s.name, s.signature]));
    for (const [name, sig] of beforeBy) {
      const newSig = afterBy.get(name);
      if (newSig === undefined || newSig !== sig) {
        seeds.push({ file: id, symbol: name, reason: "diff" });
      }
    }
    // New additions are NOT seeded — they can't have existing consumers.
  }

  if (seeds.length === 0) {
    return { actualDirs: [] };
  }

  // Use the modified store to walk references (re-open read-only).
  const store = await openIndex(work, { readOnly: true, autoRebuild: false });
  try {
    const report = await computeImpact(store, seeds);
    const dirs = new Set<string>();
    for (const a of report.affected) dirs.add(a.context_scope);
    return { actualDirs: [...dirs].sort() };
  } finally {
    await store.close();
  }
}

async function loadScenarios(): Promise<Scenario[]> {
  const scenariosDir = join(fixtureRoot, "scenarios");
  const entries = await readdir(scenariosDir, { withFileTypes: true });
  const out: Scenario[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = join(scenariosDir, e.name);
    const expectedRaw = await readFile(join(dir, "expected.json"), "utf8");
    out.push({ dir, name: e.name, expected: JSON.parse(expectedRaw) });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

async function collectSourceFiles(root: string): Promise<FileId[]> {
  const EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".py"]);
  const out: FileId[] = [];
  async function walk(absDir: string, relDir: string): Promise<void> {
    const entries = await readdir(absDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const abs = join(absDir, entry.name);
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(abs, rel);
        continue;
      }
      if (entry.isFile() && EXTS.has(extname(entry.name).toLowerCase())) {
        out.push(rel);
      }
    }
  }
  await walk(root, "");
  return out.sort();
}
