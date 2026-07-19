/* world.js — shared data model + geometry for GenieWheels roads & nodes.
 *
 * Coordinates everywhere in here are IMAGE-NATIVE pixels (the raw map image
 * pixel space, before the per-map gameplay `scale`). The game multiplies by
 * `scale` at render time; this module never knows about gameplay scale.
 *
 * Exposes a single global: window.GW
 */
(function () {
  const GW = {};

  // ── small helpers ──────────────────────────────────────────
  const dist = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
  const round = (n) => Math.round(n * 100) / 100;
  let _idCounter = 0;
  function uid(prefix) {
    _idCounter += 1;
    // browser-only; avoids needing Math.random for determinism in tests
    return `${prefix}_${Date.now().toString(36)}${_idCounter}`;
  }
  GW.uid = uid;
  GW.dist = dist;

  // ── Catmull-Rom (centripetal, alpha = 0.5) ─────────────────
  // Curve passes through the control points; centripetal avoids cusps/loops.
  function interp(a, b, ta, tb, t) {
    const denom = tb - ta;
    const f = denom === 0 ? 0 : (t - ta) / denom;
    return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
  }

  function catmullSegment(p0, p1, p2, p3, nSeg, alpha) {
    const out = [];
    const t0 = 0;
    const t1 = t0 + Math.pow(Math.max(dist(p0, p1), 1e-4), alpha);
    const t2 = t1 + Math.pow(Math.max(dist(p1, p2), 1e-4), alpha);
    const t3 = t2 + Math.pow(Math.max(dist(p2, p3), 1e-4), alpha);
    for (let i = 0; i < nSeg; i++) {
      const t = t1 + (t2 - t1) * (i / nSeg);
      const A1 = interp(p0, p1, t0, t1, t);
      const A2 = interp(p1, p2, t1, t2, t);
      const A3 = interp(p2, p3, t2, t3, t);
      const B1 = interp(A1, A2, t0, t2, t);
      const B2 = interp(A2, A3, t1, t3, t);
      out.push(interp(B1, B2, t1, t2, t));
    }
    return out;
  }

  const reflect = (a, b) => ({ x: 2 * a.x - b.x, y: 2 * a.y - b.y });

  // Flatten control points → dense polyline (native px).
  function flatten(points, closed, spacing) {
    spacing = spacing || 8;
    const pts = (points || []).map((p) => ({ x: p.x, y: p.y }));
    if (pts.length === 0) return [];
    if (pts.length === 1) return [{ x: pts[0].x, y: pts[0].y }];
    if (pts.length === 2) return [ { ...pts[0] }, { ...pts[1] } ];

    let seq;
    let segCount;
    if (closed) {
      seq = [pts[pts.length - 1], ...pts, pts[0], pts[1]];
      segCount = pts.length;
    } else {
      seq = [reflect(pts[0], pts[1]), ...pts, reflect(pts[pts.length - 1], pts[pts.length - 2])];
      segCount = pts.length - 1;
    }

    const poly = [];
    for (let i = 0; i < segCount; i++) {
      const p0 = seq[i], p1 = seq[i + 1], p2 = seq[i + 2], p3 = seq[i + 3];
      const n = Math.max(2, Math.round(dist(p1, p2) / spacing));
      poly.push(...catmullSegment(p0, p1, p2, p3, n, 0.5));
    }
    poly.push(closed ? { ...poly[0] } : { ...pts[pts.length - 1] });
    return poly;
  }
  GW.flatten = flatten;

  // ── distance from a point to a polyline ────────────────────
  function distToPolyline(poly, x, y) {
    let best = Infinity, bx = 0, by = 0, bi = 0, bt = 0;
    for (let i = 0; i < poly.length - 1; i++) {
      const a = poly[i], b = poly[i + 1];
      const dx = b.x - a.x, dy = b.y - a.y;
      const l2 = dx * dx + dy * dy;
      let t = l2 ? ((x - a.x) * dx + (y - a.y) * dy) / l2 : 0;
      t = Math.max(0, Math.min(1, t));
      const px = a.x + dx * t, py = a.y + dy * t;
      const d = Math.hypot(x - px, y - py);
      if (d < best) { best = d; bx = px; by = py; bi = i; bt = t; }
    }
    return { dist: best, x: bx, y: by, i: bi, t: bt };
  }
  GW.distToPolyline = distToPolyline;

  // Nearest point across all splines (for node snapping / on-road tests).
  function nearestOnRoads(world, x, y) {
    let best = null;
    for (const s of world.splines) {
      if (!s.poly || s.poly.length < 2) continue;
      const r = distToPolyline(s.poly, x, y);
      if (!best || r.dist < best.dist) best = { ...r, splineId: s.id, width: s.width };
    }
    return best; // null if no splines
  }
  GW.nearestOnRoads = nearestOnRoads;

  // ── normalization / (de)serialization ──────────────────────
  function normSpline(s) {
    const sp = {
      id: s.id || uid('sp'),
      points: (s.points || []).map((p) => ({ x: +p.x, y: +p.y })),
      width: +s.width || 60,
      curve: s.curve || 'catmull-rom',
      closed: !!s.closed,
      oneway: !!s.oneway,
    };
    sp.poly = flatten(sp.points, sp.closed);
    return sp;
  }

  function normNode(n) {
    return {
      id: n.id || uid('nd'),
      kind: n.kind === 'intersection' ? 'intersection' : 'stop', // 'stop' (delivery) | 'intersection'
      x: +n.x, y: +n.y,
      label: n.label || '',
      provides: Array.isArray(n.provides) ? n.provides.slice() : [],
      accepts: Array.isArray(n.accepts) ? n.accepts.slice() : [],
      radius: +n.radius || (n.kind === 'intersection' ? 110 : 60),
      access: n.access || 'car',        // 'car' | 'foot' | 'any'
      snap: n.snap || null,
    };
  }

  // Load raw data (object or JSON string) → in-memory world with cached polys.
  function loadWorld(data) {
    if (typeof data === 'string') data = JSON.parse(data);
    data = data || {};
    return {
      format: 'geniewheels.world',
      version: 1,
      mapId: data.mapId || null,
      imageSize: data.imageSize || null,
      splines: (data.splines || []).map(normSpline),
      nodes: (data.nodes || []).map(normNode),
      items: data.items || [],
    };
  }
  GW.loadWorld = loadWorld;

  function emptyWorld(mapId, imageSize) {
    return {
      format: 'geniewheels.world', version: 1,
      mapId: mapId || null,
      imageSize: imageSize || null,
      splines: [], nodes: [], items: [],
    };
  }
  GW.emptyWorld = emptyWorld;

  // Serialize → pretty JSON string, stripping derived fields (poly).
  function serialize(world) {
    const out = {
      format: 'geniewheels.world',
      version: 1,
      mapId: world.mapId,
      imageSize: world.imageSize,
      splines: world.splines.map((s) => ({
        id: s.id,
        points: s.points.map((p) => ({ x: round(p.x), y: round(p.y) })),
        width: round(s.width),
        curve: s.curve,
        closed: s.closed,
        oneway: s.oneway,
      })),
      nodes: world.nodes.map((n) => n.kind === 'intersection'
        ? { id: n.id, kind: 'intersection', x: round(n.x), y: round(n.y), radius: round(n.radius) }
        : { id: n.id, kind: 'stop', x: round(n.x), y: round(n.y), label: n.label,
            provides: n.provides, accepts: n.accepts, radius: round(n.radius),
            access: n.access, snap: n.snap || null }),
      items: world.items || [],
    };
    return JSON.stringify(out, null, 2);
  }
  GW.serialize = serialize;

  // Recompute a spline's cached polyline after its points/width change.
  GW.reflow = (spline) => { spline.poly = flatten(spline.points, spline.closed); return spline; };

  // Compute+attach a node's snap (nearest road point) from current splines.
  GW.computeSnap = (world, node) => {
    const r = nearestOnRoads(world, node.x, node.y);
    node.snap = r ? { splineId: r.splineId, t: round(r.i + r.t) } : null;
    return node.snap;
  };

  if (typeof window !== 'undefined') window.GW = GW;
  if (typeof module !== 'undefined' && module.exports) module.exports = GW;
})();
