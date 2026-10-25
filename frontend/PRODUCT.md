# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The Ember build team, operating on laptops: driving the rover, running the autopilot simulator, capturing scenes. The same screens double as the live demo for judges and investors watching over the team's shoulder, so they must read at a glance to someone who has never seen them.

## Product Purpose

Ember is an autonomous wildfire-prevention rover that finds dry leaves and pine needles on the ground and collects them, breaking up the fuel that lets small ignitions grow into wildfires. An iPhone rides on the rover as its brain (camera, LiDAR, AR tracking, on-device leaf detection) and drives an ESP32 motor board.

The web app's rover pages are:

- `/sim`: the autopilot simulator. The rover's real brain (`rover-brain`, the same code the phone runs) clears a work circle round a pile on a virtual lawn, shown in 3D and as a top-down map.
- `/control`: the laptop remote. Drive (D-pad / WASD, stop), run the arm sequence, connect to the rover over WebSocket (or a simulated client), view a Gaussian splat scene, and capture frames from the rover's iPhone or the laptop webcam.

Success: the team can operate confidently, and a first-time viewer understands what the rover is doing within seconds.

## Positioning

Ember clears a firebreak: a cleared strip of ground round a home. The logo's flame is cut by a horizontal gap that is that cleared strip.

## Operating Context

Laptops, indoors and at demos, sometimes outdoors near the rover. Keyboard driving (WASD / arrows, Space/Esc to stop). Simulated and live modes must never be confused.

## Capabilities and Constraints

- Next.js 16 app, Tailwind 4, client-only rover pages (WebGL, WebSockets, File System Access API).
- The wildfire map (`/wildfire`) keeps its own Blueprint console; only the shared top bar is common.
- Terminology: work circle, pile, bin, leaves per trip, harsh sensors, seed, simulated / live.

## Brand Commitments

- Name: Ember. Assets in `assets/`: `ember-mark.svg` (flame with firebreak), `ember-logo.svg` (mark + wide-tracked EMBER wordmark), `ember-icon.svg`.
- Ember orange `#E8501F`; wordmark ink `#1C1917`; wordmark in a neo-grotesque (Helvetica Neue), weight 500, wide letter-spacing.
- The user asked for a clean, simple, minimal operator dashboard inspired by the logo, with production-grade features such as collapsible panels.

## Evidence on Hand

Logo assets above. No customer, metrics, or deployment claims exist; do not invent them.

## Product Principles

1. State before decoration: what the rover is doing is always the loudest thing on screen.
2. Simulated is never mistaken for live.
3. Readable by a stranger in one glance, operable by the team without the mouse.
4. Stop is always one key and one click away.

## Accessibility & Inclusion

Keyboard operable throughout; visible focus; colour is never the only carrier of state.
