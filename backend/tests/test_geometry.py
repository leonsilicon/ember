import numpy as np
import pytest

from rover_vision.geometry import mask_to_polygons, polygon_centroid, polygon_contact_point, simplify_polygon


def square_mask(h=100, w=200, box=(20, 30, 60, 90)):
    y1, x1, y2, x2 = box
    mask = np.zeros((h, w), dtype=np.uint8)
    mask[y1:y2, x1:x2] = 255
    return mask


def test_square_becomes_one_normalised_polygon():
    polys = mask_to_polygons(square_mask())
    assert len(polys) == 1
    poly = polys[0]
    assert poly.shape[1] == 2
    assert poly[:, 0].min() == pytest.approx(30 / 200, abs=0.01)
    assert poly[:, 0].max() == pytest.approx(89 / 200, abs=0.01)
    assert poly[:, 1].min() == pytest.approx(20 / 100, abs=0.01)
    assert poly[:, 1].max() == pytest.approx(59 / 100, abs=0.01)


def test_each_component_is_an_instance_and_specks_are_dropped():
    mask = square_mask()
    mask[80:90, 150:190] = 255  # second blob
    mask[5, 5] = 255  # single-pixel noise
    assert len(mask_to_polygons(mask)) == 2


def test_antialiased_edges_use_threshold():
    mask = square_mask()
    mask[mask == 0] = 100  # faint halo below 127 is background
    assert len(mask_to_polygons(mask)) == 1


def test_bool_mask_supported_and_empty_mask_gives_nothing():
    assert len(mask_to_polygons(square_mask() > 0)) == 1
    assert mask_to_polygons(np.zeros((10, 10), bool)) == []


def test_rejects_non_2d():
    with pytest.raises(ValueError):
        mask_to_polygons(np.zeros((4, 4, 3), np.uint8))


def test_centroid_of_rectangle():
    rect = np.array([[0, 0], [100, 0], [100, 50], [0, 50]], dtype=np.float32)
    assert polygon_centroid(rect) == (50, 25)


def test_contact_point_is_bottom_middle():
    rect = np.array([[0, 0], [100, 0], [100, 50], [0, 50]], dtype=np.float32)
    assert polygon_contact_point(rect) == (50, 50)


def test_contact_point_of_triangle_is_its_tip():
    tri = np.array([[0, 0], [100, 0], [40, 80]], dtype=np.float32)
    assert polygon_contact_point(tri) == (40, 80)


@pytest.mark.parametrize("fn", [polygon_centroid, polygon_contact_point])
def test_degenerate_polygons_return_none(fn):
    assert fn(None) is None
    assert fn(np.array([[0, 0], [1, 1]], dtype=np.float32)) is None


def test_simplify_polygon_keeps_shape_with_few_vertices():
    theta = np.linspace(0, 2 * np.pi, 400, endpoint=False)
    circle = np.stack([50 + 40 * np.cos(theta), 50 + 40 * np.sin(theta)], axis=1)
    simple = simplify_polygon(circle)
    assert 8 <= len(simple) <= 40
    assert simple[:, 0].min() == pytest.approx(10, abs=2) and simple[:, 0].max() == pytest.approx(90, abs=2)
    tri = np.array([[0, 0], [1, 0], [0, 1]], dtype=np.float32)
    assert len(simplify_polygon(tri)) == 3
