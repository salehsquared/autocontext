# `context view`

Generate a self-contained HTML report showing every tracked scope, its freshness, evidence, and (optional) dependency graph. The output is a single file that works offline, works over `file://`, and works when emailed or committed to a PR.

## Quick start

```bash
context view
open context-report.html        # or --open to do both at once
```

The default output path is `./context-report.html` in the project root — discoverable, shareable, and naturally aligned with other local-report conventions (`coverage/index.html`, `lighthouse.html`). Add `context-report.html` to `.gitignore` if you don't want to commit it.

## What it shows

- **Directory tree** in the left nav, one `<details>` per scope. Each node carries a freshness icon and a policy-violation badge when applicable.
- **Detail pane** for the selected scope: summary, decisions, constraints, subdirectory links, exports, evidence block, policy violations, and the raw `.context.yaml`.
- **Dependency graph** — force-directed SVG over directory-level import edges. Hidden when `.autocontext/index/` is absent. Click a node to jump to that scope.
- **Legend + totals** (`N fresh · N stale · N missing · N violations`) in the header.

## Flags

| Flag | Default | Behavior |
|---|---|---|
| `--out <path>` | `context-report.html` | Output file. Parent directory may be missing one level (auto-created). |
| `--open` | off | Opens the file in the OS default browser after writing. No-op under `CI=1`. |
| `--no-graph` | off | Skip the dep-graph section. Smaller output; faster on huge repos. |
| `--no-source` | off | Drop exports' signatures and the raw YAML bodies. Biggest size saving. |
| `-p, --path <root>` | `.` | Project root. |

## Exit codes

| Code | When |
|---|---|
| 0 | File written successfully |
| 1 | `-p, --path` is missing or not a directory |
| 2 | Output path unwritable, or generated report exceeds the 2 MB hard cap |

## Graceful degradation

`context view` runs on a plain repo with only `.context.yaml` files and still produces a useful report. Absent prerequisites degrade to placeholders rather than errors:

| Missing | What the viewer does |
|---|---|
| `.autocontext/index/` (T1) | Hides the Dependency graph tab. Freshness collapses to the 3-state enum. |
| `.autocontext/policy-results.json` | Policy chips render as "not evaluated". Neutral — never invents red/green signals. |
| `semantic_fingerprint` in yaml | Falls back to 3-state freshness. |
| `evidence:` block | Detail pane omits the Evidence section for that scope. |

To populate the graph and policy chips:

```bash
context index                                                     # enable graph
context validate --policy --json > .autocontext/policy-results.json  # enable policy chips
context view --open
```

## Self-contained, offline, no CDN

- No `<script src>`, no `<link href>`, no external assets. Everything is inlined (CSS, JS, SVG icons).
- Ships a restrictive CSP: `default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:`. No network at all.
- Uses the system font stack. No webfonts.
- Respects `prefers-color-scheme` (light/dark). Respects `prefers-reduced-motion`.

## Size budget

- Soft cap: < 500 KB for a medium repo (~200 scopes).
- Hard cap: 2 MB. Larger than that fails the command and suggests `--no-source` / `--no-graph`.

On this repo today (83 scopes, with the index built): ~233 KB with everything, ~91 KB with `--no-source --no-graph`.

## Determinism

Given the same inputs, `context view` produces byte-identical output. Ordering is stable (scopes sort lexicographically; dep-edges sort by `(source, target)`; graph layout is seeded from scope-id hashes). The only non-deterministic field is `generated_at` — set `FROZEN_TIME=<ISO>` to pin it for snapshot tests.

## Limitations

- No editor — the viewer never writes `.context.yaml`.
- No server — no hot reload, no router, no IPC.
- No framework — hand-rolled DOM. If you want to add features, keep the vanilla-JS constraint.
- Dep-graph layout is force-directed; adding a scope can reshuffle positions. Use `--no-graph` if you need stable diagrams.
- No string-intern compression in the JSON blob (v1). Large monorepos may hit the soft cap — file an issue if this bites.
