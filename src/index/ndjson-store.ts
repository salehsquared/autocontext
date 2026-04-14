import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";

import type {
  DirEdge,
  FileFingerprint,
  FileId,
  ImportEdge,
  IndexManifest,
  IndexSymbol,
  Reference,
} from "./types.js";
import {
  collectionDir,
  dirEdgesPath,
  fingerprintsPath,
  indexRoot,
  lockPath,
  manifestPath,
  shardPath,
  tmpDir,
} from "./paths.js";
import { shardKeyForFile } from "./shard.js";
import { INDEX_VERSION, grammarHashesEqual } from "./version.js";
import { acquireLock, type LockHandle } from "./lock.js";
import { computeFileFingerprint, fileIsStable } from "./fingerprint.js";
import type { IndexStore, OpenIndexOptions } from "./store.js";

type ShardCollection = "symbols" | "imports" | "references";
const SHARD_COLLECTIONS: ShardCollection[] = ["symbols", "imports", "references"];

export async function openNdjsonIndex(
  projectRoot: string,
  options: OpenIndexOptions = {},
): Promise<IndexStore> {
  const readOnly = options.readOnly ?? false;
  const autoRebuild = options.autoRebuild ?? !readOnly;

  await mkdir(indexRoot(projectRoot), { recursive: true });
  for (const c of SHARD_COLLECTIONS) {
    await mkdir(collectionDir(projectRoot, c), { recursive: true });
  }
  await mkdir(tmpDir(projectRoot), { recursive: true });

  const lock = await acquireLock(
    lockPath(projectRoot),
    readOnly ? "shared" : "exclusive",
  );

  // Sweep stray tmp files from a prior crash.
  if (!readOnly) {
    try {
      const stale = await readdir(tmpDir(projectRoot));
      await Promise.all(
        stale.map((n) => rm(join(tmpDir(projectRoot), n), { force: true })),
      );
    } catch {
      /* fresh dir; nothing to sweep */
    }
  }

  const manifest = await loadOrInitManifest(projectRoot, {
    autoRebuild,
    readOnly,
    autocontextVersion: options.autocontextVersion ?? "0.0.0-dev",
    grammarHashes: options.grammarHashes ?? {},
  });

  return new NdjsonIndexStore(projectRoot, manifest, lock);
}

async function loadOrInitManifest(
  projectRoot: string,
  opts: {
    autoRebuild: boolean;
    readOnly: boolean;
    autocontextVersion: string;
    grammarHashes: Record<string, string>;
  },
): Promise<IndexManifest> {
  const mPath = manifestPath(projectRoot);
  const freshManifest = (): IndexManifest => ({
    index_version: INDEX_VERSION,
    autocontext_version: opts.autocontextVersion,
    project_root: projectRoot,
    last_full_build: new Date(0).toISOString(),
    file_count: 0,
    grammar_hashes: opts.grammarHashes,
  });

  let existing: IndexManifest | null = null;
  try {
    const raw = await readFile(mPath, "utf8");
    existing = JSON.parse(raw) as IndexManifest;
  } catch {
    existing = null;
  }

  const needsRebuild =
    existing === null ||
    existing.index_version !== INDEX_VERSION ||
    existing.project_root !== projectRoot ||
    !grammarHashesEqual(existing.grammar_hashes ?? {}, opts.grammarHashes);

  if (!needsRebuild) return existing!;

  if (!opts.autoRebuild) {
    const err = new Error(
      `autocontext index needs rebuild (version or layout mismatch). Run \`context index --rebuild\`.`,
    ) as Error & { code?: string };
    err.code = "EAUTOCONTEXTREBUILD";
    throw err;
  }

  // Wipe NDJSONs and dir_edges; keep .lock and .tmp.
  for (const c of SHARD_COLLECTIONS) {
    await rm(collectionDir(projectRoot, c), { recursive: true, force: true });
    await mkdir(collectionDir(projectRoot, c), { recursive: true });
  }
  await rm(fingerprintsPath(projectRoot), { force: true });
  await rm(dirEdgesPath(projectRoot), { force: true });

  const fresh = freshManifest();
  await atomicWriteJson(mPath, fresh, tmpDir(projectRoot));
  return fresh;
}

class NdjsonIndexStore implements IndexStore {
  public manifest: IndexManifest;
  private readonly projectRoot: string;
  private readonly lock: LockHandle;
  private readonly shardMutex = new Map<string, Promise<void>>();
  private fingerprintMutex: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(projectRoot: string, manifest: IndexManifest, lock: LockHandle) {
    this.projectRoot = projectRoot;
    this.manifest = manifest;
    this.lock = lock;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.lock.release();
  }

  // --- writers ---

  async writeFile(input: {
    file: FileId;
    symbols: IndexSymbol[];
    imports: ImportEdge[];
    references: Reference[];
    fingerprint: FileFingerprint;
  }): Promise<void> {
    const shard = shardKeyForFile(input.file);
    await this.underShardLock(shard, async () => {
      await rewriteShard(
        shardPath(this.projectRoot, "symbols", shard),
        (row: IndexSymbol) => row.file !== input.file,
        input.symbols,
        tmpDir(this.projectRoot),
      );
      await rewriteShard(
        shardPath(this.projectRoot, "imports", shard),
        (row: ImportEdge) => row.from !== input.file,
        input.imports,
        tmpDir(this.projectRoot),
      );
      await rewriteShard(
        shardPath(this.projectRoot, "references", shard),
        (row: Reference) => row.file !== input.file,
        input.references,
        tmpDir(this.projectRoot),
      );
    });
    await this.underFingerprintLock(async () => {
      await rewriteShard(
        fingerprintsPath(this.projectRoot),
        (row: FileFingerprint) => row.file !== input.file,
        [input.fingerprint],
        tmpDir(this.projectRoot),
      );
    });
  }

  async dropFile(file: FileId): Promise<void> {
    const shard = shardKeyForFile(file);
    await this.underShardLock(shard, async () => {
      await rewriteShard(
        shardPath(this.projectRoot, "symbols", shard),
        (row: IndexSymbol) => row.file !== file,
        [],
        tmpDir(this.projectRoot),
      );
      await rewriteShard(
        shardPath(this.projectRoot, "imports", shard),
        (row: ImportEdge) => row.from !== file,
        [],
        tmpDir(this.projectRoot),
      );
      await rewriteShard(
        shardPath(this.projectRoot, "references", shard),
        (row: Reference) => row.file !== file,
        [],
        tmpDir(this.projectRoot),
      );
    });
    await this.underFingerprintLock(async () => {
      await rewriteShard(
        fingerprintsPath(this.projectRoot),
        (row: FileFingerprint) => row.file !== file,
        [],
        tmpDir(this.projectRoot),
      );
    });
  }

  async recomputeDirEdges(): Promise<void> {
    const weights = new Map<string, number>();
    for await (const edge of this.scanImports()) {
      if (!edge.resolved_to) continue;
      const fromDir = dirOf(edge.from);
      const toDir = dirOf(edge.resolved_to);
      if (fromDir === toDir) continue;
      const key = `${fromDir}\u0000${toDir}`;
      weights.set(key, (weights.get(key) ?? 0) + 1);
    }
    const edges: DirEdge[] = [];
    for (const [key, weight] of weights) {
      const [from_dir, to_dir] = key.split("\u0000");
      edges.push({ from_dir, to_dir, weight });
    }
    edges.sort((a, b) =>
      a.from_dir === b.from_dir
        ? a.to_dir.localeCompare(b.to_dir)
        : a.from_dir.localeCompare(b.from_dir),
    );
    await atomicWriteJson(
      dirEdgesPath(this.projectRoot),
      edges,
      tmpDir(this.projectRoot),
    );
  }

  async writeManifest(update: Partial<IndexManifest>): Promise<void> {
    this.manifest = {
      ...this.manifest,
      ...update,
      index_version: INDEX_VERSION,
      project_root: this.projectRoot,
    };
    await atomicWriteJson(
      manifestPath(this.projectRoot),
      this.manifest,
      tmpDir(this.projectRoot),
    );
  }

  // --- incremental planning ---

  async diffAgainstDisk(
    projectRoot: string,
    candidateFiles: FileId[],
  ): Promise<{
    changed: FileId[];
    added: FileId[];
    removed: FileId[];
    unchanged: FileId[];
  }> {
    const stored = new Map<FileId, FileFingerprint>();
    for (const row of await readNdjsonAll<FileFingerprint>(
      fingerprintsPath(this.projectRoot),
    )) {
      stored.set(row.file, row);
    }

    const candidateSet = new Set(candidateFiles);
    const changed: FileId[] = [];
    const added: FileId[] = [];
    const unchanged: FileId[] = [];

    for (const f of candidateFiles) {
      const prior = stored.get(f);
      const abs = join(projectRoot, f);
      if (!prior) {
        added.push(f);
        continue;
      }
      if (await fileIsStable(abs, prior)) {
        unchanged.push(f);
        continue;
      }
      // Fast-path miss; confirm with a full hash.
      try {
        const fresh = await computeFileFingerprint(abs, f);
        if (fresh.content_hash === prior.content_hash) {
          unchanged.push(f);
        } else {
          changed.push(f);
        }
      } catch {
        // File vanished mid-diff — treat as removed on next pass.
        changed.push(f);
      }
    }

    const removed: FileId[] = [];
    for (const f of stored.keys()) {
      if (!candidateSet.has(f)) removed.push(f);
    }

    return { changed, added, removed, unchanged };
  }

  // --- readers ---

  async getFileSymbols(file: FileId): Promise<IndexSymbol[]> {
    const shard = shardKeyForFile(file);
    const all = await readNdjsonAll<IndexSymbol>(
      shardPath(this.projectRoot, "symbols", shard),
    );
    const rows = all.filter((s) => s.file === file);
    rows.sort((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind.localeCompare(b.kind),
    );
    return rows;
  }

  async getFileImports(file: FileId): Promise<ImportEdge[]> {
    const shard = shardKeyForFile(file);
    const all = await readNdjsonAll<ImportEdge>(
      shardPath(this.projectRoot, "imports", shard),
    );
    const rows = all.filter((e) => e.from === file);
    rows.sort((a, b) =>
      a.raw === b.raw ? a.line - b.line : a.raw.localeCompare(b.raw),
    );
    return rows;
  }

  async getFileFingerprint(file: FileId): Promise<FileFingerprint | null> {
    for (const row of await readNdjsonAll<FileFingerprint>(
      fingerprintsPath(this.projectRoot),
    )) {
      if (row.file === file) return row;
    }
    return null;
  }

  async findSymbolsByName(
    name: string,
    scope?: { file?: FileId; dir?: string },
  ): Promise<IndexSymbol[]> {
    if (scope?.file) {
      return (await this.getFileSymbols(scope.file)).filter((s) => s.name === name);
    }
    const shardKey = scope?.dir ? shardKeyForFile(`${scope.dir}/x`) : null;
    const out: IndexSymbol[] = [];
    for (const shard of shardKey ? [shardKey] : await this.listShards("symbols")) {
      const rows = await readNdjsonAll<IndexSymbol>(
        shardPath(this.projectRoot, "symbols", shard),
      );
      for (const s of rows) {
        if (s.name !== name) continue;
        if (scope?.dir && !s.file.startsWith(`${scope.dir}/`)) continue;
        out.push(s);
      }
    }
    return out;
  }

  async getSymbol(id: string): Promise<IndexSymbol | null> {
    const hash = id.indexOf("#");
    if (hash <= 0) return null;
    const file = id.slice(0, hash);
    for (const s of await this.getFileSymbols(file)) {
      if (s.id === id) return s;
    }
    return null;
  }

  async getReferencesTo(symbolId: string): Promise<Reference[]> {
    const out: Reference[] = [];
    for (const shard of await this.listShards("references")) {
      for (const r of await readNdjsonAll<Reference>(
        shardPath(this.projectRoot, "references", shard),
      )) {
        if (r.symbol_id === symbolId) out.push(r);
      }
    }
    return out;
  }

  async getReferencesFrom(file: FileId): Promise<Reference[]> {
    const shard = shardKeyForFile(file);
    const rows = await readNdjsonAll<Reference>(
      shardPath(this.projectRoot, "references", shard),
    );
    return rows.filter((r) => r.file === file);
  }

  async *scanImports(filter?: {
    fromGlob?: string;
    toGlob?: string;
  }): AsyncIterable<ImportEdge> {
    const fromRe = filter?.fromGlob ? globToRegex(filter.fromGlob) : null;
    const toRe = filter?.toGlob ? globToRegex(filter.toGlob) : null;
    for (const shard of await this.listShards("imports")) {
      for (const edge of await readNdjsonAll<ImportEdge>(
        shardPath(this.projectRoot, "imports", shard),
      )) {
        if (fromRe && !fromRe.test(edge.from)) continue;
        if (toRe && !(edge.resolved_to && toRe.test(edge.resolved_to))) continue;
        yield edge;
      }
    }
  }

  async getDirEdges(): Promise<DirEdge[]> {
    try {
      const raw = await readFile(dirEdgesPath(this.projectRoot), "utf8");
      return JSON.parse(raw) as DirEdge[];
    } catch {
      return [];
    }
  }

  async getImporters(file: FileId): Promise<FileId[]> {
    const out = new Set<FileId>();
    for await (const edge of this.scanImports()) {
      if (edge.resolved_to === file) out.add(edge.from);
    }
    return [...out].sort();
  }

  async getImportees(file: FileId): Promise<FileId[]> {
    const edges = await this.getFileImports(file);
    const out = new Set<FileId>();
    for (const e of edges) {
      if (e.resolved_to) out.add(e.resolved_to);
    }
    return [...out].sort();
  }

  // --- internals ---

  private async listShards(c: ShardCollection): Promise<string[]> {
    try {
      const entries = await readdir(collectionDir(this.projectRoot, c));
      return entries
        .filter((n) => n.endsWith(".ndjson"))
        .map((n) => n.slice(0, -".ndjson".length))
        .sort();
    } catch {
      return [];
    }
  }

  private async underShardLock<T>(shard: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.shardMutex.get(shard) ?? Promise.resolve();
    let release: () => void = () => {};
    const next = new Promise<void>((r) => (release = r));
    this.shardMutex.set(shard, prior.then(() => next));
    try {
      await prior;
      return await fn();
    } finally {
      release();
      // Clean up when we're the tail.
      if (this.shardMutex.get(shard) === prior.then(() => next)) {
        this.shardMutex.delete(shard);
      }
    }
  }

  private async underFingerprintLock<T>(fn: () => Promise<T>): Promise<T> {
    const prior = this.fingerprintMutex;
    let release: () => void = () => {};
    const next = new Promise<void>((r) => (release = r));
    this.fingerprintMutex = prior.then(() => next);
    try {
      await prior;
      return await fn();
    } finally {
      release();
    }
  }
}

// --- NDJSON helpers ---

async function readNdjsonAll<T>(path: string): Promise<T[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const lines = raw.split("\n");
  const out: T[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === "") continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // Drop last truncated line from a crashed writer; any other parse error
      // is a bug in the writer — drop quietly and keep going.
      if (i === lines.length - 1) continue;
    }
  }
  return out;
}

/**
 * Atomic write: rewrite a whole shard file by filtering existing rows and
 * appending new ones, then rename a tmp file into place. Never appends in
 * place — avoids readers seeing half-written lines.
 */
async function rewriteShard<T>(
  path: string,
  keep: (row: T) => boolean,
  append: T[],
  tmpDirPath: string,
): Promise<void> {
  const existing = await readNdjsonAll<T>(path);
  const filtered = existing.filter(keep);
  const combined = [...filtered, ...append];

  if (combined.length === 0 && !existsSync(path)) return;

  await mkdir(dirname(path), { recursive: true });
  const contents = combined.map((row) => JSON.stringify(row)).join("\n") +
    (combined.length > 0 ? "\n" : "");
  const tmp = join(
    tmpDirPath,
    `${basename(path)}.${process.pid}.${rand()}.tmp`,
  );
  await mkdir(tmpDirPath, { recursive: true });
  await writeFile(tmp, contents);
  await rename(tmp, path);
}

async function atomicWriteJson(
  path: string,
  value: unknown,
  tmpDirPath: string,
): Promise<void> {
  await mkdir(tmpDirPath, { recursive: true });
  const tmp = join(
    tmpDirPath,
    `${basename(path)}.${process.pid}.${rand()}.tmp`,
  );
  await writeFile(tmp, JSON.stringify(value, null, 2));
  await rename(tmp, path);
}

function rand(): string {
  return createHash("sha1")
    .update(`${Date.now()}-${Math.random()}`)
    .digest("hex")
    .slice(0, 8);
}

function dirOf(fileId: FileId): string {
  const slash = fileId.lastIndexOf("/");
  if (slash === -1) return ".";
  return fileId.slice(0, slash);
}

function globToRegex(glob: string): RegExp {
  // Very small glob dialect: `*` matches any run of non-slash; `**` matches anything.
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${re}$`);
}

/** Exported for tests. */
export const _internals = { readNdjsonAll, rewriteShard, globToRegex };
