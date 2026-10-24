"""Build the app's leaf detector: OWL-ViT as an ExecuTorch program for react-native-executorch.

`bun run build` in this package (or `uv run export.py`) writes two files to dist/:

- owlvit-leaves-<sha256 prefix>.pte, delegated to Core ML (fp16 unless --precision fp32). Its
  signature is the one react-native-executorch's object detector runs any model with:
  forward(f32[1, 3, 768, 768]) -> (boxes f32[576, 4], scores f32[576], classes f32[576]). There
  is one candidate per 32 px patch, its box is xyxy in input pixels, and its class indexes the
  labels in the manifest.
- owlvit-leaves.json, the manifest: the model's file name, labels, preprocessing and thresholds.
  The splat server serves both at /models/, and the app reads the manifest to find the model.

OWL-ViT is open-vocabulary: it scores image patches against text embeddings. The queries below
don't change at runtime, so they are embedded once here and stored in the program. The phone
then runs only the image tower and the box and class heads (no tokenizer, no text tower).

Before writing anything, the build runs the exported program with ExecuTorch's runtime on this
Mac (through Core ML, as on the phone) and checks it against transformers' own OWL-ViT.
"""

import argparse
import hashlib
import json
import sys
from pathlib import Path
from time import perf_counter

import coremltools as ct
import torch
from executorch.backends.apple.coreml.compiler import CoreMLBackend
from executorch.backends.apple.coreml.partition import CoreMLPartitioner
from executorch.exir import to_edge_transform_and_lower
from executorch.runtime import Runtime
from PIL import Image
from transformers import OwlViTForObjectDetection, OwlViTProcessor

SOURCE_MODEL = "google/owlvit-base-patch32"
NAME = "owlvit-leaves"
# The label each query is shown as, and the query itself; from vlm-test.py.
QUERIES = {
    "dead leaf": "a photo of a dead leaf",
    "brown leaf": "a photo of a brown leaf",
    "dry leaf": "a photo of a dry brown leaf",
    "fallen leaves": "a photo of fallen brown leaves",
    "leaves on ground": "a photo of brown leaves scattered on the ground",
    "leaf pile": "a photo of a pile of autumn leaves",
}
# vlm-test.py's default. OWL-ViT's sigmoid scores run low, and lower still through the phone's
# camera: a leaf photo filling a quarter of the frame scored 4–7% ("leaf pile").
CONFIDENCE_THRESHOLD = 0.05
# vlm-test.py's NMS_IOU_THRESHOLD.
IOU_THRESHOLD = 0.6
# How far the exported program may drift from transformers: (max box error in input pixels, max
# score error). fp16, which the Neural Engine runs, moves the boxes of candidates nobody would
# show by tens of pixels, so boxes and classes are only compared where the score is >= 1%.
PRECISIONS = {
    "fp16": (ct.precision.FLOAT16, (16, 0.01)),
    "fp32": (ct.precision.FLOAT32, (0.5, 1e-4)),
}
CHECKED_SCORE = 0.01

PACKAGE_DIR = Path(__file__).resolve().parent
FIXTURE = PACKAGE_DIR / "fixtures" / "leaves.jpg"


class LeafDetector(torch.nn.Module):
    """OWL-ViT's image side and heads, scoring patches against fixed query embeddings."""

    def __init__(self, owl: OwlViTForObjectDetection, query_embeds: torch.Tensor):
        super().__init__()
        self.owl = owl
        self.input_size = owl.config.vision_config.image_size
        # The class head normalizes the queries on every call; they're constant, so do it once.
        queries = query_embeds / (torch.linalg.norm(query_embeds, dim=-1, keepdim=True) + 1e-6)
        self.register_buffer("queries", queries.T.contiguous())

    def classify(self, image_feats: torch.Tensor):
        """OwlViTClassPredictionHead, with a matmul for its einsum, which Core ML can't convert."""
        head = self.owl.class_head
        class_embeds = head.dense0(image_feats)
        class_embeds = class_embeds / (torch.linalg.norm(class_embeds, dim=-1, keepdim=True) + 1e-6)
        logits = class_embeds @ self.queries
        return (logits + head.logit_shift(image_feats)) * (head.elu(head.logit_scale(image_feats)) + 1)

    def forward(self, pixel_values: torch.Tensor):
        # Mirrors OwlViTForObjectDetection.forward minus the text tower.
        feature_map = self.owl.image_embedder(pixel_values=pixel_values)[0]
        batch, height, width, hidden = feature_map.shape
        image_feats = feature_map.reshape(batch, height * width, hidden)
        logits = self.classify(image_feats)
        cx, cy, w, h = (self.owl.box_predictor(image_feats, feature_map)[0] * self.input_size).unbind(-1)
        boxes = torch.stack([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], dim=-1)
        scores, classes = logits[0].sigmoid().max(dim=-1)
        return boxes.clamp(0, self.input_size), scores, classes.float()


def load_reference(image_path: Path):
    """transformers' OWL-ViT and processor, the processed image, and OWL-ViT's predictions for it."""
    processor = OwlViTProcessor.from_pretrained(SOURCE_MODEL)
    owl = OwlViTForObjectDetection.from_pretrained(SOURCE_MODEL).eval()
    image = Image.open(image_path).convert("RGB")
    inputs = processor(text=[list(QUERIES.values())], images=image, return_tensors="pt")
    with torch.inference_mode():
        outputs = owl(**inputs)
    return owl, processor, inputs["pixel_values"], outputs


def check(name: str, actual, expected, tolerance: tuple[float, float]):
    """Fails the build if a candidate's box or score drifts further than `tolerance` allows."""
    boxes_a, scores_a, classes_a = actual
    boxes_e, scores_e, classes_e = expected
    checked = scores_e >= CHECKED_SCORE
    box_error = (boxes_a - boxes_e)[checked].abs().max().item()
    score_error = (scores_a - scores_e).abs().max().item()
    # Synonymous queries score almost alike, so a few near-ties may flip.
    class_flips = (classes_a[checked] != classes_e[checked]).sum().item()
    print(f"  {name}: max box error {box_error:.2f} px and {class_flips}/{checked.sum().item()} classes "
          f"differ where the score is >= {CHECKED_SCORE:.0%}; max score error {score_error:.4f}")
    if box_error > tolerance[0] or score_error > tolerance[1] or class_flips > checked.sum().item() // 10:
        sys.exit(f"{name} doesn't match transformers' OWL-ViT; not writing the model.")


def describe(outputs, labels, limit=8):
    boxes, scores, classes = outputs
    order = scores.argsort(descending=True)[:limit]
    for index in order.tolist():
        x1, y1, x2, y2 = (round(v) for v in boxes[index].tolist())
        print(f"    {labels[int(classes[index])]:>16} {scores[index]:.1%}  ({x1},{y1})-({x2},{y2})")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, default=PACKAGE_DIR / "dist", help="output directory (default: dist/)")
    parser.add_argument("--image", type=Path, default=FIXTURE, help="image to check the export on")
    parser.add_argument("--precision", choices=PRECISIONS, default="fp16",
                        help="Core ML compute precision: fp16 runs on the Neural Engine (default: fp16)")
    args = parser.parse_args()
    labels = list(QUERIES)

    print(f"Loading {SOURCE_MODEL}...")
    owl, processor, pixel_values, reference = load_reference(args.image)
    input_size = owl.config.vision_config.image_size
    detector = LeafDetector(owl, reference.text_embeds[0]).eval()

    # transformers' predictions in the detector's output format.
    cx, cy, w, h = (reference.pred_boxes[0] * input_size).unbind(-1)
    expected_boxes = torch.stack([cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2], dim=-1).clamp(0, input_size)
    expected_scores, expected_classes = reference.logits[0].sigmoid().max(dim=-1)
    expected = (expected_boxes, expected_scores, expected_classes.float())

    print(f"Checking the detector against transformers on {args.image.name}:")
    with torch.inference_mode():
        eager = detector(pixel_values)
    check("PyTorch", eager, expected, (0.01, 1e-5))
    describe(eager, labels)

    precision, tolerance = PRECISIONS[args.precision]
    print(f"Exporting to ExecuTorch (Core ML, {args.precision})...")
    exported = torch.export.export(detector, (torch.zeros(1, 3, input_size, input_size),))
    compile_specs = CoreMLBackend.generate_compile_specs(
        compute_precision=precision,
        minimum_deployment_target=ct.target.iOS18,
    )
    # The whole graph has to run in Core ML: the app's ExecuTorch links only a few CPU kernels.
    partitioner = CoreMLPartitioner(compile_specs=compile_specs, lower_full_graph=True)
    program = to_edge_transform_and_lower(exported, partitioner=[partitioner]).to_executorch()

    print("Running the exported program with ExecuTorch's runtime:")
    method = Runtime.get().load_program(program.buffer).load_method("forward")
    method.execute([pixel_values])  # The first run compiles the Core ML model.
    start = perf_counter()
    lowered = tuple(method.execute([pixel_values]))
    print(f"  {(perf_counter() - start) * 1000:.0f} ms on this Mac")
    check("ExecuTorch", lowered, expected, tolerance)
    describe(lowered, labels)

    # The app caches models by URL, so each build gets a file name of its own.
    sha256 = hashlib.sha256(program.buffer).hexdigest()
    args.out.mkdir(parents=True, exist_ok=True)
    for previous in args.out.glob(f"{NAME}-*.pte"):
        previous.unlink()
    model_path = args.out / f"{NAME}-{sha256[:12]}.pte"
    model_path.write_bytes(program.buffer)
    manifest = {
        "model": model_path.name,
        "sha256": sha256,
        "source": SOURCE_MODEL,
        "precision": args.precision,
        "inputSize": input_size,
        "candidates": int(expected_scores.numel()),
        "labels": labels,
        "queries": list(QUERIES.values()),
        # CLIP's normalization (OwlViTProcessor), after stretching the image to inputSize².
        "mean": list(processor.image_processor.image_mean),
        "std": list(processor.image_processor.image_std),
        "confidenceThreshold": CONFIDENCE_THRESHOLD,
        "iouThreshold": IOU_THRESHOLD,
    }
    (args.out / f"{NAME}.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Wrote {model_path} ({len(program.buffer) / 1e6:.0f} MB) and {NAME}.json")


if __name__ == "__main__":
    main()
