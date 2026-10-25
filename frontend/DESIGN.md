# Design: Ember pages (`/control`, `/sim`, `/live`, `/view/[id]`)

The world is a **field instrument**: one warm-grey enclosure, off-white module faces separated by gaps (the logo's firebreak), and a single ember orange that means *live* or *the primary action*, nothing else. The wildfire map (`/wildfire`) keeps its own Blueprint console under the shared top bar, and is otherwise not covered here.

## Tokens

Defined in `src/app/(rover)/rover.css` as CSS variables and exposed to Tailwind via `@theme inline` (`bg-panel`, `text-ink-2`, `border-line`, …). Light by default; dark by system preference or the top bar's toggle (`data-theme` on `<html>`, `src/rover/ui/theme.ts`).

| Role | Light | Dark | Use |
|---|---|---|---|
| `enclosure` | `#e9e7e2` | `#11100f` | page ground; shows through as the gaps between modules |
| `panel` | `#f8f7f4` | `#1a1917` | module faces, floating overlays (95% + blur) |
| `well` | `#f0eee9` | `#222120` | inputs, segmented tracks, inset readouts |
| `line` / `line-strong` | `#dcd9d2` / `#c6c2b9` | `#2c2a27` / `#3c3935` | hairlines, hover borders |
| `ink` / `ink-2` / `ink-3` | `#1c1917` / `#57534e` / `#6f6a63` | `#eeece7` / `#b5b0a7` / `#8f8a81` | text: primary, secondary, hints |
| `ember` | `#e8501f` | `#f0602f` | primary button fill (ink text on it), live LEDs, active nav underline, focus ring |
| `ember-ink` | `#b23a10` | `#ff8a5c` | ember as text on panels |
| `ok` / `warn` / `danger` / `info` | | | LED and state colours; `danger` is reserved for Stop and errors |
| `stage` | `#0f0e0d` | `#0b0a09` | behind 3D, splat and camera pictures |
| `--map-*` | | | the top-down map canvas (read per frame by `TopDownView`) |

Simulated mode is always marked with the amber `.hatch` stripe (top bar pill and banner), never colour alone.

## Type

Geist for UI, Geist Mono (`.num`) only for measurements, times, addresses and counts. Module titles: 11px, semibold, uppercase, 0.14em tracking. The EMBER wordmark is set in Helvetica Neue 500 at 0.28em tracking, as in `assets/ember-logo.svg`.

## Components (`src/rover/ui/`)

- `Shell.tsx`: `TopBar` (mark, pages, live status, page actions, panels/shortcuts/theme, who's signed in and Sign out; `account.tsx` carries the login down from the root layout), then the banner slot, stage, rail, dock and shortcuts dialog. A page without a rail (the wildfire console) uses `TopBar` alone. Global keys: `\` panels, `?` shortcuts.
- `layout.tsx`: `Module` (collapse to header; dock to the edge tab strip; stays mounted while docked), `Rail` (resizable 300–560px by drag or arrow keys, double-click resets), `Dock`. State persists per page in `localStorage` (`ember.layout/<page>`). Below 1024px modules stack under the stage and docking is off.
- `kit.tsx`: `Button` (primary / secondary / ghost / danger), `IconButton`, `Segmented`, `Led` (square lamp, always beside a word), `Meter` (segmented cells), `Readout`, `Field`, `Hint`, `Kbd`, `INPUT`, icon set (lucide geometry, 1.75 stroke).

## Composition

The stage owns the screen. Floating overlays on it (status readout top-left, camera toolbar top-right, transport bottom-centre) use `panel/95`, a hairline and `shadow-float`. Radii: 10px modules and overlays, 6px controls, 2px LEDs. Motion: 150–200ms colour and height transitions only; LEDs blink in steps; all of it is off under reduced motion.

## Stages

- `/control`, live mode: `LiveMapView`, the rover brain's map streamed from the phone (rover-brain `live-map.ts`, map lines on the camera server's `/detections`), drawn like the sim's top view on the `--map-*` tokens; the rover's pose eases between the 5 Hz updates. Simulated mode: the splat viewer (captures or the sample).
- `/sim`: the 3D yard, with the top view as a rail module.
- `/live`: the phone's recording rebuilt on the Mac as it streams (`app/(rover)/live/live-scene.ts`), its readout top-left. The rail has the session's readouts, the view's controls (follow the phone `F`, confidence `C`, point size, PLY download) and the Captures module, which the recording joins once it stops. The app's own view of the same reconstruction (`?embed`) is the scene alone.
- `/view/[id]`: a capture's newest splat snapshot (`splat-scene.ts`, reloaded as training goes), with the capture's readouts and the other captures beside it. Live 3D stays lit in the top bar, since that is where it is reached from.

## Rules

- Ember appears once per region at most. If two things want it, one of them is not primary.
- Stop is always reachable: the Drive module and the top bar's compact Stop.
- Shortcut handlers ignore text fields, modifiers and open dialogs (`isShortcutEvent`).
