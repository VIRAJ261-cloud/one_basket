/*
 * Route search visualizer.
 *
 * The browser does NOT run its own Dijkstra/A*. It replays the steps that
 * the server recorded from the project's real algorithms (src/tracing.py):
 *
 *   step = one priority-queue pop:
 *     kind      "expand" | "goal" | "stale" (outdated entry skipped)
 *     node      popped node, with its g / h / f
 *     examined  neighbours whose road was relaxed
 *     relaxed   neighbours whose cost improved (pushed), with new g / h / f
 *     frontier_size, frontier_top   priority queue after the step
 *
 * Timeline per algorithm: position 0 = start, 1..steps = search steps,
 * then one extra position per final-path road (traced back from the
 * destination along the parent links, as reconstruct_path() does).
 */
"use strict";

const SVGNS = "http://www.w3.org/2000/svg";
const ALGO_LABEL = { dijkstra: "Dijkstra", astar: "A*" };

const app = {
  graph: null,           // /api/graph payload
  nodes: new Map(),      // id -> node
  pairs: new Map(),      // "a|b" -> edge pair
  data: null,            // /api/search payload
  runners: [],           // one per visible algorithm panel
  tick: 0,
  maxTick: 0,
  timer: null,
  playing: false,
  view: null,            // shared SVG viewBox {x, y, w, h}
  searchBox: null,
};

// ---------------------------------------------------------------- helpers
const $ = (sel) => document.querySelector(sel);
const pairKey = (u, v) => (u < v ? `${u}|${v}` : `${v}|${u}`);

function esc(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function svgEl(tag, attrs, parent) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  if (parent) parent.appendChild(el);
  return el;
}

function unit() { return app.data ? app.data.unit : "min"; }

function fmtCost(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return "–";
  return unit() === "km" ? `${v.toFixed(3)} km` : `${v.toFixed(2)} min`;
}
function fmtShort(v) { return unit() === "km" ? v.toFixed(2) : v.toFixed(1); }
function fmtMs(v) { return v === undefined ? "–" : `${v.toFixed(4)} ms`; }

function nodeName(id) {
  const n = app.nodes.get(id);
  return n ? n.name : id;
}

function showError(msg) {
  const box = $("#error");
  box.textContent = msg;
  box.hidden = !msg;
}

// ---------------------------------------------------------------- startup
async function init() {
  try {
    const res = await fetch("/api/graph");
    app.graph = await res.json();
  } catch (err) {
    showError("Could not load the graph from the server. Is visualize.py running?");
    $("#graphInfo").textContent = "Graph not loaded.";
    return;
  }
  const g = app.graph;
  for (const n of g.nodes) app.nodes.set(n.id, n);
  for (const e of g.edges) app.pairs.set(pairKey(e.a, e.b), e);

  $("#graphInfo").textContent =
    `Real dataset: ${g.stats.locations} locations (${g.stats.societies} societies, ` +
    `${g.stats.restaurants} restaurants) · ${g.stats.roads} one-way roads · ` +
    `positioned by latitude/longitude`;

  const list = $("#locations");
  const sorted = [...g.nodes].sort((a, b) =>
    (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind === "Society" ? -1 : 1));
  for (const n of sorted) {
    const opt = document.createElement("option");
    opt.value = `${n.id} — ${n.name} (${n.kind}, ${n.area})`;
    list.appendChild(opt);
  }
  $("#source").value = optionText("R128");
  $("#target").value = optionText("S019");

  wireControls();
  updateButtons();
  await applyUrlParams();
}

/**
 * Optional deep link for preparing a presentation, e.g.
 *   /?source=R128&target=S019&mode=compare&metric=time&step=40
 * starts immediately and pauses at step 40 ("step=end" for the result).
 */
async function applyUrlParams() {
  const q = new URLSearchParams(location.search);
  if (!q.has("source") || !q.has("target")) return;
  $("#source").value = optionText(q.get("source").toUpperCase()) || q.get("source");
  $("#target").value = optionText(q.get("target").toUpperCase()) || q.get("target");
  const pick = (name, value) => {
    const el = document.querySelector(`input[name=${name}][value="${value}"]`);
    if (el) el.checked = true;
  };
  if (q.has("mode")) pick("mode", q.get("mode"));
  if (q.has("algo")) pick("algo", q.get("algo"));
  if (["time", "distance"].includes(q.get("metric"))) $("#metric").value = q.get("metric");
  await startVisualization();
  if (q.has("step") && app.runners.length) {
    pause();
    const step = q.get("step");
    stepTo(step === "end" ? app.maxTick : Number(step) || 0);
  }
}

function optionText(id) {
  const n = app.nodes.get(id);
  return n ? `${n.id} — ${n.name} (${n.kind}, ${n.area})` : "";
}

/** "R190 — Hotel ..." -> "R190"; anything else is sent as typed. */
function locationQuery(text) {
  const m = text.trim().match(/^([A-Za-z]\d+)\s+—/);
  return m ? m[1] : text.trim();
}

function wireControls() {
  $("#startBtn").addEventListener("click", startVisualization);
  $("#playBtn").addEventListener("click", play);
  $("#pauseBtn").addEventListener("click", pause);
  $("#nextBtn").addEventListener("click", () => { pause(); stepTo(app.tick + 1); });
  $("#prevBtn").addEventListener("click", () => { pause(); stepTo(app.tick - 1); });
  $("#restartBtn").addEventListener("click", () => { pause(); stepTo(0); });
  $("#costLabels").addEventListener("change", renderAll);
  $("#fitBtn").addEventListener("click", () => fitView(app.searchBox));
  $("#fitAllBtn").addEventListener("click", () => fitView(null));
  document.querySelectorAll("input[name=mode]").forEach((r) =>
    r.addEventListener("change", () => {
      $("#algoField").style.opacity = modeValue() === "compare" ? 0.4 : 1;
    }));
  for (const id of ["#source", "#target"]) {
    $(id).addEventListener("keydown", (e) => { if (e.key === "Enter") startVisualization(); });
  }
  document.addEventListener("keydown", onKey);
  window.addEventListener("resize", renderAll);
}

function onKey(e) {
  if (["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement.tagName)) return;
  if (!app.runners.length) return;
  if (e.key === " ") { e.preventDefault(); app.playing ? pause() : play(); }
  else if (e.key === "ArrowRight") { pause(); stepTo(app.tick + 1); }
  else if (e.key === "ArrowLeft") { pause(); stepTo(app.tick - 1); }
  else if (e.key === "r" || e.key === "R") { pause(); stepTo(0); }
}

const modeValue = () => document.querySelector("input[name=mode]:checked").value;
const algoValue = () => document.querySelector("input[name=algo]:checked").value;

// ---------------------------------------------------------------- search
async function startVisualization() {
  pause();
  showError("");
  const source = locationQuery($("#source").value);
  const target = locationQuery($("#target").value);
  if (!source || !target) { showError("Please enter both a source and a destination."); return; }

  const params = new URLSearchParams({ source, target, metric: $("#metric").value });
  $("#startBtn").disabled = true;
  $("#startBtn").textContent = "Running algorithms…";
  try {
    const res = await fetch(`/api/search?${params}`);
    const payload = await res.json();
    if (!res.ok) { showError(payload.error || "Search failed."); return; }
    app.data = payload;
  } catch (err) {
    showError("Could not reach the visualization server.");
    return;
  } finally {
    $("#startBtn").disabled = false;
    $("#startBtn").textContent = "Start Visualization";
  }

  const mode = modeValue();
  const algos = mode === "compare" ? ["dijkstra", "astar"] : [algoValue()];
  $("#stage").className = `stage ${mode}`;
  buildPanels(algos);
  app.searchBox = searchArea();
  app.tick = 0;
  app.maxTick = Math.max(...app.runners.map((r) => r.total));
  fitView(app.searchBox);
  renderHeuristicNote();
  play();
}

/** Every node either algorithm touched, plus the endpoints. */
function searchArea() {
  const ids = new Set([app.data.source, app.data.target]);
  for (const algo of ["dijkstra", "astar"]) {
    for (const s of app.data[algo].steps) {
      ids.add(s.node);
      s.examined.forEach((n) => ids.add(n));
    }
  }
  return ids;
}

// ---------------------------------------------------------------- panels
function buildPanels(algos) {
  const host = $("#panels");
  host.innerHTML = "";
  app.runners = algos.map((algo) => {
    const run = app.data[algo];
    const panel = document.createElement("div");
    panel.className = "card panel";
    panel.innerHTML = `
      <div class="panel-head">
        <h2>${ALGO_LABEL[algo]}</h2>
        <span class="badge ${run.verified ? "ok" : "warn"}"
          title="Trace replay matches a normal run of the algorithm (path, cost, nodes, edges)">
          ${run.verified ? "trace verified ✓" : "trace mismatch"}</span>
        <span class="pstats"></span>
      </div>
      <svg class="graph" role="img" aria-label="${ALGO_LABEL[algo]} search on the delivery graph"></svg>
      <div class="panel-foot"><div class="pcur"></div><div class="act"></div></div>`;
    host.appendChild(panel);

    const svg = panel.querySelector("svg");
    const edgeLayer = svgEl("g", {}, svg);
    const nodeLayer = svgEl("g", {}, svg);
    const pulse = svgEl("circle", { class: "pulse", r: 0 }, svg);
    const labelLayer = svgEl("g", {}, svg);

    const edgeEls = new Map();
    for (const [key, e] of app.pairs) {
      const a = app.nodes.get(e.a), b = app.nodes.get(e.b);
      edgeEls.set(key, svgEl("line", {
        x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: "e",
      }, edgeLayer));
    }
    // Draw restaurants first so the (fewer, bigger) societies sit on top.
    const nodeEls = new Map();
    const order = [...app.graph.nodes].sort((a, b) =>
      (a.kind === b.kind ? 0 : a.kind === "Restaurant" ? -1 : 1));
    for (const n of order) {
      nodeEls.set(n.id, svgEl("circle", {
        cx: n.x, cy: n.y, r: 3, class: "n", "data-id": n.id,
      }, nodeLayer));
    }

    const runner = {
      algo, run, steps: run.steps, svg, edgeEls, nodeEls, labelLayer, pulse,
      total: run.steps.length + (run.found ? run.path.length - 1 : 0),
      headStats: panel.querySelector(".pstats"),
      curEl: panel.querySelector(".pcur"),
      actEl: panel.querySelector(".act"),
      state: null,
    };
    attachPanZoom(svg);
    attachTooltip(svg, runner);
    return runner;
  });
}

// ---------------------------------------------------------------- state
/** Rebuild the algorithm's state after `p` timeline positions. */
function computeState(r, p) {
  const steps = r.steps;
  const k = Math.min(p, steps.length);
  const src = app.data.source;
  const visited = new Set();
  const frontier = new Map();   // open nodes -> best {g,h,f}
  const best = new Map();       // every discovered node -> best {g,h,f}
  const examined = new Set();   // roads relaxed so far (pair keys)
  let edgesExamined = 0;

  // Before the first pop the queue holds only the source (g = 0).
  const first = steps[0];
  const start = { g: 0, h: first ? first.h : 0, f: first ? first.f : 0 };
  frontier.set(src, start);
  best.set(src, start);

  for (let i = 0; i < k; i++) {
    const s = steps[i];
    if (s.kind !== "stale") {
      visited.add(s.node);
      frontier.delete(s.node);
      best.set(s.node, { g: s.g, h: s.h, f: s.f });
    }
    for (const nb of s.examined) examined.add(pairKey(s.node, nb));
    edgesExamined += s.examined.length;
    for (const rl of s.relaxed) {
      frontier.set(rl.node, rl);
      best.set(rl.node, rl);
    }
  }

  const step = k > 0 ? steps[k - 1] : null;
  const inSearch = p <= steps.length;
  const currentEdges = new Set();
  if (step && inSearch) step.examined.forEach((nb) => currentEdges.add(pairKey(step.node, nb)));

  // Final path: revealed road by road, walking back from the destination.
  const path = r.run.path;
  const shown = Math.max(0, Math.min(p - steps.length, path.length - 1));
  const pathNodes = new Set();
  const pathEdges = new Set();
  if (shown > 0) {
    for (let i = path.length - 1 - shown; i < path.length; i++) pathNodes.add(path[i]);
    for (let i = path.length - 1 - shown; i < path.length - 1; i++) pathEdges.add(pairKey(path[i], path[i + 1]));
  }

  return {
    p, k, step, inSearch, visited, frontier, best, examined, edgesExamined,
    currentEdges, pathNodes, pathEdges, shown,
    current: step && inSearch ? step.node : null,
    done: p >= r.total,
  };
}

// ---------------------------------------------------------------- render
function pxPerUnit(svg) {
  const v = app.view;
  const w = svg.clientWidth || 800, h = svg.clientHeight || 500;
  return Math.min(w / v.w, h / v.h);
}

function renderAll() {
  if (!app.runners.length) return;
  for (const r of app.runners) render(r);
  renderPresenter();
  renderResults();
  updateButtons();
}

function render(r) {
  const st = computeState(r, Math.min(app.tick, r.total));
  r.state = st;
  const ppu = pxPerUnit(r.svg);
  const src = app.data.source, dst = app.data.target;

  for (const [key, line] of r.edgeEls) {
    let cls = "e";
    if (st.pathEdges.has(key)) cls += " e-path";
    else if (st.currentEdges.has(key)) cls += " e-current";
    else if (st.examined.has(key)) cls += " e-explored";
    line.setAttribute("class", cls);
  }

  for (const [id, c] of r.nodeEls) {
    const n = app.nodes.get(id);
    let s = "unvisited";
    if (id === src) s = "source";
    else if (id === dst) s = "destination";
    else if (st.pathNodes.has(id)) s = "path";
    else if (id === st.current) s = "current";
    else if (st.frontier.has(id)) s = "frontier";
    else if (st.visited.has(id)) s = "explored";

    let cls = `n n-${s} k-${n.kind}`;
    if (id === st.current) cls += " is-current";
    else if (st.pathNodes.has(id)) cls += " on-path";
    c.setAttribute("class", cls);

    let radius = n.kind === "Society" ? 5.5 : 3.2;
    if (s === "source" || s === "destination") radius = 8;
    else if (id === st.current) radius += 3.5;
    else if (s === "path") radius += 2;
    c.setAttribute("r", radius / ppu);
  }
  // Keep the key nodes on top of overlapping neighbours.
  for (const id of [st.current, src, dst]) {
    if (id) r.nodeEls.get(id).parentNode.appendChild(r.nodeEls.get(id));
  }

  // Pulsing ring around the node being expanded.
  if (st.current) {
    const n = app.nodes.get(st.current);
    r.pulse.setAttribute("cx", n.x);
    r.pulse.setAttribute("cy", n.y);
    r.pulse.setAttribute("r", 15 / ppu);
  } else {
    r.pulse.setAttribute("r", 0);
  }

  renderLabels(r, st, ppu);
  renderPanelText(r, st);
}

function renderLabels(r, st, ppu) {
  const layer = r.labelLayer;
  layer.innerHTML = "";
  const size = 11 / ppu;
  const important = new Set([app.data.source, app.data.target, ...st.pathNodes]);
  if (st.current) important.add(st.current);
  const costKey = r.algo === "astar" ? "f" : "g";
  const withCosts = $("#costLabels").checked;

  const put = (id, text, cls) => {
    const n = app.nodes.get(id);
    svgEl("text", {
      x: n.x + 7 / ppu, y: n.y - 6 / ppu, class: cls,
      "font-size": size, "stroke-width": 3 / ppu,
    }, layer).textContent = text;
  };

  if (withCosts) {
    for (const [id, v] of st.best) {
      if (important.has(id)) continue;
      put(id, `${costKey}=${fmtShort(v[costKey])}`, "lbl cost");
    }
  }
  for (const id of important) {
    const v = st.best.get(id);
    const cost = withCosts && v ? ` ${costKey}=${fmtShort(v[costKey])}` : "";
    put(id, `${id}${cost}`, "lbl");
  }
}

function renderPanelText(r, st) {
  const steps = r.steps.length;
  const stepLabel = st.inSearch
    ? `Step ${st.k} / ${steps}`
    : `Final path ${st.shown} / ${r.run.path.length - 1}`;
  r.headStats.textContent =
    `${stepLabel} · Explored ${st.visited.size} · Frontier ${st.frontier.size}`;

  const s = st.step;
  if (st.current && s) {
    const ghf = r.algo === "astar"
      ? `g=${fmtShort(s.g)} h=${fmtShort(s.h)} f=${fmtShort(s.f)}`
      : `distance from source g=${fmtShort(s.g)}`;
    r.curEl.innerHTML = `Current: <b>${esc(s.node)}</b> ${esc(nodeName(s.node))} · ${ghf} ${unit()}`;
  } else {
    r.curEl.innerHTML = st.done && r.run.found
      ? `<b>Route found:</b> ${fmtCost(r.run.cost)} · ${r.run.nodes_visited} nodes explored`
      : st.done ? "<b>No route exists.</b>" : "&nbsp;";
  }
  r.actEl.innerHTML = describe(r, st, true);
}

/** Plain-language explanation of the current position (for presenting). */
function describe(r, st, short) {
  const s = st.step;
  const isA = r.algo === "astar";
  const src = app.data.source, dst = app.data.target;
  const list = (items) => items.map((n) => `<b>${esc(n)}</b>`).join(", ");

  if (st.p === 0) {
    return `Start: the priority queue holds only the source <b>${esc(src)}</b> with g = 0` +
      (isA ? `, h = ${fmtShort(r.steps[0].h)}.` : ".");
  }
  if (st.done && !r.run.found) {
    return `The priority queue is empty and <b>${esc(dst)}</b> was never reached: no route exists.`;
  }
  if (!st.inSearch) {
    if (st.done) return `Done. Route ${list(r.run.path)} reconstructed from the parent links.`;
    const i = r.run.path.length - 1 - st.shown;
    const u = r.run.path[i], v = r.run.path[i + 1];
    const leg = r.run.legs[i];
    return `Reconstructing the route: parent(${esc(v)}) = <b>${esc(u)}</b> ` +
      `(${leg.km.toFixed(3)} km, ${leg.min.toFixed(1)} min).`;
  }

  if (s.kind === "stale") {
    return `Pop an outdated queue entry for <b>${esc(s.node)}</b> (already ${isA ? "closed" : "visited"} ` +
      `with a lower cost): skip it. This is lazy deletion, because heapq has no decrease-key.`;
  }
  const why = isA
    ? `lowest f = g + h = ${fmtShort(s.g)} + ${fmtShort(s.h)} = ${fmtShort(s.f)}`
    : `smallest known distance g = ${fmtShort(s.g)}`;
  if (s.kind === "goal") {
    return `Pop the destination <b>${esc(dst)}</b> (${why}). Its cost is now final, so the search stops.`;
  }
  if (s.examined.length === 0) {
    return `Pop <b>${esc(s.node)}</b> (${why}). Mark it ${isA ? "closed" : "visited"}. ` +
      `All of its neighbours are already ${isA ? "closed" : "visited"}, so there is nothing to relax.`;
  }
  const improved = s.relaxed.map((x) => x.node);
  const unchanged = s.examined.length - improved.length;
  let text = `Pop <b>${esc(s.node)}</b> (${why}). Mark it ${isA ? "closed" : "visited"} and relax ` +
    `${s.examined.length} outgoing road${s.examined.length === 1 ? "" : "s"}: `;
  if (improved.length) {
    text += `${improved.length} improved`;
    if (!short) text += ` (${list(improved.slice(0, 8))}${improved.length > 8 ? ", …" : ""})`;
  } else {
    text += "no improvements";
  }
  if (unchanged) text += `, ${unchanged} already had a cheaper path`;
  return text + ".";
}

function renderPresenter() {
  const r = app.runners[0];
  if (!r || !r.state || app.runners.length > 1) return;
  const st = r.state;
  const isA = r.algo === "astar";
  const s = st.step;

  $("#stepNo").textContent = st.inSearch
    ? `Step ${st.k} / ${r.steps.length}`
    : `Final path ${st.shown} / ${r.run.path.length - 1}`;
  const cur = st.current || (st.p === 0 ? app.data.source : null);
  $("#curNode").textContent = cur || "–";
  $("#curName").textContent = cur ? nodeName(cur) : "";
  $("#action").innerHTML = describe(r, st, false);

  const stat = (k, v) => `<div class="stat"><div class="v">${v}</div><div class="k">${k}</div></div>`;
  let html = stat("Nodes explored", st.visited.size) +
    stat("Nodes in frontier", st.frontier.size) +
    stat("Roads examined", st.edgesExamined) +
    stat(isA ? "Current g(n)" : "Current cost", st.current && s ? fmtCost(s.g) : "–");
  if (isA) {
    html += stat("h(n) heuristic", st.current && s ? fmtCost(s.h) : "–") +
      stat("f(n) = g + h", st.current && s ? fmtCost(s.f) : "–");
  }
  $("#stats").innerHTML = html;

  // Priority queue after this step, in the order the heap will pop it.
  let rows;
  if (st.k === 0) {
    rows = [{ node: app.data.source, g: 0, h: r.steps[0] ? r.steps[0].h : 0, f: r.steps[0] ? r.steps[0].f : 0 }];
  } else {
    rows = s.frontier_top;
  }
  const size = st.k === 0 ? 1 : s.frontier_size;
  const head = isA
    ? "<tr><th>#</th><th>Node</th><th class=num>g</th><th class=num>h</th><th class=num>f</th></tr>"
    : "<tr><th>#</th><th>Node</th><th class=num>g (distance)</th></tr>";
  const body = rows.map((row, i) => {
    const cells = isA
      ? `<td class=num>${fmtShort(row.g)}</td><td class=num>${fmtShort(row.h)}</td><td class=num>${fmtShort(row.f)}</td>`
      : `<td class=num>${fmtShort(row.g)}</td>`;
    return `<tr class="${i === 0 && !st.done ? "next" : ""}"><td>${i + 1}</td>` +
      `<td title="${esc(nodeName(row.node))}">${esc(row.node)}</td>${cells}</tr>`;
  }).join("");
  $("#pqTable").innerHTML = head + (body || `<tr><td colspan=5 class=muted>empty</td></tr>`);
  $("#pqTitle").textContent = `Priority queue, ordered by ${isA ? "f = g + h" : "g"} (${unit()})`;
  $("#pqNote").textContent = size > rows.length
    ? `Showing ${rows.length} of ${size} open nodes. The highlighted row is popped next.`
    : "The highlighted row is popped next.";
}

function renderHeuristicNote() {
  const scale = app.data.heuristic_scale;
  const u = app.data.unit;
  $("#heuristicNote").innerHTML =
    `<b>A* heuristic</b> (same function as <code>src/astar.py</code>):<br>` +
    `h(n) = ${scale.toFixed(4)} × haversine_km(n, ${esc(app.data.target)}) ${u}<br>` +
    `<span class="muted">The scale comes from <code>calibrate_scale()</code>, so h(n) never ` +
    `over-estimates the real cost, and A* stays optimal.</span>`;
}

// ---------------------------------------------------------------- results
function renderResults() {
  const box = $("#results");
  const allDone = app.runners.length && app.runners.every((r) => app.tick >= r.total);
  box.hidden = !allDone;
  if (!allDone) return;

  $("#finalRoutes").innerHTML = app.runners.map((r) => finalRouteCard(r.run)).join("");
  $("#comparison").innerHTML = comparisonTable();
}

function finalRouteCard(run) {
  const title = `<h2>${esc(run.algorithm)}: final route</h2>`;
  if (!run.found) return `<div class="card">${title}<p>No route exists between these locations.</p></div>`;
  const items = run.path.map((id, i) => {
    const leg = run.legs[i];
    const legText = leg ? `<div class="leg">↓ ${leg.km.toFixed(3)} km, ${leg.min.toFixed(1)} min</div>` : "";
    return `<li><b>${esc(id)}</b> ${esc(nodeName(id))}${legText}</li>`;
  }).join("");
  return `<div class="card">${title}
    <p class="route-line">${run.path.map(esc).join(" → ")}</p>
    <ol class="route-list">${items}</ol>
    <div>Distance: <b>${run.total_distance_km.toFixed(3)} km</b> ·
      Minimum time: <b>${run.total_time_min.toFixed(1)} min</b> ·
      Nodes explored: <b>${run.nodes_visited}</b> ·
      Execution time: <b>${fmtMs(run.execution_time_ms)}</b></div></div>`;
}

function comparisonTable() {
  const d = app.data.dijkstra, a = app.data.astar;
  const n = app.data.benchmark_runs;
  const lower = (x, y) => [x < y ? "win" : "", y < x ? "win" : ""];
  const rows = [
    ["Nodes explored", d.nodes_visited, a.nodes_visited, lower(d.nodes_visited, a.nodes_visited)],
    ["Edges explored (relaxed)", d.edges_relaxed, a.edges_relaxed, lower(d.edges_relaxed, a.edges_relaxed)],
    ["Roads in route", d.edges_traversed, a.edges_traversed, ["", ""]],
    ["Distance", `${d.total_distance_km.toFixed(3)} km`, `${a.total_distance_km.toFixed(3)} km`, ["", ""]],
    ["Minimum time", `${d.total_time_min.toFixed(1)} min`, `${a.total_time_min.toFixed(1)} min`, ["", ""]],
    ["Execution time (1 run)", fmtMs(d.execution_time_ms), fmtMs(a.execution_time_ms),
      lower(d.execution_time_ms, a.execution_time_ms)],
  ];
  if (n > 0) {
    rows.push([`Average time (${n} runs)`, fmtMs(d.avg_time_ms), fmtMs(a.avg_time_ms), lower(d.avg_time_ms, a.avg_time_ms)]);
    rows.push([`Minimum time (${n} runs)`, fmtMs(d.min_time_ms), fmtMs(a.min_time_ms), lower(d.min_time_ms, a.min_time_ms)]);
  }
  const body = rows.map(([k, x, y, w]) =>
    `<tr><td>${k}</td><td class="${w[0]}">${x}</td><td class="${w[1]}">${y}</td></tr>`).join("");

  let verdict = "";
  if (d.found) {
    const saved = d.nodes_visited - a.nodes_visited;
    verdict = saved > 0
      ? `A* explored <b>${saved} fewer nodes</b> (${Math.round(100 * saved / d.nodes_visited)}% less), ` +
        `because h(n) steers it toward ${esc(app.data.target)}.`
      : saved === 0
        ? "Both explored the same number of nodes. Here the heuristic could not rule anything out."
        : "Dijkstra explored fewer nodes on this query.";
    verdict += Math.abs(d.cost - a.cost) < 1e-9
      ? ` Both found the same optimal cost (${fmtCost(d.cost)}).`
      : " <b>Warning: the costs differ.</b>";
  } else {
    verdict = "No route exists between these locations.";
  }
  return `<h2>Algorithm comparison</h2>
    <p class="muted small">Actual values from the project's dijkstra() and astar() on the same graph, source and destination.</p>
    <table class="cmp"><tr><th></th><th>Dijkstra</th><th>A*</th></tr>${body}</table>
    <p class="verdict">${verdict}</p>`;
}

// ---------------------------------------------------------------- playback
function delay() {
  const speed = Number($("#speed").value);          // 1 (slow) .. 10 (fast)
  return 1800 * Math.pow(0.6, speed - 1);            // 1800 ms .. ~18 ms
}

function stepTo(t) {
  if (!app.runners.length) return;
  app.tick = Math.max(0, Math.min(t, app.maxTick));
  renderAll();
}

function play() {
  if (!app.runners.length) return;
  if (app.tick >= app.maxTick) app.tick = 0;       // replay from the start
  app.playing = true;
  renderAll();
  const loop = () => {
    if (!app.playing) return;
    if (app.tick >= app.maxTick) { pause(); return; }
    stepTo(app.tick + 1);
    app.timer = setTimeout(loop, delay());
  };
  clearTimeout(app.timer);
  app.timer = setTimeout(loop, delay());
}

function pause() {
  app.playing = false;
  clearTimeout(app.timer);
  updateButtons();
}

function updateButtons() {
  const ready = app.runners.length > 0;
  $("#playBtn").disabled = !ready || app.playing;
  $("#pauseBtn").disabled = !ready || !app.playing;
  $("#nextBtn").disabled = !ready || app.tick >= app.maxTick;
  $("#prevBtn").disabled = !ready || app.tick <= 0;
  $("#restartBtn").disabled = !ready;
  $("#fitBtn").disabled = !ready;
  $("#fitAllBtn").disabled = !ready;
}

// ---------------------------------------------------------------- view
function fitView(ids) {
  const pts = ids ? [...ids].map((id) => app.nodes.get(id)) : app.graph.nodes;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of pts) {
    minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
    minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
  }
  const w = Math.max(maxX - minX, 40), h = Math.max(maxY - minY, 40);
  const pad = 0.08;
  app.view = {
    x: (minX + maxX) / 2 - w * (0.5 + pad), y: (minY + maxY) / 2 - h * (0.5 + pad),
    w: w * (1 + 2 * pad), h: h * (1 + 2 * pad),
  };
  applyView(true);
}

function applyView(rerender) {
  const v = app.view;
  for (const r of app.runners) r.svg.setAttribute("viewBox", `${v.x} ${v.y} ${v.w} ${v.h}`);
  if (rerender) renderAll();
}

function toUser(svg, clientX, clientY) {
  return new DOMPoint(clientX, clientY).matrixTransform(svg.getScreenCTM().inverse());
}

function attachPanZoom(svg) {
  svg.addEventListener("wheel", (e) => {
    e.preventDefault();
    const pt = toUser(svg, e.clientX, e.clientY);
    const f = e.deltaY < 0 ? 0.85 : 1 / 0.85;
    const v = app.view;
    const w = Math.min(Math.max(v.w * f, 8), app.graph.width * 3);
    const k = w / v.w;
    app.view = { x: pt.x - (pt.x - v.x) * k, y: pt.y - (pt.y - v.y) * k, w, h: v.h * k };
    applyView(true);
  }, { passive: false });

  let drag = null;
  svg.addEventListener("pointerdown", (e) => {
    drag = { x: e.clientX, y: e.clientY, view: { ...app.view }, ppu: pxPerUnit(svg) };
    svg.setPointerCapture(e.pointerId);
    svg.classList.add("dragging");
  });
  svg.addEventListener("pointermove", (e) => {
    if (!drag) return;
    app.view = {
      ...drag.view,
      x: drag.view.x - (e.clientX - drag.x) / drag.ppu,
      y: drag.view.y - (e.clientY - drag.y) / drag.ppu,
    };
    applyView(false);   // panning does not change node sizes
  });
  const end = () => { drag = null; svg.classList.remove("dragging"); };
  svg.addEventListener("pointerup", end);
  svg.addEventListener("pointercancel", end);
}

function attachTooltip(svg, runner) {
  const tip = $("#tooltip");
  svg.addEventListener("mousemove", (e) => {
    const id = e.target.getAttribute && e.target.getAttribute("data-id");
    if (!id) { tip.hidden = true; return; }
    const n = app.nodes.get(id);
    const st = runner.state;
    let status = "unvisited";
    if (st) {
      if (st.visited.has(id)) status = runner.algo === "astar" ? "explored (closed)" : "explored (visited)";
      else if (st.frontier.has(id)) status = "in frontier (priority queue)";
    }
    const v = st && st.best.get(id);
    const costs = v
      ? (runner.algo === "astar"
        ? `g = ${fmtCost(v.g)}<br>h = ${fmtCost(v.h)}<br>f = ${fmtCost(v.f)}`
        : `distance from source = ${fmtCost(v.g)}`)
      : "not reached yet";
    tip.innerHTML = `<b>${esc(n.id)}</b> ${esc(n.name)}<br>` +
      `<span class="t-muted">${esc(n.kind)} · ${esc(n.area)}${n.cuisine ? " · " + esc(n.cuisine) : ""}</span><br>` +
      `${esc(status)}<br>${costs}`;
    tip.hidden = false;
    tip.style.left = `${e.clientX + 14}px`;
    tip.style.top = `${e.clientY + 14}px`;
  });
  svg.addEventListener("mouseleave", () => { tip.hidden = true; });
}

init();
