import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

interface PackageJsonShape {
  version?: string;
}

let cachedVersion: string | null = null;

export function getAutocontextVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const pkg = require("../package.json") as PackageJsonShape;
    if (typeof pkg.version === "string" && pkg.version.length > 0) {
      cachedVersion = pkg.version;
      return cachedVersion;
    }
  } catch {
    // Fall through to the stable dev fallback.
  }
  cachedVersion = "0.0.0-dev";
  return cachedVersion;
}

export const AUTOCONTEXT_VERSION = getAutocontextVersion();
