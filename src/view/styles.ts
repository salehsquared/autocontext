export const STYLES = `
:root {
  --fg: #1a1a1a;
  --bg: #fafaf7;
  --muted: #5a5a5a;
  --accent: #0b63d6;
  --line: #dad8d3;
  --chip-bg: #ececec;
  --fresh: #2e7d32;
  --stale: #c25c00;
  --semantic: #b9151a;
  --missing: #888888;
}
@media (prefers-color-scheme: dark) {
  :root {
    --fg: #e9e7e2;
    --bg: #1c1d20;
    --muted: #9aa0a6;
    --accent: #74a8ff;
    --line: #373941;
    --chip-bg: #2b2d33;
    --fresh: #7bc47f;
    --stale: #f2b676;
    --semantic: #f28a86;
    --missing: #888888;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; }
body {
  background: var(--bg);
  color: var(--fg);
  font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  min-height: 100vh;
}
a { color: var(--accent); text-decoration: none; }
a:hover, a:focus { text-decoration: underline; }
header[role="banner"] {
  padding: 14px 20px;
  border-bottom: 1px solid var(--line);
  display: flex;
  align-items: baseline;
  gap: 20px;
  flex-wrap: wrap;
}
header h1 { margin: 0; font-size: 18px; font-weight: 600; }
header nav { display: flex; gap: 12px; }
header .badges {
  margin-left: auto;
  color: var(--muted);
  font-size: 12px;
}
main {
  display: grid;
  grid-template-columns: minmax(220px, 300px) minmax(320px, 1fr);
  min-height: calc(100vh - 60px);
}
aside[role="complementary"] {
  border-right: 1px solid var(--line);
  padding: 12px;
  overflow-y: auto;
  max-height: calc(100vh - 60px);
  position: sticky;
  top: 60px;
}
aside details { margin-left: 0; }
aside details details { margin-left: 14px; }
aside summary {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: 3px;
}
aside summary:hover { background: var(--chip-bg); }
aside summary .label {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
aside summary .violations {
  font-size: 11px;
  background: var(--semantic);
  color: white;
  border-radius: 9px;
  padding: 1px 6px;
}
section#detail {
  padding: 18px 24px;
  max-width: 900px;
  overflow-wrap: anywhere;
}
section#detail h2 { margin: 0 0 4px; }
section#detail .chips { margin-bottom: 10px; display: flex; gap: 6px; flex-wrap: wrap; }
section#detail h3 {
  margin-top: 22px;
  margin-bottom: 6px;
  font-size: 14px;
  text-transform: uppercase;
  color: var(--muted);
  letter-spacing: 0.05em;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--chip-bg);
  font-size: 12px;
}
.chip.fresh { color: var(--fresh); border: 1px solid var(--fresh); background: transparent; }
.chip.stale, .chip.cosmetic_stale { color: var(--stale); border: 1px solid var(--stale); background: transparent; }
.chip.semantic_stale { color: var(--semantic); border: 1px solid var(--semantic); background: transparent; }
.chip.missing { color: var(--missing); border: 1px solid var(--missing); background: transparent; }
.icon { width: 14px; height: 14px; vertical-align: middle; }
.icon.fresh { color: var(--fresh); }
.icon.stale, .icon.cosmetic_stale { color: var(--stale); }
.icon.semantic_stale { color: var(--semantic); }
.icon.missing { color: var(--missing); }
.violations-list li { margin: 4px 0; }
.violations-list .rule { color: var(--muted); font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12px; margin-right: 6px; }
pre, code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
pre {
  background: var(--chip-bg);
  padding: 10px 12px;
  border-radius: 4px;
  overflow-x: auto;
  max-height: 400px;
}
.exports-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.exports-table td { padding: 3px 6px; border-bottom: 1px solid var(--line); vertical-align: top; }
.exports-table td:first-child { font-family: ui-monospace, SFMono-Regular, monospace; white-space: nowrap; color: var(--accent); }
footer { padding: 14px 20px; color: var(--muted); font-size: 12px; border-top: 1px solid var(--line); }
#graph { padding: 18px 24px; }
#graph svg { width: 100%; max-height: 70vh; background: var(--chip-bg); border-radius: 4px; }
#graph circle { cursor: pointer; }
#graph text { pointer-events: none; font-size: 10px; fill: var(--fg); }
#graph line { stroke: var(--muted); stroke-opacity: 0.4; }
.skip-link {
  position: absolute;
  left: -9999px;
  top: auto;
}
.skip-link:focus {
  position: fixed;
  top: 8px;
  left: 8px;
  padding: 6px 10px;
  background: var(--bg);
  border: 2px solid var(--accent);
  z-index: 100;
}
.sr-only {
  position: absolute;
  width: 1px; height: 1px;
  padding: 0; margin: -1px;
  overflow: hidden;
  clip: rect(0,0,0,0);
  white-space: nowrap;
  border: 0;
}
@media (prefers-reduced-motion: reduce) {
  * { transition: none !important; animation: none !important; }
}
`.trim();
