import { extname, join } from "node:path";
import type { ScanResult } from "../../core/scanner.js";
import { readIfExists, stripComments } from "./shared.js";

/**
 * `events` extractor (T5-B). Emits human-readable lines for detected pub/sub
 * call sites — Node EventEmitter, DOM addEventListener, RxJS Subjects, and
 * generic EventBus-style calls. Conservative: anything requiring type
 * inference (React synthetic events, Vue $emit with indirection, dynamic
 * event names) is skipped.
 */

const MAX_ENTRIES = 20;
const NAME_CAP = 64;

const JS_EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

interface Pattern {
  regex: RegExp;
  label: (match: RegExpMatchArray) => string;
}

const JS_PATTERNS: Pattern[] = [
  // emitter.on("event-name", …)
  {
    regex: /(\b[A-Za-z_$][A-Za-z0-9_$]*)\.on\(\s*["']([^"']{1,64})["']/g,
    label: (m) => `on("${m[2]}") via ${m[1]}`,
  },
  // emitter.emit("event-name", …)
  {
    regex: /(\b[A-Za-z_$][A-Za-z0-9_$]*)\.emit\(\s*["']([^"']{1,64})["']/g,
    label: (m) => `emit("${m[2]}") via ${m[1]}`,
  },
  // emitter.addListener / .once
  {
    regex: /(\b[A-Za-z_$][A-Za-z0-9_$]*)\.(once|addListener)\(\s*["']([^"']{1,64})["']/g,
    label: (m) => `${m[2]}("${m[3]}") via ${m[1]}`,
  },
  // target.addEventListener("name", …)
  {
    regex: /(\b[A-Za-z_$][A-Za-z0-9_$]*|window|document)\.addEventListener\(\s*["']([^"']{1,64})["']/g,
    label: (m) => `addEventListener("${m[2]}") on ${m[1]}`,
  },
  // subject$.next(...) / subject$.subscribe(
  {
    regex: /(\b[A-Za-z_$][A-Za-z0-9_$]*\$?)\.(next|subscribe)\(/g,
    label: (m) => `${m[2]}() via ${m[1]}`,
  },
];

const PY_PATTERNS: Pattern[] = [
  // signal.send(sender) / signal.connect(callback)
  {
    regex: /\b([A-Za-z_][A-Za-z0-9_]*)\.(send|connect|disconnect)\(/g,
    label: (m) => `${m[2]}() via ${m[1]}`,
  },
];

export async function extractEvents(scanResult: ScanResult): Promise<string[]> {
  const seen = new Set<string>();

  for (const filename of scanResult.files) {
    const ext = extname(filename).toLowerCase();
    const patterns = patternsFor(ext);
    if (patterns.length === 0) continue;
    const raw = await readIfExists(join(scanResult.path, filename));
    if (!raw) continue;
    const stripped = stripComments(raw, ext);
    for (const p of patterns) {
      for (const m of stripped.matchAll(p.regex)) {
        const label = p.label(m as unknown as RegExpMatchArray);
        if (!label || label.length > NAME_CAP + 32) continue;
        if (isNoisy(m)) continue;
        seen.add(label);
      }
    }
  }

  return [...seen].sort().slice(0, MAX_ENTRIES);
}

function patternsFor(ext: string): Pattern[] {
  if (JS_EXTS.has(ext)) return JS_PATTERNS;
  if (ext === ".py") return PY_PATTERNS;
  return [];
}

/** Conservative noise filter — reject common false positives. */
function isNoisy(match: RegExpMatchArray): boolean {
  const target = match[1];
  if (target === "console") return true;
  if (target === "Array") return true;
  if (target === "Promise") return true;
  if (target === "Object") return true;
  if (target === "JSON") return true;
  if (target === "Math") return true;
  if (target === "String") return true;
  // `.subscribe(` is legitimate; `.emit(` on non-emitter is rare false positive.
  return false;
}
