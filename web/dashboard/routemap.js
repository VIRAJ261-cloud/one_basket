/*
 * Route map component.
 *
 * Draws the real delivery network from /api/graph (locations placed by their
 * latitude/longitude, road links drawn as straight lines) and overlays the
 * routes exactly as returned by the backend: each driver's road path, the
 * numbered stops in visit order, start points and blocked roads.
 * It never computes a route itself.
 */
const SVGNS = "http://www.w3.org/2000/svg";

function el(tag, attrs, parent) {
  const node = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
  if (parent) parent.appendChild(node);
  return node;
}

function esc(text) {
  return String(text ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

export function createRouteMap(svg, graph, tooltip) {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  let view = null;
  let current = { routes: [], closed: [], focus: [] };

  svg.innerHTML = "";
  svg.setAttribute("role", "img");
  const base = el("g", {}, svg);
  const overlay = el("g", {}, svg);

  // Base network: every road link and every location.
  const roadLayer = el("g", { stroke: "#e2e6ec", "stroke-width": 1, "vector-effect": "non-scaling-stroke" }, base);
  for (const e of graph.edges) {
    const a = nodes.get(e.a), b = nodes.get(e.b);
    el("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, "vector-effect": "non-scaling-stroke" }, roadLayer);
  }
  const placeLayer = el("g", {}, base);
  const placeEls = [];
  for (const n of graph.nodes) {
    const isSoc = n.kind === "Society";
    const shape = isSoc
      ? el("rect", { fill: "#9fb3c8", stroke: "#fff", "data-id": n.id }, placeLayer)
      : el("circle", { fill: "#f3b38f", stroke: "#fff", "data-id": n.id }, placeLayer);
    placeEls.push([n, shape, isSoc]);
  }

  const ppu = () => (view ? svg.clientWidth / view.w : 1);

  function sizePlaces() {
    const k = 1 / ppu();
    for (const [n, shape, isSoc] of placeEls) {
      if (isSoc) {
        const s = 9 * k;
        shape.setAttribute("x", n.x - s / 2); shape.setAttribute("y", n.y - s / 2);
        shape.setAttribute("width", s); shape.setAttribute("height", s);
        shape.setAttribute("rx", 2 * k); shape.setAttribute("stroke-width", 1.2 * k);
      } else {
        shape.setAttribute("cx", n.x); shape.setAttribute("cy", n.y);
        shape.setAttribute("r", 3 * k); shape.setAttribute("stroke-width", 0.8 * k);
      }
    }
  }

  function drawOverlay() {
    overlay.innerHTML = "";
    const k = 1 / ppu();
    for (const [a, b] of current.closed) {
      const p = nodes.get(a), q = nodes.get(b);
      if (!p || !q) continue;
      el("line", { x1: p.x, y1: p.y, x2: q.x, y2: q.y, stroke: "#d92d20", "stroke-width": 4,
        "stroke-dasharray": "6 5", "vector-effect": "non-scaling-stroke" }, overlay);
      const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
      el("circle", { cx: mx, cy: my, r: 8 * k, fill: "#d92d20" }, overlay);
      el("line", { x1: mx - 4 * k, y1: my, x2: mx + 4 * k, y2: my, stroke: "#fff", "stroke-width": 2.4,
        "vector-effect": "non-scaling-stroke" }, overlay);
    }
    for (const r of current.routes) {
      const pts = r.path.map((id) => nodes.get(id)).filter(Boolean);
      if (pts.length > 1) {
        el("polyline", { points: pts.map((p) => `${p.x},${p.y}`).join(" "), fill: "none",
          stroke: "#fff", "stroke-width": 8, "stroke-linejoin": "round", "stroke-linecap": "round",
          "vector-effect": "non-scaling-stroke" }, overlay);
        el("polyline", { points: pts.map((p) => `${p.x},${p.y}`).join(" "), fill: "none",
          stroke: r.color, "stroke-width": 4.5, "stroke-linejoin": "round", "stroke-linecap": "round",
          "vector-effect": "non-scaling-stroke" }, overlay);
        // Direction arrows at the middle of each road segment.
        for (let i = 0; i + 1 < pts.length; i++) {
          const p = pts[i], q = pts[i + 1];
          const len = Math.hypot(q.x - p.x, q.y - p.y);
          if (len * ppu() < 40) continue;
          const ang = Math.atan2(q.y - p.y, q.x - p.x) * 180 / Math.PI;
          const g = el("g", { transform: `translate(${(p.x + q.x) / 2},${(p.y + q.y) / 2}) rotate(${ang}) scale(${k})` }, overlay);
          el("path", { d: "M -5 -5 L 4 0 L -5 5 Z", fill: r.color, stroke: "#fff", "stroke-width": 1 }, g);
        }
      }
    }
    // Start markers.
    for (const r of current.routes) {
      const s = nodes.get(r.start);
      if (!s) continue;
      el("circle", { cx: s.x, cy: s.y, r: 9 * k, fill: "#fff", stroke: r.color, "stroke-width": 4,
        "vector-effect": "non-scaling-stroke", "data-id": s.id }, overlay);
    }
    // Numbered stop markers; stops sharing a place are combined ("2·3").
    for (const r of current.routes) {
      const groups = new Map();
      for (const s of r.stops) {
        if (!groups.has(s.node)) groups.set(s.node, []);
        groups.get(s.node).push(s);
      }
      for (const [id, stops] of groups) {
        const n = nodes.get(id);
        if (!n) continue;
        const label = stops.map((s) => s.num).join("·");
        const kind = stops.every((s) => s.kind === "PICKUP") ? "pickup"
          : stops.every((s) => s.kind === "DROPOFF") ? "delivery" : "mixed";
        const fill = kind === "pickup" ? "#c2410c" : kind === "delivery" ? "#15803d" : "#475467";
        const w = Math.max(22, 9 + label.length * 7.5) * k, h = 22 * k;
        const g = el("g", { "data-id": id }, overlay);
        el("rect", { x: n.x - w / 2, y: n.y - h - 6 * k, width: w, height: h, rx: h / 2, fill,
          stroke: r.color, "stroke-width": 2.5, "vector-effect": "non-scaling-stroke", "data-id": id }, g);
        el("path", { d: `M ${n.x - 4 * k} ${n.y - 7 * k} L ${n.x} ${n.y - 1 * k} L ${n.x + 4 * k} ${n.y - 7 * k} Z`,
          fill, "data-id": id }, g);
        const t = el("text", { x: n.x, y: n.y - 6 * k - h / 2 + 4.3 * k, "text-anchor": "middle",
          "font-size": 12.5 * k, "font-weight": 700, fill: "#fff", "data-id": id }, g);
        t.textContent = label;
      }
    }
  }

  function apply() {
    if (!view) return;
    svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`);
    sizePlaces();
    drawOverlay();
  }

  function fit(ids) {
    const pts = (ids && ids.length ? ids : graph.nodes.map((n) => n.id))
      .map((id) => nodes.get(id)).filter(Boolean);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of pts) {
      minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
    }
    const aspect = (svg.clientWidth || 800) / (svg.clientHeight || 470);
    let w = Math.max(maxX - minX, 80) * 1.3, h = Math.max(maxY - minY, 80) * 1.3;
    if (w / h < aspect) w = h * aspect; else h = w / aspect;
    view = { x: (minX + maxX) / 2 - w / 2, y: (minY + maxY) / 2 - h / 2, w, h };
    apply();
  }

  // Pan and zoom.
  const toUser = (x, y) => new DOMPoint(x, y).matrixTransform(svg.getScreenCTM().inverse());
  svg.addEventListener("wheel", (e) => {
    if (!view) return;
    e.preventDefault();
    const pt = toUser(e.clientX, e.clientY);
    const f = e.deltaY < 0 ? 0.85 : 1 / 0.85;
    view = { x: pt.x - (pt.x - view.x) * f, y: pt.y - (pt.y - view.y) * f, w: view.w * f, h: view.h * f };
    apply();
  }, { passive: false });
  let drag = null;
  svg.addEventListener("pointerdown", (e) => {
    if (!view) return;
    drag = { x: e.clientX, y: e.clientY, v: { ...view }, k: ppu() };
    svg.setPointerCapture(e.pointerId);
    svg.classList.add("dragging");
  });
  svg.addEventListener("pointermove", (e) => {
    if (drag) {
      view = { ...drag.v, x: drag.v.x - (e.clientX - drag.x) / drag.k, y: drag.v.y - (e.clientY - drag.y) / drag.k };
      svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`);
      return;
    }
    const id = e.target.getAttribute && e.target.getAttribute("data-id");
    if (!tooltip) return;
    if (!id) { tooltip.hidden = true; return; }
    const n = nodes.get(id);
    const visits = [];
    for (const r of current.routes) {
      for (const s of r.stops) {
        if (s.node === id) visits.push(`${r.driverId} stop ${s.num}: ${s.kind === "PICKUP" ? "collect" : "deliver"} ${s.order_id}`);
      }
      if (r.start === id) visits.push(`${r.driverId} starts here`);
    }
    tooltip.innerHTML = `<b>${esc(n.name)}</b> <span class="t-muted">(${esc(n.id)})</span><br>` +
      `<span class="t-muted">${n.kind === "Society" ? "Society" : "Restaurant"} · ${esc(n.area)}</span>` +
      (visits.length ? `<br>${visits.map(esc).join("<br>")}` : "");
    tooltip.hidden = false;
    tooltip.style.left = `${e.clientX + 14}px`;
    tooltip.style.top = `${e.clientY + 14}px`;
  });
  const end = () => {
    if (drag) { drag = null; svg.classList.remove("dragging"); apply(); }
  };
  svg.addEventListener("pointerup", end);
  svg.addEventListener("pointercancel", end);
  svg.addEventListener("mouseleave", () => { if (tooltip) tooltip.hidden = true; });

  return {
    /** routes: [{driverId, color, start, path, stops:[{num, kind, node, order_id}]}] */
    show(routes, options = {}) {
      current = { routes, closed: options.closed || [], focus: options.focus || [] };
      const ids = new Set(current.focus);
      for (const r of routes) { r.path.forEach((id) => ids.add(id)); ids.add(r.start); }
      for (const [a, b] of current.closed) { ids.add(a); ids.add(b); }
      svg.setAttribute("aria-label", routes.length
        ? `Map of ${routes.length} driver route(s) with ${routes.reduce((s, r) => s + r.stops.length, 0)} stops`
        : "Delivery network map");
      fit([...ids]);
    },
    refit() { fit([...new Set([...current.focus, ...current.routes.flatMap((r) => r.path)])]); },
  };
}
