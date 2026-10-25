import sys
from pathlib import Path

import numpy as np
import rasterio

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import zones  # noqa: E402

RES = 30
NODATA = -9999
N = 80
# 80 x 80 cells, origin at (0, 2400): x = col*30, y = 2400 - row*30
TRANSFORM = rasterio.Affine(RES, 0, 0, 0, -RES, N * RES)
ident = lambda x, y: (x, y)  # noqa: E731


def make_raster():
    arr = np.full((N, N), 101, dtype=np.int16)  # non-fuel everywhere
    arr[10:30, 10:30] = 2                      # 20 x 20 Extreme block (36 ha)
    arr[60:63, 60:63] = 2                      # 3 x 3 Extreme speck (0.81 ha) -> dropped
    arr[10:30, 45:65] = 650                    # 20 x 20 moderate block (needs leaf-off to qualify)
    arr[35:45, 10:30] = 102                    # water just south of the Extreme block
    return arr


def no_leafoff():
    return np.full((N, N), np.nan, np.float32), np.full((N, N), np.nan, np.float32)


def build(arr, drop, on, xy=np.zeros((0, 2))):
    return zones.build_zones(arr, TRANSFORM, NODATA, drop, on, xy, ident)


def test_category_by_code_is_consistent():
    # the tests below assume these codes; fail loudly if categories.json changes
    assert zones.P.category_of(2, NODATA) == "extreme"
    assert zones.P.category_of(650, NODATA) == "moderate"
    assert zones.P.category_of(102, NODATA) == "water"


def test_extreme_block_is_one_zone_and_speck_is_dropped():
    feats = build(make_raster(), *no_leafoff())
    assert len(feats) == 1
    p = feats[0]["properties"]
    assert 25 < p["area_ha"] < 45
    assert p["fuel_mix"]["extreme"] > 0.9
    assert p["top_fuel"].startswith("C-2")
    assert feats[0]["id"] == p["zid"] == 1


def test_moderate_forest_needs_heavy_leafoff_to_become_a_zone():
    arr = make_raster()
    drop, on = no_leafoff()
    on[:] = 0.8
    drop[10:30, 45:65] = 0.4  # every leaf down over the moderate block
    feats = build(arr, drop, on)
    assert len(feats) == 2
    mod = [f for f in feats if f["properties"]["fuel_mix"].get("moderate", 0) > 0.5]
    assert len(mod) == 1 and mod[0]["properties"]["leafoff_share"] > 0.9


def test_water_is_never_a_zone_and_distance_is_measured():
    arr = make_raster()
    feats = build(arr, *no_leafoff())
    p = feats[0]["properties"]
    # water starts 5 rows (150 m) below the block; smoothing rounds the blob but cannot reach it
    assert p["water_m"] is not None and 100 <= p["water_m"] <= 200
    assert zones.cell_score(np.ones((2, 2)), np.ones((2, 2)), np.ones((2, 2), bool)).max() == 0


def test_homes_inside_near_and_far():
    xy = np.array([
        [600, 2400 - 600],   # inside the Extreme block
        [915, 2400 - 600],   # 15 m east of it -> within 30 m
        [1200, 2400 - 600],  # ~300 m east -> within 500 m only
        [2300, 100],         # far corner
    ], dtype=float)
    p = build(make_raster(), *no_leafoff(), xy)[0]["properties"]
    assert p["homes_in"] == 1
    assert p["homes_30m"] == 2
    assert p["homes_500m"] == 3


def test_label_point_is_inside_the_zone():
    from shapely.geometry import Point, shape

    f = build(make_raster(), *no_leafoff())[0]
    assert shape(f["geometry"]).contains(Point(f["properties"]["lon"], f["properties"]["lat"]))
