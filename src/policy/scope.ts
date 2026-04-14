/**
 * Subtree scope helpers. All paths are project-relative POSIX ("." for root).
 */

export function fileInScope(file: string, scope: string): boolean {
  if (scope === "." || scope === "") return true;
  return file === scope || file.startsWith(`${scope}/`);
}

export function dirInScope(dir: string, scope: string): boolean {
  if (scope === "." || scope === "") return true;
  return dir === scope || dir.startsWith(`${scope}/`);
}

export function normalizeScope(scope: string): string {
  const normalized = scope.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
  return normalized === "" ? "." : normalized;
}
