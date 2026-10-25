"""Roads a crew could burn out from (back-burn anchors): Overture transportation segments, drivable classes only,
clipped to the area and simplified, as roads.geojson with `name` and `class`.

    overturemaps download --bbox=<bbox> -f geojson --type=segment -o roads_overture.geojson
    python roads.py --segments roads_overture.geojson --bbox=<bbox> --out ../../frontend/public/wildfire
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import shapely
from shapely.geometry import box, mapping, shape

ROAD_CLASSES = {"motorway", "trunk", "primary", "secondary", "tertiary", "residential", "unclassified", "living_street", "track"}
SIMPLIFY_DEG = 0.00003  # ~3 m


def road_features(segments: list[dict], clip) -> list[dict]:
    out = []
    for f in segments:
        p = f.get("properties", {})
        if p.get("subtype") != "road" or p.get("class") not in ROAD_CLASSES:
            continue
        g = shape(f["geometry"])
        if g.is_empty or not g.intersects(clip):
            continue
        g = g.intersection(clip).simplify(SIMPLIFY_DEG)
        if g.is_empty:
            continue
        names = p.get("names") or {}
        name = names.get("primary") if isinstance(names, dict) else None
        parts = list(g.geoms) if hasattr(g, "geoms") else [g]
        for part in parts:
            if part.geom_type != "LineString" or part.length == 0:
                continue
            out.append({"type": "Feature", "geometry": mapping(shapely.set_precision(part, 1e-6)), "properties": {"name": name, "class": p["class"]}})
    for i, f in enumerate(out, start=1):
        f["id"] = i
        f["properties"]["rid"] = i
    return out


def write_roads(feats: list[dict], out: Path) -> dict:
    (out / "roads.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":")))
    return {"file": "roads.geojson", "count": len(feats), "classes": sorted(ROAD_CLASSES), "source": "Overture Maps transportation segments (OSM), ODbL"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--segments", required=True)
    ap.add_argument("--bbox", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    bbox = tuple(float(x) for x in a.bbox.split(","))
    out = Path(a.out)
    segs = json.loads(Path(a.segments).read_text())["features"]
    meta = write_roads(road_features(segs, box(*bbox)), out)
    cov_path = out / "coverage.json"
    cov = json.loads(cov_path.read_text())
    cov["roads"] = meta
    cov_path.write_text(json.dumps(cov, indent=2))
    print(json.dumps(meta))


if __name__ == "__main__":
    main()
