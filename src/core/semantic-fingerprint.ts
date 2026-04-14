import { createHash } from "node:crypto";
import { extname, join, relative } from "node:path";
import { readdir } from "node:fs/promises";
import type { IndexStore } from "../index/store.js";
import { toFileId } from "../index/paths.js";
import type {
  FileId,
  ImportEdge,
  IndexSymbol,
} from "../index/types.js";

/**
 * Semantic fingerprint (T2). An additive, sha256-12 hash over a directory's
 * exported API surface, import graph, and policy-relevant facts. Designed to
 * distinguish *semantic* churn (exports/signatures/deps/rules changed) from
 * *cosmetic* churn (whitespace, comments, non-exported body edits) so the
 * pre-commit hook, `context status --explain`, and CI can stop treating
 * formatter runs as meaningful regen triggers.
 *
 * Cache-free on purpose: computation is cheap relative to the index build it
 * relies on. If a repo is large enough that per-file sem-fp cost matters, a
 * cache next to `.autocontext/index/` is an easy follow-up.
 */

export const SEMANTIC_FINGERPRINT_MARKER = "semv1";

/** Policy-relevant facts pulled from a directory's `.context.yaml`. */
export interface PolicyFacts {
  constraints?: string[];
  rules?: Array<Record<string, unknown>>;
  environment?: string[];
}

interface FilePreimage {
  file: string;
  exported_symbols: Array<{
    name: string;
    kind: string;
    signature: string | null;
  }>;
  public_signatures: string[];
  import_edges: Array<{
    raw: string;
    resolved_to: string | null;
    symbols: string[];
  }>;
}

interface DirectoryPreimage {
  schema_version_marker: typeof SEMANTIC_FINGERPRINT_MARKER;
  files: FilePreimage[];
  policy_relevant_facts: {
    constraints: string[];
    rules: Array<Record<string, unknown>>;
    environment: string[];
  };
}

/**
 * Stable JSON stringify — keys at every depth are sorted lexicographically.
 * Arrays keep their order (callers sort explicitly where semantics demand it).
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${parts.join(",")}}`;
}

function sha256_12(s: string): string {
  return createHash("sha256").update(s).digest("hex").slice(0, 12);
}

/**
 * Compute the semantic fingerprint for a single file. Reads definitions +
 * imports from the index; a file the index doesn't know about returns a
 * hash of "(no data)" so callers can still compose it into a directory hash.
 */
export async function computeFileSemanticFingerprint(
  file: FileId,
  store: IndexStore,
): Promise<{ sem_fp_12: string; deps_fp_12: string; preimage: FilePreimage }> {
  const [symbols, imports] = await Promise.all([
    store.getFileSymbols(file),
    store.getFileImports(file),
  ]);
  const preimage = buildFilePreimage(file, symbols, imports);
  const sem_fp_12 = sha256_12(stableStringify(preimage));
  const deps_fp_12 = sha256_12(stableStringify(preimage.import_edges));
  return { sem_fp_12, deps_fp_12, preimage };
}

function buildFilePreimage(
  file: FileId,
  symbols: IndexSymbol[],
  imports: ImportEdge[],
): FilePreimage {
  const exported = symbols
    .filter((s) => s.exported)
    .map((s) => ({
      name: s.name,
      kind: s.kind,
      signature: s.signature ?? null,
    }))
    .sort((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind.localeCompare(b.kind),
    );
  const public_signatures = exported
    .map((s) => s.signature)
    .filter((sig): sig is string => typeof sig === "string")
    .slice()
    .sort();
  const import_edges = imports
    .map((e) => ({
      raw: e.raw,
      resolved_to: e.resolved_to ?? null,
      symbols: [...e.symbols].sort(),
    }))
    .sort((a, b) => {
      if (a.raw !== b.raw) return a.raw.localeCompare(b.raw);
      return (a.resolved_to ?? "").localeCompare(b.resolved_to ?? "");
    });
  return { file, exported_symbols: exported, public_signatures, import_edges };
}

/**
 * Compute the semantic fingerprint for a directory. Non-recursive: only the
 * files directly under `dirPath` with a source extension the analyzer knows
 * how to touch. Missing index = returned fingerprint omits the file's
 * contribution (empty preimage), which is the conservative choice: two runs
 * on the same inputs must agree even when the index is cold.
 */
export async function computeSemanticFingerprint(
  dirPath: string,
  facts: PolicyFacts,
  store: IndexStore,
  projectRoot: string,
): Promise<{ sem_fp_12: string; preimage: DirectoryPreimage }> {
  const sourceFiles = await listDirectorySourceFiles(dirPath);
  const filePreimages: FilePreimage[] = [];
  for (const rel of sourceFiles) {
    const fileId = toFileId(relative(projectRoot, join(dirPath, rel)));
    const { preimage } = await computeFileSemanticFingerprint(fileId, store);
    filePreimages.push(preimage);
  }
  filePreimages.sort((a, b) => a.file.localeCompare(b.file));

  const preimage: DirectoryPreimage = {
    schema_version_marker: SEMANTIC_FINGERPRINT_MARKER,
    files: filePreimages,
    policy_relevant_facts: {
      constraints: [...(facts.constraints ?? [])].sort(),
      rules: [...(facts.rules ?? [])].sort((a, b) =>
        stableStringify(a).localeCompare(stableStringify(b)),
      ),
      environment: [...(facts.environment ?? [])].sort(),
    },
  };
  const sem_fp_12 = sha256_12(stableStringify(preimage));
  return { sem_fp_12, preimage };
}

const INDEXABLE_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py"]);

async function listDirectorySourceFiles(dirPath: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = extname(entry.name).toLowerCase();
    if (!INDEXABLE_EXTS.has(ext)) continue;
    out.push(entry.name);
  }
  out.sort();
  return out;
}

/** Pull the policy-relevant facts out of a parsed ContextFile. */
export function extractPolicyFacts(ctx: {
  constraints?: string[];
  rules?: Array<Record<string, unknown>>;
  environment?: string[];
}): PolicyFacts {
  return {
    constraints: ctx.constraints,
    rules: ctx.rules,
    environment: ctx.environment,
  };
}
