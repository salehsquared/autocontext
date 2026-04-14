import { extname } from "node:path";
import { analyzeTsLike, isTsLike, type AnalysisOutput } from "./ts-analyzer.js";
import type { FileId } from "./types.js";

/**
 * Dispatches a single file to the per-language analyzer. Returns an empty
 * "fallback" output when the extension isn't supported yet. Builder / CLI
 * code should never care which language backed the analysis.
 */
export async function analyzeFile(
  content: string,
  fileId: FileId,
): Promise<AnalysisOutput> {
  const ext = extname(fileId).toLowerCase();
  if (isTsLike(ext)) {
    return analyzeTsLike(content, fileId, ext);
  }
  return {
    symbols: [],
    imports: [],
    tentativeReferences: [],
    analysisMode: "fallback",
  };
}

export function analyzerSupports(ext: string): boolean {
  return isTsLike(ext);
}

export type { AnalysisOutput, TentativeReference } from "./ts-analyzer.js";
