"""Command-line entry point: ``python -m rover_vision <command> --help``."""

import argparse
import sys
from pathlib import Path


def _perception(args, with_leaf_detector: bool):
    """The leaf detector (unless ``--no-leaf-detector``) and a Perception
    configured from the rover/mount flags. Returns (perception, detector, mount)."""
    from rover_vision.occupancy import GridSpec, RoverSpec
    from rover_vision.perception import Perception
    from rover_vision.spatial import Mount

    detector = None
    if not args.no_leaf_detector:
        from rover_vision.leaves import LeafDetector  # heavy import (transformers)

        detector = LeafDetector(args.leaf_threshold, args.tile_grid)
    mount = Mount(pitch_deg=args.pitch, roll_deg=args.roll, camera_height_m=args.camera_height)
    rover = RoverSpec(width_m=args.rover_width, max_step_m=args.max_step)
    perception = Perception(detector if with_leaf_detector else None, rover, GridSpec(), mount)
    return perception, detector, mount


def cmd_navigate(args):
    from rover_vision.navigate import run

    # The live loop runs the (slow) leaf detector itself, in the background.
    perception, detector, _ = _perception(args, with_leaf_detector=False)
    run(perception, detector, args.source, args.hfov, show=not args.no_show, save=args.save, emit_json=args.json)


def cmd_serve(args):
    import uvicorn

    from rover_vision.server import create_app

    perception, _, mount = _perception(args, with_leaf_detector=True)
    uvicorn.run(create_app(perception, mount), host=args.host, port=args.port, log_level="info")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m rover_vision", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    shared = argparse.ArgumentParser(add_help=False)
    g = shared.add_argument_group("leaf detector")
    g.add_argument("--leaf-threshold", type=float, default=0.05, help="OWL-ViT score needed to count as a leaf")
    g.add_argument("--tile-grid", type=int, choices=(1, 2, 3), default=2, help="OWL-ViT crops per side")
    g.add_argument("--no-leaf-detector", action="store_true", help="don't load OWL-ViT (leaves come from the phone)")
    g = shared.add_argument_group("rover and camera mount (used when the frame has no ARKit pose)")
    g.add_argument("--pitch", type=float, default=15.0, help="degrees the camera looks below horizontal")
    g.add_argument("--roll", type=float, default=0.0, help="degrees of clockwise camera roll")
    g.add_argument("--camera-height", type=float, help="lens height above ground in m (default: fit from depth, else 0.30)")
    g.add_argument("--rover-width", type=float, default=0.45, help="m; corridors are this wide")
    g.add_argument("--max-step", type=float, default=0.08, help="m; anything taller blocks the rover")

    nav = sub.add_parser("navigate", parents=[shared], help="live view: leaves + depth → map and corridors")
    nav.add_argument("--source", default="0", help='"realsense", camera index, video file/URL or image')
    nav.add_argument("--hfov", type=float, default=69.0, help="horizontal field of view (deg) for cameras without intrinsics")
    nav.add_argument("--save", type=Path, help="output video (streams) or image (single image)")
    nav.add_argument("--no-show", action="store_true")
    nav.add_argument("--json", action="store_true", help="print rover-perception/2 JSON (without grid) per frame")
    nav.set_defaults(func=cmd_navigate)

    serve = sub.add_parser("serve", parents=[shared], help="HTTP API for the phone app (POST /v1/perceive)")
    serve.add_argument("--host", default="0.0.0.0")
    serve.add_argument("--port", type=int, default=8765)
    serve.set_defaults(func=cmd_serve)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        args.func(args)
    except (FileNotFoundError, ValueError, RuntimeError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
