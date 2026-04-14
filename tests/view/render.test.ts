import { describe, it, expect } from "vitest";
import { renderHtml } from "../../src/view/render.js";
import type { ViewData } from "../../src/view/types.js";

function makeData(overrides: Partial<ViewData> = {}): ViewData {
  return {
    project: {
      name: "demo",
      root: "/tmp/demo",
      generated_at: "2026-04-14T00:00:00Z",
      autocontext_version: "0.2.0",
    },
    scopes: [
      {
        scope: ".",
        summary: "Root",
        freshness: "fresh",
        decisions: [],
        constraints: [],
        subdirectories: [{ name: "src/", summary: "src", freshness: "fresh" }],
        exports: [],
        violations: [],
        raw_yaml: "version: 1\n",
        file_count: 1,
      },
      {
        scope: "src",
        summary: "Source",
        freshness: "stale",
        decisions: [],
        constraints: ["no circular deps"],
        subdirectories: [],
        exports: [{ name: "buildPack", signature: "(opts) => Pack" }],
        violations: [{ rule_kind: "forbid_import", message: "bad", file: "src/a.ts", line: 3 }],
        raw_yaml: "version: 1\n",
        file_count: 3,
      },
    ],
    dir_edges: [{ source: "src", target: ".", weight: 1 }],
    has_index: true,
    has_policy: true,
    has_semantic_staleness: false,
    totals: { fresh: 1, stale: 1, semantic_stale: 0, cosmetic_stale: 0, missing: 0, violations: 1 },
    ...overrides,
  };
}

describe("renderHtml", () => {
  it("emits a self-contained HTML document with no remote fetches", () => {
    const html = renderHtml(makeData(), { includeGraph: true, includeSource: true });
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("autocontext-data");
    expect(html).toContain("role=\"banner\"");
    expect(html).toContain("role=\"complementary\"");
    // No remote fetches.
    expect(html).not.toMatch(/<script\s+src=/i);
    expect(html).not.toMatch(/<link\s+[^>]*href="https?:\/\//i);
    expect(html).not.toMatch(/<img\s+[^>]*src="https?:\/\//i);
    // CSP present.
    expect(html).toContain("Content-Security-Policy");
  });

  it("embeds tree entries for every scope", () => {
    const html = renderHtml(makeData(), { includeGraph: true, includeSource: true });
    expect(html).toContain('href="#scope=."');
    expect(html).toContain('href="#scope=src"');
    expect(html).toContain('<details');
  });

  it("--no-graph hides the graph section and nav", () => {
    const html = renderHtml(makeData(), { includeGraph: false, includeSource: true });
    expect(html).not.toContain('id="graph"');
    expect(html).not.toContain('id="nav-graph"');
  });

  it("--no-source strips raw_yaml and export signatures from the embedded blob", () => {
    const html = renderHtml(makeData(), { includeGraph: true, includeSource: false });
    const blobMatch = html.match(/<script type="application\/json" id="autocontext-data">(.*?)<\/script>/s);
    expect(blobMatch).toBeTruthy();
    const blob = JSON.parse(blobMatch![1].replace(/<\\\//g, "</"));
    for (const s of blob.scopes) {
      expect(s.raw_yaml).toBe("");
      for (const e of s.exports) expect(e.signature).toBeUndefined();
    }
  });

  it("renders the same bytes for the same data (deterministic)", () => {
    const a = renderHtml(makeData(), { includeGraph: true, includeSource: true });
    const b = renderHtml(makeData(), { includeGraph: true, includeSource: true });
    expect(a).toBe(b);
  });

  it("produces output under the byte-size guard for a small fixture", () => {
    const html = renderHtml(makeData(), { includeGraph: true, includeSource: true });
    expect(html.length).toBeLessThan(250 * 1024);
  });

  it("degrades politely when has_index/has_policy are false", () => {
    const html = renderHtml(
      makeData({ has_index: false, has_policy: false, dir_edges: [] }),
      { includeGraph: true, includeSource: true },
    );
    expect(html).not.toContain('id="nav-graph"');
  });

  it("escapes HTML-unsafe scope names", () => {
    const data = makeData({
      scopes: [
        {
          scope: "<script>",
          summary: "xss",
          freshness: "fresh",
          decisions: [],
          constraints: [],
          subdirectories: [],
          exports: [],
          violations: [],
          raw_yaml: "",
          file_count: 0,
        },
      ],
    });
    const html = renderHtml(data, { includeGraph: false, includeSource: false });
    // The real XSS vector is breaking out of <script type="application/json">
    // via a literal </script>. That must be escaped.
    const blobMatch = html.match(/<script type="application\/json" id="autocontext-data">([\s\S]*?)<\/script>/);
    expect(blobMatch).toBeTruthy();
    expect(blobMatch![1]).not.toContain("</script>");
    // In HTML context (outside the JSON blob), the raw scope name must be entity-escaped.
    const beforeBlob = html.slice(0, html.indexOf('<script type="application/json"'));
    expect(beforeBlob).not.toMatch(/<script>/);
  });
});
