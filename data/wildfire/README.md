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
