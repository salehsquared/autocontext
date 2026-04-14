import chalk from "chalk";
import type { FreshnessState, LegacyFreshnessState } from "../core/fingerprint.js";

export function freshnessIcon(state: FreshnessState): string {
  switch (state) {
    case "fresh": return chalk.green("✓ fresh    ");
    case "cosmetic_stale": return chalk.yellow.dim("~ cosmetic ");
    case "semantic_stale": return chalk.yellow("⚠ semantic ");
    case "missing": return chalk.red("✗ missing  ");
  }
}

/** Renders using the legacy three-state vocabulary for contexts that haven't
 *  migrated to the 4-state enum yet. */
export function freshnessIconLegacy(state: LegacyFreshnessState): string {
  switch (state) {
    case "fresh": return chalk.green("✓ fresh  ");
    case "stale": return chalk.yellow("⚠ stale  ");
    case "missing": return chalk.red("✗ missing");
  }
}

export function successMsg(msg: string): string {
  return chalk.green(`  ✓ ${msg}`);
}

export function warnMsg(msg: string): string {
  return chalk.yellow(`  ⚠ ${msg}`);
}

export function errorMsg(msg: string): string {
  return chalk.red(`  ✗ ${msg}`);
}

export function heading(msg: string): string {
  return chalk.bold(msg);
}

export function dim(msg: string): string {
  return chalk.dim(msg);
}

export function progressBar(current: number, total: number): string {
  const width = 20;
  const filled = Math.round((current / total) * width);
  const bar = "=".repeat(filled) + " ".repeat(width - filled);
  return `  [${bar}] ${current}/${total}`;
}
