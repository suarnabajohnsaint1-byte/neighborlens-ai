# NL-04 citywide OSM display edge alignment

Display version `bacolod-display-osm-land-v3` uses the pinned OSM Bacolod City land boundary as the outer reference. Along with Mansilingan and Granada, it aligns Felisa, Estefania, Banago, Singcang-Airport and every other barangay whose uncovered city-edge component has one adjacent barangay. The city edge and coastline keep their original coordinates.

Each display addition is inside the pinned city, outside previously covered barangay areas, and touches the city perimeter. The rule scans all 61 display barangays and never assigns a component at a shared junction. This is an app display convention. It does not establish official jurisdiction, move the city line into offshore water, or change the server's GPS, residency or authorization inputs.

| Check | Result |
| --- | --- |
| Valid barangay geometries | 61 |
| Aligned components | 255 across 19 barangays, including the v2 Mansilingan and Granada work |
| Newly covered area since v2 | 556,848.17 m² |
| Felisa, Estefania, Banago and Singcang-Airport | 166,825.23, 15,067.74, 23,554.17 and 5,261.87 m² added respectively |
| Measured exterior area | 0.00 m² |
| Barangay overlap pairs above 1 m² | 0 |
| Remaining measured uncovered city area | 227,669.01 m² |
| Shared city-edge components above 1 m² | 13 |

The largest unresolved shared component is between Barangays 2 and 8. The audit records the neighboring barangays, areas, and representative coordinates for the remaining shared components. Some of the display coverage is inside Murcia, Talisay or Bago City in the PSA/NAMRIA dataset because that dataset and OSM use different municipal boundaries. The overlay keeps the OSM reference requested for display and does not assign the shared gaps without an agreed barangay split.

Run `python -B scripts/audit_osm_display_geometry.py` from the repository root. The optional `--candidate-directory .data/nl04-psa-reconciliation` checks deterministic alignment from the source, and `--municipal-source .data/nl04-edge/psa-namria-2023-city.geojson` measures municipal source discrepancies.

The v3 update patch applies after the OSM v2 patch. Check it with `git apply --check` before applying. The patch is reversible and carries no database changes.
