"""Leaf-off (fresh litter) layer from Sentinel-2.

Compares NDVI of a leaf-on scene (late summer) with the most recent clear autumn scene
over the pilot bbox and writes a 30 m raster aligned to the Ontario hazard grid:

    band 1  ndvi_on   leaf-on NDVI
    band 2  ndvi_off  leaf-off NDVI
    band 3  drop      ndvi_on - ndvi_off (positive = canopy lost its leaves)

Scenes come from Microsoft Planetary Computer (Sentinel-2 L2A COGs, no key needed).

    python leafoff.py --like pilot_hazard_30m_epsg3978.tif --bbox=-79.35,45.20,-78.95,45.45 \
        --out pilot_leafoff_30m_epsg3978.tif
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path

import numpy as np
import planetary_computer
import pystac_client
import rasterio
import rasterio.warp
import rasterio.windows
from rasterio.enums import Resampling

STAC = "https://planetarycomputer.microsoft.com/api/stac/v1"
# Sentinel-2 scene classification values we trust for NDVI
SCL_OK = {4, 5, 6, 7}  # vegetation, not-vegetated, water, unclassified(low-prob cloud)


def read_band(href: str, bounds_wgs84, out_shape, dst_transform, dst_crs, resampling):
    """Read a COG window covering bounds and reproject it onto the target grid."""
    with rasterio.open(href) as src:
        b = rasterio.warp.transform_bounds("EPSG:4326", src.crs, *bounds_wgs84)
        win = rasterio.windows.from_bounds(*b, src.transform).round_offsets().round_lengths()
        win = win.intersection(rasterio.windows.Window(0, 0, src.width, src.height))
        arr = src.read(1, window=win).astype(np.float32)
        tr = src.window_transform(win)
        dst = np.full(out_shape, np.nan, dtype=np.float32)
        rasterio.warp.reproject(
            arr, dst, src_transform=tr, src_crs=src.crs, dst_transform=dst_transform, dst_crs=dst_crs,
            src_nodata=0, dst_nodata=np.nan, resampling=resampling,
        )
        return dst


def ndvi_for(item, bounds, shape, transform, crs):
    red = read_band(item.assets["B04"].href, bounds, shape, transform, crs, Resampling.average)
    nir = read_band(item.assets["B08"].href, bounds, shape, transform, crs, Resampling.average)
    scl = read_band(item.assets["SCL"].href, bounds, shape, transform, crs, Resampling.mode)
    ok = np.isin(np.nan_to_num(scl, nan=0).astype(np.int16), list(SCL_OK))
    with np.errstate(divide="ignore", invalid="ignore"):
        ndvi = (nir - red) / (nir + red)
    ndvi[~ok] = np.nan
    return ndvi


def pick_scenes(bbox, leaf_on: tuple[str, str], leaf_off: tuple[str, str], max_cloud: float):
    cat = pystac_client.Client.open(STAC, modifier=planetary_computer.sign_inplace)

    def best(window):
        items = cat.search(
            collections=["sentinel-2-l2a"], bbox=bbox, datetime=f"{window[0]}/{window[1]}",
            query={"eo:cloud_cover": {"lt": max_cloud}},
        ).item_collection()
        # whole-bbox coverage first, then least cloud
        items = [i for i in items if covers(i, bbox)]
        if not items:
            raise SystemExit(f"no clear Sentinel-2 scene covering the bbox in {window}")
        return min(items, key=lambda i: i.properties["eo:cloud_cover"])

    def latest(window):
        items = cat.search(
            collections=["sentinel-2-l2a"], bbox=bbox, datetime=f"{window[0]}/{window[1]}",
            query={"eo:cloud_cover": {"lt": max_cloud}},
        ).item_collection()
        items = [i for i in items if covers(i, bbox)]
        if not items:
            raise SystemExit(f"no clear Sentinel-2 scene covering the bbox in {window}")
        return max(items, key=lambda i: i.properties["datetime"])

    return best(leaf_on), latest(leaf_off)


def covers(item, bbox) -> bool:
    w, s, e, n = item.bbox
    return w <= bbox[0] and s <= bbox[1] and e >= bbox[2] and n >= bbox[3]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--like", required=True, help="raster whose grid (CRS, 30 m cells) the output must match")
    ap.add_argument("--bbox", required=True, help="minlon,minlat,maxlon,maxlat")
    ap.add_argument("--out", required=True)
    ap.add_argument("--leaf-on", default="2026-08-15/2026-09-25", help="date range for the leaf-on reference")
    ap.add_argument("--leaf-off", default=f"2026-10-01/{date.today().isoformat()}", help="date range for the latest leaf-off scene")
    ap.add_argument("--max-cloud", type=float, default=20)
    args = ap.parse_args()
    bbox = tuple(float(x) for x in args.bbox.split(","))

    with rasterio.open(args.like) as like:
        crs, transform, shape = like.crs, like.transform, (like.height, like.width)
        pad = 0.01
        bounds = (bbox[0] - pad, bbox[1] - pad, bbox[2] + pad, bbox[3] + pad)
        like_bounds = rasterio.warp.transform_bounds(like.crs, "EPSG:4326", *like.bounds)
        bounds = (min(bounds[0], like_bounds[0]), min(bounds[1], like_bounds[1]), max(bounds[2], like_bounds[2]), max(bounds[3], like_bounds[3]))

    on, off = pick_scenes(bbox, tuple(args.leaf_on.split("/")), tuple(args.leaf_off.split("/")), args.max_cloud)
    print(f"leaf-on  {on.id} cloud {on.properties['eo:cloud_cover']:.1f}%", file=sys.stderr)
    print(f"leaf-off {off.id} cloud {off.properties['eo:cloud_cover']:.1f}%", file=sys.stderr)

    ndvi_on = ndvi_for(on, bounds, shape, transform, crs)
    ndvi_off = ndvi_for(off, bounds, shape, transform, crs)
    drop = ndvi_on - ndvi_off

    profile = {
        "driver": "GTiff", "dtype": "float32", "count": 3, "width": shape[1], "height": shape[0],
        "crs": crs, "transform": transform, "nodata": np.nan, "compress": "deflate", "tiled": True,
    }
    with rasterio.open(args.out, "w", **profile) as dst:
        dst.write(ndvi_on, 1)
        dst.write(ndvi_off, 2)
        dst.write(drop, 3)
        dst.set_band_description(1, "ndvi_on")
        dst.set_band_description(2, "ndvi_off")
        dst.set_band_description(3, "ndvi_drop")
    meta = {
        "leaf_on": {"id": on.id, "date": on.properties["datetime"][:10], "cloud_cover": on.properties["eo:cloud_cover"]},
        "leaf_off": {"id": off.id, "date": off.properties["datetime"][:10], "cloud_cover": off.properties["eo:cloud_cover"]},
        "source": "Copernicus Sentinel-2 L2A via Microsoft Planetary Computer",
        "valid_fraction": float(np.isfinite(drop).mean()),
        "drop_p50": float(np.nanpercentile(drop, 50)),
        "drop_p90": float(np.nanpercentile(drop, 90)),
    }
    Path(args.out).with_suffix(".json").write_text(json.dumps(meta, indent=2))
    print(json.dumps(meta, indent=2))


if __name__ == "__main__":
    main()
