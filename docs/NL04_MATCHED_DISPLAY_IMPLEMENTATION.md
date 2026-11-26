# Superseded NL-04 matched display implementation

The matched PSA/NAMRIA city was superseded when the requested city reference changed to the pink OpenStreetMap basemap edge. See [the OSM display implementation](NL04_OSM_DISPLAY_IMPLEMENTATION.md) for the current implementation. The rest of this report records the earlier candidate.

The isolated worktree draws the full-resolution PSA/NAMRIA COD-AB 2023-11-06 city and barangay pair. The city outline remains purple and dashed and draws above the barangay overlay so the shared edge stays visible. The accepted v4 package remains available for rollback and legacy location hints. The earlier comparison and Punta Taytay-only candidate are historical evidence.

| Purpose | Version | Files |
| --- | --- | --- |
| Visible city and barangays | `bacolod-display-psa-namria-20231106-v1` | `bacolod-display-city.json` and `bacolod-display-barangays.json` |
| Server city gate and enrollment version | `bacolod-map-reference-v3` | `bacolod-city-boundary.json` and the existing root manifest entries |
| Legacy browser location hints | `bacolod-barangay-display-v4` | `bacolod-barangay-boundaries.json` |
| Server barangay decisions | Version of each approved repository polygon | Existing operational database and geofence service |

The browser revalidates the boundary manifest, keys dataset requests by SHA-256 and versions the shared map script URL. The signup map, Citizen report map, both Report Details layouts, Admin GIS and Barangay GIS draw the matched display pair. Where the operational API resolves a barangay, the browser keeps that API result for reporting and looks up the display polygon by name. Legacy browser location hints keep using the existing service-area inputs. The original server city checksum is `e3918e98d774c3e555a6c583a739f82cd3a8864b7cd0931a09a9d64854514e61`.

## Geometry verification

The matched package preserves the names and identifiers of all 61 valid barangays. The audited uncovered area and exterior overflow are both 0.00 m². There are zero overlap pairs above 1 m². Mansilingan shares 3,219.38 m and Granada shares 11,847.83 m of display city edge. Their two marked gaps are 0.00 m² within the matched display city. Uncovered area in those marked strips was 103,561.16 m² and 78,671.83 m² respectively in the v4 view. The display package intersects none of the supplied PSA/NAMRIA Murcia, Talisay or Bago City polygons by measured area.

The application and the comparison use the same candidate coordinates. The two display asset checksums and candidate-file checksums are recorded in the manifest and the assets respectively. The geometry check uses EPSG:32651, a 0.0001 m² numerical tolerance and the historical 1 m² overlap reporting threshold.

```powershell
python -B scripts/audit_matched_display_geometry.py
npm test
git diff --check
```

To verify the input artifacts and neighboring municipalities as well, supply `--candidate-directory .data/nl04-psa-reconciliation` and `--municipal-source .data/nl04-edge/psa-namria-2023-city.geojson`.

## Runtime verification

The full Node suite passed 1,271 tests. Targeted desktop and mobile Chromium verification covered all six map surfaces in 14 browser cases. Admin GIS and Barangay GIS checked the actual Leaflet coordinates against the matched city and both highlighted barangays. The Admin GIS screenshots were captured on a private loopback fixture using its own SQLite database. Close-ups show the purple application line following the matched city and barangay edges. The underlying OpenStreetMap tile image can still show a different boundary line.

## Display and authorization discrepancies

The matched city contains 518,805.12 m² outside the original operational city. The operational city contains 1,000,373.64 m² outside the display city. A point inside the displayed line can therefore remain ineligible for registration or reporting. A point outside it can still pass the operational city check and is then subject to the server's existing barangay, accuracy, freshness and residency rules. The automated client test covers this separation at the earlier Vista Alegre overflow sample. The example point is inside the matched display and remains outside the operational city. No operational polygon, record, residency decision or permission was changed.

The source geometry supports this internally consistent display. Official adoption for operational use still requires government approval and an approved barangay dataset.

## Integration and rollback

The cumulative patch applies to baseline `fe36a3f`. Use the smaller incremental patch if the finalized v4 handoff has already been integrated. Keep any security or Report Details changes in the target tree. Run `git apply --check` against the intended target with the chosen patch, resolve any conflicts with current work, and apply it only after approval. The incremental patch can be reversed with `git apply --reverse --check` followed by `git apply --reverse` to restore the accepted v4 display while preserving its original handoff. No database migration is required.
