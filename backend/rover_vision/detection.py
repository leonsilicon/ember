"""The detection record shared by the leaf detector, the protocol and drawing."""

from dataclasses import dataclass


@dataclass(frozen=True)
class Detection:
    """One leaf box in image pixels. ``point_px`` is the box centre, where its depth is read."""

    label: str
    confidence: float
    box_xyxy: tuple[int, int, int, int]
    point_px: tuple[int, int]

    def to_dict(self) -> dict:
        return {
            "label": self.label,
            "confidence": round(self.confidence, 3),
            "box_xyxy": list(self.box_xyxy),
            "point_px": list(self.point_px),
        }

    @classmethod
    def from_box(cls, label: str, confidence: float, box: tuple[int, int, int, int]) -> "Detection":
        x1, y1, x2, y2 = box
        return cls(label, confidence, box, ((x1 + x2) // 2, (y1 + y2) // 2))
