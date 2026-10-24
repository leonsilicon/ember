import json

import numpy as np
import pytest
import yaml
from PIL import Image

from rover_vision.datasets import coco, rugd, yolo_merge
from rover_vision.datasets.yolo import YoloSegWriter, group_split, parse_class_mapping, random_split
from rover_vision.tasks import HAZARDS, TaskSpec
from tests.conftest import TOY


@pytest.fixture
def redirect_task(tmp_path, monkeypatch):
    """Point a task's dataset_dir into tmp_path so tests never touch data/."""

    def _redirect(task: TaskSpec):
        monkeypatch.setattr(TaskSpec, "dataset_dir", property(lambda self: tmp_path / "yolo" / self.name))
        return tmp_path / "yolo" / task.name

    return _redirect


def read_labels(root, split):
    return {p.stem: p.read_text().split("\n") for p in sorted((root / "labels" / split).glob("*.txt"))}


# --- splits and mapping ------------------------------------------------------


def test_random_split_is_deterministic_and_sized():
    a, b = random_split(20, 0.25, seed=1), random_split(20, 0.25, seed=1)
    assert a == b and a.count("val") == 5


def test_group_split_holds_out_whole_groups_and_keeps_one_for_training():
    sizes = {"a": 10, "b": 10, "c": 10, "d": 10}
    val = group_split(sizes, 0.2, seed=0)
    assert 1 <= len(val) < len(sizes)
    assert group_split({"only": 5}, 0.5, seed=0) == set()


def test_parse_class_mapping_validates_targets():
    assert parse_class_mapping("leaf=dead_leaf, grass = green_plant", TOY) == {
        "leaf": "dead_leaf",
        "grass": "green_plant",
    }
    with pytest.raises(KeyError):
        parse_class_mapping("leaf=not_a_class", TOY)
    with pytest.raises(ValueError):
        parse_class_mapping("leaf", TOY)


# --- writer -------------------------------------------------------------------


def test_writer_outputs_layout_yaml_and_replaces_only_its_source(redirect_task):
    root = redirect_task(TOY)
    tri = np.array([[0.1, 0.1], [0.9, 0.1], [0.5, 0.9]])
    image = Image.new("RGB", (3000, 1500))

    with YoloSegWriter(TOY, "other") as w:
        w.add(image, [(2, tri)], "train", "keep")
    with YoloSegWriter(TOY, "src") as w:
        w.add(image, [(0, tri)], "train", "old")
    with YoloSegWriter(TOY, "src") as w:  # re-run: "old" must disappear
        w.add(image, [(0, tri), (1, tri)], "val", "new")
        w.add(image, [], "train", "empty")

    assert sorted(p.name for p in (root / "images" / "train").iterdir()) == ["other__keep.jpg", "src__empty.jpg"]
    assert max(Image.open(root / "images" / "val" / "src__new.jpg").size) == 1280
    assert read_labels(root, "val")["src__new"][0].startswith("0 0.10000 0.10000")
    assert read_labels(root, "train")["src__empty"] == [""]
    assert w.stats["instances"] == 2 and w.stats["background"] == 1 and w.stats["dead_leaf"] == 1

    data = yaml.safe_load((root / "data.yaml").read_text())
    assert data["names"] == dict(enumerate(TOY.names))
    assert data["path"] == str(root.resolve())


# --- converters ---------------------------------------------------------------


def test_rugd_decode_merges_rock_and_rockbed_and_ignores_drivable():
    colormap = {"rock": (153, 204, 255), "rock-bed": (102, 102, 0), "grass": (0, 102, 0), "water": (0, 128, 255)}
    ann = np.zeros((10, 10, 3), np.uint8)
    ann[:5] = colormap["rock"]
    ann[5:] = colormap["rock-bed"]
    ann[0, 0] = colormap["grass"]
    masks = rugd.decode_annotation(ann, colormap)
    assert set(masks) == {HAZARDS.class_id("rock")}
    assert masks[HAZARDS.class_id("rock")].sum() == 99


def test_rugd_convert_splits_by_scene(tmp_path, redirect_task):
    root = redirect_task(HAZARDS)
    src = tmp_path / "rugd"
    src.mkdir()
    (src / "RUGD_annotation-colormap.txt").write_text("0 void 0 0 0\n6 water 0 128 255\n21 rock 153 204 255\n")
    for scene in ("creek", "trail", "park", "village"):
        for i in range(3):
            for kind in ("RUGD_annotations", "RUGD_frames-with-annotations"):
                (src / kind / scene).mkdir(parents=True, exist_ok=True)
            ann = np.zeros((40, 50, 3), np.uint8)
            ann[20:, :] = (0, 128, 255)  # water band across the bottom
            ann[2:10, 2:10] = (153, 204, 255)  # a rock
            Image.fromarray(ann).save(src / "RUGD_annotations" / scene / f"{scene}_{i:05d}.png")
            Image.new("RGB", (50, 40)).save(src / "RUGD_frames-with-annotations" / scene / f"{scene}_{i:05d}.png")

    stats = rugd.convert(src, stride=1, val_frac=0.25)
    assert stats["water"] == 12 and stats["rock"] == 12

    scenes = {split: {s.split("__")[1].split("_")[0] for s in read_labels(root, split)} for split in ("train", "val")}
    assert scenes["val"] and scenes["train"] and not scenes["val"] & scenes["train"]


def test_coco_convert_maps_categories_and_keeps_background(tmp_path, redirect_task):
    root = redirect_task(HAZARDS)
    images = tmp_path / "images"
    images.mkdir()
    for name in ("a.png", "b.png"):
        Image.new("RGB", (100, 80)).save(images / name)
    ann_file = tmp_path / "instances.json"
    ann_file.write_text(
        json.dumps(
            {
                "images": [
                    {"id": 1, "file_name": "a.png", "width": 100, "height": 80},
                    {"id": 2, "file_name": "b.png", "width": 100, "height": 80},
                ],
                "categories": [{"id": 7, "name": "Rock"}, {"id": 9, "name": "Sky"}],
                "annotations": [
                    {"id": 1, "image_id": 1, "category_id": 7, "iscrowd": 0, "area": 800, "bbox": [10, 10, 40, 20],
                     "segmentation": [[10, 10, 50, 10, 50, 30, 10, 30]]},
                    {"id": 2, "image_id": 1, "category_id": 9, "iscrowd": 0, "area": 800, "bbox": [0, 0, 100, 10],
                     "segmentation": [[0, 0, 100, 0, 100, 10, 0, 10]]},
                ],
            }
        )
    )
    stats = coco.convert([ann_file], images, HAZARDS, coco.SIMFOREST_TO_HAZARD, "sim", val_frac=0.5)
    assert stats["rock"] == 1 and stats["instances"] == 1 and stats["background"] == 1
    labels = {**read_labels(root, "train"), **read_labels(root, "val")}
    assert labels["sim__instances_a"][0].startswith(f"{HAZARDS.class_id('rock')} ")


def test_yolo_merge_remaps_and_drops_unmapped(tmp_path, redirect_task):
    root = redirect_task(TOY)
    src = tmp_path / "roboflow"
    (src / "valid" / "images").mkdir(parents=True)
    (src / "valid" / "labels").mkdir(parents=True)
    (src / "data.yaml").write_text(yaml.safe_dump({"names": ["broadleaf-litter", "conifer-logs", "sky"]}))
    Image.new("RGB", (32, 32)).save(src / "valid" / "images" / "x.jpg")
    (src / "valid" / "labels" / "x.txt").write_text(
        "0 0.1 0.1 0.5 0.1 0.5 0.5\n1 0.2 0.2 0.6 0.2 0.6 0.6\n2 0.1 0.1 0.2 0.1 0.2 0.2\n0 0.5 0.5 0.2 0.2\n"
    )
    stats = yolo_merge.convert(src, TOY, {"broadleaf-litter": "dead_leaf", "conifer-logs": "obstacle"})
    lines = read_labels(root, "val")["roboflow__valid_x"]
    assert [int(l.split()[0]) for l in lines if l] == [TOY.class_id("dead_leaf"), TOY.class_id("obstacle")]
    assert stats["val"] == 1

    with pytest.raises(KeyError):
        yolo_merge.convert(src, TOY, {"nope": "dead_leaf"})


def test_yolo_merge_workspace_layout_identity_mapping_and_unlabelled(tmp_path, redirect_task):
    redirect_task(TOY)
    ws = tmp_path / "my-field"
    (ws / "images").mkdir(parents=True)
    (ws / "labels").mkdir()
    (ws / "classes.txt").write_text("\n".join(TOY.names) + "\n")
    for i in range(6):
        Image.new("RGB", (32, 32)).save(ws / "images" / f"f{i}.jpg")
    for i in range(4):  # f4, f5 not labelled yet
        (ws / "labels" / f"f{i}.txt").write_text("" if i == 3 else "4 0.1 0.1 0.9 0.1 0.5 0.9\n")

    stats = yolo_merge.convert(ws, TOY, val_frac=0.25)
    assert stats["unlabelled"] == 2
    assert stats["train"] + stats["val"] == 4
    assert stats["leaf_pile"] == 3 and stats["background"] == 1
