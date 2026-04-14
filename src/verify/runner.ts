import { spawn } from "node:child_process";

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  timedOut: boolean;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface RunOptions {
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}

const MAX_STREAM_BYTES = 5 * 1024 * 1024;
const SIGKILL_ESCALATION_MS = 5_000;
const TRUNCATION_FOOTER = "\n... [output truncated, exceeded 5 MiB]\n";

/**
 * Run a shell command with a wall-clock timeout, capped output streams, and
 * escalating kill (SIGTERM → SIGKILL 5 s later). Never rejects; partial results
 * are surfaced via `exitCode`, `signal`, and `timedOut`.
 */
export async function runVerifyCommand(
  command: string,
  opts: RunOptions,
): Promise<SpawnResult> {
  const started = Date.now();
  return await new Promise<SpawnResult>((resolve) => {
    const mergedEnv: NodeJS.ProcessEnv = { ...process.env, ...(opts.env ?? {}) };
    const child = spawn(command, {
      shell: true,
      cwd: opts.cwd,
      env: mergedEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutTruncated) return;
      if (stdoutBytes + chunk.length > MAX_STREAM_BYTES) {
        const remaining = MAX_STREAM_BYTES - stdoutBytes;
        if (remaining > 0) stdout += chunk.slice(0, remaining).toString("utf8");
        stdout += TRUNCATION_FOOTER;
        stdoutTruncated = true;
        stdoutBytes = MAX_STREAM_BYTES;
        return;
      }
      stdoutBytes += chunk.length;
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderrTruncated) return;
      if (stderrBytes + chunk.length > MAX_STREAM_BYTES) {
        const remaining = MAX_STREAM_BYTES - stderrBytes;
        if (remaining > 0) stderr += chunk.slice(0, remaining).toString("utf8");
        stderr += TRUNCATION_FOOTER;
        stderrTruncated = true;
        stderrBytes = MAX_STREAM_BYTES;
        return;
      }
      stderrBytes += chunk.length;
      stderr += chunk.toString("utf8");
    });

    let killTimer: NodeJS.Timeout | undefined;
    let escalationTimer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs > 0) {
      killTimer = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
        escalationTimer = setTimeout(() => {
          try { child.kill("SIGKILL"); } catch { /* ignore */ }
        }, SIGKILL_ESCALATION_MS);
      }, opts.timeoutMs);
    }

    child.on("error", (err) => {
      if (killTimer) clearTimeout(killTimer);
      if (escalationTimer) clearTimeout(escalationTimer);
      resolve({
        stdout,
        stderr: stderr + (stderr.endsWith("\n") ? "" : "\n") + `spawn error: ${err.message}\n`,
        exitCode: null,
        signal: null,
        durationMs: Date.now() - started,
        timedOut,
        stdoutTruncated,
        stderrTruncated,
      });
    });

    child.on("close", (code, signal) => {
      if (killTimer) clearTimeout(killTimer);
      if (escalationTimer) clearTimeout(escalationTimer);
      resolve({
        stdout,
        stderr,
        exitCode: code,
        signal: signal ?? null,
        durationMs: Date.now() - started,
        timedOut,
        stdoutTruncated,
        stderrTruncated,
      });
    });
  });
}
