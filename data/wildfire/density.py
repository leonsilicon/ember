"""High-density home areas: smooth blue blobs where homes are packed together, in the same style as the fire-risk zones.

Counts building centroids within SEARCH_M of every 30 m cell, keeps cells at or above MIN_HOMES_PER_HA, merges and
smooths them like zones.py and drops blobs under MIN_HA. Reads buildings.json from an output folder and writes
density.geojson next to it (also updates coverage.json).

    python density.py --out ../../frontend/public/wildfire
"""
from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import numpy as np
import shapely
from pyproj import Transformer
from shapely.geometry import mapping
from shapely.ops import polylabel
from shapely.strtree import STRtree

import zones

CELL_M = 30
SEARCH_M = 150  # homes counted within this radius of each cell (~7 ha)
MIN_HOMES_PER_HA = 2.0  # suburban lots (~500 m2 lots with roads) and denser
MIN_HA = 3.0


def density_grid(xy: np.ndarray, cell_m: float = CELL_M, search_m: float = SEARCH_M):
    """Homes per hectare within search_m of each cell centre, over the buildings' bounding box (padded)."""
    if not len(xy):
        return np.zeros((1, 1), np.float32), (0.0, 0.0)
    pad = search_m + cell_m
    x0, y0 = xy[:, 0].min() - pad, xy[:, 1].min() - pad
    x1, y1 = xy[:, 0].max() + pad, xy[:, 1].max() + pad
    w, h = int(math.ceil((x1 - x0) / cell_m)), int(math.ceil((y1 - y0) / cell_m))
    cx = x0 + (np.arange(w) + 0.5) * cell_m
    cy = y1 - (np.arange(h) + 0.5) * cell_m
    tree = STRtree(shapely.points(xy))
    gx, gy = np.meshgrid(cx, cy)
    centres = shapely.points(np.column_stack([gx.ravel(), gy.ravel()]))
    pairs = tree.query(centres, predicate="dwithin", distance=search_m)
    counts = np.bincount(pairs[0], minlength=len(centres)).reshape(h, w)
    per_ha = counts / (math.pi * search_m**2 / 10_000)
    return per_ha.astype(np.float32), (x0, y1)


def build_density(xy: np.ndarray, to_wgs84, min_per_ha: float = MIN_HOMES_PER_HA) -> list[dict]:
    import rasterio

    per_ha, (x0, y1) = density_grid(xy)
    transform = rasterio.Affine(CELL_M, 0, x0, 0, -CELL_M, y1)
    blobs = zones.smooth_blobs(zones.mask_polygons(per_ha >= min_per_ha, transform), min_ha=MIN_HA)
    tree = STRtree(shapely.points(xy)) if len(xy) else None
    feats = []
    for i, b in enumerate(blobs, start=1):
        homes = int(len(tree.query(b, predicate="intersects"))) if tree else 0
        if homes == 0:
            continue
        label = polylabel(b, tolerance=10) if b.geom_type == "Polygon" else b.representative_point()
        lon, lat = to_wgs84(label.x, label.y)
        g84 = shapely.set_precision(shapely.transform(b, lambda c: np.column_stack(to_wgs84(c[:, 0], c[:, 1]))), 1e-6)
        feats.append({
            "type": "Feature",
            "id": i,
            "geometry": mapping(g84),
            "properties": {
                "did": i,
                "area_ha": round(b.area / 10_000, 1),
                "homes": homes,
                "homes_per_ha": round(homes / (b.area / 10_000), 2),
                "lon": round(float(lon), 6),
                "lat": round(float(lat), 6),
            },
        })
    feats.sort(key=lambda f: -f["properties"]["homes"])
    for i, f in enumerate(feats, start=1):
        f["id"] = i
        f["properties"]["did"] = i
    return feats


def write_density(feats: list[dict], out: Path) -> dict:
    (out / "density.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":")))
    return {"file": "density.geojson", "count": len(feats), "search_m": SEARCH_M, "min_homes_per_ha": MIN_HOMES_PER_HA, "min_ha": MIN_HA}


def run(out: Path, crs="EPSG:3978") -> dict:
    rows = json.loads((out / "buildings.json").read_text())
    f = rows["fields"]
    lon_i, lat_i = f.index("lon"), f.index("lat")
    to_crs = Transformer.from_crs("EPSG:4326", crs, always_xy=True).transform
    to_wgs84 = Transformer.from_crs(crs, "EPSG:4326", always_xy=True).transform
    lons = np.array([r[lon_i] for r in rows["rows"]])
    lats = np.array([r[lat_i] for r in rows["rows"]])
    xy = np.column_stack(to_crs(lons, lats)) if len(lons) else np.zeros((0, 2))
    meta = write_density(build_density(xy, to_wgs84), out)
    cov_path = out / "coverage.json"
    cov = json.loads(cov_path.read_text())
    cov["density"] = meta
    cov_path.write_text(json.dumps(cov, indent=2))
    return meta


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(zones.P.HERE.parent.parent / "frontend" / "public" / "wildfire"))
    print(json.dumps(run(Path(ap.parse_args().out))))
