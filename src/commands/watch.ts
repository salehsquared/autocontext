import { resolve, posix } from "node:path";
import { watch as chokidarWatch } from "chokidar";
import { scanProject, flattenBottomUp } from "../core/scanner.js";
import { readContext, UnsupportedVersionError } from "../core/writer.js";
import { checkFreshness, legacyState } from "../core/fingerprint.js";
import { freshnessIcon, heading, dim } from "../utils/display.js";
import { loadScanOptions } from "../utils/scan-options.js";
import { loadConfig } from "../utils/config.js";
import { filterByMinTokens } from "../utils/tokens.js";
import type { ScanResult } from "../core/scanner.js";
import type { FreshnessState } from "../core/fingerprint.js";

interface DirState {
  dir: ScanResult;
  state: FreshnessState;
}

function normalizePathForMatch(input: string): string {
  const normalized = input.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized || "/";
}

export function findTrackedDirForFile(
  filePath: string,
  rootPath: string,
  trackedDirPaths: Iterable<string>,
): string | undefined {
  const rootNormalized = normalizePathForMatch(rootPath);
  const trackedNormalized = new Set(
    Array.from(trackedDirPaths, (path) => normalizePathForMatch(path)),
  );

  let candidate = normalizePathForMatch(posix.dirname(filePath.replace(/\\/g, "/")));

  while (candidate.length >= rootNormalized.length) {
    if (trackedNormalized.has(candidate)) return candidate;
    const parent = normalizePathForMatch(posix.dirname(candidate));
    if (parent === candidate) break;
    candidate = parent;
  }

  return undefined;
}

/**
 * Watch for file changes and report staleness in real-time.
 * Read-only: never writes to disk.
 */
export async function watchCommand(
  options: { path?: string; interval?: string },
): Promise<void> {
  const rootPath = resolve(options.path ?? ".");
  const parsedInterval = Number.parseInt(options.interval ?? "500", 10);
  const debounceMs = Number.isFinite(parsedInterval) && parsedInterval > 0 ? parsedInterval : 500;

  const config = await loadConfig(rootPath);
  const scanOptions = await loadScanOptions(rootPath);
  const scanResult = await scanProject(rootPath, scanOptions);
  const allDirs = flattenBottomUp(scanResult);
  const { dirs } = await filterByMinTokens(allDirs, config?.min_tokens);

  // Compute initial state
  const dirStates = new Map<string, DirState>();
  let freshCount = 0;
  let staleCount = 0;
  let missingCount = 0;

  console.log(heading("\ncontext watch\n"));
  console.log(`  Watching ${rootPath}`);
  console.log(`  Debounce: ${debounceMs}ms`);
  console.log(`  Press Ctrl+C to stop.\n`);

  for (const dir of dirs) {
    let context;
    try {
      context = await readContext(dir.path);
    } catch (err) {
      if (err instanceof UnsupportedVersionError) {
        console.log(dim(`  ${dir.relativePath}: ${err.message} (skipped)`));
        context = null;
      } else {
        throw err;
      }
    }
    let state: FreshnessState;

    if (context) {
      const result = await checkFreshness(dir.path, context.fingerprint);
      state = result.state;
    } else {
      state = "missing";
    }

    dirStates.set(dir.path, { dir, state });
    const label = dir.relativePath === "." ? "(root)" : dir.relativePath;
    console.log(`  ${freshnessIcon(state)}  ${label}`);

    if (state === "fresh") freshCount++;
    else if (legacyState(state) === "stale") staleCount++;
    else missingCount++;
  }

  console.log(
    `\n  ${freshCount} fresh, ${staleCount} stale, ${missingCount} missing\n`,
  );

  // Build a map from normalized directory path to ScanResult for quick lookup
  const dirByPath = new Map<string, ScanResult>();
  for (const dir of dirs) {
    dirByPath.set(normalizePathForMatch(dir.path), dir);
  }

  // Track debounce timers per directory
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  async function recheckDir(dir: ScanResult): Promise<void> {
    let context;
    try {
      context = await readContext(dir.path);
    } catch (err) {
      if (err instanceof UnsupportedVersionError) {
        context = null;
      } else {
        throw err;
      }
    }
    let newState: FreshnessState;

    if (context) {
      const result = await checkFreshness(dir.path, context.fingerprint);
      newState = result.state;
    } else {
      newState = "missing";
    }

    const prev = dirStates.get(dir.path);
    if (prev && prev.state !== newState) {
      dirStates.set(dir.path, { dir, state: newState });
      const label = dir.relativePath === "." ? "(root)" : dir.relativePath;
      const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
      console.log(`  ${dim(time)}  ${freshnessIcon(newState)}  ${label}  ${dim("(files changed)")}`);
    }
  }

  // Watch all tracked directories
  const watchPaths = dirs.map((d) => d.path);
  const watcher = chokidarWatch(watchPaths, {
    ignored: [
      /node_modules/,
      /\.git/,
      /\.context\.yaml$/,
      /\.context\.config\.yaml$/,
    ],
    persistent: true,
    ignoreInitial: true,
    depth: 0, // Only watch direct files, not subdirectories
  });

  watcher.on("all", (_event, filePath) => {
    const parentPath = findTrackedDirForFile(filePath, rootPath, dirByPath.keys());
    const dir = parentPath ? dirByPath.get(parentPath) : undefined;
    if (!dir) return;

    // Debounce per directory
    const existing = timers.get(dir.path);
    if (existing) clearTimeout(existing);

    timers.set(
      dir.path,
      setTimeout(() => {
        timers.delete(dir.path);
        recheckDir(dir).catch(() => {});
      }, debounceMs),
    );
  });

  // Graceful shutdown
  const cleanup = () => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    watcher.close().catch(() => {});
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}
