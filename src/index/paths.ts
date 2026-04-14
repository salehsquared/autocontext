import { join, posix, sep } from "node:path";

/** Directory name; also the gitignore entry. */
export const AUTOCONTEXT_DIR = ".autocontext";
export const INDEX_DIR_NAME = "index";

/** All on-disk index paths derive from this. */
export function indexRoot(projectRoot: string): string {
  return join(projectRoot, AUTOCONTEXT_DIR, INDEX_DIR_NAME);
}

export function manifestPath(projectRoot: string): string {
  return join(indexRoot(projectRoot), "manifest.json");
}

export function fingerprintsPath(projectRoot: string): string {
  return join(indexRoot(projectRoot), "fingerprints.ndjson");
}

export function dirEdgesPath(projectRoot: string): string {
  return join(indexRoot(projectRoot), "dir_edges.json");
}

export function lockPath(projectRoot: string): string {
  return join(indexRoot(projectRoot), ".lock");
}

export function tmpDir(projectRoot: string): string {
  return join(indexRoot(projectRoot), ".tmp");
}

export function shardPath(
  projectRoot: string,
  collection: "symbols" | "imports" | "references",
  shardKey: string,
): string {
  return join(indexRoot(projectRoot), collection, `${shardKey}.ndjson`);
}

export function collectionDir(
  projectRoot: string,
  collection: "symbols" | "imports" | "references",
): string {
  return join(indexRoot(projectRoot), collection);
}

/** Convert a host-native path (or already-POSIX path) to a POSIX-normalized FileId. */
export function toFileId(relativePath: string): string {
  if (sep === posix.sep) return relativePath.replace(/^\.?\/+/, "");
  return relativePath.split(sep).join(posix.sep).replace(/^\.?\/+/, "");
}
