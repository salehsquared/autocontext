import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cloneRepo } from "./git.js";

export interface DefaultRepo {
  url: string;
  name: string;
  lang: string;
}

export const DEFAULT_REPOS: DefaultRepo[] = [
  { url: "https://github.com/expressjs/express", name: "express", lang: "js" },
  { url: "https://github.com/pallets/flask", name: "flask", lang: "python" },
  { url: "https://github.com/colinhacks/zod", name: "zod", lang: "ts" },
  { url: "https://github.com/go-chi/chi", name: "chi", lang: "go" },
  { url: "https://github.com/fastify/fastify", name: "fastify", lang: "ts" },
  { url: "https://github.com/openclaw/openclaw", name: "openclaw", lang: "ts" },
  { url: "https://github.com/smartcontractkit/chainlink", name: "chainlink", lang: "go" },
];

export async function cloneAndInit(
  repo: DefaultRepo,
  initFn: (rootPath: string) => Promise<void>,
): Promise<string> {
  const tempDir = await mkdtemp(join(tmpdir(), `autocontext-bench-${repo.name}-`));
  await cloneRepo(repo.url, tempDir, 100);
  await initFn(tempDir);
  return tempDir;
}

export async function cleanupRepos(tempDirs: string[]): Promise<void> {
  await Promise.all(
    tempDirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
}
