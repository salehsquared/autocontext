/**
 * Deterministic tokenizer for T3's BM25F retrieval.
 * Same rules run over corpus documents and user queries.
 */

export type Zone =
  | "summary"
  | "decisions"
  | "constraints"
  | "symbols"
  | "facets"
  | "state"
  | "path";

const STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "in", "and", "or", "is", "this", "that", "it",
  "for", "with", "on", "at", "by", "as", "be", "are", "was", "were", "not",
  "no", "we", "us", "you", "your", "i",
]);

export function tokenize(text: string, zone: Zone): string[] {
  if (!text) return [];
  const nfc = text.normalize("NFC");
  const fragments = nfc.split(/[^A-Za-z0-9_]+/g).filter((f) => f.length > 0);
  const out: string[] = [];
  for (const frag of fragments) {
    const lowered = frag.toLowerCase();
    if (lowered.length >= 2) out.push(lowered);
    const parts = splitIdent(frag);
    // Only emit split parts when they aren't a single repeat of the original.
    if (parts.length > 1 || (parts.length === 1 && parts[0] !== lowered)) {
      for (const part of parts) {
        if (part.length >= 2) out.push(part);
      }
    }
  }
  if (zone === "symbols") return out;
  return out.filter((t) => !STOPWORDS.has(t));
}

/** Split on camelCase + snake_case + digit↔alpha boundaries. Operates on
 *  the ORIGINAL case so camel boundaries are visible; lowercases output. */
function splitIdent(frag: string): string[] {
  const parts: string[] = [];
  let cur = "";
  const flush = () => {
    if (cur) parts.push(cur.toLowerCase());
    cur = "";
  };
  for (let i = 0; i < frag.length; i++) {
    const ch = frag[i];
    const prev = i > 0 ? frag[i - 1] : "";
    const isUpper = ch >= "A" && ch <= "Z";
    const isLower = ch >= "a" && ch <= "z";
    const isDigit = ch >= "0" && ch <= "9";
    const prevLower = prev >= "a" && prev <= "z";
    const prevUpper = prev >= "A" && prev <= "Z";
    const prevDigit = prev >= "0" && prev <= "9";
    const prevAlpha = prevLower || prevUpper;
    if (ch === "_" || ch === "-" || ch === ".") {
      flush();
      continue;
    }
    // camelCase: lower→upper (foo|Bar)
    if (isUpper && prevLower) flush();
    // PascalCase: upper→upper→lower (XMLParser → XML|Parser); break before the
    // trailing lowercase run so "HT|Tp" doesn't happen.
    if (isLower && prevUpper && cur.length > 1) {
      const last = cur[cur.length - 1];
      cur = cur.slice(0, -1);
      flush();
      cur = last;
    }
    // digit↔alpha boundaries
    if ((isDigit && prevAlpha) || (isLower && prevDigit) || (isUpper && prevDigit)) {
      flush();
    }
    cur += ch;
  }
  flush();
  return parts.filter((p) => p.length >= 2);
}
