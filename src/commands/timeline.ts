import { resolve } from "node:path";
import { isGitRepo, logForPath } from "../core/git.js";
import { dim, errorMsg, heading } from "../utils/display.js";

export interface TimelineCommandOptions {
  path?: string;
  max?: number;
  json?: boolean;
}

/**
 * `context timeline <path>` — chronological log of changes touching the
 * `.context.yaml` at the given scope. Read-only: runs `git log --follow`
 * under the hood. `<path>` may be a directory (we resolve to its yaml) or
 * a file path directly.
 */
export async function timelineCommand(
  target: string | undefined,
  options: TimelineCommandOptions = {},
): Promise<void> {
  const rootPath = resolve(options.path ?? ".");
  if (!isGitRepo(rootPath)) {
    console.error(errorMsg("Not a git repository."));
    process.exitCode = 1;
    return;
  }
  const yamlPath = resolveYamlPath(target);

  const commits = logForPath(rootPath, yamlPath, {
    max: options.max ?? 50,
    follow: true,
  });

  if (options.json) {
    process.stdout.write(JSON.stringify({ path: yamlPath, commits }, null, 2) + "\n");
    return;
  }

  console.log(heading(`\ntimeline: ${yamlPath}\n`));
  if (commits.length === 0) {
    console.log(dim("  No git history for this context file."));
    return;
  }
  for (const c of commits) {
    const date = new Date(c.timestamp * 1000).toISOString().slice(0, 10);
    console.log(
      `  ${c.sha.slice(0, 10)}  ${date}  ${c.authorName}  ${dim(c.subject)}`,
    );
  }
  console.log("");
}

function resolveYamlPath(target: string | undefined): string {
  if (!target || target === "." || target === "") return ".context.yaml";
  const normalized = target.replace(/\/+$/, "");
  if (normalized.endsWith(".context.yaml")) return normalized;
  return `${normalized}/.context.yaml`;
}
