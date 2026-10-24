import sys
from pathlib import Path

import numpy as np
import rasterio
from shapely.geometry import box
from shapely.strtree import STRtree

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import pipeline  # noqa: E402

RES = 30
NODATA = -9999
# 40 x 40 cells, origin at (0, 1200): x = col*30, y = 1200 - row*30
TRANSFORM = rasterio.Affine(RES, 0, 0, 0, -RES, 40 * RES)


def make_raster():
    arr = np.full((40, 40), 101, dtype=np.int16)      # non-fuel everywhere
    arr[:, 30:] = 2                                     # Extreme (C-2) for x >= 900
    arr[0:2, :] = NODATA                                # no data for y >= 1140
    arr[20:22, 0:5] = 5                                 # pine (C-5) block near x 0-150, y 540-600
    arr[30:40, 0:10] = 650                              # moderate block
    return arr


def analyze(geom):
    arr = make_raster()
    hz = pipeline.hazard_polygons(arr, TRANSFORM, NODATA)
    return pipeline.analyze_building(geom, arr, TRANSFORM, NODATA, STRtree(hz), hz)


def test_codes_are_mapped_by_category_not_numeric_order():
    assert pipeline.category_of(13, NODATA) == "low"
    assert pipeline.category_of(3, NODATA) == "high"
    assert pipeline.category_of(999, NODATA) == "unknown"
    assert pipeline.category_of(NODATA, NODATA) == "nodata"
    assert pipeline.highest_category({"low", "extreme", "pine_eval", "not_rated"}) == "extreme"
    assert pipeline.highest_category({"pine_eval", "not_rated"}) is None


def test_building_inside_extreme_overlaps():
    r = analyze(box(950, 400, 970, 420))
    assert r.hazard_overlap and r.hazard_within_30m
    assert r.highest_category_footprint == "extreme"
    assert r.nearest_hazard_m == 0.0
    assert r.coverage_complete


def test_building_20m_from_extreme_is_within_30m_but_not_overlapping():
    r = analyze(box(860, 400, 880, 420))  # east edge at x=880, hazard starts at x=900
    assert not r.hazard_overlap
    assert r.hazard_within_30m
    assert r.nearest_hazard_m == 20.0
    assert r.highest_category_footprint is None  # 101 is not rated
    assert r.has_not_rated


def test_building_far_from_hazard_has_nothing_detected():
    r = analyze(box(300, 400, 320, 420))
    assert not r.hazard_overlap and not r.hazard_within_30m
    assert r.nearest_hazard_m == 580.0
    assert r.coverage_complete


def test_edge_touching_is_within_30m_at_distance_zero():
    r = analyze(box(880, 400, 900, 420))  # shares the x=900 boundary with the hazard cells
    assert not r.hazard_overlap  # footprint does not enter a hazard cell
    assert r.hazard_within_30m
    assert r.nearest_hazard_m == 0.0


def test_pine_within_30m_sets_needs_evaluation():
    r = analyze(box(170, 560, 190, 580))  # pine block spans x 0-150, y 540-600
    assert r.needs_evaluation
    assert not r.hazard_within_30m


def test_moderate_is_ranked_but_not_a_hazard():
    r = analyze(box(100, 100, 120, 120))
    assert r.highest_category_footprint == "moderate"
    assert not r.hazard_overlap and not r.hazard_within_30m


def test_nodata_within_30m_marks_coverage_incomplete():
    r = analyze(box(300, 1100, 320, 1120))  # ring reaches y=1150, nodata starts at y=1140
    assert not r.coverage_complete


def test_building_leaving_raster_marks_coverage_incomplete():
    r = analyze(box(-10, 400, 10, 420))
    assert not r.coverage_complete


def test_every_legend_code_in_categories_has_known_category():
    for code, entry in pipeline.CATEGORIES["codes"].items():
        assert entry["category"] in pipeline.CATEGORIES["categories"], code
