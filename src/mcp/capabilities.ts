/**
 * T6 capability metadata. Single source of truth for tool versioning.
 *
 * `tools_version` bumps on breaking changes to existing tools (removing,
 * narrowing input, changing output key semantics). Additive changes are
 * silent.
 */

export const SERVER_VERSION = "0.2.0";
export const TOOLS_VERSION = 2;

export const TOOL_SINCE_VERSION: Record<string, number> = {
  query_context: 1,
  check_freshness: 1,
  list_contexts: 1,
  aggregate_evidence: 1,
  find_definition: 2,
  find_references: 2,
  find_related: 2,
  search_context: 2,
  build_context_pack: 2,
  explain_staleness: 2,
  impact: 2,
  check_policies: 2,
};

export interface CapabilityResource {
  server_version: string;
  tools_version: number;
  tools: Array<{ name: string; since: number }>;
  index: { required_by: string[] };
  bm25: { required_by: string[] };
  compat: {
    legacy_state_tools: string[];
    new_state_tools: string[];
  };
}

export function buildCapabilityResource(): CapabilityResource {
  return {
    server_version: SERVER_VERSION,
    tools_version: TOOLS_VERSION,
    tools: Object.entries(TOOL_SINCE_VERSION)
      .map(([name, since]) => ({ name, since }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    index: {
      required_by: [
        "find_definition",
        "find_references",
        "find_related",
        "impact",
        "check_policies",
        "explain_staleness",
      ],
    },
    bm25: { required_by: ["search_context", "build_context_pack"] },
    compat: {
      legacy_state_tools: ["check_freshness", "list_contexts"],
      new_state_tools: ["explain_staleness"],
    },
  };
}
