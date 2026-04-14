#!/usr/bin/env node

import { resolve } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { statusCommand } from "./commands/status.js";
import { regenCommand } from "./commands/regen.js";
import { rehashCommand } from "./commands/rehash.js";
import { validateCommand } from "./commands/validate.js";
import { showCommand } from "./commands/show.js";
import { configCommand } from "./commands/config.js";
import { ignoreCommand } from "./commands/ignore.js";
import { watchCommand } from "./commands/watch.js";
import { doctorCommand } from "./commands/doctor.js";
import { statsCommand } from "./commands/stats.js";
import { healthCommand } from "./commands/health.js";
import { benchCommand } from "./commands/bench.js";
import { indexCommand } from "./commands/index-cmd.js";
import { impactCommand } from "./commands/impact.js";
import { cacheClearCommand, cacheStatsCommand } from "./commands/cache.js";
import { diffCommand } from "./commands/diff.js";
import { timelineCommand } from "./commands/timeline.js";
import { hotspotsCommand } from "./commands/hotspots.js";
import { startMcpServer } from "./mcp/server.js";
import { loadEnvForCli } from "./utils/env.js";
import { errorMsg } from "./utils/display.js";

export interface CommandHandlers {
  initCommand: typeof initCommand;
  statusCommand: typeof statusCommand;
  regenCommand: typeof regenCommand;
  rehashCommand: typeof rehashCommand;
  validateCommand: typeof validateCommand;
  showCommand: typeof showCommand;
  configCommand: typeof configCommand;
  ignoreCommand: typeof ignoreCommand;
  watchCommand: typeof watchCommand;
  doctorCommand: typeof doctorCommand;
  statsCommand: typeof statsCommand;
  healthCommand: typeof healthCommand;
  benchCommand: typeof benchCommand;
  indexCommand: typeof indexCommand;
  impactCommand: typeof impactCommand;
  cacheStatsCommand: typeof cacheStatsCommand;
  cacheClearCommand: typeof cacheClearCommand;
  diffCommand: typeof diffCommand;
  timelineCommand: typeof timelineCommand;
  hotspotsCommand: typeof hotspotsCommand;
  startMcpServer: typeof startMcpServer;
}

const defaultHandlers: CommandHandlers = {
  initCommand,
  statusCommand,
  regenCommand,
  rehashCommand,
  validateCommand,
  showCommand,
  configCommand,
  ignoreCommand,
  watchCommand,
  doctorCommand,
  statsCommand,
  healthCommand,
  benchCommand,
  indexCommand,
  impactCommand,
  cacheStatsCommand,
  cacheClearCommand,
  diffCommand,
  timelineCommand,
  hotspotsCommand,
  startMcpServer,
};

function isInvokedDirectly(argv1: string | undefined): boolean {
  if (typeof argv1 !== "string") return false;

  // npm/yarn often invoke package bins through symlinks in node_modules/.bin.
  // Compare real paths so symlinked execution still triggers the CLI entrypoint.
  try {
    const invokedPath = realpathSync(argv1);
    const thisModulePath = realpathSync(fileURLToPath(import.meta.url));
    if (invokedPath === thisModulePath) return true;
  } catch {
    // Fall through to URL equality check below.
  }

  try {
    return import.meta.url === pathToFileURL(argv1).href;
  } catch {
    return false;
  }
}

export function createProgram(handlers: CommandHandlers = defaultHandlers): Command {
  const program = new Command();

  program
    .name("context")
    .description("Folder-level documentation for LLMs — .context.yaml files for every directory")
    .version("0.1.0");

  program
    .command("init")
    .description("Scan project and generate all .context.yaml files")
    .option("--llm", "Use LLM provider for richer context generation")
    .option("--evidence", "Collect test/typecheck evidence from existing artifacts")
    .option("--no-agents", "Skip AGENTS.md generation")
    .option("--full", "Generate verbose context (files, interfaces, dependencies)")
    .option("--parallel <n>", "Process directories in parallel (n = concurrency)", parseInt)
    .option("-p, --path <path>", "Project root path")
    .action(async (opts) => {
      if (opts.parallel !== undefined && (!Number.isInteger(opts.parallel) || opts.parallel < 1)) {
        console.error(errorMsg("--parallel must be a positive integer"));
        process.exitCode = 1;
        return;
      }
      await handlers.initCommand({
        noLlm: !opts.llm,
        path: opts.path,
        evidence: opts.evidence,
        noAgents: opts.agents === false,
        parallel: opts.parallel,
        full: opts.full,
      });
    });

  program
    .command("status")
    .description("Check freshness of all .context.yaml files")
    .option("--json", "Output machine-readable JSON")
    .option("-p, --path <path>", "Project root path")
    .action(async (opts) => {
      await handlers.statusCommand({ path: opts.path, json: opts.json });
    });

  program
    .command("regen [target]")
    .description("Regenerate .context.yaml for a specific directory")
    .option("--all", "Regenerate all .context.yaml files")
    .option("--force", "Overwrite without confirmation")
    .option("--no-llm", "Use static analysis only")
    .option("--evidence", "Collect test/typecheck evidence from existing artifacts")
    .option("--no-agents", "Skip AGENTS.md generation")
    .option("--stale", "Only regenerate stale or missing contexts")
    .option("--semantic-stale", "Like --stale, but skip cosmetic-only drift (requires index)")
    .option("--dry-run", "Preview what would be regenerated without changes")
    .option("--full", "Generate verbose context (files, interfaces, dependencies)")
    .option("--parallel <n>", "Process directories in parallel (n = concurrency)", parseInt)
    .option("-p, --path <path>", "Project root path")
    .action(async (target, opts) => {
      if (opts.parallel !== undefined && (!Number.isInteger(opts.parallel) || opts.parallel < 1)) {
        console.error(errorMsg("--parallel must be a positive integer"));
        process.exitCode = 1;
        return;
      }
      await handlers.regenCommand(target, {
        all: opts.all,
        force: opts.force,
        noLlm: opts.llm === false,
        path: opts.path,
        evidence: opts.evidence,
        noAgents: opts.agents === false,
        stale: opts.stale,
        semanticStale: opts.semanticStale,
        dryRun: opts.dryRun,
        parallel: opts.parallel,
        full: opts.full,
      });
    });

  program
    .command("rehash")
    .description("Recompute fingerprints without regenerating content")
    .option("-p, --path <path>", "Project root path")
    .action(async (opts) => {
      await handlers.rehashCommand({ path: opts.path });
    });

  program
    .command("validate")
    .description("Check all .context.yaml files for syntax and schema errors")
    .option("--strict", "Cross-reference declared fields against source code")
    .option("-p, --path <path>", "Project root path")
    .action(async (opts) => {
      await handlers.validateCommand({ path: opts.path, strict: opts.strict });
    });

  program
    .command("show <target>")
    .description("Pretty-print a .context.yaml file")
    .action(async (target) => {
      await handlers.showCommand(target);
    });

  program
    .command("config")
    .description("View or edit provider settings")
    .option("--provider <provider>", "Set LLM provider (anthropic, openai, google, ollama)")
    .option("--model <model>", "Set model ID")
    .option("--max-depth <depth>", "Set maximum scan depth")
    .option("--ignore <dirs...>", "Add directories to ignore list")
    .option("--api-key-env <var>", "Set environment variable name for API key")
    .option("--mode <mode>", "Set default generation mode (lean, full)")
    .option("-p, --path <path>", "Project root path")
    .action(async (opts) => {
      await handlers.configCommand({
        path: opts.path,
        provider: opts.provider,
        model: opts.model,
        maxDepth: opts.maxDepth,
        ignore: opts.ignore,
        apiKeyEnv: opts.apiKeyEnv,
        mode: opts.mode,
      });
    });

  program
    .command("ignore <target>")
    .description("Add a directory to .contextignore")
    .option("-p, --path <path>", "Project root path")
    .action(async (target, opts) => {
      await handlers.ignoreCommand(target, { path: opts.path });
    });

  program
    .command("watch")
    .description("Watch for file changes and report staleness in real-time")
    .option("-p, --path <path>", "Project root path")
    .option("--interval <ms>", "Debounce interval in milliseconds", "500")
    .action(async (opts) => {
      await handlers.watchCommand({ path: opts.path, interval: opts.interval });
    });

  program
    .command("doctor")
    .description("Check project health: config, API keys, coverage, staleness, validation")
    .option("--json", "Output machine-readable JSON")
    .option("-p, --path <path>", "Project root path")
    .action(async (opts) => {
      await handlers.doctorCommand({ path: opts.path, json: opts.json });
    });

  program
    .command("stats")
    .description("Show project statistics and token reduction metrics")
    .option("--json", "Output as JSON")
    .option("-p, --path <path>", "Project root path")
    .action(async (opts) => {
      await handlers.statsCommand({ path: opts.path, json: opts.json });
    });

  program
    .command("health")
    .description("Aggregate code health evidence across all scopes")
    .option("--json", "Output as JSON")
    .option("-p, --path <path>", "Project root path")
    .action(async (opts) => {
      await handlers.healthCommand({ path: opts.path, json: opts.json });
    });

  program
    .command("bench")
    .description("Benchmark whether .context.yaml files improve LLM accuracy")
    .option("--json", "Output machine-readable JSON")
    .option("--iterations <n>", "Repeat each task N times", parseInt)
    .option("--tasks <path>", "Path to manual tasks YAML file")
    .option("--max-tasks <n>", "Maximum tasks to generate", parseInt)
    .option("--seed <n>", "Seed for deterministic sampling", parseInt)
    .option("--category <cat>", "Only run this task category")
    .option("--out <file>", "Write JSON report to file")
    .option("--allow-stale", "Include stale context files")
    .option("--repo <url>", "Clone and benchmark a GitHub repo")
    .option("--default-repos", "Benchmark against curated default repos")
    .option("-p, --path <path>", "Project root path")
    .action(async (opts) => {
      await handlers.benchCommand({
        path: opts.path,
        json: opts.json,
        iterations: opts.iterations,
        tasks: opts.tasks,
        maxTasks: opts.maxTasks,
        seed: opts.seed,
        category: opts.category,
        out: opts.out,
        allowStale: opts.allowStale,
        repo: opts.repo,
        defaultRepos: opts.defaultRepos,
      });
    });

  program
    .command("index")
    .description("Build or refresh the local code index under .autocontext/index/")
    .option("--rebuild", "Wipe .autocontext/index/ and build from scratch")
    .option("-p, --path <path>", "Project root path")
    .action(async (opts) => {
      await handlers.indexCommand({ rebuild: opts.rebuild, path: opts.path });
    });

  const cacheCmd = program
    .command("cache")
    .description("Manage the deterministic LLM response cache");
  cacheCmd
    .command("stats")
    .description("Show cache status + size")
    .option("--json", "Output machine-readable JSON")
    .option("-p, --path <path>", "Project root path")
    .action(async (opts) => {
      await handlers.cacheStatsCommand({ path: opts.path, json: opts.json });
    });
  cacheCmd
    .command("clear")
    .description("Remove every cached LLM response from .autocontext/llm-cache/")
    .option("-p, --path <path>", "Project root path")
    .action(async (opts) => {
      await handlers.cacheClearCommand({ path: opts.path });
    });

  program
    .command("diff <range>")
    .description("Diff meaningful .context.yaml fields between two git revisions (e.g. main..feature)")
    .option("--scope <path>", "Restrict to a single scope")
    .option("--json", "Output machine-readable JSON")
    .option("-p, --path <path>", "Project root path")
    .action(async (range, opts) => {
      await handlers.diffCommand(range, { path: opts.path, scope: opts.scope, json: opts.json });
    });

  program
    .command("timeline [target]")
    .description("Show git history of a scope's .context.yaml")
    .option("--max <n>", "Maximum number of commits (default 50)", parseInt)
    .option("--json", "Output machine-readable JSON")
    .option("-p, --path <path>", "Project root path")
    .action(async (target, opts) => {
      await handlers.timelineCommand(target, {
        path: opts.path,
        max: opts.max,
        json: opts.json,
      });
    });

  program
    .command("hotspots")
    .description("Rank scopes by context churn (semantic fingerprint changes, or raw commits)")
    .option("--max <n>", "Maximum rows (default 20)", parseInt)
    .option("--raw-count", "Force raw commit count metric even if semantic fingerprints are present")
    .option("--json", "Output machine-readable JSON")
    .option("-p, --path <path>", "Project root path")
    .action(async (opts) => {
      await handlers.hotspotsCommand({
        path: opts.path,
        max: opts.max,
        rawCount: opts.rawCount,
        json: opts.json,
      });
    });

  program
    .command("impact <target>")
    .description("List directories affected by changes to a file or symbol")
    .option("--json", "Output machine-readable JSON")
    .option("--max-depth <n>", "Maximum BFS hops (default 3)", parseInt)
    .option("--max <n>", "Maximum affected files (default 100)", parseInt)
    .option("-p, --path <path>", "Project root path")
    .action(async (target, opts) => {
      await handlers.impactCommand(target, {
        path: opts.path,
        json: opts.json,
        maxDepth: opts.maxDepth,
        max: opts.max,
      });
    });

  program
    .command("serve")
    .description("Start MCP server for LLM tool integration (stdio transport)")
    .option("-p, --path <path>", "Project root path")
    .action(async (opts) => {
      const rootPath = resolve(opts.path ?? ".");
      await handlers.startMcpServer(rootPath);
    });

  return program;
}

export async function runCli(
  argv: string[] = process.argv,
  handlers: CommandHandlers = defaultHandlers,
): Promise<void> {
  await loadEnvForCli(argv);
  const program = createProgram(handlers);
  await program.parseAsync(argv);
}

const invokedDirectly = isInvokedDirectly(process.argv[1]);

if (invokedDirectly) {
  runCli().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(msg);
    process.exit(1);
  });
}
