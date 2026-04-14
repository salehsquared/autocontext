/**
 * Tiny glob dialect for policy rules.
 *
 *   *           — one path segment (no "/")
 *   **          — zero or more path segments
 *   ?           — single character within a segment
 *   {a,b}       — brace expansion (no nesting)
 *   !pattern    — negation (only valid inside array form; last-match-wins)
 *
 * No character classes, no extglob. Match surface stays small on purpose.
 */

export type GlobPattern = string | string[];

interface CompiledEntry {
  regex: RegExp;
  negated: boolean;
}

export interface CompiledGlob {
  entries: CompiledEntry[];
  /** True iff every entry is negated — such a glob can never match. */
  allNegated: boolean;
}

export function compileGlob(pattern: GlobPattern): CompiledGlob {
  const patterns = Array.isArray(pattern) ? pattern : [pattern];
  const entries: CompiledEntry[] = [];
  let positive = 0;
  for (const raw of patterns) {
    const negated = raw.startsWith("!");
    const body = negated ? raw.slice(1) : raw;
    if (!negated) positive++;
    entries.push({ regex: compileOne(body), negated });
  }
  return { entries, allNegated: positive === 0 };
}

export function matchGlob(path: string, glob: CompiledGlob): boolean {
  if (glob.allNegated) return false;
  let matched = false;
  for (const entry of glob.entries) {
    if (entry.regex.test(path)) {
      matched = !entry.negated;
    }
  }
  return matched;
}

function compileOne(body: string): RegExp {
  const expanded = expandBraces(body);
  const alts = expanded.map((alt) => `(?:${globToRegex(alt)})`);
  return new RegExp(`^(?:${alts.join("|")})$`);
}

function expandBraces(input: string): string[] {
  const open = input.indexOf("{");
  if (open < 0) return [input];
  const close = input.indexOf("}", open + 1);
  if (close < 0) return [input];
  const pre = input.slice(0, open);
  const post = input.slice(close + 1);
  const parts = input.slice(open + 1, close).split(",");
  const out: string[] = [];
  for (const part of parts) {
    for (const tail of expandBraces(post)) {
      out.push(pre + part + tail);
    }
  }
  return out;
}

function globToRegex(glob: string): string {
  let out = "";
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === "*" && glob[i + 1] === "*") {
      // ** → match across segments. Collapse any trailing "/" so "a/**/b"
      // matches "a/b" as well as "a/x/b".
      if (glob[i + 2] === "/") {
        out += "(?:.*/)?";
        i += 3;
      } else {
        out += ".*";
        i += 2;
      }
      continue;
    }
    if (ch === "*") {
      out += "[^/]*";
      i++;
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      i++;
      continue;
    }
    // Regex-escape everything else.
    if (/[.+^$()|\\]/.test(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
    i++;
  }
  return out;
}
