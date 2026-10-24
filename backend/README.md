# Backend: rover vision

Perception for the leaf-collecting rover on the Mac: the OWL-ViT leaf
detector, a trained **hazard** model, and a service that turns a camera frame
(+ LiDAR depth) into what the rover needs, in metres. The iPhone app does
the same leaf/obstacle work on-device (`apps/soon2026/src/lib/rover-brain`).
This service adds the hazard model (water above all, which LiDAR can't see),
and the Mac tools are for testing with a webcam, RealSense or video.

| Piece | What it does |
|---|---|
| [`leaf_detector.py`](rover_vision/leaf_detector.py) | OWL-ViT dry-leaf detection from text prompts (no training) |
| hazards | YOLOv8-seg trained on RUGD: `water`, `rock`, `log`, `tree`, `bush`, `person`, `structure` |
| [`perception.py`](rover_vision/perception.py) | frame → leaves and hazards in metres, top-down occupancy grid, corridors, suggestion (`rover-perception/1` JSON) |
| [`server.py`](rover_vision/server.py) | HTTP API taking the app's own keyframe message |

## Setup

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
pip install pyrealsense2-macosx        # only if you use a RealSense
```

## Run it

```bash
# Service for the phone app (POST /v1/perceive)
python -m rover_vision serve                              # http://0.0.0.0:8765
python -m rover_vision serve --no-leaf-detector           # the phone sends its own leaf boxes

# Live view on the Mac: camera view + top-down minimap
python -m rover_vision navigate                           # webcam (intrinsics from --hfov)
python -m rover_vision navigate --source realsense        # calibrated, with depth
python -m rover_vision navigate --source walk.mp4 --save out.mp4 --pitch 20 --camera-height 0.3
python -m rover_vision navigate --json --no-show          # rover-perception/1 per frame

# Pieces on their own
python -m rover_vision.leaf_detector --image photo.jpg
python -m rover_vision detect --source 0                  # hazards only
```

## How it works

Everything metric is in the **rover frame**: origin on the ground below the
camera, `x` right, `y` up, `z` forward, and `bearing_deg = atan2(x, z)` (+ is
right). Which way is up comes from the ARKit pose when the frame has one,
otherwise from the mount (`--pitch`, `--roll`). The camera height comes from
`--camera-height`, or is fitted from depth (the most common level below the
camera that stretches away from it), or defaults to 0.30 m.

1. **Leaves.** Box centre → LiDAR depth there, or the ray onto the floor.
   Gives position, distance and bearing.
2. **Hazards.** Upright things (rocks, trees…) are placed by where their mask
   meets the ground. Water is flat, so every pixel of its mask is ray-cast
   onto the ground (LiDAR on water is missing or mirrors the sky).
3. **Grid.** A 4 × 5 m top-down map in 10 cm cells: `free`, `obstacle` (taller
   than `--max-step`), `drop`, a hazard class, or `unknown`.
4. **Corridors.** For each bearing from −45° to +45°, how far a
   `--rover-width` strip is clear. A leaf is `reachable` if its corridor is
   clear up to it and it isn't inside a hazard.
5. **Suggestion.** `drive_to_leaf` (nearest reachable), `explore` (straightest
   open corridor), or `stop`.

The detectors see the image upright (it's turned using the pose), so a
sideways phone still works.

## The service

`POST /v1/perceive` takes exactly the message the app's `LiveStreamer`
sends to the splat server: `u32 header length | JSON header | JPEG | float32
depth | uint8 confidence`. The header has `intrinsics`, `jpegBytes`, `pose`
and `depth`, with these optional extras:

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
  "schema": "rover-perception/1",
  "camera": {"height_m": 0.31, "height_source": "depth_fit", "pitch_deg": 18.2, "roll_deg": 0.4},
  "leaves": [{"label": "dry leaf", "score": 0.21, "box_px": [..], "point_px": [..],
              "position": {"x_m": 0.42, "y_m": 0.0, "z_m": 1.37, "distance_m": 1.43,
                           "bearing_deg": 17.0, "source": "depth"},
              "reachable": true, "blocked_by": null}],
  "hazards": [{"label": "water", "score": 0.7, "contact": {"distance_m": 2.1, "bearing_deg": -20.5, ...}}],
  "corridors": [{"bearing_deg": 0.0, "clearance_m": 2.3, "blocked_by": "rock", "observed_m": 4.8}],
  "grid": {"resolution_m": 0.1, "rows": 50, "cols": 40, "codes_b64": "...", "legend": {"0": "unknown", ...}},
  "suggestion": {"action": "drive_to_leaf", "bearing_deg": 17.0, "distance_m": 1.43, "leaf_index": 0}
}
```

`POST /v1/perceive/annotated` returns the overlay as a JPEG, and
`GET /v1/health` reports which models are loaded.

**Timing.** Hazards take about 75 ms per frame on the M4 CPU at 512 px.
OWL-ViT takes about 1.5 s on the GPU with 2×2 tiles. PyTorch's Apple-GPU
backend can't run two models at once from different threads, so the hazard
model goes on the CPU whenever OWL-ViT uses the GPU (`models.py`). The
service handles one frame at a time.

## Training the hazards model

```bash
python -m rover_vision prepare rugd               # data/raw/rugd → data/yolo/hazards
python -m rover_vision train hazards --epochs 30 --imgsz 512
python -m rover_vision train hazards --resume     # continue an interrupted run
python -m rover_vision export hazards             # CoreML for the iPhone
```

Get RUGD (~6 GB, research licence) from the
[HF mirror](https://huggingface.co/datasets/WilliamBonilla62/RUGD):

```bash
python -c "from huggingface_hub import snapshot_download as d; d('WilliamBonilla62/RUGD', repo_type='dataset', local_dir='data/raw/rugd', allow_patterns=['RUGD_annotations/*','RUGD_frames-with-annotations/*','RUGD_annotation-colormap.txt'])"
```

Other sources stack into the same training set:
`prepare coco --preset simforest` for SimForest (synthetic, ~112 GB, no
water), or `prepare yolo` for any YOLO-seg export or your own labelled
frames. An M4 takes 15+ minutes per epoch; a Colab T4 is several times faster.

## Layout

```
rover_vision/
  leaf_detector.py  OWL-ViT leaf detection (standalone script too)
  leaves.py         its output → Detection records
  spatial.py        camera geometry in the rover frame (pose/mount, rays, depth)
  occupancy.py      top-down grid and corridors
  perception.py     the pipeline and rover-perception/1 JSON
  protocol.py       decodes the app's keyframe message
  server.py         FastAPI service
  navigation.py     suggestion + drawing (minimap)
  navigate.py       live loop on webcam / video / RealSense
  models.py         loading models on compatible devices
  camera.py         webcam / video / image / RealSense-with-depth
  tasks.py          hazard classes (single source of truth)
  detection.py      model output → Detection records
  geometry.py       mask/polygon helpers
  render.py         drawing
  detect.py         hazards-only live/batch inference
  train.py, export.py
  datasets/         RUGD, COCO, YOLO-seg converters
tests/              pytest -q
archive/            earlier trained leaf-model experiments (gitignored)
```

## Limits worth knowing

- The hazard model was trained on daytime RUGD footage from the eastern
  US, so expect misses at night and on unfamiliar terrain. Depth is the
  safety net.
- Without depth, positions come from the ray onto flat ground, so they are
  only as good as `--pitch` and `--camera-height` (or the ARKit pose) and
  the ground being flat.
- OWL-ViT scores are low in absolute terms. The default threshold of 0.05
  matches `leaf_detector.py`; raise it if it fires on bark or soil.
