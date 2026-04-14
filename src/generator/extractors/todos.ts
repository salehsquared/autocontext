import { extname, join } from "node:path";
import type { ScanResult } from "../../core/scanner.js";
import { readIfExists } from "./shared.js";

const MARKER_RE =
  /(?<![A-Za-z0-9_])(TODO|FIXME|XXX|HACK)\b\s*(?:\(([^)]{1,40})\))?\s*:\s*(.+?)(?=\*\/|\n|$)/g;

const SCANNABLE_EXTS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".pyi",
  ".go",
  ".rs",
  ".vue",
  ".svelte",
]);

const MAX_ENTRIES = 10;
const BODY_MAX = 120;

export async function extractTodos(scanResult: ScanResult): Promise<string[]> {
  const rows: Array<{ file: string; line: number; text: string }> = [];

  for (const filename of scanResult.files) {
    const ext = extname(filename).toLowerCase();
    if (!SCANNABLE_EXTS.has(ext)) continue;
    const raw = await readIfExists(join(scanResult.path, filename));
    if (!raw) continue;
    const lines = raw.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match = MARKER_RE.exec(line);
      MARKER_RE.lastIndex = 0;
      if (!match) continue;

      // String-literal guard: skip when the preceding text has an odd count
      // of unescaped quotes (the marker is probably inside a string).
      const preceding = line.slice(0, match.index);
      const quoteCount =
        (preceding.match(/"/g) ?? []).length + (preceding.match(/'/g) ?? []).length;
      if (quoteCount % 2 === 1) continue;

      const marker = match[1];
      const author = match[2];
      const bodyRaw = match[3].replace(/\*\/\s*$/, "").trim();
      if (bodyRaw.length < 3) continue;
      if (/^:/.test(bodyRaw)) continue;
      if (/^https?:\/\//.test(bodyRaw)) continue;
      const body = bodyRaw.length > BODY_MAX ? bodyRaw.slice(0, BODY_MAX) + "\u2026" : bodyRaw;

      const relDir = scanResult.relativePath === "." ? "" : scanResult.relativePath;
      const path = relDir ? `${relDir}/${filename}` : filename;
      const label = author ? `${marker}(${author})` : marker;
      rows.push({ file: path, line: i + 1, text: `${path}:${i + 1} ${label}: ${body}` });
    }
  }

  rows.sort((a, b) =>
    a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file),
  );
  const capped = rows.slice(0, MAX_ENTRIES).map((r) => r.text);
  if (rows.length > MAX_ENTRIES) {
    capped.push(`\u2026 +${rows.length - MAX_ENTRIES} more TODOs`);
  }
  return capped;
}
