import { compileGlob, matchGlob } from "../glob.js";
import type { RequireTestFileRule } from "../rules.js";
import type { RuleEvaluationInput, Violation } from "../types.js";
import { fileInScope } from "../scope.js";
import { basename, extname } from "node:path/posix";

export async function evaluateRequireTestFile(
  input: RuleEvaluationInput,
): Promise<Violation[]> {
  const rule = input.rule as RequireTestFileRule;
  const forGlob = compileGlob(rule.for);
  const selfMatch = patternToSelfRegex(rule.pattern);
  const basenames = new Set<string>();
  for (const f of input.ctx.sourceFiles) basenames.add(basename(f));

  const violations: Violation[] = [];

  for (const file of input.ctx.sourceFiles) {
    if (!fileInScope(file, input.ruleScope)) continue;
    if (!matchGlob(file, forGlob)) continue;

    const selfName = basename(file);
    if (selfMatch.test(selfName)) continue; // file is already a test file

    const ext = extname(file).replace(/^\./, "");
    const name = basename(file, extname(file));
    const expectedBase = expandPattern(rule.pattern, name, ext);

    if (!basenames.has(expectedBase)) {
      violations.push({
        rule_kind: "require_test_file",
        scope: input.ruleScope,
        severity: "error",
        rule_index: input.ruleIndex,
        file,
        message:
          rule.message ??
          `require_test_file: ${file} has no matching test file (expected ${expectedBase})`,
      });
    }
  }

  violations.sort((a, b) => (a.file! < b.file! ? -1 : a.file! > b.file! ? 1 : 0));
  return violations;
}

function expandPattern(pattern: string, name: string, ext: string): string {
  return pattern.replace(/\{name\}/g, name).replace(/\{ext\}/g, ext);
}

/** Compile the user pattern into a regex that matches any filename that looks
 *  like a test file per the pattern (i.e. `{name}` is any non-empty string and
 *  `{ext}` is any token). Used for the self-skip check. */
function patternToSelfRegex(pattern: string): RegExp {
  let out = "^";
  let i = 0;
  while (i < pattern.length) {
    if (pattern.startsWith("{name}", i)) {
      out += ".+";
      i += 6;
      continue;
    }
    if (pattern.startsWith("{ext}", i)) {
      out += "[A-Za-z0-9]+";
      i += 5;
      continue;
    }
    const ch = pattern[i];
    out += /[.+*^$()|\\?]/.test(ch) ? `\\${ch}` : ch;
    i++;
  }
  out += "$";
  return new RegExp(out);
}
