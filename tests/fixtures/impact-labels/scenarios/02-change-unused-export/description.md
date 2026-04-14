# 02 — Change body of an unused export

Change the body of `multiply` in `src/core/math.ts`. Nobody imports `multiply`.

**Why it should NOT propagate:** the reverse-reference graph shows zero consumers of `multiply`. The file's semantic fingerprint may change (a public signature moved), but no downstream directory is actually affected.

**Expected impact directories:** none.

Note: a fingerprint-only staleness check would mark `src/core/` stale, but `context impact` operates over the reference graph, not fingerprints, so it returns an empty set here. This is the correct behavior and is precisely why the semantic layer exists.
