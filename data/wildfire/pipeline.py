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
import rasterio.transform
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
    leafoff_30m: float | None = None
    f_fuel: float = 0.0
    l_leafoff: float = 0.5
    n_neighbours: int = 0
    exposure: float = 0.0


LEAFOFF_FULL = 0.35  # NDVI drop treated as "all leaves down" (p90 of the pilot is ~0.31)
LEAFOFF_CLASSES = ((0.25, 1), (0.32, 2), (0.40, 3))  # drop >= threshold -> class (~top 25% / 10% / 3% of pilot canopy)


def mean_under(geom, arr: np.ndarray, transform) -> float | None:
    """Mean of finite raster values touched by geom, or None if nothing valid."""
    minx, miny, maxx, maxy = geom.bounds
    win = rasterio.windows.from_bounds(minx, miny, maxx, maxy, transform)
    r0, c0 = max(int(math.floor(win.row_off)), 0), max(int(math.floor(win.col_off)), 0)
    r1 = min(int(math.ceil(win.row_off + win.height)), arr.shape[0])
    c1 = min(int(math.ceil(win.col_off + win.width)), arr.shape[1])
    if r1 <= r0 or c1 <= c0:
        return None
    sub = arr[r0:r1, c0:c1]
    mask = rasterio.features.geometry_mask(
        [mapping(geom)], out_shape=sub.shape, transform=transform @ rasterio.Affine.translation(c0, r0), invert=True, all_touched=True
    )
    vals = sub[mask]
    vals = vals[np.isfinite(vals)]
    return float(vals.mean()) if vals.size else None


# Ignition Risk shown in the UI = 100 x exposure x (0.4 + 0.6 x live CWFIS dryness).
# exposure is the static part computed here from three 0-1 inputs.
RISK_WEIGHTS = {"fuel": 0.55, "leafoff": 0.25, "neighbours": 0.20}
NEIGHBOUR_CAP = 4  # structures within 30 m at which the neighbour term saturates
FUEL_WEIGHT = {"extreme": 1.0, "high": 0.8, "pine_eval": 0.6, "moderate": 0.4, "low": 0.15}


def fuel_cover(geom, arr: np.ndarray, transform, nodata) -> float:
    """Rank-weighted share of the raster cells touched by geom that carry forest fuel (0-1)."""
    minx, miny, maxx, maxy = geom.bounds
    win = rasterio.windows.from_bounds(minx, miny, maxx, maxy, transform)
    r0, c0 = max(int(math.floor(win.row_off)), 0), max(int(math.floor(win.col_off)), 0)
    r1 = min(int(math.ceil(win.row_off + win.height)), arr.shape[0])
    c1 = min(int(math.ceil(win.col_off + win.width)), arr.shape[1])
    if r1 <= r0 or c1 <= c0:
        return 0.0
    sub = arr[r0:r1, c0:c1]
    mask = rasterio.features.geometry_mask(
        [mapping(geom)], out_shape=sub.shape, transform=transform @ rasterio.Affine.translation(c0, r0), invert=True, all_touched=True
    )
    vals = sub[mask]
    if nodata is not None:
        vals = vals[vals != nodata]
    if vals.size == 0:
        return 0.0
    w = sum(FUEL_WEIGHT.get(category_of(int(c), nodata), 0.0) * n for c, n in zip(*np.unique(vals, return_counts=True)))
    return float(w / vals.size)


def fuel_exposure(res: "BuildingResult", cover: float) -> float:
    """F: half how much of the 30 m zone is forest fuel, half how close rated High/Extreme gets."""
    if res.hazard_overlap:
        prox = 1.0
    elif res.hazard_within_30m:
        d = res.nearest_hazard_m if res.nearest_hazard_m is not None else SCREEN_M / 2
        prox = 0.55 + 0.45 * max(0.0, 1 - d / SCREEN_M)
    else:
        prox = 0.0
    return min(1.0, 0.5 * cover + 0.5 * prox)


def leafoff_exposure(leafoff: float | None) -> float:
    """L: fresh canopy drop in the 30 m zone; neutral 0.5 when the satellite had no clear view."""
    return 0.5 if leafoff is None else min(1.0, max(0.0, leafoff / LEAFOFF_FULL))


def exposure_of(f_fuel: float, l_leafoff: float, n_neighbours: int) -> float:
    n = min(n_neighbours, NEIGHBOUR_CAP) / NEIGHBOUR_CAP
    return RISK_WEIGHTS["fuel"] * f_fuel + RISK_WEIGHTS["leafoff"] * l_leafoff + RISK_WEIGHTS["neighbours"] * n


def write_fuel_grid(arr: np.ndarray, transform, crs, nodata, bbox, out: Path) -> dict:
    """Fuel codes resampled onto a Web Mercator grid (~30 m ground cells) for the browser fire simulation.

    fuel.bin is uint8 row-major, 0 = no data / outside raster, otherwise 1-based index into `codes`."""
    codes = sorted(int(c) for c in np.unique(arr) if nodata is None or int(c) != int(nodata))
    idx = np.zeros(arr.shape, dtype=np.uint8)
    for i, code in enumerate(codes, start=1):
        idx[arr == code] = i
    left, bottom, right, top = rasterio.warp.transform_bounds("EPSG:4326", "EPSG:3857", *bbox)
    lat_c = (bbox[1] + bbox[3]) / 2
    res = 30 / math.cos(math.radians(lat_c))  # mercator metres per 30 ground metres
    width, height = math.ceil((right - left) / res), math.ceil((top - bottom) / res)
    dst_transform = rasterio.Affine(res, 0, left, 0, -res, top)
    dst = np.zeros((height, width), dtype=np.uint8)
    rasterio.warp.reproject(
        idx, dst, src_transform=transform, src_crs=crs, dst_transform=dst_transform, dst_crs="EPSG:3857",
        src_nodata=0, dst_nodata=0, resampling=rasterio.warp.Resampling.nearest,
    )
    (out / "fuel.bin").write_bytes(dst.tobytes())
    return {
        "file": "fuel.bin",
        "width": width,
        "height": height,
        "cell_m": 30,
        "crs": "EPSG:3857",
        "origin": [left, top],
        "res": res,
        "codes": [{"index": i, "code": c, "fuel": fuel_of(c), "cat": category_of(c, nodata)} for i, c in enumerate(codes, start=1)],
    }


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
    ap.add_argument("--leafoff", help="Sentinel-2 leaf-off raster from leafoff.py (same grid as --raster)")
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

    drop = ndvi_on = leafoff_meta = None
    if args.leafoff:
        with rasterio.open(args.leafoff) as lo:
            lwin = rasterio.windows.from_bounds(*rasterio.transform.array_bounds(arr.shape[0], arr.shape[1], transform), lo.transform)
            lwin = lwin.round_offsets().round_lengths()
            ndvi_on = lo.read(1, window=lwin, boundless=True, fill_value=np.nan)
            drop = lo.read(3, window=lwin, boundless=True, fill_value=np.nan)
            assert drop.shape == arr.shape, (drop.shape, arr.shape)
        meta_path = Path(args.leafoff).with_suffix(".json")
        leafoff_meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}

    to_raster = Transformer.from_crs("EPSG:4326", crs, always_xy=True).transform
    to_wgs84 = Transformer.from_crs(crs, "EPSG:4326", always_xy=True).transform

    print(f"raster window {arr.shape}, building hazard index…", file=sys.stderr)
    hz_geoms = hazard_polygons(arr, transform, nodata)
    hz_tree = STRtree(hz_geoms) if hz_geoms else None

    coverage_poly = box(*bbox)
    print("analyzing buildings…", file=sys.stderr)
    raw = json.loads(buildings_path.read_text())
    footprints = []  # (feature, wgs84 geom, raster-crs geom)
    for feat in raw["features"]:
        g84 = shape(feat["geometry"])
        if g84.is_empty or not g84.is_valid:
            g84 = g84.buffer(0)
            if g84.is_empty:
                continue
        footprints.append((feat, g84, shp_transform(to_raster, g84)))
    bldg_tree = STRtree([g for _, _, g in footprints])
    out_feats = []
    ring_feats = []
    rows = []
    stats = {"total": 0, "hazard_overlap": 0, "hazard_within_30m": 0, "needs_evaluation": 0, "incomplete": 0, "exposure_60": 0}
    for fid, (feat, g84, g) in enumerate(footprints, start=1):
        res = analyze_building(g, arr, transform, nodata, hz_tree, hz_geoms)
        if not coverage_poly.contains(g84):
            res.coverage_complete = False
        zone = g.buffer(SCREEN_M)
        if drop is not None:
            lo = mean_under(zone, drop, transform)
            res.leafoff_30m = None if lo is None else round(lo, 3)
        res.f_fuel = round(fuel_exposure(res, fuel_cover(zone, arr, transform, nodata)), 3)
        res.l_leafoff = round(leafoff_exposure(res.leafoff_30m), 3)
        res.n_neighbours = int(len(bldg_tree.query(zone, predicate="intersects")) - 1)
        res.exposure = round(exposure_of(res.f_fuel, res.l_leafoff, res.n_neighbours), 3)
        stats["exposure_60"] += res.exposure >= 0.6
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
        rows.append([fid, props["lon"], props["lat"], res.exposure, res.f_fuel, res.l_leafoff, res.n_neighbours, props["area_m2"]])
        ring84 = shp_transform(to_wgs84, g.buffer(SCREEN_M, quad_segs=6))
        ring_feats.append({"type": "Feature", "id": fid, "geometry": mapping(ring84), "properties": {"fid": fid}})

    (out / "buildings.json").write_text(
        json.dumps({"fields": ["fid", "lon", "lat", "exposure", "f_fuel", "l_leafoff", "n_neighbours", "area_m2"], "rows": rows}, separators=(",", ":"))
    )
    print("writing fuel grid…", file=sys.stderr)
    grid = write_fuel_grid(arr, transform, crs, nodata, bbox, out)

    buildings_geojson = work / "buildings.geojson"
    buildings_geojson.write_text(json.dumps({"type": "FeatureCollection", "features": out_feats}, separators=(",", ":")))
    rings_geojson = work / "rings.geojson"
    rings_geojson.write_text(json.dumps({"type": "FeatureCollection", "features": ring_feats}, separators=(",", ":")))

    run_tippecanoe(
        args.tippecanoe, {"buildings": buildings_geojson, "rings": rings_geojson}, out / "buildings.pmtiles",
        ["-Z10", "-z16", "--no-feature-limit", "--no-tile-size-limit", "--use-attribute-for-id=fid", "--detect-shared-borders"],
    )
    print("high fire-risk zones…", file=sys.stderr)
    import zones  # imports this module, so only once it has finished loading

    centroids = np.array([[g.centroid.x, g.centroid.y] for _, _, g in footprints]) if footprints else np.zeros((0, 2))
    zones_meta = zones.write_zones(zones.build_zones(arr, transform, nodata, drop, ndvi_on, centroids, to_wgs84, coverage_poly), out)

    coverage = {
        "area_name": args.area_name,
        "bbox": bbox,
        "coverage": mapping(coverage_poly),
        "screening_distance_m": SCREEN_M,
        "source": CATEGORIES["source"],
        "buildings_source": "Overture Maps buildings (OSM + Microsoft ML + Google + Esri), ODbL/CDLA",
        "stats": stats,
        "tiles": {"buildings": "buildings.pmtiles"},
        "zones": zones_meta,
        "leafoff": {**leafoff_meta, "classes": [{"min_drop": t, "drop_class": c} for t, c in LEAFOFF_CLASSES], "full_drop": LEAFOFF_FULL} if leafoff_meta is not None else None,
        "files": {"buildings": "buildings.json"},
        "grid": grid,
        "risk": {
            "weights": RISK_WEIGHTS,
            "neighbour_cap": NEIGHBOUR_CAP,
            "formula": "risk = 100 x exposure x (0.4 + 0.6 x dryness); exposure = 0.55 F + 0.25 L + 0.20 N (static, here); dryness = live CWFIS FFMC 70-95 -> 0-1 (browser)",
        },
    }
    (out / "coverage.json").write_text(json.dumps(coverage, indent=2))
    shutil.copy(HERE / "categories.json", out / "categories.json")
    print(json.dumps(stats, indent=2))


if __name__ == "__main__":
    main()
