import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { ConfigFile, Evidence, VerifyCommand, VerifyKind } from "../core/schema.js";
import { getVerifyCommand } from "../utils/config.js";
import { readContext } from "../core/writer.js";
import { writeContextAtomic } from "./writeback.js";
import { runVerifyCommand, type SpawnResult } from "./runner.js";
import { PARSERS, pickParser } from "./parsers/index.js";
import type { ParserId } from "./parsers/types.js";
import { resolveGitHeadSha } from "../generator/evidence.js";

export const VERIFY_KINDS: VerifyKind[] = ["test", "typecheck", "lint", "coverage", "build"];

export interface VerifyKindRun {
  kind: VerifyKind;
  command: string;
  exit_code: number | null;
  duration_ms: number;
  timed_out: boolean;
  parser: ParserId;
  parsed_to: Partial<Evidence>;
  parser_warnings: string[];
}

export interface VerifyKindSkipped {
  kind: VerifyKind;
  reason: "not_configured" | "filtered_out";
}

export interface VerifyScopeReport {
  scope: string;
  ran: VerifyKindRun[];
  skipped: VerifyKindSkipped[];
  evidence_written: boolean;
  status: "ok" | "partial" | "failed" | "no_context";
}

export interface VerifyRunReport {
  root: string;
  started_at: string;
  finished_at: string;
  scopes: VerifyScopeReport[];
  totals: {
    passing: number;
    failing: number;
    clean: number;
    errors: number;
    unknown: number;
  };
}

export interface OrchestratorOptions {
  projectRoot: string;
  scopes: Array<{ relative: string; absolute: string }>;
  config: ConfigFile;
  onlyKinds?: Set<VerifyKind>;
  timeoutSecondsOverride?: number;
  merge: boolean;
  dryRun: boolean;
  /** Test seam: override the spawn runner. */
  runFn?: (command: string, opts: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv }) => Promise<SpawnResult>;
  /** Test seam: override the git-SHA resolver. */
  shaFn?: (dir: string) => Promise<string | null>;
}

export async function runVerify(opts: OrchestratorOptions): Promise<VerifyRunReport> {
  const startedAt = new Date().toISOString();
  const scopes: VerifyScopeReport[] = [];
  const totals = { passing: 0, failing: 0, clean: 0, errors: 0, unknown: 0 };
  const runFn = opts.runFn ?? runVerifyCommand;
  const shaFn = opts.shaFn ?? resolveGitHeadSha;
  const defaultTimeoutMs =
    (opts.timeoutSecondsOverride ??
      opts.config.verify?.default_timeout_seconds ??
      600) * 1000;

  for (const scope of opts.scopes) {
    const report: VerifyScopeReport = {
      scope: scope.relative,
      ran: [],
      skipped: [],
      evidence_written: false,
      status: "ok",
    };
    const runsToKeep: VerifyKindRun[] = [];
    for (const kind of VERIFY_KINDS) {
      const command = getVerifyCommand(opts.config, kind, scope.relative);
      if (!command) {
        report.skipped.push({ kind, reason: "not_configured" });
        continue;
      }
      if (opts.onlyKinds && !opts.onlyKinds.has(kind)) {
        report.skipped.push({ kind, reason: "filtered_out" });
        continue;
      }
      const resolved = resolveCommandForKind(command, kind, opts.projectRoot, scope.absolute, defaultTimeoutMs);
      if (opts.dryRun) {
        runsToKeep.push({
          kind,
          command: resolved.commandString,
          exit_code: null,
          duration_ms: 0,
          timed_out: false,
          parser: resolved.parser,
          parsed_to: {},
          parser_warnings: [],
        });
        continue;
      }
      const spawnResult = await runFn(resolved.commandString, {
        cwd: resolved.cwd,
        timeoutMs: resolved.timeoutMs,
        env: resolved.env,
      });
      let artifactText: string | undefined;
      if (resolved.artifact) {
        try {
          artifactText = await readFile(resolved.artifact, "utf-8");
        } catch {
          // Missing artifact: leave undefined, parser decides how to recover.
        }
      }
      const parser = PARSERS[resolved.parser];
      const parseResult = parser({
        spawn: spawnResult,
        artifactText,
        cwd: resolved.cwd,
      });
      runsToKeep.push({
        kind,
        command: resolved.commandString,
        exit_code: spawnResult.exitCode,
        duration_ms: spawnResult.durationMs,
        timed_out: spawnResult.timedOut,
        parser: resolved.parser,
        parsed_to: parseResult.evidence,
        parser_warnings: parseResult.warnings,
      });
    }

    if (!opts.dryRun && runsToKeep.length > 0) {
      const merged = composeEvidence(runsToKeep);
      const sha = await shaFn(scope.absolute);
      if (sha) merged.commit_sha = sha;
      merged.collected_at = new Date().toISOString();

      const ctx = await readContext(scope.absolute);
      if (!ctx) {
        report.status = "no_context";
      } else {
        const nextEvidence: Evidence = opts.merge
          ? { ...(ctx.evidence ?? {}), ...merged } as Evidence
          : merged as Evidence;
        ctx.evidence = nextEvidence;
        ctx.last_updated = new Date().toISOString();
        await writeContextAtomic(scope.absolute, ctx);
        report.evidence_written = true;
      }
    }

    report.ran = runsToKeep;
    report.status = classifyScope(runsToKeep, report.status);
    countTotals(totals, runsToKeep);
    scopes.push(report);
  }

  return {
    root: opts.projectRoot,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    scopes,
    totals,
  };
}

interface ResolvedCommand {
  commandString: string;
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  artifact?: string;
  parser: ParserId;
}

function resolveCommand(
  command: VerifyCommand,
  projectRoot: string,
  scopeAbsolute: string,
  defaultTimeoutMs: number,
): ResolvedCommand & { kindHint?: VerifyKind } {
  // Default cwd is the resolved scope; an explicit `cwd` on the object form
  // overrides. Artifact paths resolve relative to the final cwd.
  if (typeof command === "string") {
    return {
      commandString: command,
      cwd: scopeAbsolute,
      timeoutMs: defaultTimeoutMs,
      parser: pickParser("test", undefined, command), // placeholder, overridden below
    };
  }
  const cwd = command.cwd
    ? isAbsolute(command.cwd)
      ? command.cwd
      : resolve(projectRoot, command.cwd)
    : scopeAbsolute;
  const artifact = command.artifact ? resolve(cwd, command.artifact) : undefined;
  const timeoutMs = command.timeout_seconds !== undefined ? command.timeout_seconds * 1000 : defaultTimeoutMs;
  return {
    commandString: command.command,
    cwd,
    timeoutMs,
    env: command.env,
    artifact,
    parser: pickParser("test", command.parser, command.command), // placeholder — caller wraps with real kind
  };
}

/**
 * Small wrapper to make `pickParser` kind-aware without threading the kind
 * through `resolveCommand`. Called once per (kind, command).
 */
export function resolveCommandForKind(
  command: VerifyCommand,
  kind: VerifyKind,
  projectRoot: string,
  scopeAbsolute: string,
  defaultTimeoutMs: number,
): ResolvedCommand {
  const base = resolveCommand(command, projectRoot, scopeAbsolute, defaultTimeoutMs);
  const explicit = typeof command === "string" ? undefined : command.parser;
  base.parser = pickParser(kind, explicit, base.commandString);
  return base;
}

// Rewire resolveCommand usage in runVerify above to use resolveCommandForKind.
// (Inlined below: we re-hook by wrapping the call at the one use site.)

function composeEvidence(runs: VerifyKindRun[]): Partial<Evidence> {
  let evidence: Partial<Evidence> = {};
  for (const run of runs) {
    evidence = { ...evidence, ...run.parsed_to };
  }
  // Promote build exit-code failures to typecheck=errors when no typecheck was run.
  const buildRun = runs.find((r) => r.kind === "build");
  const typecheckRun = runs.find((r) => r.kind === "typecheck");
  if (buildRun && !typecheckRun && (buildRun.exit_code ?? 0) !== 0) {
    evidence.typecheck = "errors";
    evidence.typecheck_tool = evidence.typecheck_tool ?? "build";
  }
  return evidence;
}

function classifyScope(runs: VerifyKindRun[], current: VerifyScopeReport["status"]): VerifyScopeReport["status"] {
  if (current === "no_context") return current;
  if (runs.length === 0) return "ok";
  let success = 0;
  let failure = 0;
  for (const run of runs) {
    if (run.timed_out || (run.exit_code ?? 0) !== 0) {
      failure++;
      continue;
    }
    const ev = run.parsed_to;
    if (ev.test_status === "failing" || ev.typecheck === "errors" || ev.lint_status === "errors") failure++;
    else success++;
  }
  if (failure === 0) return "ok";
  if (success === 0) return "failed";
  return "partial";
}

function countTotals(totals: VerifyRunReport["totals"], runs: VerifyKindRun[]): void {
  for (const run of runs) {
    const ev = run.parsed_to;
    if (ev.test_status === "passing") totals.passing++;
    else if (ev.test_status === "failing") totals.failing++;
    else if (ev.test_status === "unknown") totals.unknown++;
    if (ev.typecheck === "clean" || ev.lint_status === "clean") totals.clean++;
    if (ev.typecheck === "errors" || ev.lint_status === "errors") totals.errors++;
    if (ev.typecheck === "unknown" || ev.lint_status === "unknown") totals.unknown++;
  }
}
