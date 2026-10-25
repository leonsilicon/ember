# Wildfire hazard screening pipeline

Turns Ontario MNRF's **Potential Hazardous Forest Types for Wildland Fire** (30 m raster)
plus Overture building footprints into the static files the `#/wildfire` map screen reads
from `frontend/public/wildfire/`:

| file | what |
| --- | --- |
| `zones.geojson` | high fire-risk zones (`zones.py`): smoothed polygons with area, fuel mix, leaf-off share, homes inside / within 30 m / within 500 m, distance to water and an inside label point |
| `buildings.pmtiles` | layers `buildings` (footprints with screening results) and `rings` (exact 30 m buffers, same ids) (`hazard_overlap`, `hazard_within_30m`, `needs_evaluation`, `coverage_complete`, `nearest_hazard_m`, fuel codes) |
| `density.geojson` | high-density home areas (`density.py`): smooth blobs where ≥ 2 homes/ha within 150 m, with `homes`, `area_ha`, `homes_per_ha` and a label point |
| `roads.geojson` | drivable roads (`roads.py`, from Overture segments) used as back-burn anchors in the suggested actions |
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

## Canopy leaf-off layer and Ignition Risk

`leafoff.py` pulls two Sentinel-2 L2A scenes from Microsoft Planetary Computer (no key): the clearest
leaf-on scene (Aug–Sep) and the latest clear autumn scene, masks clouds with SCL, and writes the NDVI
drop on the hazard grid:

    python leafoff.py --like pilot_hazard_30m_epsg3978.tif --bbox=-79.35,45.20,-78.95,45.45 \
        --out pilot_leafoff_30m_epsg3978.tif

Pass it to the pipeline with `--leafoff`. Each building then gets `leafoff_30m` (mean NDVI drop in its
30 m band) and a static `exposure` (0–1) = 0.55 × fuel + 0.25 × leaf-off + 0.20 × neighbours, where fuel is
the High/Extreme cover and proximity in the 30 m zone, leaf-off is the drop scaled to 0.35, and neighbours is
the count of other structures within 30 m capped at 4 (`RISK_WEIGHTS`, `NEIGHBOUR_CAP`). The UI shows
Ignition Risk = 100 × exposure × (0.4 + 0.6 × today's CWFIS fine-fuel dryness), so the number moves with the
weather. `fuel.bin` is the hazard grid resampled for the fire-spread simulation.

## High fire-risk zones

`zones.py` (run at the end of the pipeline, or on its own against an existing `buildings.json`) scores every 30 m
cell as 0.6 × fuel weight (the same per-category weights as the home score) + 0.4 × leaf-off (NDVI drop / 0.35,
only where there was canopy), keeps cells ≥ 0.6, closes gaps under ~120 m, drops strands thinner than ~90 m and
blobs under 5 ha, and writes `zones.geojson`. On the pilot that is 307 zones, ~6,000 ha. They are almost all
High/Extreme conifer; hardwood leaf-off alone does not reach the threshold, so leaf-off mostly shows up as a
driver on the zone card rather than creating zones. Today's dryness (CWFIS FFMC) is one value for the whole pilot,
so it is not part of where the zones are.

    python zones.py --raster pilot_hazard_30m_epsg3978.tif --leafoff pilot_leafoff_30m_epsg3978.tif \
        --bbox=-79.35,45.20,-78.95,45.45

Satellites can't see a leaf pile; the drop measures canopy greenness loss, not litter on the ground.

`validate_leafoff.py` checks the layer against Ontario's fuel types (independent data): on the pilot, hardwood (D-1)
cells show a median NDVI drop of 0.26 (57% ≥ 0.25), conifer stands 0.09 (0.5% ≥ 0.25), water 0.01; the drop separates
hardwood from conifer with AUC 0.96. It cannot validate litter on a specific lawn — nobody has ground truth for that.
