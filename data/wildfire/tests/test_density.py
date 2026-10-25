import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import density  # noqa: E402

ident = lambda x, y: (x, y)  # noqa: E731


def grid_homes(n, spacing, x0=0, y0=0):
    return np.array([[x0 + i * spacing, y0 + j * spacing] for i in range(n) for j in range(n)], dtype=float)


def test_subdivision_becomes_one_blob_and_scattered_homes_do_not():
    sub = grid_homes(12, 35)                      # 144 homes on 35 m lots -> ~8 homes/ha
    scattered = grid_homes(4, 400, x0=3000, y0=3000)  # 16 homes 400 m apart
    feats = density.build_density(np.vstack([sub, scattered]), ident)
    assert len(feats) == 1
    p = feats[0]["properties"]
    assert p["homes"] == 144
    assert p["homes_per_ha"] >= density.MIN_HOMES_PER_HA
    assert feats[0]["id"] == p["did"] == 1


def test_no_homes_no_blobs():
    assert density.build_density(np.zeros((0, 2)), ident) == []
