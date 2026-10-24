# Backend: rover vision

Perception for the leaf-collecting rover: finding dry leaves, spotting
obstacles, and fusing both into where to drive.

| Piece | What it does | Model |
|---|---|---|
| [`leaf_detector.py`](rover_vision/leaf_detector.py) | Finds dry leaves from text prompts, no training | OWL-ViT (open vocabulary) |
| hazards | Segments what the rover must not drive into: `water`, `rock`, `log`, `tree`, `bush`, `person`, `structure` | YOLOv8-seg trained on RUGD |
| [`navigation.py`](rover_vision/navigation.py) | Fuses leaves + hazards + optional depth into `drive_to_target` / `explore` / `stop` with a steering angle | rules, no model |

## Setup

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
pip install pyrealsense2-macosx        # only if you use a RealSense
```

## Run it

```bash
# Everything together: point the camera ahead and move it around
python -m rover_vision navigate                         # webcam
python -m rover_vision navigate --source realsense      # + depth
python -m rover_vision navigate --source walk.mp4 --save out.mp4
python -m rover_vision navigate --json --no-show        # Pi payload per frame

# Leaves only (your original script)
python -m rover_vision.leaf_detector --image photo.jpg
python -m rover_vision.leaf_detector                    # RealSense, falls back to webcam

# Hazards only
python -m rover_vision detect --source 0
```

## How the two are combined

The view is split into 7 vertical **sectors**, each a steering direction
(about ±35°). A sector turns **red** (blocked) when:

1. **Hazard masks** cover ≥12% of its **near band**, the bottom 40% of the
   image. For a forward-facing camera that's the ground the rover is about
   to drive onto. Hazards further up the image are further away and don't
   block yet.
2. **Depth** (RealSense now, iPhone LiDAR later) shows anything closer than
   0.6 m in the middle rows of the sector, where upright obstacles appear.

The two cover each other's blind spots. Depth catches any obstacle,
including ones the hazard model has never seen. The hazard model catches
what depth can't: water reflects or absorbs the sensor and returns little
or no depth.

Then:

- **`drive_to_target`**: the nearest leaf that isn't inside a hazard or in a
  blocked sector. Nearest means by depth when available, otherwise lowest in
  the image. The angle is the steering angle to it.
- **`explore`**: no reachable leaf, so head for the open sector closest to
  straight ahead.
- **`stop`**: every sector is blocked.

The orange arrow is heading to a leaf, the white arrow is exploring, and
the bar along the bottom shows blocked (red, with the reason) and open
(green) sectors. `--json` prints what goes to the Pi:

```json
{"action": "drive_to_target", "angle_deg": -12.4, "target": "dry leaf",
 "target_px": [412, 388], "distance_cm": 118,
 "blocked": [{"angle_deg": 30.5, "by": "water"}]}
```

Tuning lives in `NavConfig` (`--sectors`, `--hfov`, `--stop-distance` on
the CLI). Set `--hfov` to your camera's horizontal field of view: D435
colour is about 69°, iPhone wide is about 70°.

**Timing.** The hazard model runs every frame (~30 ms). OWL-ViT takes about
1.5 s per frame on the M4 GPU, so it runs in the background on the newest
frame and its result is reused until the next one lands. Obstacle
avoidance is real-time; leaf boxes lag by a second or so.

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
  navigation.py     sectors, blocking, decision, overlay
  navigate.py       live loop (camera → hazards + leaves → decision)
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
- The bands assume a roughly level, forward-facing camera. If you mount
  it tilted down, raise `near_band` / `depth_band` in `NavConfig`.
- OWL-ViT scores are low in absolute terms. The default threshold of 0.05
  matches `leaf_detector.py`; raise it if it fires on bark or soil.
