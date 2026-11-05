/*
 * Delivery Route Planner — dashboard.
 *
 * UI only. All data comes from the existing backend:
 *   GET  /api/meta            counts, service zones, delivery-area policy
 *   GET  /api/graph           real locations and roads (names, positions)
 *   GET  /api/serviceability  real ServiceabilityPolicy.check for one pair
 *   POST /api/multistop       real multi-stop optimiser + naive baseline,
 *                             road closures and rerouting (src/scenario.py)
 * Nothing here computes routes; explanations are written from the stops the
 * backend returned.
 */
import { createRouteMap } from "./routemap.js";

const COLORS = ["#2563eb", "#9333ea", "#0e9384", "#c11574", "#b54708", "#3e4784", "#4d7c0f", "#dd2590"];
const VIEWS = ["dashboard", "orders", "results", "closures", "how"];
const STORE_KEY = "delivery-planner-v1";

const EXAMPLES = [
  {
    title: "Two restaurants → one society",
    text: "Orders from two restaurants for the same housing society.",
    orders: [["R001", "S004"], ["R002", "S004"]],
    drivers: ["S005"],
  },
  {
    title: "One restaurant → three societies",
    text: "One restaurant sends food to three different societies.",
    orders: [["R016", "S017"], ["R016", "S007"], ["R016", "S012"]],
    drivers: ["S020"],
  },
  {
    title: "Several restaurants → several societies",
    text: "Mixed orders and two drivers, including one order outside the delivery areas.",
    orders: [["R001", "S004"], ["R002", "S003"], ["R016", "S012"], ["R190", "S010"]],
    drivers: ["S005", "S020"],
  },
];

const state = {
  meta: null,
  graph: null,
  nodes: new Map(),
  roads: new Map(),           // "a|b" -> [km, min] for every directed road
  orders: [],                 // {restaurant, society, check}
  drivers: [],                // start node ids
  capacity: 3,
  algorithm: "dijkstra",
  maxRide: "20",
  enforce: true,
  status: "idle",             // idle | planning | planned | error
  result: null,               // backend report for the last plan
  resultSpec: null,           // the request that produced it
  plannedAt: null,
  method: "insertion",        // which plan the results view shows
  closure: null,              // {road, at, before, after, spec}
  closureView: "after",
  closureBusy: false,
  showAllRoads: false,
};

// ---------------------------------------------------------------- helpers
const $ = (sel) => document.querySelector(sel);
function esc(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
const km = (v) => `${Number(v).toFixed(2)} km`;
const mins = (v) => `${Math.round(Number(v))} min`;
const nodeName = (id) => (state.nodes.get(id) ? state.nodes.get(id).name : id);
const nodeArea = (id) => (state.nodes.get(id) ? state.nodes.get(id).area : "");
const orderId = (i) => `O${String(i + 1).padStart(2, "0")}`;
const driverId = (i) => `D${String(i + 1).padStart(2, "0")}`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function listJoin(items) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function showGlobalError(msg) {
  const box = $("#globalError");
  box.textContent = msg || "";
  box.hidden = !msg;
}

async function api(path, options) {
  let res;
  try {
    res = await fetch(path, options);
  } catch (err) {
    throw new Error("Cannot reach the server. Is `python dashboard.py` still running?");
  }
  let data = null;
  try { data = await res.json(); } catch (err) { /* handled below */ }
  if (!res.ok) throw new Error((data && data.error) || `The server answered with an error (${res.status}).`);
  if (data === null) throw new Error("The server sent an unreadable answer.");
  return data;
}

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      orders: state.orders.map((o) => [o.restaurant, o.society]),
      drivers: state.drivers, capacity: state.capacity, algorithm: state.algorithm,
      maxRide: state.maxRide, enforce: state.enforce,
    }));
  } catch (err) { /* storage unavailable: not needed to work */ }
}

function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || "null");
    if (!saved) return false;
    state.orders = (saved.orders || []).filter(([r, s]) => state.nodes.has(r) && state.nodes.has(s))
      .map(([r, s]) => ({ restaurant: r, society: s, check: null }));
    state.drivers = (saved.drivers || []).filter((id) => state.nodes.has(id));
    state.capacity = saved.capacity || 3;
    state.algorithm = saved.algorithm === "astar" ? "astar" : "dijkstra";
    state.maxRide = saved.maxRide ?? "20";
    state.enforce = saved.enforce !== false;
    return true;
  } catch (err) {
    return false;
  }
}

// Plain-language reasons for the backend's reason codes.
function reasonText(code, message) {
  const p = state.meta ? state.meta.policy : {};
  const texts = {
    OUTSIDE_SERVICE_ZONE: "This restaurant does not deliver to that area.",
    DELIVERY_DISTANCE_EXCEEDED: `Too far: the trip is longer than the ${p.max_distance_km} km delivery limit.`,
    DELIVERY_TIME_EXCEEDED: `Too far: the trip takes longer than the ${p.max_time_min}-minute delivery limit.`,
    NO_ROAD_ROUTE: "No road connects this restaurant to this society.",
    INVALID_RESTAURANT_OR_SOCIETY: "The restaurant or society is not in the dataset.",
    RESTAURANT_NOT_ACCEPTING_ORDERS: "This restaurant is not accepting orders right now.",
    DEADLINE_UNREACHABLE: "It cannot arrive before its deadline.",
    NO_FEASIBLE_DRIVER: "No driver could take it without breaking a rule (capacity, distance or time limits).",
    PICKUP_UNREACHABLE: "No driver can reach this restaurant by road (for example, its only access road is blocked).",
    DROPOFF_UNREACHABLE: "A blocked road cut off the society after the food was collected.",
    ROAD_CLOSED_UNREACHABLE: "A blocked road cut off this stop; the order was offered to other drivers.",
    DEADLINE_AT_RISK: "The detour around the blocked road makes this order late.",
    RIDE_TIME_LIMIT_AT_RISK: "The detour around the blocked road keeps the food in the vehicle longer than allowed.",
  };
  const base = texts[code] || (code ? code.replaceAll("_", " ").toLowerCase() : "Not delivered.");
  return message && code !== "INVALID_RESTAURANT_OR_SOCIETY" ? `${base} (${message})` : base;
}

// ---------------------------------------------------------------- routing
function currentView() {
  const v = location.hash.replace("#", "");
  return VIEWS.includes(v) ? v : "dashboard";
}

function showView() {
  const view = currentView();
  for (const v of VIEWS) $(`#view-${v}`).hidden = v !== view;
  for (const a of document.querySelectorAll(".sidebar nav a")) {
    a.classList.toggle("active", a.dataset.view === view);
    if (a.dataset.view === view) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  }
  if (view === "results") renderResults();
  if (view === "closures") renderClosures();
  if (view === "dashboard") renderDashboard();
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------- startup
async function init() {
  $("#serverNotice").hidden = true;      // the script is running
  try {
    const [meta, graph] = await Promise.all([api("/api/meta"), api("/api/graph")]);
    state.meta = meta;
    state.graph = graph;
  } catch (err) {
    showGlobalError(`Could not load the delivery data (${err.message}). Start the server with ` +
      "`python dashboard.py` and open http://127.0.0.1:8060/ .");
    $("#stats").innerHTML = "";
    return;
  }
  for (const n of state.graph.nodes) state.nodes.set(n.id, n);
  for (const e of state.graph.edges) {
    if (e.ab) state.roads.set(`${e.a}|${e.b}`, e.ab);
    if (e.ba) state.roads.set(`${e.b}|${e.a}`, e.ba);
  }
  if (!restore() || !state.drivers.length) {
    state.drivers = state.drivers.length ? state.drivers : [firstSociety()];
  }

  buildSelects();
  wireOrders();
  renderExamples();
  renderOrderList();
  renderDrivers();
  syncSettings();
  window.addEventListener("hashchange", showView);
  showView();
  // Re-check stored orders against the real policy.
  state.orders.forEach((o) => checkOrder(o));
}

function firstSociety() {
  return [...state.nodes.values()].filter((n) => n.kind === "Society")
    .sort((a, b) => a.id.localeCompare(b.id))[0].id;
}

// ---------------------------------------------------------------- dashboard
function renderDashboard() {
  if (!state.meta) return;
  const m = state.meta;
  const cards = [
    [m.restaurants, "Restaurants"],
    [m.societies, "Delivery societies"],
    [m.roads, "One-way road links"],
    [state.orders.length, "Orders in this plan"],
    [state.drivers.length, "Drivers in this plan"],
  ];
  $("#stats").innerHTML = cards.map(([v, k]) =>
    `<div class="stat"><div class="v">${esc(v)}</div><div class="k">${esc(k)}</div></div>`).join("");

  const ps = $("#planStatus");
  if (state.status === "planning") {
    ps.innerHTML = `<div class="big">Planning…</div><p class="muted">The optimizer is working on your orders.</p>`;
  } else if (state.status === "planned" && state.result) {
    const t = state.result.methods.insertion.totals;
    const n = state.resultSpec.orders.length;
    ps.innerHTML = `<div class="big">${t.delivered} of ${n} orders planned</div>
      <p class="muted">${plural(t.drivers_used, "driver", "drivers")} · ${km(t.distance_km)} · about ${mins(t.drive_time_min)} of driving.
      Planned at ${esc(state.plannedAt)}.</p>
      ${isStale() ? `<p><span class="pill warn">Orders changed since this plan</span></p>` : ""}
      <a class="btn" href="#results">View route</a>`;
  } else if (state.status === "error") {
    ps.innerHTML = `<div class="big">Planning failed</div><p class="muted">See the message on the order page and try again.</p>
      <a class="btn" href="#orders">Back to orders</a>`;
  } else {
    ps.innerHTML = `<div class="big">No route planned yet</div>
      <p class="muted">${state.orders.length ? `${plural(state.orders.length, "order is", "orders are")} waiting to be planned.`
        : "Start by adding orders."}</p>`;
  }

  const p = m.policy;
  const counts = {};
  for (const id of Object.keys(m.zones)) {
    const z = m.zones[id] || "No area";
    const kind = state.nodes.get(id)?.kind === "Society" ? "soc" : "rest";
    counts[z] = counts[z] || { soc: 0, rest: 0 };
    counts[z][kind] += 1;
  }
  const cross = p.allowed_zone_pairs.map(([a, b]) => `${a} → ${b}`);
  $("#areaRules").innerHTML = `
    <ul class="area-list">
      ${p.zones.map((z) => `<li><span class="pill neutral">${esc(z)}</span>
        <span class="muted small">${counts[z]?.rest || 0} restaurants · ${counts[z]?.soc || 0} societies</span></li>`).join("")}
    </ul>
    <p class="small" style="margin-top:10px">${p.allow_same_zone ? "Restaurants deliver within their own town" : "Same-town delivery is off"}${cross.length
      ? `, plus ${esc(listJoin(cross))}` : ""}. Other combinations are not delivered.
      Trips must be at most ${esc(p.max_distance_km ?? "any")} km and ${esc(p.max_time_min ?? "any")} min.</p>
    <p class="muted small">These areas and limits are project assumptions (config/serviceability.json), not real company boundaries.</p>`;
}

function renderExamples() {
  $("#examples").innerHTML = EXAMPLES.map((ex, i) =>
    `<button type="button" class="example" data-ex="${i}"><b>${esc(ex.title)}</b><span>${esc(ex.text)}</span></button>`).join("");
  for (const b of document.querySelectorAll(".example")) {
    b.onclick = () => {
      const ex = EXAMPLES[Number(b.dataset.ex)];
      state.orders = ex.orders.filter(([r, s]) => state.nodes.has(r) && state.nodes.has(s))
        .map(([r, s]) => ({ restaurant: r, society: s, check: null }));
      state.drivers = ex.drivers.filter((id) => state.nodes.has(id));
      state.orders.forEach((o) => checkOrder(o));
      renderOrderList();
      renderDrivers();
      save();
      location.hash = "#orders";
      $("#optimizeHint").textContent = `Example loaded: "${ex.title}". Press Optimize Delivery Route.`;
    };
  }
}

// ---------------------------------------------------------------- orders
function zoneOf(id) { return (state.meta && state.meta.zones[id]) || "Other"; }

function grouped(kind, filter) {
  const q = (filter || "").trim().toLowerCase();
  const groups = new Map();
  const list = [...state.nodes.values()].filter((n) => n.kind === kind)
    .filter((n) => !q || `${n.name} ${n.area} ${n.id}`.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const n of list) {
    const z = zoneOf(n.id);
    if (!groups.has(z)) groups.set(z, []);
    groups.get(z).push(n);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function optionsHtml(groups) {
  return groups.map(([z, ns]) => `<optgroup label="${esc(z)}">${ns.map((n) =>
    `<option value="${esc(n.id)}">${esc(n.name)} — ${esc(n.area)} (${esc(n.id)})</option>`).join("")}</optgroup>`).join("");
}

function buildSelects() {
  fillRestaurants("");
  $("#societySelect").innerHTML = `<option value="">Choose a society…</option>` + optionsHtml(grouped("Society"));
}

function fillRestaurants(filter) {
  const sel = $("#restaurantSelect");
  const keep = sel.value;
  const groups = grouped("Restaurant", filter);
  sel.innerHTML = groups.length ? optionsHtml(groups) : `<option value="" disabled>No restaurant matches “${esc(filter)}”</option>`;
  if (keep && [...sel.options].some((o) => o.value === keep)) sel.value = keep;
}

let checkSeq = 0;
async function updatePairCheck() {
  const r = $("#restaurantSelect").value, s = $("#societySelect").value;
  const box = $("#pairCheck");
  $("#addOrderBtn").disabled = !(r && s);
  if (!(r && s)) { box.innerHTML = ""; return; }
  const seq = ++checkSeq;
  box.innerHTML = `<span class="muted">Checking delivery area…</span>`;
  try {
    const c = await api(`/api/serviceability?restaurant=${encodeURIComponent(r)}&society=${encodeURIComponent(s)}`);
    if (seq !== checkSeq) return;
    box.innerHTML = checkHtml(c, true);
  } catch (err) {
    if (seq === checkSeq) box.innerHTML = `<span class="pill bad">Check failed</span> <span class="muted">${esc(err.message)}</span>`;
  }
}

function checkHtml(c, long) {
  if (!c) return `<span class="pill neutral">Checking…</span>`;
  if (c.serviceable) {
    return `<span class="pill ok">Deliverable</span> <span class="muted small">${km(c.distance_km)} · about ${mins(c.time_min)} direct</span>`;
  }
  const extra = long && !state.enforce ? " Delivery-area rules are switched off, so it will still be planned." : "";
  return `<span class="pill bad">Not deliverable</span> <span class="small">${esc(reasonText(c.reason, c.message))}${esc(extra)}</span>`;
}

async function checkOrder(order) {
  try {
    order.check = await api(`/api/serviceability?restaurant=${encodeURIComponent(order.restaurant)}&society=${encodeURIComponent(order.society)}`);
  } catch (err) {
    order.check = { serviceable: false, reason: null, message: err.message };
  }
  renderOrderList();
}

function wireOrders() {
  $("#restaurantFilter").addEventListener("input", (e) => { fillRestaurants(e.target.value); updatePairCheck(); });
  $("#restaurantSelect").addEventListener("change", updatePairCheck);
  $("#societySelect").addEventListener("change", updatePairCheck);
  $("#addOrderBtn").onclick = () => {
    const r = $("#restaurantSelect").value, s = $("#societySelect").value;
    if (!r || !s) return;
    const order = { restaurant: r, society: s, check: null };
    state.orders.push(order);
    checkOrder(order);
    $("#societySelect").value = "";
    updatePairCheck();
    afterEdit();
  };
  $("#clearOrdersBtn").onclick = () => {
    if (state.orders.length && !confirm("Remove all orders from this plan?")) return;
    state.orders = [];
    afterEdit();
  };
  $("#addDriverBtn").onclick = () => {
    state.drivers.push(state.drivers[state.drivers.length - 1] || firstSociety());
    renderDrivers();
    afterEdit();
  };
  $("#capacity").addEventListener("input", (e) => { state.capacity = e.target.value; afterEdit(false); });
  $("#algorithm").addEventListener("change", (e) => { state.algorithm = e.target.value; afterEdit(false); });
  $("#maxRide").addEventListener("input", (e) => { state.maxRide = e.target.value; afterEdit(false); });
  $("#enforceAreas").addEventListener("change", (e) => { state.enforce = e.target.checked; afterEdit(false); });
  $("#optimizeBtn").onclick = optimize;
}

function syncSettings() {
  $("#capacity").value = state.capacity;
  $("#algorithm").value = state.algorithm;
  $("#maxRide").value = state.maxRide;
  $("#enforceAreas").checked = state.enforce;
}

function afterEdit(rerender = true) {
  if (rerender) renderOrderList();
  $("#formErrors").hidden = true;
  $("#optimizeHint").textContent = "";
  updateNav();
  save();
}

function updateNav() {
  $("#navOrders").textContent = state.orders.length || "";
  $("#navResult").hidden = !state.result;
}

function renderOrderList() {
  $("#orderCount").textContent = state.orders.length ? `(${state.orders.length})` : "";
  updateNav();
  const box = $("#orderList");
  if (!state.orders.length) {
    box.innerHTML = `<div class="empty"><b>No orders yet</b>Choose a restaurant and a society on the left, then press “Add order” — or load an example from the dashboard.</div>`;
    return;
  }
  box.innerHTML = `<table class="order-table">
    <thead><tr><th>Order</th><th>Collect from</th><th>Deliver to</th><th>Delivery area</th><th><span class="sr-only">Remove</span></th></tr></thead>
    <tbody>${state.orders.map((o, i) => `<tr>
      <td class="oid">${orderId(i)}</td>
      <td><span class="place">${esc(nodeName(o.restaurant))}</span><span class="place-sub">${esc(nodeArea(o.restaurant))} · ${esc(o.restaurant)}</span></td>
      <td><span class="place">${esc(nodeName(o.society))}</span><span class="place-sub">${esc(nodeArea(o.society))} · ${esc(o.society)}</span></td>
      <td>${checkHtml(o.check, false)}</td>
      <td><button type="button" class="btn ghost sm danger" data-rm="${i}" aria-label="Remove order ${orderId(i)}">Remove</button></td>
    </tr>`).join("")}</tbody></table>`;
  for (const b of box.querySelectorAll("[data-rm]")) {
    b.onclick = () => { state.orders.splice(Number(b.dataset.rm), 1); afterEdit(); };
  }
}

function renderDrivers() {
  const all = [...grouped("Society"), ...grouped("Restaurant")];
  const opts = optionsHtml(all.map(([z, ns]) => [`${z} — ${ns[0].kind === "Society" ? "societies" : "restaurants"}`, ns]));
  $("#driverList").innerHTML = state.drivers.map((id, i) => `<li>
      <span class="dname"><span class="swatch" style="background:${COLORS[i % COLORS.length]}"></span>${driverId(i)}</span>
      <select data-driver="${i}" aria-label="Starting point of driver ${driverId(i)}">${opts}</select>
      <button type="button" class="btn ghost sm danger" data-rmd="${i}" ${state.drivers.length === 1 ? "disabled" : ""}
        aria-label="Remove driver ${driverId(i)}">Remove</button></li>`).join("");
  for (const sel of document.querySelectorAll("[data-driver]")) {
    sel.value = state.drivers[Number(sel.dataset.driver)];
    sel.onchange = () => { state.drivers[Number(sel.dataset.driver)] = sel.value; afterEdit(false); };
  }
  for (const b of document.querySelectorAll("[data-rmd]")) {
    b.onclick = () => { state.drivers.splice(Number(b.dataset.rmd), 1); renderDrivers(); afterEdit(false); };
  }
}

function validate() {
  const errors = [];
  if (!state.orders.length) errors.push("Add at least one order.");
  state.orders.forEach((o, i) => {
    if (!state.nodes.has(o.restaurant) || !state.nodes.has(o.society)) errors.push(`${orderId(i)} needs a restaurant and a society.`);
  });
  if (!state.drivers.length) errors.push("Add at least one driver.");
  const cap = Number(state.capacity);
  if (!Number.isInteger(cap) || cap < 1 || cap > 10) errors.push("Orders per driver must be a whole number from 1 to 10.");
  if (state.maxRide !== "" && (Number.isNaN(Number(state.maxRide)) || Number(state.maxRide) < 0)) {
    errors.push("Max extra minutes must be 0 or more (or empty for no limit).");
  }
  if (state.orders.length > 200) errors.push("Plan at most 200 orders at a time.");
  return errors;
}

function buildSpec(closures = []) {
  return {
    orders: state.orders.map((o) => ({ restaurant: o.restaurant, society: o.society })),
    drivers: [...state.drivers],
    capacity: Number(state.capacity),
    algorithm: state.algorithm,
    max_ride_extra_min: state.maxRide === "" ? null : Number(state.maxRide),
    enforce_serviceability: state.enforce,
    improve: "relocate",
    closures,
  };
}

function isStale() {
  return !!state.resultSpec && JSON.stringify(buildSpec()) !== JSON.stringify({ ...state.resultSpec, closures: [] });
}

async function optimize() {
  const errors = validate();
  const box = $("#formErrors");
  if (errors.length) {
    box.innerHTML = `<b>Please fix the following:</b><ul>${errors.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>`;
    box.hidden = false;
    return;
  }
  box.hidden = true;
  const btn = $("#optimizeBtn");
  btn.disabled = true;
  btn.innerHTML = `<span class="spinner" aria-hidden="true"></span> Optimizing…`;
  state.status = "planning";
  const spec = buildSpec();
  try {
    const result = await api("/api/multistop", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(spec),
    });
    state.result = result;
    state.resultSpec = spec;
    state.plannedAt = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    state.status = "planned";
    state.method = "insertion";
    state.closure = null;
    updateNav();
    location.hash = "#results";
  } catch (err) {
    state.status = "error";
    box.innerHTML = `<b>The route could not be planned.</b> ${esc(err.message)}`;
    box.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = "Optimize Delivery Route";
  }
}

// ---------------------------------------------------------------- results
function routesFor(method) {
  return method.drivers.map((d) => ({
    driverId: d.driver_id,
    color: COLORS[(Number(d.driver_id.slice(1)) - 1) % COLORS.length],
    start: d.start,
    path: d.path,
    stops: d.stops.map((s, i) => ({ ...s, num: i + 1 })),
  }));
}

/** One plain-language sentence written from the returned stops. */
function explainDriver(d) {
  const parts = [];
  let i = 0;
  while (i < d.stops.length) {
    const s = d.stops[i];
    let j = i;
    const ids = [];
    while (j < d.stops.length && d.stops[j].kind === s.kind && d.stops[j].node === s.node) { ids.push(d.stops[j].order_id); j += 1; }
    const what = ids.length === 1 ? `Order ${ids[0]}` : `Orders ${listJoin(ids)}`;
    parts.push(s.kind === "PICKUP"
      ? `collects ${what} from ${nodeName(s.node)}`
      : `delivers ${what} to ${nodeName(s.node)}`);
    i = j;
  }
  if (!parts.length) return `Driver ${d.driver_id} has no stops.`;
  const body = parts.length === 1 ? parts[0]
    : `${parts.slice(0, -1).join(", then ")}, and finally ${parts[parts.length - 1]}`;
  return `Driver ${d.driver_id} starts at ${nodeName(d.start)}, ${body}.`;
}

function comparisonText(opt, base) {
  const ot = opt.totals, bt = base.totals;
  const diff = bt.distance_km - ot.distance_km;
  const timeDiff = bt.drive_time_min - ot.drive_time_min;
  if (ot.delivered !== bt.delivered) {
    return `The two plans deliver a different number of orders (${ot.delivered} vs ${bt.delivered}), so their distances are not directly comparable.`;
  }
  if (Math.abs(diff) < 0.0005) {
    return "Both plans drive the same distance here: there was no shorter way to combine these orders within the rules.";
  }
  if (diff > 0) {
    const pct = (diff / bt.distance_km) * 100;
    return `The optimized route drives ${km(diff)} less (${pct.toFixed(1)}% shorter) and about ${mins(Math.max(timeDiff, 0))} less` +
      `${ot.batched ? ", because drivers collect several orders before delivering them instead of making a separate trip for each" : ""}.`;
  }
  return `Here the simple route is ${km(-diff)} shorter. The optimizer chooses each order's position quickly and is not guaranteed to find the best possible plan.`;
}

function renderResults() {
  const body = $("#resultsBody");
  if (!state.result) {
    body.innerHTML = `<div class="card"><div class="empty"><b>No route yet</b>Add orders and press “Optimize Delivery Route”.<br><br>
      <a class="btn primary" href="#orders">Create orders</a></div></div>`;
    return;
  }
  const r = state.result;
  const opt = r.methods.insertion, base = r.methods.append;
  const shown = r.methods[state.method];
  const ot = opt.totals;
  const n = state.resultSpec.orders.length;
  const notDelivered = shown.orders.filter((o) => o.status !== "DELIVERED");
  const atRisk = shown.orders.filter((o) => o.status === "DELIVERED" && (o.late || o.reason));

  body.innerHTML = `
    ${isStale() ? `<div class="banner warn">Your orders or settings changed after this plan was made. Press <a href="#orders">Optimize Delivery Route</a> again to update it.</div>` : ""}
    <div class="summary">
      <div class="stat"><div class="v">${ot.delivered} / ${n}</div><div class="k">Orders delivered</div></div>
      <div class="stat"><div class="v">${km(ot.distance_km)}</div><div class="k">Total driving distance</div></div>
      <div class="stat"><div class="v">${mins(ot.drive_time_min)}</div><div class="k">Estimated driving time</div></div>
      <div class="stat"><div class="v">${ot.drivers_used} / ${state.resultSpec.drivers.length}</div><div class="k">Drivers used</div></div>
    </div>
    ${ot.delivered === 0 ? `<div class="banner error">None of the orders could be delivered. The reasons are listed below.</div>` : ""}

    <div class="card">
      <h2>Optimized route vs simple route</h2>
      <div class="compare">
        ${compareSide("Optimized route", "Collects several orders per trip", opt, true)}
        ${compareSide("Simple route", "One order at a time: collect, deliver, next", base, false)}
      </div>
      <p class="explain" style="margin-top:12px">${esc(comparisonText(opt, base))}</p>
    </div>

    <div class="card">
      <div class="card-head">
        <h2>Route map</h2>
        <div class="seg" role="group" aria-label="Which plan to show">
          <button type="button" data-method="insertion" class="${state.method === "insertion" ? "on" : ""}" aria-pressed="${state.method === "insertion"}">Optimized route</button>
          <button type="button" data-method="append" class="${state.method === "append" ? "on" : ""}" aria-pressed="${state.method === "append"}">Simple route</button>
        </div>
      </div>
      <div class="map-wrap"><svg id="resultMap" class="map-svg"></svg>
        <div class="map-tools"><button type="button" class="btn sm" id="refitBtn">Fit route</button></div></div>
      ${legendHtml(shown, false)}
    </div>

    <h2 style="margin:8px 0 0">${state.method === "insertion" ? "Optimized route" : "Simple route"}: stop by stop</h2>
    ${shown.drivers.length ? shown.drivers.map((d) => driverCard(d, shown)).join("")
      : `<div class="card"><div class="empty"><b>No driver has any stops</b>No order could be assigned.</div></div>`}

    ${notDelivered.length || atRisk.length ? `<div class="card"><h2>Orders needing attention</h2><ul class="issue-list">
      ${notDelivered.map((o) => issueItem(o, false)).join("")}${atRisk.map((o) => issueItem(o, true)).join("")}</ul></div>` : ""}

    <details class="card tech"><summary><b>Technical details</b></summary>
      <table>
        <tr><td>Road search method</td><td>${r.settings.algorithm === "astar" ? "A*" : "Dijkstra"} (optimising ${esc(r.settings.metric)})</td></tr>
        <tr><td>Orders per driver</td><td>${r.settings.capacity}</td></tr>
        <tr><td>Max extra ride time</td><td>${r.settings.max_ride_extra_min ?? "no limit"} min</td></tr>
        <tr><td>Delivery-area rules</td><td>${r.settings.serviceability ? "applied" : "off"}</td></tr>
        <tr><td>Planning time</td><td>optimized ${opt.totals.planning_ms.toFixed(1)} ms · simple ${base.totals.planning_ms.toFixed(1)} ms</td></tr>
        <tr><td>Rule check (optimized)</td><td>${opt.violations.length ? esc(opt.violations.join("; ")) : "all rules satisfied: each order collected once before delivery, at the right places, within capacity"}</td></tr>
        <tr><td>Rule check (simple)</td><td>${base.violations.length ? esc(base.violations.join("; ")) : "all rules satisfied"}</td></tr>
      </table>
    </details>`;

  for (const b of body.querySelectorAll("[data-method]")) {
    b.onclick = () => { state.method = b.dataset.method; renderResults(); };
  }
  const map = createRouteMap($("#resultMap"), state.graph, $("#tooltip"));
  map.show(routesFor(shown), { focus: shown.orders.flatMap((o) => [o.restaurant, o.society]).filter((id) => state.nodes.has(id)) });
  $("#refitBtn").onclick = () => map.refit();
}

function compareSide(title, sub, m, best) {
  const t = m.totals;
  return `<div class="side ${best ? "best" : ""}">
    <h3>${esc(title)} ${best ? `<span class="pill ok">Recommended</span>` : ""}</h3>
    <p class="muted small">${esc(sub)}</p>
    <dl><dt>Distance</dt><dd>${km(t.distance_km)}</dd>
      <dt>Driving time</dt><dd>${mins(t.drive_time_min)}</dd>
      <dt>Orders delivered</dt><dd>${t.delivered}</dd>
      <dt>Drivers used</dt><dd>${t.drivers_used}</dd></dl></div>`;
}

function legendHtml(method, closed) {
  return `<div class="map-legend">
    ${method.drivers.map((d) => `<span><i class="swatch" style="background:${COLORS[(Number(d.driver_id.slice(1)) - 1) % COLORS.length]}"></i>${esc(d.driver_id)}</span>`).join("")}
    <span><i class="lg-shape start"></i>Driver start</span>
    <span><i class="lg-shape pick"></i>Pickup stop (number = visit order)</span>
    <span><i class="lg-shape del"></i>Delivery stop</span>
    <span><i class="lg-shape rest"></i>Restaurant</span>
    <span><i class="lg-shape soc"></i>Society</span>
    ${closed ? `<span><i class="lg-line"></i>Blocked road</span>` : ""}
    <span class="small">Places use their real latitude/longitude; roads are drawn as straight links, not street shapes.</span>
  </div>`;
}

function driverCard(d, method) {
  const color = COLORS[(Number(d.driver_id.slice(1)) - 1) % COLORS.length];
  const orders = new Map(method.orders.map((o) => [o.order_id, o]));
  return `<div class="card driver-card">
    <h3><span class="swatch" style="background:${color}"></span> Driver ${esc(d.driver_id)}
      <span class="meta">${km(d.distance_km)} · about ${mins(d.drive_time_min)} driving · ${plural(new Set(d.stops.map((s) => s.order_id)).size, "order", "orders")}</span></h3>
    <p class="explain">${esc(explainDriver(d))}</p>
    <ol class="timeline">
      <li><span class="tl-num start" aria-hidden="true">Start</span>
        <div class="tl-body"><div class="what">Starts at ${esc(nodeName(d.start))}</div><div class="where">${esc(d.start)} · ${esc(nodeArea(d.start))}</div></div>
        <div class="tl-side">0 min</div></li>
      ${d.stops.map((s, i) => {
        const o = orders.get(s.order_id);
        const pick = s.kind === "PICKUP";
        const other = pick ? `for ${nodeName(o.society)}` : `from ${nodeName(o.restaurant)}`;
        const wait = pick && s.departure > s.arrival + 0.05 ? ` · waits ${mins(s.departure - s.arrival)} for the food` : "";
        return `<li><span class="tl-num ${pick ? "pickup" : "delivery"}" aria-hidden="true">${i + 1}</span>
          <div class="tl-body">
            <div class="what"><span class="pill ${pick ? "pickup" : "delivery"}">${pick ? "Pickup" : "Delivery"}</span>
              ${pick ? "Collect" : "Deliver"} order ${esc(s.order_id)} ${pick ? "from" : "to"} ${esc(s.name)}</div>
            <div class="where">${esc(s.node)} · ${esc(nodeArea(s.node))} · ${esc(other)}${esc(wait)}</div>
          </div>
          <div class="tl-side">arrives at <b>${mins(s.arrival)}</b><br>${km(s.cum_km)} driven</div></li>`;
      }).join("")}
    </ol>
    <details class="small muted"><summary>Roads driven (${d.path.length - 1})</summary>${d.path.map((id) => esc(`${nodeName(id)} (${id})`)).join(" → ")}</details>
  </div>`;
}

function issueItem(o, risk) {
  const title = risk ? `${o.order_id} was delivered${o.late ? " late" : ""}` : `${o.order_id} was not delivered`;
  const status = { REJECTED: "Not accepted", FAILED: "Could not be delivered", PENDING: "Not assigned" }[o.status] || o.status;
  return `<li class="${risk ? "warn" : ""}"><b>${esc(title)}</b> — ${esc(o.restaurant_name)} → ${esc(o.society_name)}
    ${risk ? "" : `<span class="pill bad">${esc(status)}</span>`}
    <div class="why">${esc(reasonText(o.reason, o.message))}</div></li>`;
}

// ---------------------------------------------------------------- closures
function roadLabel(key) {
  const [a, b] = key.split("|");
  const w = state.roads.get(key);
  return `${nodeName(a)} (${a}) → ${nodeName(b)} (${b})${w ? ` · ${w[0].toFixed(2)} km` : ""}`;
}

function renderClosures() {
  const body = $("#closuresBody");
  if (!state.result) {
    body.innerHTML = `<div class="card"><div class="empty"><b>Plan a route first</b>Road closures are tested on your current delivery plan.<br><br>
      <a class="btn primary" href="#orders">Create orders</a></div></div>`;
    return;
  }
  const c = state.closure;
  const plan = c ? c.before : state.result;
  const used = new Set();
  for (const d of plan.methods.insertion.drivers) {
    for (let i = 0; i + 1 < d.path.length; i++) used.add(`${d.path[i]}|${d.path[i + 1]}`);
  }
  const all = state.showAllRoads ? [...state.roads.keys()].filter((k) => !used.has(k)) : [];
  const byName = (a, b) => roadLabel(a).localeCompare(roadLabel(b));

  body.innerHTML = `
    ${isStale() ? `<div class="banner warn">Your orders changed after the last plan. Closures are tested on the last plan; <a href="#orders">optimize again</a> to use your new orders.</div>` : ""}
    ${c ? `<div class="blocked"><div><b>Blocked:</b> ${esc(roadLabel(c.road))}<br>
      <span class="small">${c.at > 0 ? `Closed ${c.at} minutes after drivers set off.` : "Closed before drivers set off."}</span></div>
      <button type="button" class="btn" id="restoreBtn" ${state.closureBusy ? "disabled" : ""}>Restore road</button></div>` : ""}
    <div class="steps">
      <div class="card">
        <h2>1. Choose a road to block</h2>
        <p class="muted small">Roads are one-way links from the dataset. The list starts with roads your optimized route uses.</p>
        <select id="roadSelect" aria-label="Road to block" ${c ? "disabled" : ""}>
          <optgroup label="Used by the current optimized route">${[...used].sort(byName).map((k) =>
            `<option value="${esc(k)}">${esc(roadLabel(k))}</option>`).join("")}</optgroup>
          ${all.length ? `<optgroup label="Other roads">${all.sort(byName).map((k) =>
            `<option value="${esc(k)}">${esc(roadLabel(k))}</option>`).join("")}</optgroup>` : ""}
        </select>
        <label class="toggle small" style="margin-top:8px"><input type="checkbox" id="allRoads" ${state.showAllRoads ? "checked" : ""} ${c ? "disabled" : ""}> Show every road in the network (${state.roads.size})</label>
      </div>
      <div class="card">
        <h2>2. When does it close?</h2>
        <div class="radio-row">
          <label><input type="radio" name="when" value="0" ${!c || c.at === 0 ? "checked" : ""} ${c ? "disabled" : ""}> Before drivers set off</label>
          <label><input type="radio" name="when" value="later" ${c && c.at > 0 ? "checked" : ""} ${c ? "disabled" : ""}> While drivers are on the way, after
            <input type="number" id="whenMin" min="1" step="1" value="${c && c.at > 0 ? c.at : 5}" ${c ? "disabled" : ""} aria-label="Minutes after departure"> minutes</label>
        </div>
        <button type="button" class="btn primary" id="blockBtn" style="margin-top:14px" ${c || state.closureBusy ? "disabled" : ""}>
          ${state.closureBusy && !c ? `<span class="spinner" aria-hidden="true"></span> Re-planning…` : "Block road and re-plan"}</button>
      </div>
    </div>
    <div id="closureError" class="banner error" role="alert" hidden></div>
    <div id="closureResult"></div>`;

  const sel = $("#roadSelect");
  if (sel && c) sel.value = c.road;
  const all$ = $("#allRoads");
  if (all$) all$.onchange = () => { state.showAllRoads = all$.checked; renderClosures(); };
  const block = $("#blockBtn");
  if (block) block.onclick = blockRoad;
  const restoreBtn = $("#restoreBtn");
  if (restoreBtn) restoreBtn.onclick = restoreRoad;
  if (c) renderClosureOutcome();
}

async function blockRoad() {
  const key = $("#roadSelect").value;
  if (!key) return;
  const when = document.querySelector("input[name=when]:checked").value;
  const at = when === "0" ? 0 : Number($("#whenMin").value);
  const err = $("#closureError");
  if (when !== "0" && (!Number.isFinite(at) || at <= 0)) {
    err.textContent = "Enter the number of minutes after departure (1 or more).";
    err.hidden = false;
    return;
  }
  const [source, target] = key.split("|");
  const spec = { ...state.resultSpec, closures: [{ source, target, at, reopen_at: null }] };
  state.closureBusy = true;
  renderClosures();
  try {
    const after = await api("/api/multistop", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(spec),
    });
    state.closure = { road: key, at, before: state.result, after, restored: null };
    state.closureView = "after";
  } catch (e) {
    state.closureBusy = false;
    renderClosures();
    $("#closureError").textContent = `Re-planning failed: ${e.message}`;
    $("#closureError").hidden = false;
    return;
  }
  state.closureBusy = false;
  renderClosures();
}

async function restoreRoad() {
  const c = state.closure;
  state.closureBusy = true;
  renderClosures();
  try {
    // Re-plan with the road open again (the backend always reopens roads
    // after a run; this request has no closure at all).
    const restored = await api("/api/multistop", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...state.resultSpec, closures: [] }),
    });
    const same = Math.abs(restored.methods.insertion.totals.distance_km - c.before.methods.insertion.totals.distance_km) < 1e-6;
    state.result = restored;
    state.closure = null;
    state.closureBusy = false;
    renderClosures();
    $("#closureResult").innerHTML = `<div class="banner ok">Road restored: ${esc(roadLabel(c.road))}. The plan was recalculated with the road open:
      ${km(restored.methods.insertion.totals.distance_km)}${same ? " — the same as before the closure." : "."}</div>`;
  } catch (e) {
    state.closureBusy = false;
    renderClosures();
    $("#closureError").textContent = `Could not restore: ${e.message}`;
    $("#closureError").hidden = false;
  }
}

function renderClosureOutcome() {
  const c = state.closure;
  const before = c.before.methods.insertion, after = c.after.methods.insertion;
  const [a, b] = c.road.split("|");
  const usedBefore = before.drivers.some((d) => d.path.some((id, i) => id === a && d.path[i + 1] === b));
  const delivered = (m) => new Set(m.orders.filter((o) => o.status === "DELIVERED").map((o) => o.order_id));
  const lost = [...delivered(before)].filter((id) => !delivered(after).has(id));
  const lostOrders = after.orders.filter((o) => lost.includes(o.order_id));
  const risky = after.orders.filter((o) => o.status === "DELIVERED" && (o.late || o.reason));
  const blockedUsed = after.violations.some((v) => v.includes("closed road"));
  const diffKm = after.totals.distance_km - before.totals.distance_km;
  const routeChanged = JSON.stringify(before.drivers.map((d) => d.path)) !== JSON.stringify(after.drivers.map((d) => d.path));

  let verdict;
  if (!usedBefore && !routeChanged) {
    verdict = `<div class="banner info">The current plan did not need this road, so nothing changed.</div>`;
  } else if (lost.length) {
    verdict = `<div class="banner error"><b>No alternative route for ${plural(lost.length, "order", "orders")}.</b>
      ${esc(listJoin(lost))} can no longer be delivered; see the reasons below. ${after.totals.delivered} order(s) are still delivered.</div>`;
  } else {
    verdict = `<div class="banner ok"><b>Alternative route found.</b> All ${after.totals.delivered} orders are still delivered.
      The new plan is ${diffKm >= 0 ? `${km(diffKm)} longer` : `${km(-diffKm)} shorter`} and takes about
      ${mins(Math.abs(after.totals.drive_time_min - before.totals.drive_time_min))} ${after.totals.drive_time_min >= before.totals.drive_time_min ? "more" : "less"} driving.</div>`;
  }
  const events = after.reroutes.filter((r) => r.action === "close");
  const shown = state.closureView === "after" ? after : before;

  $("#closureResult").innerHTML = `
    ${verdict}
    <p class="small ${blockedUsed ? "bad-line" : "muted"}">${blockedUsed
      ? "Warning: the backend reports the blocked road was entered after it closed."
      : "Checked by the server: no driver entered the blocked road after it closed."}</p>
    <div class="card">
      <h2>Before and after</h2>
      <div class="compare">
        ${compareSide("Before the closure", "Your current optimized plan", before, false)}
        ${compareSide("With the road blocked", c.at > 0 ? `Road closes after ${c.at} min` : "Road closed from the start", after, false)}
      </div>
    </div>
    ${events.length && c.at > 0 ? `<div class="card"><h2>What happened when the road closed</h2>${events.map((e) => `
      <p>${e.affected_drivers.length ? `${plural(e.affected_drivers.length, "driver was", "drivers were")} using this road: ${esc(listJoin(e.affected_drivers))}.`
        : "No driver was using this road at that moment."}
      ${Object.entries(e.reanchored).map(([d, n]) => `${esc(d)} finished the road it was on and continued from ${esc(nodeName(n))}.`).join(" ")}</p>
      ${Object.keys(e.released_orders).length ? `<p>${esc(listJoin(Object.keys(e.released_orders)))}: ${esc(reasonText("ROAD_CLOSED_UNREACHABLE"))}</p>` : ""}
      ${Object.keys(e.failed_orders).length ? `<p class="bad-line">${esc(listJoin(Object.keys(e.failed_orders)))}: ${esc(reasonText("DROPOFF_UNREACHABLE"))}</p>` : ""}
      ${Object.entries(e.at_risk_orders).map(([o, why]) => `<p>${esc(o)}: ${esc(reasonText(why))}</p>`).join("")}
      <p class="muted small">Re-routing took ${e.latency_ms.toFixed(1)} ms on the server.</p>`).join("")}</div>` : ""}
    <div class="card">
      <div class="card-head"><h2>Route map</h2>
        <div class="seg" role="group" aria-label="Which plan to show">
          <button type="button" data-cv="before" class="${state.closureView === "before" ? "on" : ""}" aria-pressed="${state.closureView === "before"}">Before</button>
          <button type="button" data-cv="after" class="${state.closureView === "after" ? "on" : ""}" aria-pressed="${state.closureView === "after"}">With road blocked</button>
        </div></div>
      <div class="map-wrap"><svg id="closureMap" class="map-svg"></svg></div>
      ${legendHtml(shown, true)}
    </div>
    ${shown.drivers.map((d) => driverCard(d, shown)).join("")}
    ${lostOrders.length || risky.length ? `<div class="card"><h2>Affected orders</h2><ul class="issue-list">
      ${lostOrders.map((o) => issueItem(o, false)).join("")}${risky.map((o) => issueItem(o, true)).join("")}</ul></div>` : ""}`;

  for (const btn of document.querySelectorAll("[data-cv]")) {
    btn.onclick = () => { state.closureView = btn.dataset.cv; renderClosureOutcome(); };
  }
  const map = createRouteMap($("#closureMap"), state.graph, $("#tooltip"));
  map.show(routesFor(shown), { closed: [[a, b]] });
}

init();
