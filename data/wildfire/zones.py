"""High fire-risk zones: contiguous areas of hazardous forest fuel and fresh leaf-off, as smooth polygons.

Every 30 m cell gets score = 0.6 x fuel weight (Ontario MNRF fuel category) + 0.4 x leaf-off (Sentinel-2 NDVI drop,
where there was canopy). Cells with score >= ZONE_MIN are merged, gaps narrower than ~120 m are closed, strands
thinner than ~90 m are dropped, and blobs under MIN_HA are discarded. Today's dryness (CWFIS FFMC) is one value for the
whole pilot, so it changes how dangerous the zones are today but not where they are; that is applied in the browser.

Runs as part of pipeline.py, or on its own against an existing frontend/public/wildfire/buildings.json:

    python zones.py --raster pilot_hazard_30m_epsg3978.tif --leafoff pilot_leafoff_30m_epsg3978.tif \\
        --bbox=-79.35,45.20,-78.95,45.45
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import rasterio
import rasterio.features
import rasterio.warp
import rasterio.windows
import shapely
from pyproj import Transformer
from shapely.geometry import box, mapping, shape
from shapely.ops import polylabel
from shapely.strtree import STRtree

import pipeline as P

ZONE_WEIGHTS = {"fuel": 0.6, "leafoff": 0.4}
ZONE_MIN = 0.6  # ~6.5 % of the pilot: High/Extreme forest, or moderate mixedwood with heavy leaf-off
CLOSE_M = 60  # buffer out/in: closes gaps up to ~2 x this
OPEN_M = 45  # buffer in/out: removes strands thinner than ~2 x this
MIN_HA = 5.0
SIMPLIFY_M = 12
WATER_MIN_HA = 1.0
NEAR_M = 500
LEAFOFF_HEAVY = 0.25  # NDVI drop counted as "heavy leaf-off" (same as the first leaf-off class)


def fuel_weight_grid(arr: np.ndarray, nodata) -> tuple[np.ndarray, np.ndarray]:
    """Per-cell fuel weight (0-1) and category name."""
    w = np.zeros(arr.shape, dtype=np.float32)
    cat = np.empty(arr.shape, dtype=object)
    for code in np.unique(arr):
        c = P.category_of(int(code), nodata)
        m = arr == code
        w[m] = P.FUEL_WEIGHT.get(c, 0.0)
        cat[m] = c
    return w, cat


def leafoff_grid(drop: np.ndarray | None, ndvi_on: np.ndarray | None, shape_: tuple[int, int]) -> np.ndarray:
    """Leaf-off 0-1 per cell (NDVI drop scaled to LEAFOFF_FULL), 0 where there was no canopy or no data."""
    if drop is None or ndvi_on is None:
        return np.zeros(shape_, dtype=np.float32)
    ok = np.isfinite(drop) & np.isfinite(ndvi_on) & (ndvi_on > 0.4)
    return np.where(ok, np.clip(drop / P.LEAFOFF_FULL, 0, 1), 0).astype(np.float32)


def cell_score(fuel_w: np.ndarray, leafoff: np.ndarray, water: np.ndarray) -> np.ndarray:
    s = ZONE_WEIGHTS["fuel"] * fuel_w + ZONE_WEIGHTS["leafoff"] * leafoff
    return np.where(water, 0, s).astype(np.float32)


def mask_polygons(mask: np.ndarray, transform) -> list:
    return [shape(g) for g, v in rasterio.features.shapes(mask.astype(np.uint8), mask=mask, transform=transform) if v == 1]


def smooth_blobs(polys: list, min_ha: float = MIN_HA) -> list:
    """Merge cell polygons into rounded blobs (closing then opening) and drop small ones."""
    if not polys:
        return []
    u = shapely.union_all(polys)
    u = u.buffer(CLOSE_M, quad_segs=8).buffer(-CLOSE_M, quad_segs=8)
    u = u.buffer(-OPEN_M, quad_segs=8).buffer(OPEN_M, quad_segs=8)
    u = u.simplify(SIMPLIFY_M, preserve_topology=True)
    parts = list(u.geoms) if hasattr(u, "geoms") else [u]
    out = [p.buffer(0) for p in parts if not p.is_empty and p.area >= min_ha * 10_000]
    return sorted(out, key=lambda p: -p.area)


def zone_stats(zone, score, fuel_w, cat, leafoff_raw, arr, transform, nodata) -> dict:
    """Mean score, fuel mix and leaf-off share of the cells whose centres fall in the zone."""
    m = rasterio.features.geometry_mask([zone], arr.shape, transform, invert=True)
    n = int(m.sum())
    if n == 0:
        return {"score": 0.0, "fuel_mix": {}, "top_fuel": None, "leafoff_share": 0.0}
    cats = cat[m]
    mix = {}
    for k in ("extreme", "high", "pine_eval", "moderate", "low"):
        share = float((cats == k).sum()) / n
        if share >= 0.01:
            mix[k] = round(share, 3)
    other = round(1 - sum(mix.values()), 3)
    if other >= 0.01:
        mix["other"] = other
    codes, counts = np.unique(arr[m], return_counts=True)
    burnable = [(c, k) for c, k in zip(codes, counts) if P.FUEL_WEIGHT.get(P.category_of(int(c), nodata), 0) > 0]
    top = max(burnable, key=lambda x: x[1])[0] if burnable else None
    lo = leafoff_raw[m] if leafoff_raw is not None else None
    lo_share = float(np.nanmean(np.where(np.isfinite(lo), lo >= LEAFOFF_HEAVY, False))) if lo is not None else 0.0
    return {
        "score": round(float(score[m].mean()), 3),
        "fuel_mix": mix,
        "top_fuel": P.fuel_of(int(top)) if top is not None else None,
        "leafoff_share": round(lo_share, 3),
    }


def build_zones(arr, transform, nodata, drop, ndvi_on, buildings_xy: np.ndarray, to_wgs84, clip84=None) -> list[dict]:
    """GeoJSON features (WGS84) for every high fire-risk zone. buildings_xy: building centroids in raster CRS."""
    fuel_w, cat = fuel_weight_grid(arr, nodata)
    water = cat == "water"
    score = cell_score(fuel_w, leafoff_grid(drop, ndvi_on, arr.shape), water)
    blobs = smooth_blobs(mask_polygons(score >= ZONE_MIN, transform))
    lakes = [p for p in mask_polygons(water, transform) if p.area >= WATER_MIN_HA * 10_000]
    lake_tree = STRtree(lakes) if lakes else None
    pts = shapely.points(buildings_xy) if len(buildings_xy) else np.array([])
    pt_tree = STRtree(pts) if len(pts) else None
    feats = []
    for z in blobs:
        g84 = shapely.transform(z, lambda c: np.column_stack(to_wgs84(c[:, 0], c[:, 1])))
        if clip84 is not None:
            if not clip84.intersects(g84):
                continue
            if not clip84.contains(g84):
                g84 = g84.intersection(clip84)
                if g84.is_empty or g84.area == 0:
                    continue
        st = zone_stats(z, score, fuel_w, cat, drop, arr, transform, nodata)
        homes_in = len(pt_tree.query(z, predicate="intersects")) if pt_tree else 0
        homes_30 = len(pt_tree.query(z, predicate="dwithin", distance=P.SCREEN_M)) if pt_tree else 0
        homes_500 = len(pt_tree.query(z, predicate="dwithin", distance=NEAR_M)) if pt_tree else 0
        water_m = None
        if lake_tree is not None:
            i = lake_tree.nearest(z)
            water_m = round(float(z.distance(lakes[i])))
        label = polylabel(z, tolerance=10) if z.geom_type == "Polygon" else z.representative_point()
        lon, lat = to_wgs84(label.x, label.y)
        g84 = shapely.set_precision(g84, 1e-6)
        feats.append({
            "type": "Feature",
            "geometry": mapping(g84),
            "properties": {
                "area_ha": round(z.area / 10_000, 1),
                **st,
                "homes_in": homes_in,
                "homes_30m": homes_30,
                "homes_500m": homes_500,
                "water_m": water_m,
                "lon": round(float(lon), 6),
                "lat": round(float(lat), 6),
            },
        })
    # biggest danger first: area x score, nearby homes as tie-breaker
    feats.sort(key=lambda f: (-f["properties"]["area_ha"] * f["properties"]["score"], -f["properties"]["homes_500m"]))
    for i, f in enumerate(feats, start=1):
        f["id"] = i
        f["properties"]["zid"] = i
    return feats


def write_zones(feats: list[dict], out: Path) -> dict:
    (out / "zones.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": feats}, separators=(",", ":")))
    return {
        "file": "zones.geojson",
        "count": len(feats),
        "weights": ZONE_WEIGHTS,
        "min_score": ZONE_MIN,
        "min_ha": MIN_HA,
        "formula": "zone cell score = 0.6 x fuel weight (Ontario fuel category) + 0.4 x leaf-off (Sentinel-2 NDVI drop / 0.35); cells >= 0.6, smoothed, >= 5 ha",
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raster", required=True)
    ap.add_argument("--leafoff")
    ap.add_argument("--bbox", required=True)
    ap.add_argument("--out", default=str(P.HERE.parent.parent / "frontend" / "public" / "wildfire"))
    args = ap.parse_args()
    bbox = tuple(float(x) for x in args.bbox.split(","))
    out = Path(args.out)
    with rasterio.open(args.raster) as src:
        nodata = int(src.nodata) if src.nodata is not None else None
        pad = P.SCREEN_M * 4
        b = rasterio.warp.transform_bounds("EPSG:4326", src.crs, *bbox)
        win = rasterio.windows.from_bounds(b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad, src.transform).round_offsets().round_lengths()
        arr = src.read(1, window=win)
        transform = src.window_transform(win)
        crs = src.crs
    drop = ndvi_on = None
    if args.leafoff:
        with rasterio.open(args.leafoff) as lo:
            lwin = rasterio.windows.from_bounds(*rasterio.transform.array_bounds(arr.shape[0], arr.shape[1], transform), lo.transform)
            lwin = lwin.round_offsets().round_lengths()
            ndvi_on = lo.read(1, window=lwin, boundless=True, fill_value=np.nan)
            drop = lo.read(3, window=lwin, boundless=True, fill_value=np.nan)
    to_raster = Transformer.from_crs("EPSG:4326", crs, always_xy=True).transform
    to_wgs84 = Transformer.from_crs(crs, "EPSG:4326", always_xy=True).transform
    rows = json.loads((out / "buildings.json").read_text())
    f = rows["fields"]
    lon_i, lat_i = f.index("lon"), f.index("lat")
    lons = np.array([r[lon_i] for r in rows["rows"]])
    lats = np.array([r[lat_i] for r in rows["rows"]])
    xy = np.column_stack(to_raster(lons, lats)) if len(lons) else np.zeros((0, 2))
    feats = build_zones(arr, transform, nodata, drop, ndvi_on, xy, to_wgs84, box(*bbox))
    meta = write_zones(feats, out)
    cov_path = out / "coverage.json"
    cov = json.loads(cov_path.read_text())
    cov["zones"] = meta
    cov_path.write_text(json.dumps(cov, indent=2))
    print(json.dumps({k: v for k, v in meta.items() if k != "formula"}))


if __name__ == "__main__":
    main()
