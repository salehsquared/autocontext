import { mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Advisory lock layout for `.autocontext/index/.lock`:
 *
 *   - `.lock` is an exclusive sentinel acquired with O_EXCL
 *   - `.lock.readers/` contains one lease file per shared holder
 *
 * This avoids the read-modify-write race in the old shared-reader counter.
 */

export type LockMode = "exclusive" | "shared";

export interface LockHandle {
  readonly mode: LockMode;
  release(): Promise<void>;
}

interface LockOwner {
  mode: LockMode;
  pid: number;
  acquired_at: number;
}

interface SharedLease extends LockOwner {
  mode: "shared";
}

interface ExclusiveSentinel extends LockOwner {
  mode: "exclusive";
}

interface LegacySharedLock extends LockOwner {
  mode: "shared";
  readers?: number;
}

type SignalName = "SIGINT" | "SIGTERM";
type CleanupFn = () => Promise<void>;

const EXCL_RETRY_MS = 40;
const SHARED_RETRY_MS = 20;
const SIGNAL_EXIT_CODES: Record<SignalName, number> = {
  SIGINT: 130,
  SIGTERM: 143,
};

const processCleanups = new Set<CleanupFn>();
let cleanupHandlersInstalled = false;
let signalCleanupInFlight = false;

export async function acquireLock(
  lockFilePath: string,
  mode: LockMode,
  timeoutMs = 10_000,
): Promise<LockHandle> {
  await mkdir(dirname(lockFilePath), { recursive: true });
  await mkdir(readersDir(lockFilePath), { recursive: true });
  ensureProcessCleanupHandlers();

  return mode === "exclusive"
    ? acquireExclusiveLock(lockFilePath, timeoutMs)
    : acquireSharedLock(lockFilePath, timeoutMs);
}

async function acquireExclusiveLock(
  lockFilePath: string,
  timeoutMs: number,
): Promise<LockHandle> {
  const start = Date.now();

  while (true) {
    const attempt = await tryAcquireExclusiveSentinel(lockFilePath);
    if (attempt.ok) {
      try {
        await waitForReadersToDrain(lockFilePath, start, timeoutMs);
        return makeExclusiveHandle(lockFilePath);
      } catch (err) {
        await removeSentinel(lockFilePath);
        throw err;
      }
    }

    if (Date.now() - start > timeoutMs) {
      throw lockedError(attempt.heldMode, attempt.heldPid);
    }

    await sleep(EXCL_RETRY_MS + Math.random() * EXCL_RETRY_MS);
  }
}

async function acquireSharedLock(
  lockFilePath: string,
  timeoutMs: number,
): Promise<LockHandle> {
  const start = Date.now();

  while (true) {
    const attempt = await tryAcquireSharedLease(lockFilePath);
    if (attempt.ok) {
      return makeSharedHandle(attempt.leasePath);
    }

    if (Date.now() - start > timeoutMs) {
      throw lockedError(attempt.heldMode, attempt.heldPid);
    }

    await sleep(SHARED_RETRY_MS + Math.random() * SHARED_RETRY_MS);
  }
}

async function tryAcquireExclusiveSentinel(
  lockFilePath: string,
): Promise<{ ok: true } | { ok: false; heldMode?: LockMode; heldPid?: number }> {
  try {
    const fh = await open(lockFilePath, "wx");
    const payload: ExclusiveSentinel = {
      mode: "exclusive",
      pid: process.pid,
      acquired_at: Date.now(),
    };
    await fh.writeFile(JSON.stringify(payload));
    await fh.close();
    return { ok: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }

  const held = await readLiveSentinel(lockFilePath);
  if (!held) return { ok: false };
  return { ok: false, heldMode: held.mode, heldPid: held.pid };
}

async function tryAcquireSharedLease(
  lockFilePath: string,
): Promise<
  | { ok: true; leasePath: string }
  | { ok: false; heldMode?: LockMode; heldPid?: number }
> {
  const before = await readLiveSentinel(lockFilePath);
  if (before) {
    return { ok: false, heldMode: before.mode, heldPid: before.pid };
  }

  const leasePath = join(
    readersDir(lockFilePath),
    `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.json`,
  );

  try {
    const fh = await open(leasePath, "wx");
    const payload: SharedLease = {
      mode: "shared",
      pid: process.pid,
      acquired_at: Date.now(),
    };
    await fh.writeFile(JSON.stringify(payload));
    await fh.close();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      return { ok: false };
    }
    throw err;
  }

  const after = await readLiveSentinel(lockFilePath);
  if (!after) {
    return { ok: true, leasePath };
  }

  await rm(leasePath, { force: true });
  return { ok: false, heldMode: after.mode, heldPid: after.pid };
}

async function waitForReadersToDrain(
  lockFilePath: string,
  start: number,
  timeoutMs: number,
): Promise<void> {
  while (true) {
    const leases = await listLiveReaderLeases(lockFilePath);
    if (leases.length === 0) return;

    if (Date.now() - start > timeoutMs) {
      throw lockedError("shared", leases[0]?.pid);
    }

    await sleep(EXCL_RETRY_MS + Math.random() * EXCL_RETRY_MS);
  }
}

async function listLiveReaderLeases(lockFilePath: string): Promise<SharedLease[]> {
  const dir = readersDir(lockFilePath);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const live: SharedLease[] = [];
  for (const entry of entries) {
    const leasePath = join(dir, entry);
    let parsed: SharedLease | null = null;
    try {
      const raw = await readFile(leasePath, "utf8");
      const candidate = JSON.parse(raw) as SharedLease;
      if (candidate.mode === "shared" && pidAlive(candidate.pid)) {
        parsed = candidate;
      }
    } catch {
      // Treat corrupt lease files as stale.
    }

    if (parsed) {
      live.push(parsed);
      continue;
    }

    await rm(leasePath, { force: true });
  }

  live.sort((a, b) => a.acquired_at - b.acquired_at || a.pid - b.pid);
  return live;
}

async function readLiveSentinel(lockFilePath: string): Promise<LockOwner | null> {
  let raw: string;
  try {
    raw = await readFile(lockFilePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }

  let parsed: ExclusiveSentinel | LegacySharedLock;
  try {
    parsed = JSON.parse(raw) as ExclusiveSentinel | LegacySharedLock;
  } catch {
    await removeSentinel(lockFilePath);
    return null;
  }

  if ((parsed.mode !== "exclusive" && parsed.mode !== "shared") || !pidAlive(parsed.pid)) {
    await removeSentinel(lockFilePath);
    return null;
  }

  return parsed;
}

function makeExclusiveHandle(lockFilePath: string): LockHandle {
  let released = false;
  const cleanup = async () => {
    if (released) return;
    released = true;
    unregister();
    await removeSentinel(lockFilePath);
  };
  const unregister = registerCleanup(cleanup);

  return {
    mode: "exclusive",
    release: cleanup,
  };
}

function makeSharedHandle(leasePath: string): LockHandle {
  let released = false;
  const cleanup = async () => {
    if (released) return;
    released = true;
    unregister();
    await rm(leasePath, { force: true });
  };
  const unregister = registerCleanup(cleanup);

  return {
    mode: "shared",
    release: cleanup,
  };
}

function ensureProcessCleanupHandlers(): void {
  if (cleanupHandlersInstalled) return;
  cleanupHandlersInstalled = true;

  for (const signal of Object.keys(SIGNAL_EXIT_CODES) as SignalName[]) {
    process.on(signal, () => {
      if (signalCleanupInFlight) return;
      signalCleanupInFlight = true;
      const cleanups = [...processCleanups].map(async (fn) => {
        try {
          await fn();
        } catch {
          // Best-effort only during process teardown.
        }
      });
      void Promise.all(cleanups).finally(() => {
        process.exit(SIGNAL_EXIT_CODES[signal]);
      });
    });
  }
}

function registerCleanup(fn: CleanupFn): () => void {
  processCleanups.add(fn);
  return () => {
    processCleanups.delete(fn);
  };
}

function readersDir(lockFilePath: string): string {
  return `${lockFilePath}.readers`;
}

async function removeSentinel(lockFilePath: string): Promise<void> {
  await rm(lockFilePath, { force: true });
}

function lockedError(heldMode?: LockMode, heldPid?: number): Error & { code?: string } {
  const err = new Error(
    `autocontext index is locked (mode=${heldMode ?? "?"}, pid=${heldPid ?? "?"})`,
  ) as Error & { code?: string };
  err.code = "EAUTOCONTEXTLOCKED";
  return err;
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
