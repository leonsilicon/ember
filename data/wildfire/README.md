# Wildfire hazard screening pipeline

Turns Ontario MNRF's **Potential Hazardous Forest Types for Wildland Fire** (30 m raster)
plus Overture building footprints into the static files the `#/wildfire` map screen reads
from `frontend/public/wildfire/`:

| file | what |
| --- | --- |
| `hazard.pmtiles` | vector tiles of raster cells grouped by raw fuel code (`code`, `cat`, `fuel`) |
| `buildings.pmtiles` | layers `buildings` (footprints with screening results) and `rings` (exact 30 m buffers, same ids) (`hazard_overlap`, `hazard_within_30m`, `needs_evaluation`, `coverage_complete`, `nearest_hazard_m`, fuel codes) |
| `coverage.json` | pilot bbox, source metadata, summary stats |
| `categories.json` | copy of the shared code → category → colour config |

`categories.json` is the single source of truth for fuel-code categories, colours and the
30 m screening distance; Python and the frontend both read it.

## Run

```sh
pip install -r requirements.txt          # rasterio, shapely, pyproj, overturemaps, pytest
# tippecanoe must be on PATH (https://github.com/felt/tippecanoe)

curl -LO https://ws.gisetl.lrc.gov.on.ca/fmedatadownload/Packages/HazardousFuels_QGIS.zip
unzip HazardousFuels_QGIS.zip             # -> 30m_ON20250314_EPSG-3978.tif (515 MB)

python pipeline.py --raster 30m_ON20250314_EPSG-3978.tif \
  --bbox=-79.35,45.20,-78.95,45.45 --area-name "Huntsville / Lake of Bays, Ontario"
```

Buildings are downloaded from Overture for the bbox unless `--buildings` points at an
existing GeoJSON. Rerun with a bigger bbox to widen coverage; nothing in the frontend is
area-specific.

## How a building is scored

1. Footprint and its 30 m buffer are projected to the raster CRS (EPSG:3978).
2. Every cell they touch (`all_touched`) is mapped raw code → category via `categories.json`
   (codes are **not** ordinal: 13 = Low, 3 = High).
3. `hazard_overlap` / `hazard_within_30m` = any High/Extreme cell under the footprint / buffer.
4. `nearest_hazard_m` = exact Shapely distance from the footprint to dissolved High/Extreme
   cell polygons (not a raster distance transform).
5. `needs_evaluation` = C‑5/C‑6 pine within 30 m; `coverage_complete` = false if any part
   leaves the raster, hits nodata, or leaves the pilot bbox.

`pytest tests` covers inside / boundary / 20 m / far / pine / nodata cases on a synthetic raster.

## Leaf-off (fresh litter) layer and scan priority

`leafoff.py` pulls two Sentinel-2 L2A scenes from Microsoft Planetary Computer (no key): the clearest
leaf-on scene (Aug–Sep) and the latest clear autumn scene, masks clouds with SCL, and writes the NDVI
drop on the hazard grid:

    python leafoff.py --like pilot_hazard_30m_epsg3978.tif --bbox=-79.35,45.20,-78.95,45.45 \
        --out pilot_leafoff_30m_epsg3978.tif

Pass it to the pipeline with `--leafoff`. Each building then gets `leafoff_30m` (mean NDVI drop in its
30 m band) and a static `scan_priority` (0–100): mapped hazard (overlap 1.0; within 30 m 0.55–1.0 by
distance; else 0.1) × litter (0.5 + 0.5 × drop/0.35). The UI multiplies this by today's CWFIS Fine Fuel
Moisture Code (live GetFeatureInfo), so the number on screen moves with the weather. `leafoff.pmtiles`
holds the drop classes (≥0.25 / ≥0.32 / ≥0.40) where there was canopy (leaf-on NDVI > 0.4).

Satellites can't see a leaf pile; this ranks where the rover should look first, the rover verifies.
