import { describe, it, expect, vi } from "vitest";
import { resolve } from "node:path";
import { createProgram, type CommandHandlers } from "../src/index.js";

function makeHandlers(): CommandHandlers {
  return {
    initCommand: vi.fn(async () => {}),
    statusCommand: vi.fn(async () => {}),
    regenCommand: vi.fn(async () => {}),
    rehashCommand: vi.fn(async () => {}),
    validateCommand: vi.fn(async () => {}),
    showCommand: vi.fn(async () => {}),
    configCommand: vi.fn(async () => {}),
    ignoreCommand: vi.fn(async () => {}),
    watchCommand: vi.fn(async () => {}),
    doctorCommand: vi.fn(async () => {}),
    statsCommand: vi.fn(async () => {}),
    healthCommand: vi.fn(async () => {}),
    benchCommand: vi.fn(async () => {}),
    startMcpServer: vi.fn(async () => {}),
  };
}

async function parse(programArgs: string[], handlers: CommandHandlers): Promise<void> {
  const program = createProgram(handlers);
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  await program.parseAsync(programArgs);
}

describe("CLI wiring", () => {
  it("init defaults to noLlm true and noAgents false", async () => {
    const handlers = makeHandlers();
    await parse(["node", "context", "init", "-p", "/tmp/project"], handlers);
    expect(handlers.initCommand).toHaveBeenCalledWith(expect.objectContaining({
      noLlm: true,
      path: "/tmp/project",
      noAgents: false,
    }));
  });

  it("init --llm flips noLlm to false", async () => {
    const handlers = makeHandlers();
    await parse(["node", "context", "init", "--llm", "-p", "/tmp/project"], handlers);
    expect(handlers.initCommand).toHaveBeenCalledWith(expect.objectContaining({
      noLlm: false,
      path: "/tmp/project",
      noAgents: false,
    }));
  });

  it("init --no-agents sets noAgents to true", async () => {
    const handlers = makeHandlers();
    await parse(["node", "context", "init", "--no-agents", "-p", "/tmp/project"], handlers);
    expect(handlers.initCommand).toHaveBeenCalledWith(expect.objectContaining({
      noLlm: true,
      path: "/tmp/project",
      noAgents: true,
    }));
  });

  it("regen --no-llm maps to noLlm true", async () => {
    const handlers = makeHandlers();
    await parse(
      ["node", "context", "regen", "src", "--no-llm", "--all", "--force", "-p", "/tmp/project"],
      handlers,
    );
    expect(handlers.regenCommand).toHaveBeenCalledWith("src", expect.objectContaining({
      all: true,
      force: true,
      noLlm: true,
      path: "/tmp/project",
      noAgents: false,
    }));
  });

  it("regen --no-agents sets noAgents to true", async () => {
    const handlers = makeHandlers();
    await parse(
      ["node", "context", "regen", "--all", "--no-agents", "-p", "/tmp/project"],
      handlers,
    );
    expect(handlers.regenCommand).toHaveBeenCalledWith(undefined, expect.objectContaining({
      all: true,
      noAgents: true,
    }));
  });

  it("config passes extended option set", async () => {
    const handlers = makeHandlers();
    await parse(
      [
        "node",
        "context",
        "config",
        "--provider",
        "openai",
        "--model",
        "gpt-4o",
        "--max-depth",
        "5",
        "--ignore",
        "tmp",
        "build",
        "--api-key-env",
        "CUSTOM_KEY",
        "-p",
        "/tmp/project",
      ],
      handlers,
    );

    expect(handlers.configCommand).toHaveBeenCalledWith({
      path: "/tmp/project",
      provider: "openai",
      model: "gpt-4o",
      maxDepth: "5",
      ignore: ["tmp", "build"],
      apiKeyEnv: "CUSTOM_KEY",
      mode: undefined,
    });
  });

  it("config --mode full passes mode: full", async () => {
    const handlers = makeHandlers();
    await parse(
      ["node", "context", "config", "--mode", "full", "-p", "/tmp/project"],
      handlers,
    );

    expect(handlers.configCommand).toHaveBeenCalledWith(expect.objectContaining({
      mode: "full",
      path: "/tmp/project",
    }));
  });

  it("serve resolves path before calling server start", async () => {
    const handlers = makeHandlers();
    await parse(["node", "context", "serve", "-p", "relative/path"], handlers);
    expect(handlers.startMcpServer).toHaveBeenCalledWith(resolve("relative/path"));
  });

  it("watch passes interval and path", async () => {
    const handlers = makeHandlers();
    await parse(["node", "context", "watch", "-p", "/tmp/project", "--interval", "250"], handlers);
    expect(handlers.watchCommand).toHaveBeenCalledWith({ path: "/tmp/project", interval: "250" });
  });

  it("regen --stale passes stale: true", async () => {
    const handlers = makeHandlers();
    await parse(["node", "context", "regen", "--stale", "--all", "-p", "/tmp/project"], handlers);
    expect(handlers.regenCommand).toHaveBeenCalledWith(undefined, expect.objectContaining({
      stale: true,
      all: true,
    }));
  });

  it("regen --dry-run passes dryRun: true", async () => {
    const handlers = makeHandlers();
    await parse(["node", "context", "regen", "--dry-run", "--all", "-p", "/tmp/project"], handlers);
    expect(handlers.regenCommand).toHaveBeenCalledWith(undefined, expect.objectContaining({
      dryRun: true,
    }));
  });

  it("regen --parallel 4 passes parallel: 4", async () => {
    const handlers = makeHandlers();
    await parse(["node", "context", "regen", "--parallel", "4", "--all", "-p", "/tmp/project"], handlers);
    expect(handlers.regenCommand).toHaveBeenCalledWith(undefined, expect.objectContaining({
      parallel: 4,
    }));
  });

  it("regen --parallel invalid (NaN) returns error", async () => {
    const handlers = makeHandlers();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await parse(["node", "context", "regen", "--parallel", "abc", "--all", "-p", "/tmp/project"], handlers);
    expect(handlers.regenCommand).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    errorSpy.mockRestore();
    process.exitCode = 0;
  });

  it("init --parallel 4 passes parallel: 4", async () => {
    const handlers = makeHandlers();
    await parse(["node", "context", "init", "--parallel", "4", "-p", "/tmp/project"], handlers);
    expect(handlers.initCommand).toHaveBeenCalledWith(expect.objectContaining({
      parallel: 4,
    }));
  });

  it("status --json passes json: true", async () => {
    const handlers = makeHandlers();
    await parse(["node", "context", "status", "--json", "-p", "/tmp/project"], handlers);
    expect(handlers.statusCommand).toHaveBeenCalledWith({
      path: "/tmp/project",
      json: true,
    });
  });

  it("doctor command calls doctorCommand", async () => {
    const handlers = makeHandlers();
    await parse(["node", "context", "doctor", "-p", "/tmp/project"], handlers);
    expect(handlers.doctorCommand).toHaveBeenCalledWith({
      path: "/tmp/project",
    });
  });

  it("doctor --json passes json: true", async () => {
    const handlers = makeHandlers();
    await parse(["node", "context", "doctor", "--json", "-p", "/tmp/project"], handlers);
    expect(handlers.doctorCommand).toHaveBeenCalledWith({
      path: "/tmp/project",
      json: true,
    });
  });

  it("stats command calls statsCommand with path", async () => {
    const handlers = makeHandlers();
    await parse(["node", "context", "stats", "-p", "/tmp/project"], handlers);
    expect(handlers.statsCommand).toHaveBeenCalledWith({
      path: "/tmp/project",
    });
  });

  it("stats --json passes json: true", async () => {
    const handlers = makeHandlers();
    await parse(["node", "context", "stats", "--json", "-p", "/tmp/project"], handlers);
    expect(handlers.statsCommand).toHaveBeenCalledWith({
      path: "/tmp/project",
      json: true,
    });
  });

  it("bench command calls benchCommand with path", async () => {
    const handlers = makeHandlers();
    await parse(["node", "context", "bench", "-p", "/tmp/project"], handlers);
    expect(handlers.benchCommand).toHaveBeenCalledWith(expect.objectContaining({
      path: "/tmp/project",
    }));
  });

  it("bench --json passes json: true", async () => {
    const handlers = makeHandlers();
    await parse(["node", "context", "bench", "--json", "-p", "/tmp/project"], handlers);
    expect(handlers.benchCommand).toHaveBeenCalledWith(expect.objectContaining({
      path: "/tmp/project",
      json: true,
    }));
  });

  it("bench --repo passes repo URL", async () => {
    const handlers = makeHandlers();
    await parse(["node", "context", "bench", "--repo", "https://github.com/foo/bar"], handlers);
    expect(handlers.benchCommand).toHaveBeenCalledWith(expect.objectContaining({
      repo: "https://github.com/foo/bar",
    }));
  });

  it("bench --default-repos passes defaultRepos: true", async () => {
    const handlers = makeHandlers();
    await parse(["node", "context", "bench", "--default-repos"], handlers);
    expect(handlers.benchCommand).toHaveBeenCalledWith(expect.objectContaining({
      defaultRepos: true,
    }));
  });

  it("bench --max-tasks 10 --seed 99 --category comprehension passes options", async () => {
    const handlers = makeHandlers();
    await parse(["node", "context", "bench", "--max-tasks", "10", "--seed", "99", "--category", "comprehension"], handlers);
    expect(handlers.benchCommand).toHaveBeenCalledWith(expect.objectContaining({
      maxTasks: 10,
      seed: 99,
      category: "comprehension",
    }));
  });

  it("bench --arm and --pack-budget pass through", async () => {
    const handlers = makeHandlers();
    await parse(["node", "context", "bench", "--arm", "pack,pack+policy", "--pack-budget", "5000"], handlers);
    expect(handlers.benchCommand).toHaveBeenCalledWith(expect.objectContaining({
      arm: "pack,pack+policy",
      packBudget: 5000,
    }));
  });

  it("health command calls healthCommand with path", async () => {
    const handlers = makeHandlers();
    await parse(["node", "context", "health", "-p", "/tmp/project"], handlers);
    expect(handlers.healthCommand).toHaveBeenCalledWith({
      path: "/tmp/project",
    });
  });

  it("health --json passes json: true", async () => {
    const handlers = makeHandlers();
    await parse(["node", "context", "health", "--json", "-p", "/tmp/project"], handlers);
    expect(handlers.healthCommand).toHaveBeenCalledWith({
      path: "/tmp/project",
      json: true,
    });
  });
});
