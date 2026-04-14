import { mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Minimal advisory file lock for `.autocontext/index/.lock`.
 *
 * Plan (T1-A §9) names `proper-lockfile`, but in v1 we use a hand-rolled
 * O_EXCL+PID approach to keep us on zero runtime deps. Contract:
 *
 *   - exclusive lock blocks all other exclusive *and* shared lock attempts;
 *   - shared locks coexist with other shared locks;
 *   - stale locks (owning PID no longer alive) are reclaimed;
 *   - blocked acquirers retry with jittered backoff up to `timeoutMs`.
 *
 * Cross-platform note: NFS / network FS may see weaker semantics. Documented
 * in src/index/README.md.
 */

export type LockMode = "exclusive" | "shared";

export interface LockHandle {
  readonly mode: LockMode;
  release(): Promise<void>;
}

interface LockContents {
  mode: LockMode;
  pid: number;
  readers: number; // >= 1 when mode === "shared"
  acquired_at: number;
}

const EXCL_RETRY_MS = 40;
const SHARED_RETRY_MS = 20;

export async function acquireLock(
  lockFilePath: string,
  mode: LockMode,
  timeoutMs = 10_000,
): Promise<LockHandle> {
  await mkdir(dirname(lockFilePath), { recursive: true });
  const start = Date.now();

  while (true) {
    const attempt = await tryAcquire(lockFilePath, mode);
    if (attempt.ok) {
      return makeHandle(lockFilePath, mode);
    }
    if (Date.now() - start > timeoutMs) {
      const err = new Error(
        `autocontext index is locked (mode=${attempt.heldMode ?? "?"}, pid=${attempt.heldPid ?? "?"})`,
      ) as Error & { code?: string };
      err.code = "EAUTOCONTEXTLOCKED";
      throw err;
    }
    const base = mode === "exclusive" ? EXCL_RETRY_MS : SHARED_RETRY_MS;
    await sleep(base + Math.random() * base);
  }
}

async function tryAcquire(
  lockFilePath: string,
  mode: LockMode,
): Promise<{ ok: boolean; heldMode?: LockMode; heldPid?: number }> {
  // First: try O_EXCL create. If successful, nobody else holds the lock.
  try {
    const fh = await open(lockFilePath, "wx");
    const contents: LockContents = {
      mode,
      pid: process.pid,
      readers: mode === "shared" ? 1 : 0,
      acquired_at: Date.now(),
    };
    await fh.writeFile(JSON.stringify(contents));
    await fh.close();
    return { ok: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }

  // Lock file already exists. Inspect it.
  let held: LockContents;
  try {
    const raw = await readFile(lockFilePath, "utf8");
    held = JSON.parse(raw) as LockContents;
  } catch {
    // Corrupt lock file — treat as stale and try to clear it.
    await rm(lockFilePath, { force: true });
    return { ok: false };
  }

  if (!pidAlive(held.pid)) {
    await rm(lockFilePath, { force: true });
    return { ok: false };
  }

  // Exclusive holders block every new acquirer.
  if (held.mode === "exclusive") {
    return { ok: false, heldMode: held.mode, heldPid: held.pid };
  }

  // Shared holders: additional shared acquirers OK, exclusive blocks.
  if (mode === "shared") {
    const next: LockContents = { ...held, readers: held.readers + 1 };
    try {
      await atomicRewrite(lockFilePath, JSON.stringify(next));
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  return { ok: false, heldMode: held.mode, heldPid: held.pid };
}

function makeHandle(lockFilePath: string, mode: LockMode): LockHandle {
  let released = false;
  return {
    mode,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      if (mode === "exclusive") {
        await rm(lockFilePath, { force: true });
        return;
      }
      // shared: decrement readers; remove file when last reader drops.
      try {
        const raw = await readFile(lockFilePath, "utf8");
        const held = JSON.parse(raw) as LockContents;
        if (held.readers <= 1) {
          await rm(lockFilePath, { force: true });
        } else {
          await atomicRewrite(
            lockFilePath,
            JSON.stringify({ ...held, readers: held.readers - 1 }),
          );
        }
      } catch {
        // Lock file already gone — best-effort release.
      }
    },
  };
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

async function atomicRewrite(path: string, contents: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}`;
  const { writeFile, rename } = await import("node:fs/promises");
  await writeFile(tmp, contents);
  await rename(tmp, path);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
