import type { FileId } from "./types.js";

/**
 * Shard key = first path segment of the FileId. Files at the project root
 * land in a special `__root__` shard so writes never need to escape to `/`.
 *
 * FileIds are POSIX-normalized (see paths.ts#toFileId).
 */
export function shardKeyForFile(fileId: FileId): string {
  const trimmed = fileId.replace(/^\/+/, "");
  const slash = trimmed.indexOf("/");
  if (slash === -1) return "__root__";
  const head = trimmed.slice(0, slash);
  if (head === "" || head === "." || head === "..") return "__root__";
  return sanitize(head);
}

/** Directory shard for DirEdge rollups — same rule as file shard. */
export function shardKeyForDir(dirPath: string): string {
  if (dirPath === "" || dirPath === ".") return "__root__";
  const trimmed = dirPath.replace(/^\/+/, "");
  const slash = trimmed.indexOf("/");
  const head = slash === -1 ? trimmed : trimmed.slice(0, slash);
  if (head === "" || head === "." || head === "..") return "__root__";
  return sanitize(head);
}

/** Strip chars that could escape the shard filename. We never expect these in real paths. */
function sanitize(segment: string): string {
  return segment.replace(/[^A-Za-z0-9._\-@]/g, "_");
}
