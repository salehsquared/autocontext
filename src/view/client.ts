/**
 * Browser-side hydration + dep-graph layout. Authored as vanilla browser JS
 * and embedded verbatim as a string. No imports, no bundler.
 *
 * The template inlines CLIENT_JS inside a `<script type="module">` tag, so
 * `document` and `window` are available at evaluation time.
 */
export const CLIENT_JS = String.raw`
(() => {
  const blob = document.getElementById("autocontext-data");
  if (!blob) return;
  let data;
  try {
    data = JSON.parse(blob.textContent || "{}");
  } catch (err) {
    console.error("autocontext: failed to parse data blob", err);
    return;
  }
  const scopesByKey = new Map(data.scopes.map((s) => [s.scope, s]));
  const detail = document.getElementById("detail");
  const graph = document.getElementById("graph");
  const overviewBtn = document.getElementById("nav-overview");
  const graphBtn = document.getElementById("nav-graph");

  function showPanel(which) {
    if (which === "graph" && graph && data.has_index) {
      detail?.setAttribute("hidden", "");
      graph.removeAttribute("hidden");
      if (!graph.dataset.rendered) renderGraph();
      graphBtn?.setAttribute("aria-current", "page");
      overviewBtn?.removeAttribute("aria-current");
    } else {
      graph?.setAttribute("hidden", "");
      detail?.removeAttribute("hidden");
      overviewBtn?.setAttribute("aria-current", "page");
      graphBtn?.removeAttribute("aria-current");
    }
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function chip(kind, label) {
    return '<span class="chip ' + kind + '">' + escapeHtml(label) + '</span>';
  }

  function renderScope(scope) {
    if (!detail) return;
    const freshnessLabel = scope.freshness.replace(/_/g, " ");
    const policyChip = data.has_policy
      ? (scope.violations.length === 0
        ? chip("fresh", "policy: clean")
        : chip("semantic_stale", scope.violations.length + " violation" + (scope.violations.length === 1 ? "" : "s")))
      : chip("missing", "policy: not evaluated");

    let html = '';
    html += '<h2 tabindex="-1">' + escapeHtml(scope.scope === "." ? "(root)" : scope.scope) + '</h2>';
    html += '<div class="chips">' + chip(scope.freshness, freshnessLabel) + policyChip + '</div>';
    if (scope.summary) html += '<p>' + escapeHtml(scope.summary) + '</p>';

    if (scope.decisions && scope.decisions.length > 0) {
      html += '<h3>Decisions</h3><dl>';
      for (const d of scope.decisions) {
        html += '<dt><strong>' + escapeHtml(d.what) + '</strong></dt>';
        html += '<dd>' + escapeHtml(d.why) + (d.tradeoff ? ' <em>(tradeoff: ' + escapeHtml(d.tradeoff) + ')</em>' : '') + '</dd>';
      }
      html += '</dl>';
    }

    if (scope.constraints && scope.constraints.length > 0) {
      html += '<h3>Constraints</h3><ul>';
      for (const c of scope.constraints) html += '<li>' + escapeHtml(c) + '</li>';
      html += '</ul>';
    }

    if (scope.subdirectories && scope.subdirectories.length > 0) {
      html += '<h3>Subdirectories</h3><ul>';
      for (const sub of scope.subdirectories) {
        const childKey = scope.scope === "." ? stripSlash(sub.name) : scope.scope + "/" + stripSlash(sub.name);
        html += '<li><a href="#scope=' + encodeURIComponent(childKey) + '">' + escapeHtml(sub.name) + '</a>';
        if (sub.summary) html += ' — ' + escapeHtml(sub.summary);
        html += ' ' + chip(sub.freshness, sub.freshness.replace(/_/g, " "));
        html += '</li>';
      }
      html += '</ul>';
    }

    if (scope.exports && scope.exports.length > 0) {
      html += '<h3>Exports</h3><table class="exports-table"><tbody>';
      for (const e of scope.exports) {
        html += '<tr><td>' + escapeHtml(e.name) + '</td><td>' + escapeHtml(e.signature ?? "") + '</td></tr>';
      }
      html += '</tbody></table>';
    }

    if (scope.evidence) {
      const ev = scope.evidence;
      html += '<h3>Evidence</h3><ul>';
      if (ev.test_status) html += '<li>tests: ' + escapeHtml(ev.test_status) + (ev.test_count !== undefined ? ' (' + ev.test_count + ')' : '') + '</li>';
      if (ev.typecheck) html += '<li>typecheck: ' + escapeHtml(ev.typecheck) + '</li>';
      if (ev.lint_status) html += '<li>lint: ' + escapeHtml(ev.lint_status) + '</li>';
      if (ev.coverage_percent !== undefined) html += '<li>coverage: ' + escapeHtml(ev.coverage_percent) + '%</li>';
      if (ev.collected_at) html += '<li class="muted">collected ' + escapeHtml(ev.collected_at) + '</li>';
      html += '</ul>';
    }

    if (data.has_policy) {
      html += '<h3>Policy violations</h3>';
      if (scope.violations && scope.violations.length > 0) {
        html += '<ul class="violations-list">';
        for (const v of scope.violations) {
          const loc = v.file ? (v.line ? v.file + ':' + v.line : v.file) : '';
          html += '<li><span class="rule">' + escapeHtml(v.rule_kind) + '</span>' + escapeHtml(v.message);
          if (loc) html += ' <code>' + escapeHtml(loc) + '</code>';
          html += '</li>';
        }
        html += '</ul>';
      } else {
        html += '<p class="muted">No violations in this scope.</p>';
      }
    }

    if (scope.raw_yaml) {
      html += '<h3>.context.yaml</h3><details><summary>Show source</summary><pre>' + escapeHtml(scope.raw_yaml) + '</pre></details>';
    }

    detail.innerHTML = html;
    const h2 = detail.querySelector('h2');
    if (h2) h2.focus({ preventScroll: true });
  }

  function stripSlash(s) { return s.endsWith('/') ? s.slice(0, -1) : s; }

  function renderOverviewDefault() {
    if (!detail) return;
    let html = '<h2 tabindex="-1">Project overview</h2>';
    html += '<p>Select a scope on the left to see its details.</p>';
    html += '<p>' + data.scopes.length + ' scope' + (data.scopes.length === 1 ? '' : 's') + ' tracked.</p>';
    if (!data.has_index) html += '<p class="muted">Run <code>context index</code> to enable the dependency graph.</p>';
    if (!data.has_policy) html += '<p class="muted">Run <code>context validate --policy --json &gt; .autocontext/policy-results.json</code> to show rule violations.</p>';
    detail.innerHTML = html;
  }

  function applyHash() {
    const hash = window.location.hash.slice(1);
    const params = new URLSearchParams(hash);
    const scopeKey = params.get("scope");
    if (scopeKey && scopesByKey.has(scopeKey)) {
      renderScope(scopesByKey.get(scopeKey));
      showPanel("overview");
    } else if (hash === "graph") {
      showPanel("graph");
    } else {
      renderOverviewDefault();
    }
  }

  window.addEventListener("hashchange", applyHash);
  applyHash();

  // Nav buttons
  overviewBtn?.addEventListener("click", (e) => { e.preventDefault(); window.location.hash = ""; });
  graphBtn?.addEventListener("click", (e) => { e.preventDefault(); window.location.hash = "graph"; });

  // --- Dep-graph (Fruchterman-Reingold, 40 iterations, deterministic) ---

  function renderGraph() {
    if (!graph || !data.has_index || !data.dir_edges?.length) return;
    graph.dataset.rendered = "1";
    const nodeIds = new Set();
    for (const e of data.dir_edges) { nodeIds.add(e.source); nodeIds.add(e.target); }
    const nodes = [...nodeIds].map((id) => {
      const scope = scopesByKey.get(id);
      return { id, size: scope?.file_count ?? 1, freshness: scope?.freshness ?? "missing" };
    }).sort((a, b) => a.id.localeCompare(b.id));
    const edges = data.dir_edges.slice().sort((a, b) => (a.source + a.target).localeCompare(b.source + b.target));

    const N = nodes.length;
    if (N === 0) return;
    const W = 900, H = 560;
    const k = Math.sqrt((W * H) / N);
    const index = new Map(nodes.map((n, i) => [n.id, i]));
    // Deterministic seeding via hash(id).
    const pos = nodes.map((n) => {
      let h = 0;
      for (let i = 0; i < n.id.length; i++) h = (h * 31 + n.id.charCodeAt(i)) >>> 0;
      return { x: (h % W), y: ((h >>> 16) % H) };
    });
    const disp = nodes.map(() => ({ x: 0, y: 0 }));
    for (let iter = 0; iter < 40; iter++) {
      const t = (1 - iter / 40) * (W / 10);
      for (let i = 0; i < N; i++) disp[i].x = disp[i].y = 0;
      for (let i = 0; i < N; i++) {
        for (let j = i + 1; j < N; j++) {
          let dx = pos[i].x - pos[j].x;
          let dy = pos[i].y - pos[j].y;
          let d = Math.sqrt(dx * dx + dy * dy) || 0.01;
          const f = (k * k) / d;
          dx = (dx / d) * f; dy = (dy / d) * f;
          disp[i].x += dx; disp[i].y += dy;
          disp[j].x -= dx; disp[j].y -= dy;
        }
      }
      for (const e of edges) {
        const a = index.get(e.source), b = index.get(e.target);
        if (a === undefined || b === undefined) continue;
        let dx = pos[a].x - pos[b].x;
        let dy = pos[a].y - pos[b].y;
        const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const f = (d * d) / k;
        dx = (dx / d) * f; dy = (dy / d) * f;
        disp[a].x -= dx; disp[a].y -= dy;
        disp[b].x += dx; disp[b].y += dy;
      }
      for (let i = 0; i < N; i++) {
        const d = Math.sqrt(disp[i].x * disp[i].x + disp[i].y * disp[i].y) || 0.01;
        pos[i].x += (disp[i].x / d) * Math.min(d, t);
        pos[i].y += (disp[i].y / d) * Math.min(d, t);
        pos[i].x = Math.max(10, Math.min(W - 10, pos[i].x));
        pos[i].y = Math.max(10, Math.min(H - 10, pos[i].y));
      }
    }

    let svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="dependency graph">';
    for (const e of edges) {
      const a = index.get(e.source), b = index.get(e.target);
      if (a === undefined || b === undefined) continue;
      svg += '<line x1="' + pos[a].x.toFixed(1) + '" y1="' + pos[a].y.toFixed(1) + '" x2="' + pos[b].x.toFixed(1) + '" y2="' + pos[b].y.toFixed(1) + '" stroke-width="' + Math.min(3, e.weight) + '"/>';
    }
    for (let i = 0; i < N; i++) {
      const n = nodes[i];
      const r = 4 + Math.min(10, Math.sqrt(n.size));
      const color = ({
        fresh: "#2e7d32",
        stale: "#c25c00",
        cosmetic_stale: "#c25c00",
        semantic_stale: "#b9151a",
        missing: "#888888",
      })[n.freshness] || "#888888";
      svg += '<g tabindex="0">';
      svg += '<circle cx="' + pos[i].x.toFixed(1) + '" cy="' + pos[i].y.toFixed(1) + '" r="' + r + '" fill="' + color + '" data-scope="' + escapeHtml(n.id) + '"><title>' + escapeHtml(n.id) + ' (' + n.size + ' file' + (n.size === 1 ? '' : 's') + ', ' + n.freshness.replace(/_/g, ' ') + ')</title></circle>';
      svg += '<text x="' + (pos[i].x + r + 3).toFixed(1) + '" y="' + (pos[i].y + 3).toFixed(1) + '">' + escapeHtml(n.id) + '</text>';
      svg += '</g>';
    }
    svg += '</svg>';
    graph.innerHTML = '<h2 tabindex="-1">Dependency graph</h2>' + svg;
    graph.querySelectorAll("circle[data-scope]").forEach((el) => {
      el.addEventListener("click", (ev) => {
        const scopeId = ev.target.getAttribute("data-scope");
        if (scopeId) window.location.hash = "scope=" + encodeURIComponent(scopeId);
      });
    });
  }
})();
`.trim();
