import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const distCli = resolve(process.cwd(), "dist/index.js");

if (!existsSync(distCli)) {
  console.error("dist/index.js is missing. Run `npm run build` first.");
  process.exit(1);
}

const commandChains = [
  ["init"],
  ["status"],
  ["regen"],
  ["doctor"],
  ["rehash"],
  ["validate"],
  ["watch"],
  ["show"],
  ["config"],
  ["ignore"],
  ["health"],
  ["index"],
  ["impact"],
  ["pack"],
  ["diff"],
  ["timeline"],
  ["hotspots"],
  ["verify"],
  ["view"],
  ["cache", "stats"],
  ["cache", "clear"],
  ["bench"],
  ["serve"],
];

for (const chain of commandChains) {
  const result = spawnSync(
    process.execPath,
    [distCli, ...chain, "--help"],
    {
      cwd: process.cwd(),
      encoding: "utf-8",
      stdio: "pipe",
    },
  );

  if (result.status !== 0) {
    const rendered = chain.join(" ");
    const stderr = result.stderr?.trim();
    const stdout = result.stdout?.trim();
    const detail = stderr || stdout || `exit ${result.status}`;
    console.error(`Help smoke failed for \`context ${rendered} --help\`: ${detail}`);
    process.exit(result.status ?? 1);
  }
}

console.log(`help smoke passed for ${commandChains.length} command paths`);
