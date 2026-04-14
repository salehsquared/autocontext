import { resolve, relative, extname } from "node:path";
import { readFile, rm } from "node:fs/promises";
import { scanProject, flattenBottomUp } from "../core/scanner.js";
import { ensureAutocontextGitignored } from "../core/gitignore.js";
import { loadScanOptions } from "../utils/scan-options.js";
import { successMsg, errorMsg, dim } from "../utils/display.js";
import { fingerprintsPath, indexRoot, toFileId } from "../index/paths.js";
import { openIndex } from "../index/store.js";
import { buildIndex, commitBuild } from "../index/builder.js";
import { analyzerSupports } from "../index/analyzer.js";
import type { FileId, FileFingerprint } from "../index/types.js";

export interface IndexCommandOptions {
  rebuild?: boolean;
  path?: string;
  /** Optional: skip the index build and just print file discovery — used by tests. */
  dryRun?: boolean;
}

/**
 * `context index [--rebuild] [--path <p>]`
 *
 * Builds or refreshes the local code index at `.autocontext/index/`. Always a
 * full rebuild in v1 — the cross-file reference resolver needs every file's
 * symbols available at once. The `--rebuild` flag additionally wipes the
 * on-disk index first so a stale manifest or leftover shards from a prior
 * INDEX_VERSION can't bleed through.
 */
export async function indexCommand(options: IndexCommandOptions = {}): Promise<void> {
  const rootPath = resolve(options.path ?? ".");
  const startedAt = Date.now();

  // Idempotent — fixes repos that were init'd before T1 landed.
  const giResult = await ensureAutocontextGitignored(rootPath);
  if (giResult.action === "appended") {
    console.log(successMsg(".autocontext/ added to .gitignore"));
  }

  if (options.rebuild) {
    await rm(indexRoot(rootPath), { recursive: true, force: true });
  }

  const files = await collectIndexableFiles(rootPath);
  if (options.dryRun) {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ files }, null, 2));
    return;
  }

  if (files.length === 0) {
    console.log(dim("No indexable source files found."));
    return;
  }

  const store = await openIndex(rootPath, { autoRebuild: true });
  try {
    const priorFiles = await listStoredFiles(rootPath);
    const build = await buildIndex(rootPath, files);
    await commitBuild(store, build, priorFiles);
    await store.writeManifest({
      file_count: build.files.length,
      last_full_build: new Date().toISOString(),
    });

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(2);
    console.log(
      successMsg(
        `.autocontext/index/ updated — ${build.files.length} files indexed in ${elapsed}s`,
      ),
    );
    if (build.fallbackFiles.length > 0) {
      console.log(
        dim(
          `    ${build.fallbackFiles.length} file${build.fallbackFiles.length === 1 ? "" : "s"} analyzed in fallback mode (no refs)`,
        ),
      );
    }
    if (build.parseErrors.length > 0) {
      console.log(
        dim(
          `    ${build.parseErrors.length} parse error${build.parseErrors.length === 1 ? "" : "s"} (skipped)`,
        ),
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(errorMsg(`context index failed: ${msg}`));
    process.exitCode = 1;
  } finally {
    await store.close();
  }
}

/** Collect every FileId the analyzer knows how to process, under rootPath. */
export async function collectIndexableFiles(rootPath: string): Promise<FileId[]> {
  const scanOptions = await loadScanOptions(rootPath);
  const scanResult = await scanProject(rootPath, scanOptions);
  const dirs = flattenBottomUp(scanResult);

  const out: FileId[] = [];
  for (const dir of dirs) {
    for (const filename of dir.files) {
      const ext = extname(filename).toLowerCase();
      if (!analyzerSupports(ext)) continue;
      const rel = relative(rootPath, `${dir.path}/${filename}`);
      out.push(toFileId(rel));
    }
  }
  out.sort();
  return out;
}

/** Reads every FileId currently recorded in fingerprints.ndjson. */
async function listStoredFiles(rootPath: string): Promise<FileId[]> {
  try {
    const raw = await readFile(fingerprintsPath(rootPath), "utf8");
    const out: FileId[] = [];
    for (const line of raw.split("\n")) {
      if (line === "") continue;
      try {
        const fp = JSON.parse(line) as FileFingerprint;
        out.push(fp.file);
      } catch {
        // Last-line truncation after a crashed writer — ignore.
      }
    }
    return out;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}
