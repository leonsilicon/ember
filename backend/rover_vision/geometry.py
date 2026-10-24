"""Mask and polygon helpers shared by dataset conversion and inference."""

import cv2
import numpy as np

Point = tuple[int, int]


def mask_to_polygons(
    mask: np.ndarray,
    min_area_frac: float = 0.0005,
    epsilon_frac: float = 0.002,
) -> list[np.ndarray]:
    """Turn a binary mask into one normalised (N, 2) polygon per connected
    component, the format YOLO-seg labels use.

    ``mask`` may be bool or uint8 (anything > 127 counts as foreground for
    uint8, so antialiased 0/255 masks work). Components smaller than
    ``min_area_frac`` of the image are dropped as annotation noise. Holes are
    ignored, which YOLO-seg can't represent anyway.
    """
    if mask.ndim != 2:
        raise ValueError(f"mask must be 2-D, got shape {mask.shape}")
    h, w = mask.shape
    binary = (mask > 127) if mask.dtype == np.uint8 else mask.astype(bool)
    contours, _ = cv2.findContours(binary.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    scale = np.array([w, h], dtype=np.float32)
    polygons = []
    for contour in contours:
        if cv2.contourArea(contour) < min_area_frac * h * w:
            continue
        contour = cv2.approxPolyDP(contour, epsilon_frac * cv2.arcLength(contour, True), True)
        if len(contour) < 3:
            continue
        polygons.append(np.clip(contour.reshape(-1, 2) / scale, 0.0, 1.0))
    return polygons


def simplify_polygon(polygon: np.ndarray, epsilon_frac: float = 0.01) -> np.ndarray:
    """Douglas-Peucker simplification relative to the polygon's perimeter.
    Model masks trace every pixel; a few dozen vertices are enough to label
    and far quicker to hand-edit. Works on pixel or normalised coordinates."""
    contour = np.asarray(polygon, dtype=np.float32).reshape(-1, 1, 2)
    if len(contour) <= 3:
        return contour.reshape(-1, 2)
    simplified = cv2.approxPolyDP(contour, epsilon_frac * cv2.arcLength(contour, True), True).reshape(-1, 2)
    return simplified if len(simplified) >= 3 else contour.reshape(-1, 2)


def polygon_centroid(polygon: np.ndarray) -> Point | None:
    """Area centroid of a pixel-space polygon: where the gripper should aim."""
    if polygon is None or len(polygon) < 3:
        return None
    m = cv2.moments(polygon.astype(np.float32))
    if m["m00"] == 0:
        return None
    return round(m["m10"] / m["m00"]), round(m["m01"] / m["m00"])


def polygon_contact_point(polygon: np.ndarray, band_px: float = 4.0) -> Point | None:
    """Lowest point of a pixel-space polygon, i.e. where an obstacle meets the
    ground nearest the camera. Sampling depth here gives the distance the
    rover can drive before hitting it.

    Averages x over the vertices within ``band_px`` of the bottom so a flat
    bottom edge returns its middle rather than one corner.
    """
    if polygon is None or len(polygon) < 3:
        return None
    bottom = polygon[:, 1].max()
    near_bottom = polygon[polygon[:, 1] >= bottom - band_px]
    return round(float(near_bottom[:, 0].mean())), round(float(bottom))
