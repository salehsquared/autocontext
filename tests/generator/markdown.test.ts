import { describe, it, expect } from "vitest";
import {
  AGENTS_SECTION_START,
  AGENTS_SECTION_END,
  escapeSummary,
  generateAgentsMd,
  generateAgentsSection,
  detectAgentsAction,
  applyAgentsSection,
} from "../../src/generator/markdown.js";
import type { AgentsEntry } from "../../src/generator/markdown.js";

const sampleEntries: AgentsEntry[] = [
  { scope: ".", summary: "Project root with config and entry point" },
  { scope: "src/commands", summary: "CLI command handlers" },
  { scope: "src/core", summary: "Core scanning and fingerprinting" },
];

describe("escapeSummary", () => {
  it("passes through normal text unchanged", () => {
    expect(escapeSummary("Hello world")).toBe("Hello world");
  });

  it("escapes pipe characters", () => {
    expect(escapeSummary("A | B | C")).toBe("A \\| B \\| C");
  });

  it("escapes backticks", () => {
    expect(escapeSummary("Uses `chalk` for colors")).toBe("Uses \\`chalk\\` for colors");
  });

  it("replaces newlines with spaces", () => {
    expect(escapeSummary("Line one\nLine two")).toBe("Line one Line two");
  });

  it("replaces Windows newlines with spaces", () => {
    expect(escapeSummary("Line one\r\nLine two")).toBe("Line one Line two");
  });

  it("handles all special characters together", () => {
    expect(escapeSummary("A | B\n`code`")).toBe("A \\| B \\`code\\`");
  });
});

describe("generateAgentsMd", () => {
  it("produces valid markdown with both markers", () => {
    const result = generateAgentsMd("my-project", sampleEntries);
    expect(result).toContain(AGENTS_SECTION_START);
    expect(result).toContain(AGENTS_SECTION_END);
  });

  it("includes the AGENTS.md heading", () => {
    const result = generateAgentsMd("my-project", sampleEntries);
    expect(result).toContain("# AGENTS.md");
  });

  it("includes project name in header block", () => {
    const result = generateAgentsMd("my-project", sampleEntries);
    expect(result).toContain("Project: my-project");
  });

  it("includes How to Use section", () => {
    const result = generateAgentsMd("my-project", sampleEntries);
    expect(result).toContain("### How to Use Context Files");
    expect(result).toContain("Before exploring a directory");
  });

  it("includes Maintenance section", () => {
    const result = generateAgentsMd("my-project", sampleEntries);
    expect(result).toContain("### Maintenance");
    expect(result).toContain("Update `summary`");
  });

  it("lists all directory entries in the table", () => {
    const result = generateAgentsMd("my-project", sampleEntries);
    expect(result).toContain("`.` (root)");
    expect(result).toContain("`src/commands`");
    expect(result).toContain("`src/core`");
  });

  it("handles single entry (root only)", () => {
    const result = generateAgentsMd("my-project", [
      { scope: ".", summary: "Just a root" },
    ]);
    expect(result).toContain("`.` (root)");
    expect(result).toContain("Just a root");
  });

  it("escapes special characters in summaries", () => {
    const result = generateAgentsMd("my-project", [
      { scope: ".", summary: "Uses | pipes and `backticks`" },
    ]);
    expect(result).toContain("Uses \\| pipes and \\`backticks\\`");
  });

  it("handles very long summaries", () => {
    const longSummary = "A".repeat(300);
    const result = generateAgentsMd("my-project", [
      { scope: ".", summary: longSummary },
    ]);
    expect(result).toContain(longSummary);
  });
});

describe("generateAgentsSection", () => {
  it("wraps content in start and end markers", () => {
    const result = generateAgentsSection(sampleEntries);
    expect(result).toMatch(new RegExp(`^${escapeRegex(AGENTS_SECTION_START)}`));
    expect(result).toMatch(new RegExp(`${escapeRegex(AGENTS_SECTION_END)}$`));
  });

  it("includes directory table", () => {
    const result = generateAgentsSection(sampleEntries);
    expect(result).toContain("| Directory | Summary |");
    expect(result).toContain("src/core");
  });

  it("includes workflow instructions", () => {
    const result = generateAgentsSection(sampleEntries);
    expect(result).toContain("Before exploring a directory");
    expect(result).toContain("context status");
  });
});

describe("detectAgentsAction", () => {
  const section = generateAgentsSection(sampleEntries);

  it('returns "create" when content is null', () => {
    expect(detectAgentsAction(null, section)).toBe("create");
  });

  it('returns "append" when file has no markers', () => {
    expect(detectAgentsAction("# My Project\n\nSome instructions.\n", section)).toBe("append");
  });

  it('returns "replace" when section content differs', () => {
    const oldSection = generateAgentsSection([
      { scope: ".", summary: "Old summary" },
    ]);
    const existing = `# AGENTS.md\n\n${oldSection}\n`;
    expect(detectAgentsAction(existing, section)).toBe("replace");
  });

  it('returns "skip" when section content is identical', () => {
    const existing = `# AGENTS.md\n\n${section}\n`;
    expect(detectAgentsAction(existing, section)).toBe("skip");
  });

  // Malformed marker states
  it('returns "replace" for start marker without end marker', () => {
    const malformed = `# AGENTS.md\n\n${AGENTS_SECTION_START}\nSome partial content\n`;
    expect(detectAgentsAction(malformed, section)).toBe("replace");
  });

  it('returns "append" for end marker without start marker', () => {
    const malformed = `# AGENTS.md\n\nSome content\n${AGENTS_SECTION_END}\n`;
    expect(detectAgentsAction(malformed, section)).toBe("append");
  });

  it("uses first start marker when duplicates exist", () => {
    const duplicated = `${AGENTS_SECTION_START}\nFirst\n${AGENTS_SECTION_END}\nMiddle\n${AGENTS_SECTION_START}\nSecond\n${AGENTS_SECTION_END}\n`;
    // Should compare against first occurrence
    expect(detectAgentsAction(duplicated, section)).toBe("replace");
  });
});

describe("applyAgentsSection", () => {
  const section = generateAgentsSection(sampleEntries);

  it("appends section at end of existing content", () => {
    const existing = "# My Project\n\nCustom instructions.";
    const result = applyAgentsSection(existing, section, "append");
    expect(result).toContain("# My Project");
    expect(result).toContain("Custom instructions.");
    expect(result).toContain(AGENTS_SECTION_START);
    // User content comes before autocontext section
    expect(result.indexOf("Custom instructions.")).toBeLessThan(
      result.indexOf(AGENTS_SECTION_START),
    );
  });

  it("replaces content between markers", () => {
    const oldSection = generateAgentsSection([
      { scope: ".", summary: "Old summary" },
    ]);
    const existing = `Before\n\n${oldSection}\n\nAfter`;
    const result = applyAgentsSection(existing, section, "replace");
    expect(result).toContain("Before");
    expect(result).toContain("After");
    expect(result).toContain(AGENTS_SECTION_START);
    expect(result).not.toContain("Old summary");
    expect(result).toContain("Core scanning and fingerprinting");
  });

  it("preserves user content before and after markers on replace", () => {
    const oldSection = generateAgentsSection([
      { scope: ".", summary: "Old" },
    ]);
    const existing = `# Custom Header\n\nMy instructions here.\n\n${oldSection}\n\n## My Footer\n\nMore content.`;
    const result = applyAgentsSection(existing, section, "replace");
    expect(result).toContain("# Custom Header");
    expect(result).toContain("My instructions here.");
    expect(result).toContain("## My Footer");
    expect(result).toContain("More content.");
  });

  it("handles start marker without end marker (replaces to EOF)", () => {
    const malformed = `Before\n\n${AGENTS_SECTION_START}\nPartial content without end`;
    const result = applyAgentsSection(malformed, section, "replace");
    expect(result).toContain("Before");
    expect(result).toContain(AGENTS_SECTION_START);
    expect(result).toContain(AGENTS_SECTION_END);
    expect(result).not.toContain("Partial content without end");
  });

  it("falls back to append when no start marker found in replace mode", () => {
    const existing = "Just some content.";
    const result = applyAgentsSection(existing, section, "replace");
    expect(result).toContain("Just some content.");
    expect(result).toContain(AGENTS_SECTION_START);
  });
});

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
