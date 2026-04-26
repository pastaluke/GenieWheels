# GenieWheels — Design Document

## Concept

A browser-based 2D top-down driving game using a children's road-map board as the world. Players pick a car style and color, then drive freely around the map. The camera rotates with the car so the car always faces up on screen and the world spins around it.

Hosted on GitHub Pages. No server, no build step — pure HTML/CSS/JS that anyone can open from a URL.

---

## Stack

| Layer | Choice | Reason |
|---|---|---|
| Runtime | Single `index.html` | Zero dependencies, instant load, trivial to host |
| Rendering | HTML5 Canvas 2D | Sufficient for 2D sprites + image background; no framework overhead |
| Hosting | GitHub Pages via Actions | Free, static, shareable URL |
| Assets | 1 JPEG (the board photo) | Already have it; cars drawn procedurally in JS |

No npm, no bundler, no framework. The whole game ships as two files: `index.html` and `map.jpg`.

---

## File Structure

```
GenieWheels/
├── index.html          # everything: HTML + CSS + JS
├── map.jpg             # the road-map board photo (world background)
└── .github/
    └── workflows/
        └── deploy.yml  # GitHub Actions → GitHub Pages
```

---

## Screens

### 1. Setup Screen (HTML overlay)
- Title: **GenieWheels**
- Car picker: 4 canvas thumbnail previews (Classic, Muscle, SUV, Mini)
- Color picker: 10 color swatches
- "Start Driving!" button → transitions to game

### 2. Game Screen
- Full-window `<canvas>` with the world rendering
- HUD overlay (non-canvas HTML) for speed state and controls
- "Menu" button returns to setup

---

## Camera System

The car sits fixed at the canvas center. The world (map image) translates and rotates around it.

```
ctx.translate(canvas.width/2, canvas.height/2)   // anchor to center
ctx.rotate(-carAngle)                             // spin world opposite to car heading
ctx.drawImage(mapImg, -carX, -carY, ...)          // offset by car world position
```

Result: car always faces up on screen; turning left rotates the world clockwise.

The car sprite is drawn after `ctx.restore()` — always at canvas center, always upright.

---

## World & Movement

- **World space**: origin at map image top-left, Y increases downward (canvas convention)
- **Angle convention**: `0` = north (up), positive = clockwise
- **Forward vector**: `dx = sin(angle)`, `dy = -cos(angle)`
- **Map scale**: image drawn at `1.8×` natural size to give room to roam
- **Starting position**: ~47% x, ~83% y of scaled map (near the bottom road)
- **Boundary**: car clamps to map edges (no wrapping)

---

## Speed System

Three discrete states — no analog throttle:

| State | Speed (px/sec) | Indicator |
|---|---|---|
| PARK | 0 | 1 pip lit |
| SLOW | 90 | 2 pips lit |
| FAST | 260 | 3 pips lit |

**Gas** press: PARK → SLOW → FAST (each press steps up once)  
**Brake** press: FAST → SLOW → PARK (each press steps down once)

Turn rate: **130 °/sec**, active at any speed state including PARK (lets you spin in place).

---

## Input

| Action | Keyboard | On-screen button |
|---|---|---|
| Gas | `G` | GAS button (tap = one step up) |
| Brake | `B` | BRAKE button (tap = one step down) |
| Turn left | `ArrowLeft` | ← button (hold) |
| Turn right | `ArrowRight` | → button (hold) |

Turning is hold-to-steer (continuous while key/button held). Gas and Brake are tap-to-change-state.

Touch events (`touchstart`/`touchend`) on the on-screen buttons mirror keyboard hold behavior for the turn buttons.

---

## Car Drawing

Cars are drawn procedurally with Canvas 2D — no image assets. Each is centered at `(0, 0)` facing north (up). Four types:

| ID | Shape character |
|---|---|
| `classic` | Standard sedan — tapered hood, defined cabin, small trunk |
| `muscle` | Wide body, long hood, narrow greenhouse |
| `suv` | Boxy, tall, large windows, chunky wheels |
| `mini` | Short and round, oversized windows, tiny wheels |

All share the same draw signature: `drawCar(ctx, type, color)`.  
Colors are applied as the body fill; windows, lights, and wheels use fixed colors.  
A `colorAdjust(hex, amount)` utility lightens/darkens the hex for body highlights and shadows.

Car preview thumbnails on the setup screen are small `<canvas>` elements (~60×90px) rendered once on page load.

---

## HUD

All HUD elements are HTML positioned over the canvas (no canvas re-drawing needed):

- **Speed pips** — 3 small circles, bottom-center; lit count = current speed state
- **State label** — "PARK / SLOW / FAST" text next to pips
- **Controls row** — bottom of screen: `←` `→` on left side, `BRAKE` `GAS` on right side
- **Menu button** — top-right corner

---

## Rendering Loop

```
gameLoop(timestamp):
  dt = clamp(timestamp - lastTime, 0, 100)   // ms, capped to avoid spiral on tab refocus
  lastTime = timestamp

  // physics
  carX += sin(carAngle) * speed * dt/1000
  carY -= cos(carAngle) * speed * dt/1000
  clamp car to map bounds

  if (leftHeld)  carAngle -= turnRate * dt/1000
  if (rightHeld) carAngle += turnRate * dt/1000

  // render
  clear canvas
  ctx.save()
    translate(cx, cy) → rotate(-carAngle) → drawImage(map, -carX, -carY, ...)
  ctx.restore()
  ctx.save()
    translate(cx, cy) → drawCar(ctx, type, color)
  ctx.restore()

  requestAnimationFrame(gameLoop)
```

---

## GitHub Actions Deployment

Trigger: push to `claude/2d-driving-game-PW7QP` (and `main`).  
Method: `actions/upload-pages-artifact` + `actions/deploy-pages`.  
Permissions: `pages: write`, `id-token: write`.  
Result URL: `https://pastaluke.github.io/geniewheels/`

The user needs to enable GitHub Pages in repo Settings → Pages → Source: **GitHub Actions** (one-time manual step).

---

## Out of Scope (for now)

- Multiplayer / real-time sync
- Road collision / stay-on-road enforcement
- Sound effects
- Lap timer or objectives
- Mobile landscape lock
