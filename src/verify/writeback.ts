import { writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import { CONTEXT_FILENAME, contextSchema, type ContextFile } from "../core/schema.js";

/**
 * Atomic replacement of .context.yaml. Writes to a temp file in the same
 * directory then renames — rename is atomic on POSIX when the source and
 * target live on the same filesystem. Verify uses this because Ctrl-C
 * mid-run must not leave a partial file.
 */
export async function writeContextAtomic(
  dirPath: string,
  data: ContextFile,
): Promise<void> {
  contextSchema.parse(data);
  const yaml = stringify(data);
  const target = join(dirPath, CONTEXT_FILENAME);
  const tmp = join(dirPath, `.context.yaml.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmp, yaml, "utf-8");
  await rename(tmp, target);
}
