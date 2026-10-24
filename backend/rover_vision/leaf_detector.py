"""Detect leaves with OWL-ViT in an image or a RealSense camera stream.

Install detector dependencies with ``python -m pip install torch transformers
"opencv-python<5"``. Run ``python -m rover_vision.leaf_detector --image
path/to/image.jpg`` or ``python -m rover_vision.leaf_detector``. Coordinates
are pixel positions in the captured frame. ``python -m rover_vision navigate``
combines this with obstacle detection.
"""

import argparse
from concurrent.futures import ThreadPoolExecutor
import sys
from pathlib import Path
from time import perf_counter


MODEL_NAME = "google/owlvit-base-patch32"
TEXT_QUERIES = [
    "a photo of a dead leaf",
    "a photo of a brown leaf",
    "a photo of a dry brown leaf",
    "a photo of fallen brown leaves",
    "a photo of brown leaves scattered on the ground",
    "a photo of a pile of autumn leaves",
]
QUERY_LABELS = ["dead leaf", "brown leaf", "dry leaf", "fallen leaves", "leaves on ground", "leaf pile"]
MAX_DRAWN_DETECTIONS = 20
MAX_CANDIDATES_PER_TILE = 30
NMS_IOU_THRESHOLD = 0.60


def load_detector():
    try:
        import torch
        from transformers import OwlViTForObjectDetection, OwlViTProcessor
    except ImportError as exc:
        raise RuntimeError(
            "Detector dependencies are missing. Install them with: "
            "python -m pip install torch transformers 'opencv-python<5'"
        ) from exc

    # Apple-silicon GPU is ~3x faster than CPU for OWL-ViT with identical scores.
    if torch.cuda.is_available():
        device = "cuda"
    elif torch.backends.mps.is_available():
        device = "mps"
    else:
        device = "cpu"
    print(f"Loading {MODEL_NAME} on {device}...")
    processor = OwlViTProcessor.from_pretrained(MODEL_NAME)
    model = OwlViTForObjectDetection.from_pretrained(MODEL_NAME).to(device)
    model.eval()
    return torch, processor, model, device


def make_tiles(image, grid):
    height, width = image.shape[:2]
    if grid == 1:
        return [(0, 0, width, height)]
    overlap = 0.15
    tile_width = min(width, int(width / (grid - (grid - 1) * overlap) + 0.5))
    tile_height = min(height, int(height / (grid - (grid - 1) * overlap) + 0.5))
    xs = [int(round(i * (width - tile_width) / (grid - 1))) for i in range(grid)]
    ys = [int(round(i * (height - tile_height) / (grid - 1))) for i in range(grid)]
    return [(x, y, min(x + tile_width, width), min(y + tile_height, height)) for y in ys for x in xs]


def box_iou(first, second):
    left = max(first[0], second[0])
    top = max(first[1], second[1])
    right = min(first[2], second[2])
    bottom = min(first[3], second[3])
    intersection = max(0, right - left) * max(0, bottom - top)
    first_area = max(0, first[2] - first[0]) * max(0, first[3] - first[1])
    second_area = max(0, second[2] - second[0]) * max(0, second[3] - second[1])
    union = first_area + second_area - intersection
    return intersection / union if union else 0.0


def detect(image, detector, tile_grid=2):
    torch, processor, model, device = detector
    from PIL import Image
    import cv2

    candidates = []
    for x1, y1, x2, y2 in make_tiles(image, tile_grid):
        crop = image[y1:y2, x1:x2]
        rgb_image = Image.fromarray(cv2.cvtColor(crop, cv2.COLOR_BGR2RGB))
        inputs = processor(text=[TEXT_QUERIES], images=rgb_image, return_tensors="pt")
        inputs = {key: value.to(device) for key, value in inputs.items()}
        with torch.inference_mode():
            outputs = model(**inputs)
        crop_height, crop_width = crop.shape[:2]
        sizes = torch.tensor([[crop_height, crop_width]], device=device)
        # The image processor's method exists in transformers 4 and 5; the
        # processor-level alias was removed in 5.
        result = processor.image_processor.post_process_object_detection(outputs, threshold=0.0, target_sizes=sizes)[0]

        # Retain the strongest candidates from each tile, mapped back to the
        # original camera frame. Weak candidates are useful for the threshold UI.
        order = result["scores"].argsort(descending=True)[:MAX_CANDIDATES_PER_TILE].tolist()
        for index in order:
            score = float(result["scores"][index].item())
            label = int(result["labels"][index].item())
            box = result["boxes"][index].tolist()
            box = [box[0] + x1, box[1] + y1, box[2] + x1, box[3] + y1]
            candidates.append((score, label, box))

    # Adjacent overlapping crops can find the same leaf. Suppress duplicate
    # boxes while preserving distinct, nearby leaves.
    candidates.sort(key=lambda item: item[0], reverse=True)
    kept = []
    for candidate in candidates:
        if any(box_iou(candidate[2], previous[2]) >= NMS_IOU_THRESHOLD for previous in kept):
            continue
        kept.append(candidate)

    return {
        "scores": torch.tensor([item[0] for item in kept]),
        "labels": torch.tensor([item[1] for item in kept], dtype=torch.long),
        "boxes": torch.tensor([item[2] for item in kept], dtype=torch.float32).reshape(-1, 4),
    }


def detection_summary(detections, threshold):
    scores = detections["scores"]
    labels = detections["labels"]
    if len(scores) == 0:
        return "No leaf candidates returned", 0
    best_index = int(scores.argmax().item())
    best_score = float(scores[best_index].item())
    best_label = int(labels[best_index].item())
    best_query = QUERY_LABELS[best_label] if best_label < len(QUERY_LABELS) else TEXT_QUERIES[best_label]
    x1, y1, x2, y2 = [int(value) for value in detections["boxes"][best_index].tolist()]
    center_x, center_y = (x1 + x2) // 2, (y1 + y2) // 2
    count = sum(float(score.item()) >= threshold for score in scores)
    if count:
        return f"Found {count} | best {best_score:.1%} {best_query} at ({center_x},{center_y})", count
    return f"No match >= {threshold:.0%} | best {best_score:.1%} at ({center_x},{center_y})", 0


def draw_status(image, message, color=(255, 255, 255)):
    import cv2

    height, width = image.shape[:2]
    cv2.rectangle(image, (0, 0), (width, 42), (25, 25, 25), -1)
    cv2.putText(image, message[:110], (12, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.65, color, 2, cv2.LINE_AA)
    return image


def draw_detections(image, detections, threshold, depth_frame=None):
    import cv2

    height, width = image.shape[:2]
    order = detections["scores"].argsort(descending=True).tolist()
    drawn = 0
    for index in order:
        score = detections["scores"][index]
        if float(score.item()) < threshold:
            continue
        box = detections["boxes"][index]
        label_id = int(detections["labels"][index].item())
        query = QUERY_LABELS[label_id] if label_id < len(QUERY_LABELS) else TEXT_QUERIES[label_id]
        x1, y1, x2, y2 = [int(value) for value in box.tolist()]
        x1, x2 = max(0, min(x1, width - 1)), max(0, min(x2, width - 1))
        y1, y2 = max(0, min(y1, height - 1)), max(0, min(y2, height - 1))
        center_x, center_y = (x1 + x2) // 2, (y1 + y2) // 2
        caption = f"{query}: {score.item():.1%}"
        if depth_frame is not None:
            distance = depth_frame.get_distance(center_x, center_y)
            caption += f" | Depth: {distance:.2f}m"
        cv2.rectangle(image, (x1, y1), (x2, y2), (0, 255, 0), 2)
        cv2.circle(image, (center_x, center_y), 5, (0, 0, 255), -1)
        label_y = y1 - 10 if y1 > 35 else y1 + 20
        coords_y = min(height - 8, label_y + 18)
        cv2.putText(image, caption, (x1, label_y), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 2)
        cv2.putText(image, f"box ({x1},{y1})-({x2},{y2}) center ({center_x},{center_y})",
                    (x1, coords_y), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (255, 255, 255), 1, cv2.LINE_AA)
        drawn += 1
        if drawn >= MAX_DRAWN_DETECTIONS:
            break

    # Keep the most plausible location visible even when it falls below the
    # acceptance threshold. Yellow and the WEAK label distinguish it from a hit.
    if drawn == 0 and len(order):
        index = order[0]
        score = float(detections["scores"][index].item())
        label_id = int(detections["labels"][index].item())
        query = QUERY_LABELS[label_id] if label_id < len(QUERY_LABELS) else TEXT_QUERIES[label_id]
        x1, y1, x2, y2 = [int(value) for value in detections["boxes"][index].tolist()]
        x1, x2 = max(0, min(x1, width - 1)), max(0, min(x2, width - 1))
        y1, y2 = max(0, min(y1, height - 1)), max(0, min(y2, height - 1))
        center_x, center_y = (x1 + x2) // 2, (y1 + y2) // 2
        color = (0, 215, 255)
        cv2.rectangle(image, (x1, y1), (x2, y2), color, 2)
        cv2.circle(image, (center_x, center_y), 5, color, -1)
        label_y = y1 - 10 if y1 > 35 else y1 + 20
        coords_y = min(height - 8, label_y + 18)
        cv2.putText(image, f"WEAK {query}: {score:.1%} (<{threshold:.0%})",
                    (x1, label_y), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2)
        cv2.putText(image, f"box ({x1},{y1})-({x2},{y2}) center ({center_x},{center_y})",
                    (x1, coords_y), cv2.FONT_HERSHEY_SIMPLEX, 0.42, (255, 255, 255), 1, cv2.LINE_AA)
    return image


def run_image(image_path, detector, threshold, tile_grid):
    try:
        import cv2
    except ImportError as exc:
        raise RuntimeError("OpenCV is missing. Install it with: python -m pip install opencv-python") from exc

    image = cv2.imread(str(image_path))
    if image is None:
        raise RuntimeError(f"Could not read image: {image_path}")
    print("Analyzing image...")
    detections = detect(image, detector, tile_grid)
    summary, count = detection_summary(detections, threshold)
    print(summary)
    print_detections(detections, threshold)
    draw_detections(image, detections, threshold)
    draw_status(image, summary, (80, 255, 80) if count else (0, 210, 255))
    output_path = image_path.with_name(f"{image_path.stem}-detections{image_path.suffix}")
    if not cv2.imwrite(str(output_path), image):
        raise RuntimeError(f"Could not write output image: {output_path}")
    print(f"Saved annotated image to {output_path}")


def print_detections(detections, threshold):
    scores = detections["scores"]
    order = scores.argsort(descending=True).tolist()
    printed = 0
    for index in order:
        score = float(scores[index].item())
        if score < threshold:
            continue
        label = int(detections["labels"][index].item())
        query = QUERY_LABELS[label] if label < len(QUERY_LABELS) else TEXT_QUERIES[label]
        x1, y1, x2, y2 = [int(value) for value in detections["boxes"][index].tolist()]
        center = ((x1 + x2) // 2, (y1 + y2) // 2)
        print(f"  {query}: {score:.1%} | box=({x1},{y1})-({x2},{y2}) | center={center}")
        printed += 1
        if printed >= MAX_DRAWN_DETECTIONS:
            break


def run_camera(detector, threshold, camera_source="auto", max_frames=0, display=True, output_path=None, tile_grid=2):
    try:
        import cv2
        import numpy as np
    except ImportError as exc:
        raise RuntimeError("Live camera mode needs OpenCV. Install it with: python -m pip install opencv-python") from exc

    rs = None
    if camera_source != "webcam":
        try:
            import pyrealsense2 as rs_module
            rs = rs_module
        except ImportError as exc:
            if camera_source == "realsense":
                raise RuntimeError(
                    "RealSense SDK missing. On Apple Silicon macOS, install it with: "
                    "python -m pip install pyrealsense2-macosx"
                ) from exc

    pipeline = None
    started = False
    webcam = None
    use_realsense = False
    try:
        if rs is not None:
            pipeline = rs.pipeline()
            config = rs.config()
            config.enable_stream(rs.stream.depth, 640, 480, rs.format.z16, 30)
            config.enable_stream(rs.stream.color, 640, 480, rs.format.bgr8, 30)
            try:
                pipeline.start(config)
                started = use_realsense = True
                align = rs.align(rs.stream.color)
            except RuntimeError:
                if camera_source == "realsense":
                    raise
                print("No RealSense device found; falling back to the built-in webcam.")

        if not use_realsense:
            webcam = cv2.VideoCapture(0)
            if not webcam.isOpened():
                raise RuntimeError("Could not open webcam 0. Connect a camera or use --camera-source realsense.")
            width = int(webcam.get(cv2.CAP_PROP_FRAME_WIDTH))
            height = int(webcam.get(cv2.CAP_PROP_FRAME_HEIGHT))
            print(f"Webcam resolution: {width}x{height} (native capture)")

        camera_name = "RealSense" if use_realsense else "webcam"
        print(f"Starting {camera_name}. Press 'q' in the preview to quit.")
        print(f"Looking for: {', '.join(TEXT_QUERIES)} | threshold: {threshold:.0%} | crop grid: {tile_grid}x{tile_grid}")
        submitted = completed = 0
        pending = None
        pending_image = pending_depth = None
        pending_started = 0.0
        last_result = None
        last_detections = None
        last_detection_image = last_detection_depth = None
        last_message = "Waiting for camera frame..."
        executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="owlvit")
        try:
            while True:
                if use_realsense:
                    frames = align.process(pipeline.wait_for_frames())
                    depth_frame = frames.get_depth_frame()
                    color_frame = frames.get_color_frame()
                    if not depth_frame or not color_frame:
                        continue
                    image = np.asanyarray(color_frame.get_data())
                else:
                    ok, image = webcam.read()
                    if not ok:
                        raise RuntimeError("Webcam opened but did not return a frame.")
                    depth_frame = None

                if pending is not None and pending.done():
                    detections = pending.result()
                    elapsed = perf_counter() - pending_started
                    last_detections = detections
                    last_detection_image = pending_image.copy()
                    last_detection_depth = pending_depth
                    summary, count = detection_summary(detections, threshold)
                    last_message = f"{summary} | {elapsed:.1f}s | press -/+ for threshold"
                    last_result = draw_detections(pending_image.copy(), detections, threshold, pending_depth)
                    draw_status(last_result, last_message, (80, 255, 80) if count else (0, 210, 255))
                    completed += 1
                    print(f"Frame {completed}: {summary} ({elapsed:.1f}s)")
                    print_detections(detections, threshold)
                    if output_path:
                        if not cv2.imwrite(str(output_path), last_result):
                            raise RuntimeError(f"Could not write output frame to {output_path}")
                        print(f"Saved latest annotated frame to {output_path}")
                    pending = None
                    pending_image = pending_depth = None

                can_submit = max_frames == 0 or submitted < max_frames
                if pending is None and can_submit:
                    pending_image = image.copy()
                    pending_depth = depth_frame
                    submitted += 1
                    pending_started = perf_counter()
                    last_message = f"ANALYZING frame {submitted} | {tile_grid * tile_grid} crops | {detector[3]}"
                    print(f"Computing frame {submitted} across {tile_grid * tile_grid} crops...")
                    pending = executor.submit(detect, pending_image.copy(), detector, tile_grid)

                if pending is not None:
                    preview = image.copy()
                    if last_detections is not None:
                        preview = draw_detections(preview, last_detections, threshold, depth_frame)
                    draw_status(preview, last_message + "...", (0, 220, 255))
                elif last_result is not None:
                    preview = last_result.copy()
                else:
                    preview = image.copy()
                    draw_status(preview, last_message)

                if display:
                    cv2.imshow("Rover VLM Vision", preview)
                    key = cv2.waitKey(1) & 0xFF
                    if key == ord("q"):
                        break
                    if key in (ord("-"), ord("_")):
                        threshold = max(0.0, threshold - 0.02)
                    elif key in (ord("+"), ord("=")):
                        threshold = min(1.0, threshold + 0.02)
                    if key in (ord("-"), ord("_"), ord("+"), ord("=")):
                        print(f"Detection threshold: {threshold:.0%}")
                        if last_detections is not None:
                            summary, count = detection_summary(last_detections, threshold)
                            last_message = f"{summary} | press -/+ to adjust threshold"
                            last_result = draw_detections(last_detection_image.copy(), last_detections, threshold, last_detection_depth)
                            draw_status(last_result, last_message, (80, 255, 80) if count else (0, 210, 255))
                            if output_path and not cv2.imwrite(str(output_path), last_result):
                                raise RuntimeError(f"Could not write output frame to {output_path}")

                if pending is None and max_frames and completed >= max_frames:
                    break
        finally:
            executor.shutdown(wait=True)
    finally:
        if started:
            pipeline.stop()
        if webcam is not None:
            webcam.release()
        if display:
            cv2.destroyAllWindows()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", type=Path, help="detect in an image instead of using a RealSense camera")
    parser.add_argument("--threshold", type=float, default=0.05, help="minimum detection confidence (default: 0.05; raise it to reduce false positives)")
    parser.add_argument("--query", action="append", help="extra search phrase; can be repeated, e.g. --query 'brown leaves in grass'")
    parser.add_argument("--tile-grid", type=int, choices=(1, 2, 3), default=2,
                        help="overlapping crop grid; 2 improves small/distant objects, 3 is slower but more detailed")
    parser.add_argument("--camera-source", choices=("auto", "realsense", "webcam"), default="auto",
                        help="auto prefers RealSense and falls back to webcam (default: auto)")
    parser.add_argument("--max-frames", type=int, default=0, help="stop after this many camera frames; 0 runs until quit")
    parser.add_argument("--no-display", action="store_true", help="process frames without opening a preview window")
    parser.add_argument("--output", type=Path, help="save the final annotated camera frame to this path")
    args = parser.parse_args()
    if not 0 <= args.threshold <= 1:
        parser.error("--threshold must be between 0 and 1")
    if args.max_frames < 0:
        parser.error("--max-frames must be 0 or greater")
    if args.no_display and args.max_frames == 0 and not args.image:
        parser.error("--no-display needs --max-frames so the camera run ends automatically")
    if args.query:
        TEXT_QUERIES.extend(args.query)
    try:
        detector = load_detector()
        if args.image:
            run_image(args.image, detector, args.threshold, args.tile_grid)
        else:
            run_camera(detector, args.threshold, args.camera_source, args.max_frames, not args.no_display,
                       args.output, args.tile_grid)
    except (RuntimeError, OSError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
