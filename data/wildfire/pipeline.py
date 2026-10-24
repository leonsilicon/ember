"""Wildfire hazard screening pipeline.

Reads Ontario's "Potential Hazardous Forest Types for Wildland Fire" 30 m raster and
building footprints (Overture), computes per-building screening results and writes
static PMTiles + a coverage manifest for the frontend. No database, no server.

    python pipeline.py --raster /path/to/30m_ON20250314_EPSG-3978.tif \
        --bbox=-79.35,45.20,-78.95,45.45 --out ../../frontend/public/wildfire
"""
from __future__ import annotations

import argparse
import json
import math
import shutil
import subprocess
import sys
from dataclasses import dataclass, asdict
from pathlib import Path

import numpy as np
import rasterio
import rasterio.features
import rasterio.warp
import rasterio.windows
from pyproj import Transformer
from shapely.geometry import box, mapping, shape
import shapely
from shapely.strtree import STRtree

HERE = Path(__file__).resolve().parent
CATEGORIES = json.loads((HERE / "categories.json").read_text())
CAT_RANK = {k: v["rank"] for k, v in CATEGORIES["categories"].items()}
HAZARD_CATS = {k for k, v in CATEGORIES["categories"].items() if v["hazard"]}
SCREEN_M = CATEGORIES["screening_distance_m"]


def shp_transform(fn, geom):
    return shapely.transform(geom, lambda c: np.column_stack(fn(c[:, 0], c[:, 1])))


def category_of(code: int, nodata: int | None) -> str:
    if nodata is not None and code == nodata:
        return "nodata"
    entry = CATEGORIES["codes"].get(str(int(code)))
    return entry["category"] if entry else "unknown"


def fuel_of(code: int) -> str:
    entry = CATEGORIES["codes"].get(str(int(code)))
    return entry["fuel"] if entry else f"code {int(code)}"


def highest_category(cats: set[str]) -> str | None:
    ranked = [c for c in cats if CAT_RANK.get(c, 0) > 0]
    return max(ranked, key=CAT_RANK.__getitem__) if ranked else None


@dataclass
class BuildingResult:
    hazard_overlap: bool
    hazard_within_30m: bool
    highest_category_footprint: str | None
    highest_category_30m: str | None
    needs_evaluation: bool
    has_not_rated: bool
    coverage_complete: bool
    nearest_hazard_m: float | None
    fuel_codes_footprint: list[int]
    fuel_codes_30m: list[int]


def codes_under(geom, arr: np.ndarray, transform, nodata) -> tuple[set[int], bool]:
    """Distinct raster codes touched by geom; second value is True if geom leaves the raster."""
    minx, miny, maxx, maxy = geom.bounds
    win = rasterio.windows.from_bounds(minx, miny, maxx, maxy, transform)
    r0, c0 = int(math.floor(win.row_off)), int(math.floor(win.col_off))
    r1 = int(math.ceil(win.row_off + win.height))
    c1 = int(math.ceil(win.col_off + win.width))
    outside = r0 < 0 or c0 < 0 or r1 > arr.shape[0] or c1 > arr.shape[1]
    r0, c0 = max(r0, 0), max(c0, 0)
    r1, c1 = min(r1, arr.shape[0]), min(c1, arr.shape[1])
    if r1 <= r0 or c1 <= c0:
        return set(), True
    sub = arr[r0:r1, c0:c1]
    sub_transform = transform @ rasterio.Affine.translation(c0, r0)
    mask = rasterio.features.geometry_mask(
        [mapping(geom)], out_shape=sub.shape, transform=sub_transform, invert=True, all_touched=True
    )
    vals = {int(v) for v in np.unique(sub[mask])}
    if nodata is not None and int(nodata) in vals:
        vals.discard(int(nodata))
        outside = True
    return vals, outside


def analyze_building(geom, arr, transform, nodata, hazard_tree: STRtree | None, hazard_geoms) -> BuildingResult:
    fp_codes, fp_out = codes_under(geom, arr, transform, nodata)
    ring = geom.buffer(SCREEN_M)
    ring_codes, ring_out = codes_under(ring, arr, transform, nodata)
    fp_cats = {category_of(c, nodata) for c in fp_codes}
    ring_cats = {category_of(c, nodata) for c in ring_codes}

    nearest = None
    if hazard_tree is not None and len(hazard_geoms):
        idx = hazard_tree.nearest(geom)
        if idx is not None:
            nearest = round(float(geom.distance(hazard_geoms[idx])), 1)

    return BuildingResult(
        hazard_overlap=bool(fp_cats & HAZARD_CATS),
        hazard_within_30m=bool(ring_cats & HAZARD_CATS),
        highest_category_footprint=highest_category(fp_cats),
        highest_category_30m=highest_category(ring_cats),
        needs_evaluation="pine_eval" in ring_cats,
        has_not_rated=bool(ring_cats & {"not_rated", "unknown"}),
        coverage_complete=not (fp_out or ring_out),
        nearest_hazard_m=nearest,
        fuel_codes_footprint=sorted(fp_codes),
        fuel_codes_30m=sorted(ring_codes),
    )


def hazard_polygons(arr, transform, nodata):
    """Dissolved polygons of High/Extreme cells, in raster CRS."""
    cat_mask = np.zeros(arr.shape, dtype=np.uint8)
    for code in np.unique(arr):
        if category_of(int(code), nodata) in HAZARD_CATS:
            cat_mask[arr == code] = 1
    return [shape(g) for g, v in rasterio.features.shapes(cat_mask, mask=cat_mask == 1, transform=transform) if v == 1]


def hazard_features(arr, transform, nodata, to_wgs84):
    """One polygon per contiguous run of the same raw code, with code/category/fuel."""
    arr_i32 = arr.astype(np.int32)
    valid = arr != nodata if nodata is not None else np.ones(arr.shape, bool)
    for g, v in rasterio.features.shapes(arr_i32, mask=valid, transform=transform):
        code = int(v)
        cat = category_of(code, nodata)
        if cat == "water":
            continue
        yield {
            "type": "Feature",
            "geometry": mapping(shp_transform(to_wgs84, shape(g))),
            "properties": {"code": code, "cat": cat, "fuel": fuel_of(code)},
        }


def run_tippecanoe(tippecanoe: str, layers: dict[str, Path], dst: Path, extra: list[str]):
    named = [a for name, path in layers.items() for a in ("-L", f"{name}:{path}")]
    cmd = [tippecanoe, "-o", str(dst), "--force", "--read-parallel", *extra, *named]
    print("+", " ".join(cmd), file=sys.stderr)
    subprocess.run(cmd, check=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raster", required=True, help="Ontario 30 m GeoTIFF (zip paths via /vsizip/ work)")
    ap.add_argument("--bbox", required=True, help="minlon,minlat,maxlon,maxlat (WGS84)")
    ap.add_argument("--buildings", help="Overture buildings GeoJSON; downloaded for --bbox if missing")
    ap.add_argument("--out", default=str(HERE.parent.parent / "frontend" / "public" / "wildfire"))
    ap.add_argument("--work", default=str(HERE / "work"))
    ap.add_argument("--tippecanoe", default=shutil.which("tippecanoe") or str(Path.home() / ".local/bin/tippecanoe"))
    ap.add_argument("--area-name", default="Pilot area")
    args = ap.parse_args()

    bbox = tuple(float(x) for x in args.bbox.split(","))
    out, work = Path(args.out), Path(args.work)
    out.mkdir(parents=True, exist_ok=True)
    work.mkdir(parents=True, exist_ok=True)

    buildings_path = Path(args.buildings) if args.buildings else work / "buildings_overture.geojson"
    if not buildings_path.exists():
        subprocess.run(
            ["overturemaps", "download", f"--bbox={args.bbox}", "-f", "geojson", "--type=building", "-o", str(buildings_path)],
            check=True,
        )

    with rasterio.open(args.raster) as src:
        nodata = int(src.nodata) if src.nodata is not None else None
        pad = SCREEN_M * 4
        b = rasterio.warp.transform_bounds("EPSG:4326", src.crs, *bbox)
        win = rasterio.windows.from_bounds(b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad, src.transform)
        win = win.round_offsets().round_lengths()
        arr = src.read(1, window=win)
        transform = src.window_transform(win)
        crs = src.crs

    to_raster = Transformer.from_crs("EPSG:4326", crs, always_xy=True).transform
    to_wgs84 = Transformer.from_crs(crs, "EPSG:4326", always_xy=True).transform

    print(f"raster window {arr.shape}, building hazard index…", file=sys.stderr)
    hz_geoms = hazard_polygons(arr, transform, nodata)
    hz_tree = STRtree(hz_geoms) if hz_geoms else None

    print("writing hazard features…", file=sys.stderr)
    hazard_geojson = work / "hazard.geojson"
    with hazard_geojson.open("w") as f:
        f.write('{"type":"FeatureCollection","features":[')
        first = True
        n_hz = 0
        for feat in hazard_features(arr, transform, nodata, to_wgs84):
            if not first:
                f.write(",")
            f.write(json.dumps(feat, separators=(",", ":")))
            first = False
            n_hz += 1
        f.write("]}")

    print("analyzing buildings…", file=sys.stderr)
    raw = json.loads(buildings_path.read_text())
    coverage_poly = box(*bbox)
    out_feats = []
    ring_feats = []
    stats = {"total": 0, "hazard_overlap": 0, "hazard_within_30m": 0, "needs_evaluation": 0, "incomplete": 0}
    for fid, feat in enumerate(raw["features"], start=1):
        g84 = shape(feat["geometry"])
        if g84.is_empty or not g84.is_valid:
            g84 = g84.buffer(0)
            if g84.is_empty:
                continue
        g = shp_transform(to_raster, g84)
        res = analyze_building(g, arr, transform, nodata, hz_tree, hz_geoms)
        if not coverage_poly.contains(g84):
            res.coverage_complete = False
        stats["total"] += 1
        stats["hazard_overlap"] += res.hazard_overlap
        stats["hazard_within_30m"] += res.hazard_within_30m
        stats["needs_evaluation"] += res.needs_evaluation
        stats["incomplete"] += not res.coverage_complete
        props = asdict(res)
        props["fuel_codes_footprint"] = json.dumps(props["fuel_codes_footprint"])
        props["fuel_codes_30m"] = json.dumps(props["fuel_codes_30m"])
        props["fid"] = fid
        props["gers_id"] = feat.get("id")
        srcs = feat["properties"].get("sources") or []
        props["footprint_source"] = srcs[0]["dataset"] if srcs else None
        c = g84.centroid
        props["lon"], props["lat"] = round(c.x, 6), round(c.y, 6)
        props["area_m2"] = round(g.area, 1)
        out_feats.append({"type": "Feature", "id": fid, "geometry": mapping(g84), "properties": props})
        ring84 = shp_transform(to_wgs84, g.buffer(SCREEN_M, quad_segs=6))
        ring_feats.append({"type": "Feature", "id": fid, "geometry": mapping(ring84), "properties": {"fid": fid}})

    buildings_geojson = work / "buildings.geojson"
    buildings_geojson.write_text(json.dumps({"type": "FeatureCollection", "features": out_feats}, separators=(",", ":")))
    rings_geojson = work / "rings.geojson"
    rings_geojson.write_text(json.dumps({"type": "FeatureCollection", "features": ring_feats}, separators=(",", ":")))

    run_tippecanoe(
        args.tippecanoe, {"buildings": buildings_geojson, "rings": rings_geojson}, out / "buildings.pmtiles",
        ["-Z10", "-z16", "--no-feature-limit", "--no-tile-size-limit", "--use-attribute-for-id=fid", "--detect-shared-borders"],
    )
    run_tippecanoe(
        args.tippecanoe, {"hazard": hazard_geojson}, out / "hazard.pmtiles",
        ["-Z7", "-z14", "--no-feature-limit", "--no-tile-size-limit", "--detect-shared-borders", "--coalesce-smallest-as-needed"],
    )

    coverage = {
        "area_name": args.area_name,
        "bbox": bbox,
        "coverage": mapping(coverage_poly),
        "screening_distance_m": SCREEN_M,
        "source": CATEGORIES["source"],
        "buildings_source": "Overture Maps buildings (OSM + Microsoft ML + Google + Esri), ODbL/CDLA",
        "stats": stats,
        "hazard_features": n_hz,
        "tiles": {"buildings": "buildings.pmtiles", "hazard": "hazard.pmtiles"},
    }
    (out / "coverage.json").write_text(json.dumps(coverage, indent=2))
    shutil.copy(HERE / "categories.json", out / "categories.json")
    print(json.dumps(stats, indent=2))


if __name__ == "__main__":
    main()
