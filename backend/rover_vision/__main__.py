"""Command-line entry point: ``python -m rover_vision <command> --help``."""

import argparse
import sys
from pathlib import Path

from rover_vision.tasks import TASKS, get_task


def cmd_tasks(_args):
    for task in TASKS.values():
        status = "trained" if task.best_weights.exists() else "not trained"
        data = "prepared" if task.data_yaml.exists() else "no data"
        print(f"{task.name:8} {task.description}  [{data}, {status}]")
        for i, (name, role) in enumerate(task.classes):
            print(f"    {i}  {name:20} {role.value}")


def cmd_prepare(args):
    if args.source == "rugd":
        from rover_vision.datasets import rugd

        stats = rugd.convert(args.src or rugd.DEFAULT_SRC, args.stride, args.val_frac, args.seed)
    elif args.source == "coco":
        from rover_vision.datasets import coco
        from rover_vision.datasets.yolo import parse_class_mapping

        task = get_task(args.task)
        mapping = coco.PRESETS[args.preset] if args.preset else parse_class_mapping(args.map, task)
        stats = coco.convert(args.annotations, args.images, task, mapping, args.name, args.val_frac, args.seed)
    elif args.source == "yolo":
        from rover_vision.datasets import yolo_merge
        from rover_vision.datasets.yolo import parse_class_mapping

        task = get_task(args.task)
        mapping = parse_class_mapping(args.map, task) if args.map else None
        stats = yolo_merge.convert(args.src, task, mapping, args.name, args.val_frac, args.seed)
    print(dict(stats))


def cmd_train(args):
    from rover_vision.train import train

    best = train(get_task(args.task), args.model, args.epochs, args.imgsz, args.batch, args.device, args.patience, args.resume)
    print(f"Best weights: {best}")


def cmd_detect(args):
    from rover_vision.detect import Detector, run

    tasks = [get_task(t) for t in args.tasks]
    weights = dict(w.split("=", 1) for w in args.weights)
    detector = Detector(tasks, {k: Path(v) for k, v in weights.items()}, args.conf, args.imgsz, args.device)
    run(detector, args.source, args.save, show=not args.no_show, emit_json=args.json)


def cmd_navigate(args):
    from rover_vision.navigate import run
    from rover_vision.navigation import NavConfig

    cfg = NavConfig(sectors=args.sectors, hfov_deg=args.hfov, stop_distance_m=args.stop_distance)
    run(
        args.source,
        use_hazard_model=not args.no_hazard_model,
        hazard_weights=args.hazard_weights,
        hazard_conf=args.hazard_conf,
        hazard_device=args.hazard_device,
        hazard_imgsz=args.hazard_imgsz,
        leaf_threshold=args.leaf_threshold,
        tile_grid=args.tile_grid,
        cfg=cfg,
        show=not args.no_show,
        save=args.save,
        emit_json=args.json,
    )


def cmd_export(args):
    from rover_vision.export import export_coreml

    print(f"CoreML model: {export_coreml(get_task(args.task), args.weights, args.imgsz, not args.fp32)}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m rover_vision", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    task_names = sorted(TASKS)

    sub.add_parser("tasks", help="list tasks, classes and training status").set_defaults(func=cmd_tasks)

    # prepare
    prepare = sub.add_parser("prepare", help="convert a raw dataset into a task's YOLO-seg training set")
    sources = prepare.add_subparsers(dest="source", required=True)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--val-frac", type=float, default=0.15, help="fraction held out for validation")
    common.add_argument("--seed", type=int, default=0)
    rg = sources.add_parser("rugd", parents=[common], help="RUGD off-road → hazards")
    co = sources.add_parser("coco", parents=[common], help="COCO instance seg (e.g. SimForest) → any task")
    yo = sources.add_parser("yolo", parents=[common], help="YOLO-seg export (e.g. Roboflow) → any task")
    rg.add_argument("--src", type=Path)
    rg.add_argument("--stride", type=int, default=2, help="keep every Nth annotated frame")
    co.add_argument("--task", required=True, choices=task_names)
    co.add_argument("--annotations", required=True, type=Path, nargs="+", help="COCO json file(s)")
    co.add_argument("--images", required=True, type=Path, help="folder that file_name entries are relative to")
    co.add_argument("--name", required=True, help="source tag, e.g. simforest")
    mapping = co.add_mutually_exclusive_group(required=True)
    mapping.add_argument("--map", help='"SrcClass=task_class,..."')
    mapping.add_argument("--preset", choices=["simforest"])
    yo.add_argument("--task", required=True, choices=task_names)
    yo.add_argument("--src", required=True, type=Path, help="split export or labelling workspace folder")
    yo.add_argument("--map", help='"src_class=task_class,..." (default: classes with matching names)')
    yo.add_argument("--name", help="source tag (default: folder name)")
    prepare.set_defaults(func=cmd_prepare)

    # train
    train = sub.add_parser("train", help="fine-tune YOLOv8-seg for a task")
    train.add_argument("task", choices=task_names)
    train.add_argument("--model", default="yolov8n-seg.pt", help="base weights: yolov8{n,s,m}-seg.pt")
    train.add_argument("--epochs", type=int, default=100)
    train.add_argument("--imgsz", type=int, default=640)
    train.add_argument("--batch", type=int, default=16)
    train.add_argument("--patience", type=int, default=25, help="early-stop after N epochs without improvement")
    train.add_argument("--device", help="mps, cpu, 0, ... (auto)")
    train.add_argument("--resume", action="store_true", help="continue an interrupted run")
    train.set_defaults(func=cmd_train)

    # detect
    detect = sub.add_parser("detect", help="run models on a camera, video, image or folder")
    detect.add_argument("--tasks", nargs="+", default=task_names, choices=task_names)
    detect.add_argument("--source", default="0", help="camera index, video file, stream URL, image or folder")
    detect.add_argument("--weights", nargs="*", default=[], metavar="TASK=PATH", help="override weights per task")
    detect.add_argument("--conf", type=float, default=0.35)
    detect.add_argument("--imgsz", type=int, default=640)
    detect.add_argument("--device", help="mps, cpu, 0, ... (auto)")
    detect.add_argument("--save", type=Path, help="output video file (streams) or folder (images)")
    detect.add_argument("--no-show", action="store_true", help="don't open a window")
    detect.add_argument("--json", action="store_true", help="print one JSON line of detections per frame")
    detect.set_defaults(func=cmd_detect)

    # navigate
    nav = sub.add_parser("navigate", help="leaves + hazards + depth → where to drive (live)")
    nav.add_argument("--source", default="0", help='"realsense", camera index, video file/URL or image')
    nav.add_argument("--leaf-threshold", type=float, default=0.05, help="OWL-ViT score needed to count as a leaf")
    nav.add_argument("--tile-grid", type=int, choices=(1, 2, 3), default=2, help="OWL-ViT crops per side")
    nav.add_argument("--hazard-conf", type=float, default=0.35)
    nav.add_argument("--hazard-weights", type=Path, help="default: runs/segment/hazards/weights/best.pt")
    nav.add_argument("--hazard-device", help="default: cpu when OWL-ViT uses the Apple GPU (MPS isn't thread-safe)")
    nav.add_argument("--hazard-imgsz", type=int, default=512, help="hazard model input size")
    nav.add_argument("--no-hazard-model", action="store_true", help="depth-only obstacle detection")
    nav.add_argument("--sectors", type=int, default=7, help="steering directions across the view")
    nav.add_argument("--hfov", type=float, default=69.0, help="camera horizontal field of view (deg)")
    nav.add_argument("--stop-distance", type=float, default=0.6, help="metres; closer depth blocks a sector")
    nav.add_argument("--save", type=Path, help="output video (streams) or image (single image)")
    nav.add_argument("--no-show", action="store_true")
    nav.add_argument("--json", action="store_true", help="print the Pi payload as one JSON line per frame")
    nav.set_defaults(func=cmd_navigate)

    # export
    export = sub.add_parser("export", help="export a trained task model to CoreML")
    export.add_argument("task", choices=task_names)
    export.add_argument("--weights", type=Path)
    export.add_argument("--imgsz", type=int, default=640)
    export.add_argument("--fp32", action="store_true", help="full-precision weights (default FP16)")
    export.set_defaults(func=cmd_export)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        args.func(args)
    except (FileNotFoundError, KeyError, ValueError, RuntimeError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
