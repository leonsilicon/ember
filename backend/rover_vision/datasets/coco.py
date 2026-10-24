"""COCO instance segmentation → any task.

Handles polygon and RLE annotations through pycocotools. Used for SimForest
(https://zenodo.org/records/17297743), a synthetic Swedish forest in COCO
format with Rock, tree-trunk and Foliage classes. It also works for any
other COCO export.
"""

from pathlib import Path

from PIL import Image, ImageOps
from pycocotools.coco import COCO

from rover_vision.datasets.yolo import YoloSegWriter, random_split
from rover_vision.geometry import mask_to_polygons
from rover_vision.tasks import TaskSpec

# SimForest category → hazards class. Whole-tree classes (Birch/Pine/Spruce)
# include the canopy; only trunks are collision obstacles at rover height.
SIMFOREST_TO_HAZARD = {
    "Rock": "rock",
    "Birch_Trunk": "tree",
    "Pine_Trunk": "tree",
    "Spruce_Trunk": "tree",
    "Foliage": "bush",
}

PRESETS = {"simforest": SIMFOREST_TO_HAZARD}


def convert(
    annotation_files: list[Path],
    images_dir: Path,
    task: TaskSpec,
    mapping: dict[str, str],
    source: str,
    val_frac: float = 0.15,
    seed: int = 0,
    min_area_frac: float = 0.0002,
):
    """``images_dir`` is joined with each image's ``file_name``.

    Images with no mapped annotations are kept as background examples, which
    teach the model what not to fire on.
    """
    with YoloSegWriter(task, source) as writer:
        for ann_file in annotation_files:
            coco = COCO(str(ann_file))
            cat_to_class = {
                cat["id"]: task.class_id(mapping[cat["name"]])
                for cat in coco.loadCats(coco.getCatIds())
                if cat["name"] in mapping
            }
            missing = set(mapping) - {c["name"] for c in coco.loadCats(coco.getCatIds())}
            if missing:
                print(f"warning: {ann_file.name} has no categories {sorted(missing)}")

            image_ids = sorted(coco.getImgIds())
            for image_id, split in zip(image_ids, random_split(len(image_ids), val_frac, seed)):
                info = coco.loadImgs(image_id)[0]
                path = images_dir / info["file_name"]
                if not path.exists():
                    writer.stats["missing_image"] += 1
                    continue
                instances = []
                for ann in coco.loadAnns(coco.getAnnIds(imgIds=image_id, iscrowd=None)):
                    class_id = cat_to_class.get(ann["category_id"])
                    if class_id is None or not ann.get("segmentation"):
                        continue
                    mask = coco.annToMask(ann).astype(bool)
                    instances += [(class_id, p) for p in mask_to_polygons(mask, min_area_frac=min_area_frac)]
                stem = f"{ann_file.stem}_{Path(info['file_name']).with_suffix('').as_posix().replace('/', '_')}"
                writer.add(ImageOps.exif_transpose(Image.open(path)), instances, split, stem)
    return writer.stats
