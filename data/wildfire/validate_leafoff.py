"""Sanity check for the leaf-off layer against Ontario's fuel types (an independent dataset).

Deciduous stands should lose much more NDVI between the leaf-on and leaf-off scenes than conifer
stands, and water should not move. Prints per-fuel-type medians plus an AUC for how well the NDVI
drop separates hardwood (D-1 codes 11/13) from conifer (C-1..C-6 codes 1-6) cells.

    python validate_leafoff.py --hazard pilot_hazard_30m_epsg3978.tif --leafoff pilot_leafoff_30m_epsg3978.tif
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import rasterio

CATEGORIES = json.loads((Path(__file__).resolve().parent / "categories.json").read_text())
CONIFER = [1, 2, 3, 4, 5, 6]
HARDWOOD = [11, 13]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--hazard", required=True)
    ap.add_argument("--leafoff", required=True)
    ap.add_argument("--threshold", type=float, default=0.25, help="drop treated as 'flagged' (class 1 threshold)")
    args = ap.parse_args()

    with rasterio.open(args.hazard) as h, rasterio.open(args.leafoff) as lo:
        arr, nodata = h.read(1), h.nodata
        on, off, drop = lo.read(1), lo.read(2), lo.read(3)
    assert arr.shape == drop.shape, "rasters must share the grid (run leafoff.py with --like the hazard clip)"
    ok = np.isfinite(drop)
    print(f"valid cells: {ok.mean():.1%}\n")

    rows = []
    for code in np.unique(arr):
        if code == nodata:
            continue
        m = (arr == code) & ok
        if m.sum() < 500:
            continue
        e = CATEGORIES["codes"].get(str(int(code)), {})
        rows.append((e.get("fuel", f"code {code}"), int(m.sum()), np.median(on[m]), np.median(off[m]), np.median(drop[m]), (drop[m] >= args.threshold).mean()))
    rows.sort(key=lambda r: -r[4])
    print(f"{'fuel type':40s} {'cells':>7s} {'NDVI on':>8s} {'NDVI off':>9s} {'drop':>6s} {'flagged':>8s}")
    for f, n, a, b, d, p in rows:
        print(f"{f[:40]:40s} {n:7d} {a:8.2f} {b:9.2f} {d:6.2f} {p:8.1%}")

    con, hw = np.isin(arr, CONIFER) & ok, np.isin(arr, HARDWOOD) & ok
    dc, dh = drop[con], drop[hw]
    ranks = np.searchsorted(np.sort(dc), dh, side="right")
    print(f"\nconifer  n={con.sum()} median drop {np.median(dc):.2f}, flagged {(dc >= args.threshold).mean():.1%}  (false-positive proxy)")
    print(f"hardwood n={hw.sum()} median drop {np.median(dh):.2f}, flagged {(dh >= args.threshold).mean():.1%}")
    print(f"AUC (drop separates hardwood from conifer): {ranks.mean() / len(dc):.3f}")


if __name__ == "__main__":
    main()
