import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import type { FileFingerprint, FileId } from "./types.js";
import { INDEX_VERSION } from "./version.js";

/**
 * File-level fingerprint. Lives BELOW the directory-level fingerprint in
 * src/core/fingerprint.ts — they don't share storage and serve different
 * jobs. This one feeds semantic staleness (T2) and is content-addressed.
 */
export async function computeFileFingerprint(
  absPath: string,
  fileId: FileId,
): Promise<FileFingerprint> {
  const [content, st] = await Promise.all([readFile(absPath), stat(absPath)]);
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);
  return {
    file: fileId,
    mtime_ms: Math.floor(st.mtimeMs),
    size: st.size,
    content_hash: hash,
    indexer_version: `t1a.v${INDEX_VERSION}`,
  };
}

/**
 * Fast-path check: if (mtime, size) match the stored fingerprint, the content
 * hash is assumed unchanged and we skip the read. Mirrors the directory
 * fingerprint's fast-path. Callers MUST fall through to a full hash when
 * either mtime or size diverges.
 */
export async function fileIsStable(
  absPath: string,
  stored: FileFingerprint,
): Promise<boolean> {
  try {
    const st = await stat(absPath);
    return (
      Math.floor(st.mtimeMs) === stored.mtime_ms && st.size === stored.size
    );
  } catch {
    return false;
  }
}
