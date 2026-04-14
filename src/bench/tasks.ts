import type { ScanResult } from "../core/scanner.js";
import type { BenchTask, Commit, DirFacts, TaskCategory } from "./types.js";

interface GenerateTasksInput {
  scanResult: ScanResult;
  dirFacts: Map<string, DirFacts>;
  depSets: { external: Map<string, string[]>; internal: Map<string, string[]> };
  reverseDeps: Map<string, string[]>;
  fixCommits: Commit[];
  featureCommits: Commit[];
  maxTasks?: number;
  category?: TaskCategory;
  seed?: number;
}

// Deterministic LCG PRNG
function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) & 0x7fffffff;
    return state / 0x7fffffff;
  };
}

export function seededSample<T>(arr: T[], n: number, seed: number): T[] {
  if (arr.length <= n) return [...arr];
  const rng = lcg(seed);
  const copy = [...arr];
  // Fisher-Yates partial shuffle
  for (let i = copy.length - 1; i > copy.length - 1 - n && i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(copy.length - n);
}

// Standard directory name patterns for task routing
const ROUTING_PATTERNS: Array<{
  dirPattern: RegExp;
  question: string;
  expectedDir: string;
}> = [
  {
    dirPattern: /commands?$/i,
    question: 'Where should I add a new CLI command called "export"?',
    expectedDir: "",
  },
  {
    dirPattern: /providers?$/i,
    question: "Where should I add support for a new LLM provider?",
    expectedDir: "",
  },
  {
    dirPattern: /utils?$/i,
    question: "Where should I add a new utility for date formatting?",
    expectedDir: "",
  },
  {
    dirPattern: /tests?$/i,
    question: "Where should I add new unit tests?",
    expectedDir: "",
  },
  {
    dirPattern: /controllers?$/i,
    question: "Where should I add a new API controller?",
    expectedDir: "",
  },
  {
    dirPattern: /routes?$/i,
    question: "Where should I add a new route handler?",
    expectedDir: "",
  },
  {
    dirPattern: /models?$/i,
    question: "Where should I add a new data model?",
    expectedDir: "",
  },
  {
    dirPattern: /middleware$/i,
    question: "Where should I add new middleware?",
    expectedDir: "",
  },
  {
    dirPattern: /services?$/i,
    question: "Where should I add a new service?",
    expectedDir: "",
  },
  {
    dirPattern: /components?$/i,
    question: "Where should I add a new UI component?",
    expectedDir: "",
  },
];

export async function generateTasks(input: GenerateTasksInput): Promise<BenchTask[]> {
  const {
    scanResult,
    dirFacts,
    depSets,
    reverseDeps,
    fixCommits,
    featureCommits,
    maxTasks,
    category,
    seed = 42,
  } = input;

  const allTasks: BenchTask[] = [];
  let idCounter = 0;
  const nextId = (cat: string) => `${cat}-${++idCounter}`;

  // Comprehension tasks
  if (!category || category === "comprehension") {
    for (const [scope, facts] of dirFacts) {
      if (facts.fileCount < 2) continue;
      const referenceFacts = [
        `Files: ${facts.files.join(", ")}`,
        ...(facts.exports.length > 0
          ? [`Exports: ${facts.exports.join(", ")}`]
          : []),
      ];
      allTasks.push({
        id: nextId("comp"),
        category: "comprehension",
        question: `What does the \`${scope}/\` directory do? Be specific about its purpose and what it contains.`,
        scoring: "llm_judge",
        expected: referenceFacts,
        source_scope: scope,
      });
    }
  }

  // Dependency tasks — external
  if (!category || category === "dependency") {
    for (const [scope, deps] of depSets.external) {
      if (deps.length < 3) continue;
      allTasks.push({
        id: nextId("dep-ext"),
        category: "dependency",
        question: `What external packages does \`${scope}/\` depend on?`,
        scoring: "list_coverage",
        expected: deps,
        source_scope: scope,
      });
    }

    // Dependency tasks — internal
    for (const [scope, deps] of depSets.internal) {
      if (deps.length < 2) continue;
      allTasks.push({
        id: nextId("dep-int"),
        category: "dependency",
        question: `Which internal modules does \`${scope}/\` import?`,
        scoring: "list_coverage",
        expected: deps,
        source_scope: scope,
      });
    }
  }

  // Change impact tasks
  if (!category || category === "change_impact") {
    for (const [filePath, dependents] of reverseDeps) {
      if (dependents.length < 2) continue;
      const scope = filePath.includes("/")
        ? filePath.substring(0, filePath.lastIndexOf("/"))
        : ".";
      allTasks.push({
        id: nextId("impact"),
        category: "change_impact",
        question: `If \`${filePath}\` changes, what other files or directories would likely be impacted?`,
        scoring: "topk_recall",
        expected: dependents,
        source_scope: scope,
      });
    }
  }

  // Task routing tasks
  if (!category || category === "task_routing") {
    for (const [scope] of dirFacts) {
      const dirName = scope.split("/").pop() ?? scope;
      for (const pattern of ROUTING_PATTERNS) {
        if (pattern.dirPattern.test(dirName)) {
          allTasks.push({
            id: nextId("route"),
            category: "task_routing",
            question: pattern.question,
            scoring: "target_hit",
            expected: [scope],
            source_scope: scope,
          });
          break;
        }
      }
    }
  }

  // Bug localization tasks
  if (!category || category === "bug_localization") {
    for (const commit of fixCommits) {
      const scope = commit.files[0]?.includes("/")
        ? commit.files[0].substring(0, commit.files[0].lastIndexOf("/"))
        : ".";
      allTasks.push({
        id: nextId("bug"),
        category: "bug_localization",
        question: `A user reports: "${commit.message}". Which files likely need to change to fix this?`,
        scoring: "mrr",
        expected: commit.files,
        source_scope: scope,
      });
    }
  }

  // Patch planning tasks
  if (!category || category === "patch_planning") {
    for (const commit of featureCommits) {
      const scope = commit.files[0]?.includes("/")
        ? commit.files[0].substring(0, commit.files[0].lastIndexOf("/"))
        : ".";
      allTasks.push({
        id: nextId("patch"),
        category: "patch_planning",
        question: `Plan the implementation for: "${commit.message}". List all files that would need to change and briefly describe each change.`,
        scoring: "file_set_f1",
        expected: commit.files,
        source_scope: scope,
      });
    }
  }

  // Apply maxTasks with proportional sampling across categories
  if (maxTasks && allTasks.length > maxTasks) {
    return limitTasks(allTasks, maxTasks, seed);
  }

  return allTasks;
}

export function limitTasks(
  tasks: BenchTask[],
  maxTasks: number,
  seed: number,
): BenchTask[] {
  const byCategory = new Map<string, BenchTask[]>();
  for (const task of tasks) {
    const list = byCategory.get(task.category) ?? [];
    list.push(task);
    byCategory.set(task.category, list);
  }

  const result: BenchTask[] = [];
  const categories = [...byCategory.keys()];
  const perCategory = Math.max(1, Math.floor(maxTasks / categories.length));

  for (const cat of categories) {
    const catTasks = byCategory.get(cat)!;
    const sampled = seededSample(catTasks, perCategory, seed);
    result.push(...sampled);
  }

  // If we have room for more, top up from categories with the most tasks
  if (result.length < maxTasks) {
    const remaining = tasks.filter((t) => !result.includes(t));
    const extra = seededSample(remaining, maxTasks - result.length, seed + 1);
    result.push(...extra);
  }

  return result.slice(0, maxTasks);
}
