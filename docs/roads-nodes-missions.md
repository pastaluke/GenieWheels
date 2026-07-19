# GenieWheels — Roads, Nodes & Delivery Missions

Design doc for the next big feature set: a **road/spline layer**, an in-browser
**authoring editor**, **autopilot**, **on-foot mode**, and a **delivery-mission
economy** — plus the **JSON contract** that lets you author a map and hand the
data back to be baked in.

Status: **planning**. Nothing here is built yet. This doc is the plan we'll
implement in phases.

---

## 1. Goals

From the request, in priority order:

1. **Place splines** by clicking down control points, and set the **road width**
   each spline defines.
2. **Autopilot** — a car can drive itself along the road network.
3. **Road containment** — cars can't drive where we don't want them to (roads
   define the drivable area).
4. **Exit the car** — switch to an on-foot avatar.
5. **Delivery missions** — place **nodes** at locations, editable to say what
   they provide (e.g. a node in front of the hospital says "bandaids"). A
   provider and a requester of the same item both **light up** when a mission is
   available; the game is largely about ferrying items between nodes.
6. **Export** splines + nodes as **JSON/text** so you can send it back and it
   gets baked into that map's data.

---

## 2. Design principles

- **Authoring is a dev tool, gameplay is baked.** You (the author) use the
  editor to draw roads and place nodes, export JSON, and hand it over. Players
  never see the editor — they get the baked, read-only world. This keeps the
  player build simple and the data trustworthy.
- **Data is separate from the photo.** The map images stay exactly as they are.
  Roads and nodes are a *logical overlay* on top of the photo — invisible during
  normal play (the painted road on the rug is the visual), with a debug toggle to
  see them.
- **One contract, versioned.** Everything the editor produces and the game
  consumes is a single JSON document per map, with a `version` field so we can
  evolve it without breaking old exports.
- **Author in image-native pixels.** All coordinates are stored in the map
  image's *natural* pixel space (see §3). Gameplay scale tuning never invalidates
  authored data.
- **Build in thin vertical slices.** Each phase (§14) is independently useful and
  testable — roads-only, then autopilot, then missions — so we always have a
  working game.

---

## 3. Coordinate system (read this first)

This is the thing most likely to cause pain later, so we pin it down now.

- The game loads a map image (e.g. `map2.jpg`, natural size 5389×3041) and blows
  it up by a per-map `scale` (currently `city` = 1.0, `adventure` = 1.8) to get
  **world pixels**. The car lives in world pixels.
- **Authored data is stored in image-native pixels** — i.e. the raw pixel
  coordinates of `map2.jpg`, *before* the `scale` multiply.
- At load time the game converts: `worldX = nativeX * scale`. If we later retune
  `scale` for feel, the JSON never changes.
- The editor therefore also works in image-native pixels: it shows the map at a
  known zoom and converts screen↔native on every click.

**Origin** = top-left of the image, `+x` right, `+y` down (canvas convention,
matching the existing game). Angles: `0` = north/up, positive = clockwise, same
as the car code today.

---

## 4. Data model & JSON contract

This is the heart of the doc — the format you'll export and I'll bake.

### 4.1 Top-level document

```json
{
  "format": "geniewheels.world",
  "version": 1,
  "mapId": "city",
  "imageSize": { "w": 5389, "h": 3041 },
  "splines": [ /* Spline objects */ ],
  "nodes":   [ /* Node objects */ ],
  "items":   [ /* optional catalog of item types */ ]
}
```

- `mapId` ties the data to an entry in the existing `MAPS` config.
- `imageSize` lets the loader sanity-check that coordinates match the image and
  rescale if the image is ever re-exported at a different size.

### 4.2 Spline (a road)

```json
{
  "id": "sp_1",
  "points": [ {"x": 1200, "y": 800}, {"x": 1460, "y": 815}, {"x": 1720, "y": 905} ],
  "width": 90,
  "curve": "catmull-rom",
  "closed": false,
  "oneway": false
}
```

- `points` — ordered **control points** in image-native px. The road curve passes
  *through* these (Catmull-Rom, §5).
- `width` — road width in image-native px. The drivable band is `width/2` on each
  side of the centerline.
- `closed` — if true, the spline loops (e.g. the roundabout).
- `oneway` — reserved for later autopilot/traffic direction; ignored at first.

### 4.3 Node (a stop / place)

```json
{
  "id": "nd_hospital",
  "x": 980, "y": 1240,
  "label": "Hospital",
  "provides": ["bandaids"],
  "accepts":  [],
  "radius": 70,
  "snap": { "splineId": "sp_1", "t": 0.34 }
}
```

- `x,y` — node center, image-native px.
- `label` — free text you type in the editor ("Hospital", "Pizza Place").
- `provides` — item types this node can be the **source** of (lowercased
  strings, free-form). A hospital "provides" `["bandaids"]`.
- `accepts` — item types this node will **request** as a destination. `[]` means
  "accepts nothing special"; `["*"]` means "can request anything". A node can
  both provide and accept.
- `radius` — how close (world px, after scaling) the car must stop to interact.
- `snap` — optional: the road + parameter the node is attached to, so autopilot
  knows where on the network to pull over. Auto-computed by the editor as
  "nearest point on nearest spline"; can be cleared for off-road nodes reachable
  only on foot.

### 4.4 Item catalog (optional)

```json
{ "id": "bandaids", "label": "Bandaids", "icon": "🩹", "color": "#e74c3c" }
```

Lets us attach an emoji/color to each item for the HUD. If omitted, an item type
still works — it just renders as plain text. The editor can build this list
automatically from whatever `provides`/`accepts` strings you use.

### 4.5 IDs

Stable string IDs (`sp_1`, `nd_hospital`). The editor generates them; you can
rename node IDs to be meaningful. Missions and routing reference nodes/splines by
ID, so IDs must be unique within a document.

---

## 5. Splines (math)

- **Curve type: Catmull-Rom** through the control points. It's the intuitive
  "click points, curve goes through them" behavior, and converting to a Bézier or
  polyline for rendering/physics is standard.
- At load, each spline is **flattened** to a dense polyline (e.g. a point every
  ~6–10 world px, or adaptive by curvature). Everything downstream — drawing the
  road band, distance tests, autopilot — operates on the flattened polyline plus
  the `width`. Flattening once at load keeps per-frame math cheap.
- The **road band** is the polyline stroked with `width`, round joins/caps. For
  containment we treat it as the union of capsules (segment + radius `width/2`).
- Endpoints that land near another spline's endpoint (within a snap tolerance)
  are treated as **junctions** — this is what turns individual roads into a
  connected network (§6).

---

## 6. Road network graph (derived, not authored)

Autopilot and routing need a graph; we build it from the splines at load — you
don't hand-author it.

- **Graph nodes**: spline endpoints, and any point where two spline centerlines
  cross or snap together (junctions). Mission nodes attach via their nearest
  point on a spline (`snap`).
- **Graph edges**: the spline segment between two consecutive junctions, weighted
  by its arc length. `oneway` (later) makes an edge directional.
- **Routing**: A* / Dijkstra over this graph to get a route between two mission
  nodes. The route is a sequence of spline sub-paths → concatenated into one
  target polyline the autopilot follows.

We'll expose a debug overlay that draws the graph (junction dots + edges) so we
can eyeball whether a hand-drawn network actually connects.

---

## 7. Editor (authoring tool)

An in-browser editor, dev-gated. Not shipped to players.

### 7.1 Entering
- Open the game with `#edit` in the URL (e.g. `…/geniewheels/#edit`), or press
  `E` on the setup screen. Loads the currently-selected map into an edit view.
- The edit view is **always north-up**, with **pan** (drag / arrow keys) and
  **zoom** (wheel / pinch). No car physics — it's a map editor.

### 7.2 Tools (palette on screen)
- **Select/Move** — click a control point or node to select; drag to move;
  `Delete` removes.
- **Draw Spline** — click to drop control points; `Enter` or double-click ends
  the spline. Click a segment to insert a mid-point. Selected spline shows its
  road band live.
- **Width** — slider (or `[` / `]`) sets the selected spline's `width`, with live
  band preview.
- **Place Node** — click to drop a node; a small form edits `label`,
  `provides`, `accepts`, `radius`. Drag to reposition; `snap` recomputes.
- **Junction snap** — dragging a spline endpoint near another endpoint snaps them
  together (visual highlight) so the network connects.

### 7.3 Panel
- Scrollable list of splines and nodes (click to focus/select).
- **Export** button → serializes to the §4 JSON, shows it in a `<textarea>` and
  offers a "Copy" + "Download .json".
- **Import** button → paste JSON (or load a file) to continue editing / load
  baked data.
- **Autosave** to `localStorage` keyed by `mapId` every change, so a refresh
  doesn't lose work. Export is the source of truth you send me.

### 7.4 Visualization
- Roads drawn as a semi-transparent colored band over the photo; centerline +
  control points as handles. Nodes as pins with their label and provide/accept
  chips. Toggle overlay opacity to compare against the painted rug roads.

---

## 8. Road containment (off-road policy)

"Cars don't drive where we don't want them to." A car position is **on-road** if
its distance to the nearest spline centerline ≤ that spline's `width/2` (in world
px). Enforcement is a per-map policy so we can tune feel:

- **`block`** (recommended default): if a move would leave the road, project the
  car back to the nearest boundary point — you slide along the edge instead of
  crossing it. Firm but not jarring.
- **`slow`**: grass is drivable but heavily speed-capped (arcade feel; lets you
  cut corners at a cost).
- **`free`**: no containment; roads only matter for autopilot. Useful while
  authoring.

Performance: with a handful of splines, nearest-segment distance each frame is
trivial. If a map ever has many splines, we bucket segments into a coarse grid
and only test nearby ones. (Alternative: bake a low-res road mask bitmap and
sample it — kept as a fallback if per-segment math ever gets hot.)

---

## 9. Autopilot

Follows a target polyline (a single spline, or a routed path from §6).

- **Steering: pure pursuit.** Look ahead a fixed arc-distance along the path to a
  target point; steer toward it by turning at up to the car's `TURN_RATE`. Simple,
  stable, tunable via the look-ahead distance.
- **Speed:** reuse the existing discrete states — `fast` on straights, ease to
  `slow` when the upcoming curvature or a stop (node/endpoint) demands it, `park`
  on arrival. No new physics model needed.
- **Path source:**
  - Simplest first cut: follow one chosen spline end-to-end.
  - Full version: A* route between two nodes → concatenated polyline → pure
    pursuit. This is what a delivery run uses (drive to pickup, then to dropoff).
- **Engage/disengage:** a toggle button + key. Manual steer input disengages
  autopilot (you grab the wheel). Autopilot also naturally parks the car within a
  target node's radius so pickup/dropoff can trigger.
- Autopilot is **client-side** per car; only the resulting position/heading is
  synced in multiplayer, exactly like manual driving today.

---

## 10. Exit car / on-foot mode

A player is either **driving** or **on-foot**.

- **Exit:** when parked, press a button/key → a small avatar spawns beside the
  car; the car stays put (and remains visible/enterable).
- **On-foot movement:** arrow keys move the avatar directly (constant slow walk,
  free 360° movement, no gas/brake). Camera stays north-up while walking
  (rotating-world only makes sense in a car).
- **Enter:** walk within range of a car and press enter to drive it again.
- **Why it exists:** some nodes/buildings sit off the road where a car can't
  reach; you park nearby and walk the last stretch to pick up / drop off. It also
  opens the door to on-foot-only interactions later.
- **Containment on foot:** recommend **free-roam** (walk anywhere on the rug),
  since the whole point is reaching off-road spots. Open question in §15.
- **Multiplayer:** `mode: "drive" | "foot"` goes in the synced state; remote
  players render as a car or an avatar accordingly.

---

## 11. Delivery mission system

The core loop: ferry items between nodes.

### 11.1 Items
Free-form lowercased strings (`bandaids`, `pizza`, `lumber`), optionally dressed
up via the item catalog (§4.4) with an emoji/color.

### 11.2 A mission
```
Mission {
  id, item,
  fromNodeId,   // a node whose `provides` includes item
  toNodeId,     // a different node whose `accepts` matches item (or "*")
  state: "available" | "picked_up" | "delivered" | "expired",
  reward,       // points/currency (scoring TBD, §15)
  expiresAt     // optional
}
```

### 11.3 Lifecycle
1. **Generate:** pick a provider node with item `X`, and a requester node that
   accepts `X`. Create an `available` mission. **Both nodes light up** — the
   source glows "has `X` to deliver", the destination glows "wants `X`".
2. **Pick up:** a player parks within the source node's radius (on-foot or in
   car — TBD, §15) → mission → `picked_up`; the item is now "in the vehicle";
   source stops glowing, destination keeps glowing.
3. **Deliver:** park within the destination node's radius → `delivered`; reward
   granted; destination stops glowing.
4. **Expire** (optional): time out and clear if we add `expiresAt`.

### 11.4 Node lighting
Each node tracks whether it's currently a live mission's source or destination and
renders a glow/pulse + a chip (`🩹 deliver` / `🩹 wanted`). Purely derived from
active missions.

### 11.5 Authority (multiplayer)
Recommended: **server-authoritative missions via PartyKit** so both brothers see
the *same* board and can split deliveries (co-op) or race (competitive). The
PartyKit server owns the mission list, generation timer, and completion; clients
render and send "attempt pickup/dropoff at node N" which the server validates.
- Phase-in: start with **local** missions (single-player, deterministic) to build
  the loop, then move authority to the server. The client mission code barely
  changes — only where the list comes from.

---

## 12. Export / import & the baking workflow

The loop that ties your authoring to the game:

```
You (editor)  ──Export──▶  world JSON (§4)  ──send to me──▶  baked into repo
     ▲                                                              │
     └───────────────── Import (to keep editing) ◀─────────────────┘
```

- **Export**: editor serializes to the §4 document; you copy the text or download
  `city.world.json` and send it over.
- **Bake**: the file lands at `data/<mapId>.world.json` in the repo; each `MAPS`
  entry gets a `world: 'data/city.world.json'` field; the game fetches and loads
  it at map start. (Alternatively inline it into a JS module to avoid an extra
  fetch — decide when we build the loader.)
- **Round-trip**: because export and the baked file are the *same* format,
  Importing a baked file back into the editor lets you keep refining. No lossy
  steps.
- Everything is plain JSON/text as requested — diffable in git, hand-editable in a
  pinch.

---

## 13. Rendering & performance notes

- Flatten splines once at load; cache polylines + arc-length tables (for
  look-ahead and node `t`).
- Normal play: road overlay **off** (the rug shows the road); nodes render as
  subtle markers, glowing only when part of a live mission.
- Debug overlay (key toggle): road bands, centerlines, junction graph, node
  radii — for us while building/authoring.
- All new per-frame work (containment, pure pursuit) is O(nearby segments); fine
  for the map sizes here.

---

## 14. Phased implementation plan

Each phase is shippable on its own.

| Phase | Deliverable | Notes |
|------|-------------|-------|
| **0** | JSON schema + loader + debug overlay | Load a hand-written sample `city.world.json`, draw roads/nodes over the map. Proves the contract. |
| **1** | Editor: splines + width + export/import | The authoring MVP. You can draw the city's roads and send JSON back. |
| **2** | Editor: nodes + labels + provides/accepts | Place "Hospital → bandaids" style nodes; export includes them. |
| **3** | Road containment (`block`/`slow`/`free`) | Cars kept on the road network. |
| **4** | Autopilot v1 (follow one spline, pure pursuit) | First self-driving. |
| **5** | Network graph + A* routing | Autopilot drives node→node over the whole network. |
| **6** | Exit car / on-foot mode | Avatar, enter/exit, synced in MP. |
| **7** | Missions v1 (local, single-player) | Generate, light nodes, pickup/dropoff, reward. |
| **8** | Missions v2 (PartyKit-authoritative, shared) | Both players see the same board. |

Recommended near-term target: **Phases 0–2** (get you authoring the city map and
exporting real data), then **3–4** (containment + first autopilot) since those
were called out as the motivating wins.

---

## 15. Decisions needed

Defaults are my recommendations; flag any you want changed and I'll fold them in
before we build.

1. **Off-road policy** — default `block` (slide along road edge). OK, or do you
   want grass drivable-but-slow?
2. **Pickup/dropoff** — must you be **on foot** at a node, or does **parking the
   car** within radius count? (On-foot is more of a "game"; car-only is faster to
   build.) Default: allow either.
3. **On-foot roaming** — walk anywhere, or keep the avatar near roads/paths?
   Default: walk anywhere.
4. **Mission authority** — build **shared/server-authoritative** from the start,
   or local-first then upgrade? Default: local-first (Phase 7) → shared (Phase 8).
5. **Editor access** — dev-only via `#edit` (recommended), or a button players can
   reach too?
6. **Scoring/rewards** — do deliveries earn points/currency now, or is that a
   later layer? Default: minimal score counter now, economy later.
7. **Baked data delivery** — separate `data/*.json` fetched at runtime
   (git-diffable) vs inlined into JS (one less request). Default: separate file.

---

## 16. Open extensions (not now, but the design leaves room)

- One-way roads / lanes / traffic rules (`oneway` already reserved).
- Multiple item slots / vehicle cargo capacity.
- Timed or chained delivery missions; reputation.
- Fuel / vehicle upgrades tied to delivery earnings.
- Non-player traffic driving the network on autopilot.
