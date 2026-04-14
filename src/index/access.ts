import { existsSync } from "node:fs";

import { manifestPath } from "./paths.js";
import { openIndex, type IndexStore, type OpenIndexOptions } from "./store.js";

export type ReadOnlyIndexState = "ready" | "missing" | "stale";

export function isIndexRebuildRequiredError(err: unknown): boolean {
  return (err as { code?: string } | null | undefined)?.code === "EAUTOCONTEXTREBUILD";
}

export interface OpenReadOnlyIndexReady {
  state: "ready";
  store: IndexStore;
}

export interface OpenReadOnlyIndexUnavailable {
  state: "missing" | "stale";
  store: null;
}

export type OpenReadOnlyIndexResult = OpenReadOnlyIndexReady | OpenReadOnlyIndexUnavailable;

export async function openReadOnlyIndex(
  projectRoot: string,
  options: Omit<OpenIndexOptions, "readOnly" | "autoRebuild"> = {},
): Promise<OpenReadOnlyIndexResult> {
  const manifestExists = existsSync(manifestPath(projectRoot));
  if (!manifestExists) return { state: "missing", store: null };

  try {
    const store = await openIndex(projectRoot, {
      ...options,
      readOnly: true,
      autoRebuild: false,
    });
    return { state: "ready", store };
  } catch (err) {
    if (isIndexRebuildRequiredError(err)) {
      return { state: "stale", store: null };
    }
    throw err;
  }
}
