/*
 * Multi-stop planner.
 *
 * The browser only collects the scenario and draws the answer. Planning,
 * serviceability, closures and rerouting all run on the server
 * (POST /api/multistop -> src/scenario.py -> the same
 * PickupDeliveryPlanner used by the CLI and the simulation).
 */
"use strict";

const SVGNS = "http://www.w3.org/2000/svg";
const COLORS = ["#2563eb", "#db2777", "#16a34a", "#ea580c", "#7c3aed",
  "#0891b2", "#ca8a04", "#be123c", "#4d7c0f", "#9333ea"];

const st = {
  graph: null,
  nodes: new Map(),
  result: null,
  spec: null,
  method: "insertion",
  view: null,
};

const $ = (sel) => document.querySelector(sel);

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

function showError(msg) {
  const box = $("#error");
  box.textContent = msg || "";
  box.hidden = !msg;
}

const fmt = (v, d = 1) => (v === null || v === undefined ? "–" : Number(v).toFixed(d));
const nodeLabel = (id) => {
  const n = st.nodes.get(id);
  return n ? `${id} — ${n.name}` : id;
};
const idOf = (value) => String(value || "").trim().split(/[\s—]+/)[0].toUpperCase();
const optionText = (id) => {
  const n = st.nodes.get(id);
  return n ? `${id} — ${n.name} (${n.area})` : id;
};

// ------------------------------------------------------------ startup
async function init() {
  try {
    st.graph = await (await fetch("/api/graph")).json();
  } catch (err) {
    showError("Could not load the graph. Is visualize.py running?");
    return;
  }
  for (const n of st.graph.nodes) st.nodes.set(n.id, n);
  const s = st.graph.stats;
  $("#graphInfo").textContent =
    `Real dataset: ${s.societies} societies, ${s.restaurants} restaurants, ` +
    `${s.roads} one-way roads. Planning runs on the server.`;

  const sorted = [...st.graph.nodes].sort((a, b) => a.id.localeCompare(b.id));
  for (const n of sorted) {
    const list = n.kind === "Restaurant" ? "#restaurants" : "#societies";
    for (const target of [list, "#allLocations"]) {
      const opt = document.createElement("option");
      opt.value = optionText(n.id);
      $(target).appendChild(opt);
    }
  }

  $("#addOrder").onclick = () => addOrderRow();
  $("#addDriver").onclick = () => addDriverRow();
  $("#addClosure").onclick = () => addClosureRow();
  $("#loadExample").onclick = loadExample;
  $("#clearAll").onclick = () => {
    for (const t of ["#ordersTable", "#driversTable", "#closuresTable"]) $(`${t} tbody`).innerHTML = "";
    addOrderRow();
    addDriverRow();
  };
  $("#runBtn").onclick = run;
  $("#closeRouteRoad").onclick = () => {
    const [a, b] = $("#routeRoads").value.split("|");
    if (a && b) addClosureRow(a, b, 0);
  };
  for (const el of document.querySelectorAll("input[name=method]")) {
    el.onchange = () => { st.method = el.value; renderMethod(); };
  }
  attachPanZoom($("#map"));
  // Demo deep link: /planner.html?example&run loads the example and runs it.
  const q = new URLSearchParams(location.search);
  if (q.has("example")) loadExample();
  else { addOrderRow(); addDriverRow(); }
  if (q.has("run")) run();
}

// ------------------------------------------------------------ form rows
function removable(tr) {
  const btn = tr.querySelector(".rm");
  btn.onclick = () => { tr.remove(); renumber(); };
}

function renumber() {
  [...$("#ordersTable tbody").rows].forEach((tr, i) => { tr.cells[0].textContent = `O${String(i + 1).padStart(2, "0")}`; });
  [...$("#driversTable tbody").rows].forEach((tr, i) => { tr.cells[0].textContent = `D${String(i + 1).padStart(2, "0")}`; });
}

function addOrderRow(r = "", s = "", ready = "", deadline = "") {
  const tr = document.createElement("tr");
  tr.innerHTML = `<td></td>
    <td><input class="r" list="restaurants" placeholder="e.g. R001" value="${esc(r && optionText(r))}"></td>
    <td><input class="s" list="societies" placeholder="e.g. S004" value="${esc(s && optionText(s))}"></td>
    <td><input class="num ready" type="number" min="0" step="1" value="${esc(ready)}"></td>
    <td><input class="num deadline" type="number" min="0" step="1" value="${esc(deadline)}"></td>
    <td><button type="button" class="rm" title="Remove order">×</button></td>`;
  $("#ordersTable tbody").appendChild(tr);
  removable(tr);
  renumber();
}

function addDriverRow(node = "") {
  const tr = document.createElement("tr");
  tr.innerHTML = `<td></td>
    <td><input class="node" list="allLocations" placeholder="any location, e.g. S005" value="${esc(node && optionText(node))}"></td>
    <td><button type="button" class="rm" title="Remove driver">×</button></td>`;
  $("#driversTable tbody").appendChild(tr);
  removable(tr);
  renumber();
}

function addClosureRow(a = "", b = "", at = 0, reopen = "") {
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td><input class="a" list="allLocations" value="${esc(a)}" placeholder="from"></td>
    <td><input class="b" list="allLocations" value="${esc(b)}" placeholder="to"></td>
    <td><input class="num at" type="number" min="0" step="1" value="${esc(at)}"></td>
    <td><input class="num reopen" type="number" min="0" step="1" value="${esc(reopen)}" placeholder="end"></td>
    <td><button type="button" class="rm" title="Remove closure">×</button></td>`;
  $("#closuresTable tbody").appendChild(tr);
  removable(tr);
}

/** Example inputs only (real IDs); every result still comes from the server. */
function loadExample() {
  $("#ordersTable tbody").innerHTML = "";
  $("#driversTable tbody").innerHTML = "";
  $("#closuresTable tbody").innerHTML = "";
  addOrderRow("R001", "S004");     // same restaurant -> two societies
  addOrderRow("R001", "S003");
  addOrderRow("R002", "S004");     // second restaurant -> same society
  addOrderRow("R190", "S010");     // Miraj -> Sangli: rejected by policy
  addDriverRow("S005");
  addDriverRow("S010");
}

function collect() {
  const num = (v) => (v === "" ? null : Number(v));
  const orders = [...$("#ordersTable tbody").rows].map((tr) => ({
    restaurant: idOf(tr.querySelector(".r").value),
    society: idOf(tr.querySelector(".s").value),
    ready_at: num(tr.querySelector(".ready").value),
    deadline: num(tr.querySelector(".deadline").value),
  })).filter((o) => o.restaurant || o.society);
  const drivers = [...$("#driversTable tbody").rows]
    .map((tr) => idOf(tr.querySelector(".node").value)).filter(Boolean);
  const closures = [...$("#closuresTable tbody").rows].map((tr) => ({
    source: idOf(tr.querySelector(".a").value),
    target: idOf(tr.querySelector(".b").value),
    at: num(tr.querySelector(".at").value) || 0,
    reopen_at: num(tr.querySelector(".reopen").value),
  })).filter((c) => c.source && c.target);
  return {
    orders, drivers, closures,
    capacity: Number($("#capacity").value),
    algorithm: $("#algorithm").value,
    metric: $("#metric").value,
    max_ride_extra_min: num($("#maxRide").value),
    improve: $("#improve").value,
    enforce_serviceability: $("#serviceability").checked,
  };
}

async function run() {
  showError("");
  const spec = collect();
  if (!spec.orders.length) { showError("Add at least one order."); return; }
  if (!spec.drivers.length) { showError("Add at least one driver."); return; }
  $("#runBtn").disabled = true;
  $("#runInfo").textContent = "Planning on the server…";
  try {
    const res = await fetch("/api/multistop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(spec),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    st.result = data;
    st.spec = spec;
    $("#runInfo").textContent = "";
    renderAll();
  } catch (err) {
    showError(err.message);
    $("#runInfo").textContent = "";
  } finally {
    $("#runBtn").disabled = false;
  }
}

// ------------------------------------------------------------ results
function renderAll() {
  renderSummary();
  renderRouteRoads();
  st.view = null;
  renderMethod();
}

function renderMethod() {
  if (!st.result) return;
  const m = st.result.methods[st.method];
  renderMap(m);
  renderRoutes(m);
  renderOrders(m);
  renderReroutes(m);
}

function renderSummary() {
  const r = st.result, a = r.methods.append, o = r.methods.insertion;
  const rows = [
    ["Delivered", "delivered", 0], ["Rejected (serviceability)", "rejected", 0],
    ["Failed", "failed", 0], ["Late", "late", 0],
    ["Total distance (km)", "distance_km", 3], ["Total drive time (min)", "drive_time_min", 1],
    ["Orders batched together", "batched", 0], ["Drivers used", "drivers_used", 0],
    ["Planning time (ms)", "planning_ms", 2],
  ];
  const s = r.settings;
  const constraint = (m) => (m.violations.length
    ? `<span class="bad-line">${m.violations.length} violation(s)</span>`
    : `<span class="ok-line">all satisfied ✓</span>`);
  $("#summary").innerHTML = `
    <h2>Naive greedy vs optimised</h2>
    <p class="muted small">Algorithm: ${esc(s.algorithm)} · optimise ${esc(s.metric)} · capacity ${s.capacity} ·
      max extra ride ${s.max_ride_extra_min ?? "none"} min · serviceability ${s.serviceability ? "on" : "off"} ·
      improvement ${esc(s.improve)}</p>
    <table class="cmp">
      <tr><th></th><th>${esc(a.label)}</th><th>${esc(o.label)}</th></tr>
      ${rows.map(([label, key, d]) => `<tr><td>${label}</td>
        <td>${fmt(a.totals[key], d)}</td><td>${fmt(o.totals[key], d)}</td></tr>`).join("")}
      <tr><td>Delivery constraints</td><td>${constraint(a)}</td><td>${constraint(o)}</td></tr>
    </table>
    <p class="verdict">Route distance change: <b>${(r.distance_reduction * 100).toFixed(1)}%</b> shorter with the optimiser
      (same orders, drivers, capacity and constraints).</p>`;
}

function renderRouteRoads() {
  const sel = $("#routeRoads");
  const roads = new Set();
  for (const d of st.result.methods.insertion.drivers) {
    for (let i = 0; i + 1 < d.path.length; i++) roads.add(`${d.path[i]}|${d.path[i + 1]}`);
  }
  sel.innerHTML = [...roads].sort().map((r) => {
    const [a, b] = r.split("|");
    return `<option value="${esc(r)}">${esc(a)} → ${esc(b)}</option>`;
  }).join("");
  sel.disabled = !roads.size;
  $("#closeRouteRoad").disabled = !roads.size;
}

function renderRoutes(m) {
  if (!m.drivers.length) {
    $("#routes").innerHTML = `<h2>Driver routes</h2><p class="muted">No driver moved.</p>`;
    return;
  }
  const order = new Map(m.orders.map((o) => [o.order_id, o]));
  $("#routes").innerHTML = `<h2>Driver routes — ${esc(m.label)}</h2>` + m.drivers.map((d, i) => `
    <div class="driver-head"><span class="swatch" style="background:${COLORS[i % COLORS.length]}"></span>
      ${esc(d.driver_id)} · starts at ${esc(nodeLabel(d.start))} · ${fmt(d.distance_km, 3)} km · ${fmt(d.drive_time_min)} min driving</div>
    <table class="data">
      <tr><th>#</th><th>Stop</th><th>Order</th><th>Location</th><th>For</th>
        <th class="num">Arrive</th><th class="num">Leave</th><th class="num">Cum. km</th><th class="num">Cum. min</th></tr>
      ${d.stops.map((s, k) => {
        const o = order.get(s.order_id);
        const other = s.kind === "PICKUP" ? `→ ${esc(o.society)}` : `from ${esc(o.restaurant)}`;
        return `<tr><td>${k + 1}</td>
          <td><span class="tag ${s.kind[0]}">${s.kind === "PICKUP" ? "PICKUP" : "DROP-OFF"}</span></td>
          <td>${esc(s.order_id)}</td><td>${esc(s.node)} — ${esc(s.name)}</td><td class="muted">${other}</td>
          <td class="num">${fmt(s.arrival)}</td><td class="num">${fmt(s.departure)}</td>
          <td class="num">${fmt(s.cum_km, 3)}</td><td class="num">${fmt(s.cum_min)}</td></tr>`;
      }).join("")}
    </table>
    <p class="muted small">Road path (${d.path.length - 1} roads): ${d.path.map(esc).join(" → ")}</p>`).join("");
}

function renderOrders(m) {
  $("#orders").innerHTML = `<h2>Orders — ${esc(m.label)}</h2>
    <table class="data">
      <tr><th>Order</th><th>Restaurant</th><th>Society</th><th>Status</th><th>Driver</th>
        <th class="num">Ready</th><th class="num">Picked up</th><th class="num">Delivered</th><th class="num">Deadline</th><th>Reason</th></tr>
      ${m.orders.map((o) => `<tr>
        <td>${esc(o.order_id)}</td>
        <td>${esc(o.restaurant)} — ${esc(o.restaurant_name)}</td>
        <td>${esc(o.society)} — ${esc(o.society_name)}</td>
        <td class="st-${esc(o.status)}">${esc(o.status)}${o.late ? " (LATE)" : ""}</td>
        <td>${esc(o.driver || "–")}${o.reassignments ? ` <span class="muted small">(moved ×${o.reassignments})</span>` : ""}</td>
        <td class="num">${fmt(o.ready_at)}</td><td class="num">${fmt(o.picked_up_at)}</td>
        <td class="num">${fmt(o.delivered_at)}</td><td class="num">${fmt(o.deadline)}</td>
        <td>${o.reason ? `<b>${esc(o.reason)}</b>` : ""}${o.message ? `<br><span class="muted small">${esc(o.message)}</span>` : ""}</td>
      </tr>`).join("")}
    </table>
    ${m.violations.length ? `<p class="bad-line">Constraint violations:</p><ul>${m.violations.map((v) => `<li>${esc(v)}</li>`).join("")}</ul>`
    : `<p class="ok-line small">Checked: one pickup and one drop-off per delivered order, pickup first, right society,
       capacity, single driver per order, serviceable pairs, no closed road entered, deadlines and ride limits.</p>`}`;
}

function renderReroutes(m) {
  const box = $("#reroutes");
  box.hidden = !m.reroutes.length;
  if (!m.reroutes.length) return;
  const list = (obj) => Object.entries(obj).map(([k, v]) => `${esc(k)}: ${esc(v)}`).join(", ") || "–";
  box.innerHTML = `<h2>Road closures and rerouting — ${esc(m.label)}</h2>
    <table class="data">
      <tr><th>Minute</th><th>Event</th><th>Affected drivers</th><th>Finished current road at</th>
        <th>Released (re-dispatched)</th><th>Failed</th><th>At risk</th><th class="num">Reroute ms</th></tr>
      ${m.reroutes.map((r) => `<tr><td>${fmt(r.at)}</td>
        <td>${r.action === "close" ? "Close" : "Reopen"} ${esc(r.road[0])} → ${esc(r.road[1])}</td>
        <td>${esc(r.affected_drivers.join(", ") || "–")}</td><td>${list(r.reanchored)}</td>
        <td>${list(r.released_orders)}</td><td>${list(r.failed_orders)}</td><td>${list(r.at_risk_orders)}</td>
        <td class="num">${fmt(r.latency_ms, 2)}</td></tr>`).join("")}
    </table>
    <p class="muted small">Commitment rule: a driver already on a road finishes that road, keeps its next stop, and
      is rerouted from the road's end. Orders not yet picked up that become unreachable are released for another
      driver; on-board orders whose society becomes unreachable fail (never marked delivered).</p>`;
}

// ------------------------------------------------------------ map
function renderMap(m) {
  const svg = $("#map");
  svg.innerHTML = "";
  const edges = svgEl("g", {}, svg);
  for (const e of st.graph.edges) {
    const a = st.nodes.get(e.a), b = st.nodes.get(e.b);
    svgEl("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: "e" }, edges);
  }
  const nodes = svgEl("g", {}, svg);
  for (const n of st.graph.nodes) {
    svgEl("circle", {
      cx: n.x, cy: n.y, r: n.kind === "Society" ? 4 : 2.4,
      class: `n n-unvisited k-${n.kind}`, "data-id": n.id,
    }, nodes);
  }
  for (const c of st.spec.closures) {
    const a = st.nodes.get(c.source), b = st.nodes.get(c.target);
    if (a && b) svgEl("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: "closed-road" }, svg);
  }

  const focus = new Set();
  const labels = new Map();   // node -> [text]
  m.drivers.forEach((d, i) => {
    const color = COLORS[i % COLORS.length];
    const pts = d.path.map((id) => st.nodes.get(id)).filter(Boolean);
    pts.forEach((p) => focus.add(p.id));
    svgEl("polyline", {
      points: pts.map((p) => `${p.x},${p.y}`).join(" "),
      class: "route-path", stroke: color,
    }, svg);
    const start = st.nodes.get(d.start);
    if (start) {
      svgEl("circle", { cx: start.x, cy: start.y, r: 7, fill: "#fff", stroke: color, "stroke-width": 3,
        "vector-effect": "non-scaling-stroke" }, svg);
      pushLabel(labels, d.start, `${d.driver_id} start`);
    }
    d.stops.forEach((s, k) => {
      const n = st.nodes.get(s.node);
      if (!n) return;
      const size = 6;
      if (s.kind === "PICKUP") {
        svgEl("polygon", { points: `${n.x},${n.y - size} ${n.x - size},${n.y + size * 0.8} ${n.x + size},${n.y + size * 0.8}`,
          fill: color, class: "stop-mark" }, svg);
      } else {
        svgEl("rect", { x: n.x - size * 0.8, y: n.y - size * 0.8, width: size * 1.6, height: size * 1.6,
          fill: color, class: "stop-mark" }, svg);
      }
      pushLabel(labels, s.node, `${d.driver_id}#${k + 1} ${s.kind === "PICKUP" ? "P" : "D"} ${s.order_id}`);
    });
  });
  const labelLayer = svgEl("g", {}, svg);
  for (const [id, texts] of labels) {
    const n = st.nodes.get(id);
    const t = svgEl("text", { x: n.x + 8, y: n.y - 6, class: "lbl", "font-size": 9, "stroke-width": 3 }, labelLayer);
    texts.forEach((txt, i) => {
      svgEl("tspan", { x: n.x + 8, dy: i ? 10 : 0 }, t).textContent = txt;
    });
  }
  for (const o of m.orders) { focus.add(o.restaurant); focus.add(o.society); }
  if (!st.view) fitView([...focus].filter((id) => st.nodes.has(id)));
  else applyView();
  attachTooltip(svg);

  $("#mapLegend").innerHTML = m.drivers.map((d, i) =>
    `<span><i class="swatch" style="background:${COLORS[i % COLORS.length]}"></i>${esc(d.driver_id)}</span>`).join("")
    + `<span>▲ pickup</span><span>■ drop-off</span><span>○ driver start</span>`;
}

function pushLabel(map, id, text) {
  if (!map.has(id)) map.set(id, []);
  map.get(id).push(text);
}

function fitView(ids) {
  const pts = ids.length ? ids.map((id) => st.nodes.get(id)) : st.graph.nodes;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of pts) {
    minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
    minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
  }
  const w = Math.max(maxX - minX, 60), h = Math.max(maxY - minY, 60), pad = 0.12;
  st.view = { x: (minX + maxX) / 2 - w * (0.5 + pad), y: (minY + maxY) / 2 - h * (0.5 + pad),
    w: w * (1 + 2 * pad), h: h * (1 + 2 * pad) };
  applyView();
}

function applyView() {
  const v = st.view;
  if (v) $("#map").setAttribute("viewBox", `${v.x} ${v.y} ${v.w} ${v.h}`);
}

function attachPanZoom(svg) {
  const toUser = (x, y) => new DOMPoint(x, y).matrixTransform(svg.getScreenCTM().inverse());
  svg.addEventListener("wheel", (e) => {
    if (!st.view) return;
    e.preventDefault();
    const pt = toUser(e.clientX, e.clientY);
    const k = e.deltaY < 0 ? 0.85 : 1 / 0.85;
    const v = st.view;
    st.view = { x: pt.x - (pt.x - v.x) * k, y: pt.y - (pt.y - v.y) * k, w: v.w * k, h: v.h * k };
    applyView();
  }, { passive: false });
  let drag = null;
  svg.addEventListener("pointerdown", (e) => {
    if (!st.view) return;
    const r = svg.getBoundingClientRect();
    drag = { x: e.clientX, y: e.clientY, view: { ...st.view }, ppu: r.width / st.view.w };
    svg.setPointerCapture(e.pointerId);
    svg.classList.add("dragging");
  });
  svg.addEventListener("pointermove", (e) => {
    if (!drag) return;
    st.view = { ...drag.view, x: drag.view.x - (e.clientX - drag.x) / drag.ppu,
      y: drag.view.y - (e.clientY - drag.y) / drag.ppu };
    applyView();
  });
  const end = () => { drag = null; svg.classList.remove("dragging"); };
  svg.addEventListener("pointerup", end);
  svg.addEventListener("pointercancel", end);
}

function attachTooltip(svg) {
  const tip = $("#tooltip");
  svg.onmousemove = (e) => {
    const id = e.target.getAttribute && e.target.getAttribute("data-id");
    if (!id) { tip.hidden = true; return; }
    const n = st.nodes.get(id);
    tip.innerHTML = `<b>${esc(n.id)}</b> ${esc(n.name)}<br><span class="t-muted">${esc(n.kind)} · ${esc(n.area)}</span>`;
    tip.hidden = false;
    tip.style.left = `${e.clientX + 14}px`;
    tip.style.top = `${e.clientY + 14}px`;
  };
  svg.onmouseleave = () => { tip.hidden = true; };
}

init();
