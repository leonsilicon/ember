# Backend: rover vision on the Mac

The rover's brain runs on the iPhone (`apps/soon2026/src/lib/rover-brain`).
This folder is its Mac-side twin, for testing without a phone and for anything
too heavy for the phone:

| Piece | What it does |
|---|---|
| [`leaf_detector.py`](rover_vision/leaf_detector.py) | OWL-ViT dry-leaf detection from text prompts (no training). Runs standalone too. |
| [`perception.py`](rover_vision/perception.py) | Frame + depth → leaves in metres (checked by depth: on the ground? leaf-sized?), a top-down occupancy map, corridors, and a suggested move. Same rules as the app. |
| [`server.py`](rover_vision/server.py) | HTTP API that takes the app's own keyframe message |
| [`navigate.py`](rover_vision/navigate.py) | Live view on a webcam, video, photo or RealSense (with depth) |

Obstacles come from **depth** (LiDAR or RealSense), as on the phone. The
earlier trained hazard model is in `archive/hazard-model/` (gitignored). It
scored 0.47 on trees but 0.05 on water and 0.00 on rocks, so LiDAR replaced it.

## Setup

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
pip install pyrealsense2-macosx        # only if you use a RealSense
```

## Run it

```bash
# Live view: leaf boxes with distance and bearing, plus a top-down minimap
python -m rover_vision navigate                           # webcam (no depth: floor-plane distances)
python -m rover_vision navigate --source realsense        # calibrated, with depth obstacles
python -m rover_vision navigate --source photo.jpg --pitch 25 --camera-height 0.3
python -m rover_vision navigate --json --no-show          # rover-perception/2 per frame

# Service for the phone app
python -m rover_vision serve                              # http://0.0.0.0:8765
python -m rover_vision serve --no-leaf-detector           # the phone sends its own leaf boxes

# Just the detector (writes photo-detections.jpg)
python -m rover_vision.leaf_detector --image photo.jpg
```

Without depth or an ARKit pose, distances come from the ray onto flat
ground, so set `--pitch` (degrees below horizontal) and `--camera-height`
(metres) to match how the camera is held.

## How it works

Everything metric is in the **rover frame**: origin on the ground below the
camera, `x` right, `y` up, `z` forward, and `bearing_deg = atan2(x, z)` (+ is
right). Which way is up comes from the ARKit pose when there is one, or from
`--pitch`/`--roll`. The camera height is fitted from depth (the most common
level below the camera that stretches away from it) unless given.

1. **Leaves.** Depth is sampled on a grid over the middle of each box, using
   the median. Without depth, the box centre's ray is intersected with the
   floor.
2. **Depth checks.** A detection is rejected when it's more than 25 cm off the
   ground (bark, fences, furniture), more than 1.5 m across (a hillside) or
   under 2 cm, or more than 8 m away. Rejected boxes are drawn grey with the
   reason.
3. **Grid.** A 4 × 5 m top-down map in 10 cm cells: `free`, `obstacle`
   (taller than `--max-step`, 8 cm), `drop` (more than 10 cm below the floor),
   or `unknown`.
4. **Corridors.** For each bearing from −45° to +45°, how far a
   `--rover-width` strip is clear. A leaf is reachable if its corridor is
   clear up to it.
5. **Suggestion.** `drive_to_leaf` (the nearest reachable leaf), `explore` (the
   straightest open corridor), or `stop`.

The detector sees the image upright, turned using the pose, so a sideways
phone still works. OWL-ViT also does better on a ~640 px frame than at full
camera resolution, so `LeafDetector` scales frames down first.

## The service

`POST /v1/perceive` takes the message the app's `LiveStreamer` sends to the
splat server: `u32 header length | JSON header | JPEG | float32 depth | uint8
confidence`. The header has `intrinsics`, `jpegBytes`, `pose` and `depth`,
with these optional extras:

```json
{
  "leaves": [{"box": [x1, y1, x2, y2], "score": 0.12, "label": "dry leaf"}],
  "leavesFrame": {"width": 576, "height": 768, "turns": 3},
  "cameraHeightM": 0.3
}
```

`leaves` skips the server's own OWL-ViT run. `leavesFrame` says the boxes are
in the app's upright detection frame: the JPEG rotated `turns` quarter turns
counter-clockwise and scaled to that size. `turns: 3` is the app's
`.oriented(.right)`.

Response (`?grid=0` leaves out the grid):

```json
{
  "schema": "rover-perception/2",
  "camera": {"height_m": 0.31, "height_source": "depth_fit", "pitch_deg": 18.2, "roll_deg": 0.4},
  "leaves": [{"label": "dry leaf", "score": 0.21, "box_px": [..], "point_px": [..], "size_m": 0.12,
              "position": {"x_m": 0.42, "y_m": 0.0, "z_m": 1.37, "distance_m": 1.43,
                           "bearing_deg": 17.0, "source": "depth"},
              "reachable": true, "blocked_by": null}],
  "rejected": [{"box_px": [..], "reason": "off_ground", "position": {..}}],
  "corridors": [{"bearing_deg": 0.0, "clearance_m": 2.3, "blocked_by": "obstacle", "observed_m": 4.8}],
  "grid": {"resolution_m": 0.1, "rows": 50, "cols": 40, "codes_b64": "...",
           "legend": {"0": "unknown", "1": "free", "2": "obstacle", "3": "drop"}},
  "suggestion": {"action": "drive_to_leaf", "bearing_deg": 17.0, "distance_m": 1.43, "leaf_index": 0}
}
```

`POST /v1/perceive/annotated` returns the overlay as a JPEG, and
`GET /v1/health` says whether the leaf detector is loaded.

**Timing.** OWL-ViT takes about 1.5 s per frame on the M4 GPU with 2×2
tiles. In `navigate` it runs in the background and its latest boxes are
reused, while depth and geometry run every frame. The service handles one
frame at a time: PyTorch's Apple-GPU backend crashes if two threads use it
at once.

## Layout

```
rover_vision/
  leaf_detector.py  OWL-ViT leaf detection (standalone script too)
  leaves.py         detector → Detection records (downscales to ~640 px first)
  perception.py     the pipeline, depth checks, rover-perception/2 JSON
  spatial.py        camera geometry in the rover frame (pose/mount, rays, depth)
  occupancy.py      top-down grid and corridors
  navigation.py     suggestion + drawing (minimap)
  protocol.py       decodes the app's keyframe message
  server.py         FastAPI service
  navigate.py       live loop
  camera.py         webcam / video / image / RealSense-with-depth
  detection.py      the Detection record
  render.py         drawing boxes
tests/              pytest -q (synthetic scenes with known geometry)
archive/            earlier experiments: trained leaf model, hazard model (gitignored)
```
