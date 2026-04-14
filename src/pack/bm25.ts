import type { Zone } from "./tokenize.js";
import type { ScopeDoc } from "./corpus.js";

const ZONES: Zone[] = [
  "summary",
  "decisions",
  "constraints",
  "symbols",
  "facets",
  "state",
  "path",
];

export const ZONE_WEIGHTS: Record<Zone, number> = {
  summary: 3.0,
  decisions: 2.5,
  symbols: 2.0,
  constraints: 1.5,
  state: 1.0,
  facets: 0.7,
  path: 0.5,
};

const K1 = 1.5;
const B = 0.75;

interface PerDocZoneStats {
  /** zone → { term → tf }. */
  tfByZone: Map<Zone, Map<string, number>>;
  zoneLengths: Record<Zone, number>;
}

export interface BM25Index {
  nDocs: number;
  /** Global DF: term → number of docs it appears in (across any zone). */
  df: Map<string, number>;
  zoneAvgDl: Record<Zone, number>;
  byScope: Map<string, PerDocZoneStats>;
  scores(query: string[]): Array<{ scope: string; score: number }>;
  idf(term: string): number;
}

export function buildBM25(corpus: ScopeDoc[]): BM25Index {
  const byScope = new Map<string, PerDocZoneStats>();
  const df = new Map<string, number>();
  const zoneTotalDl: Record<Zone, number> = {
    summary: 0,
    decisions: 0,
    constraints: 0,
    symbols: 0,
    facets: 0,
    state: 0,
    path: 0,
  };

  for (const doc of corpus) {
    const tfByZone = new Map<Zone, Map<string, number>>();
    const zoneLengths: Record<Zone, number> = {
      summary: 0,
      decisions: 0,
      constraints: 0,
      symbols: 0,
      facets: 0,
      state: 0,
      path: 0,
    };
    const seen = new Set<string>();
    for (const z of ZONES) {
      const tf = new Map<string, number>();
      const tokens = doc.zones[z];
      zoneLengths[z] = tokens.length;
      zoneTotalDl[z] += tokens.length;
      for (const t of tokens) {
        tf.set(t, (tf.get(t) ?? 0) + 1);
        if (!seen.has(t)) {
          seen.add(t);
          df.set(t, (df.get(t) ?? 0) + 1);
        }
      }
      tfByZone.set(z, tf);
    }
    byScope.set(doc.scope, { tfByZone, zoneLengths });
  }

  const nDocs = corpus.length;
  const zoneAvgDl: Record<Zone, number> = {
    summary: nDocs ? zoneTotalDl.summary / nDocs : 0,
    decisions: nDocs ? zoneTotalDl.decisions / nDocs : 0,
    constraints: nDocs ? zoneTotalDl.constraints / nDocs : 0,
    symbols: nDocs ? zoneTotalDl.symbols / nDocs : 0,
    facets: nDocs ? zoneTotalDl.facets / nDocs : 0,
    state: nDocs ? zoneTotalDl.state / nDocs : 0,
    path: nDocs ? zoneTotalDl.path / nDocs : 0,
  };

  function idf(term: string): number {
    const d = df.get(term) ?? 0;
    return Math.log(1 + (nDocs - d + 0.5) / (d + 0.5));
  }

  function scoreDoc(query: string[], scope: string): number {
    const stats = byScope.get(scope);
    if (!stats) return 0;
    let total = 0;
    for (const q of query) {
      const qIdf = idf(q);
      let wtf = 0;
      for (const z of ZONES) {
        const tf = stats.tfByZone.get(z)?.get(q) ?? 0;
        if (tf === 0) continue;
        const dl = stats.zoneLengths[z];
        const avgdl = zoneAvgDl[z] || 1;
        const numer = tf * (K1 + 1);
        const denom = tf + K1 * (1 - B + B * (dl / avgdl));
        wtf += ZONE_WEIGHTS[z] * (numer / denom);
      }
      total += qIdf * wtf;
    }
    return total;
  }

  function scores(query: string[]): Array<{ scope: string; score: number }> {
    const out: Array<{ scope: string; score: number }> = [];
    for (const scope of byScope.keys()) {
      const s = scoreDoc(query, scope);
      if (s > 0) out.push({ scope, score: s });
    }
    out.sort((a, b) => b.score - a.score || a.scope.localeCompare(b.scope));
    return out;
  }

  return { nDocs, df, zoneAvgDl, byScope, scores, idf };
}
