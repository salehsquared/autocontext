# 04 — Change signature of a different used export

Change `capitalize` in `src/core/strings.ts` to take an additional option. `capitalize` is used by `src/commands/format.ts` but **not** by `src/commands/compute.ts` or `src/mcp/server.ts`.

**Expected impact directories:** `src/commands` only. `src/mcp` is NOT affected — it depends on `compute`, which depends on `math`, not on `strings`.

This is the test case that distinguishes directory-level impact from naive whole-module propagation.
