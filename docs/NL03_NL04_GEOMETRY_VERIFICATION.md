# NL-03 and NL-04 geometry verification

Baseline `fe36a3f2c4d29454ce9719915295dc78f0cfd187`. All implementation work was done in the clean, detached Codex worktree at `C:/Users/cleme/.codex/worktrees/f8f8/Neighborlens-AI`. The original and manual geometry worktrees were separate, as confirmed by `git worktree list`. The shared panel document was left for Gemini's integration.

## Cause and correction

- The v3 manifest bundled independently derived data. The barangay asset identifies its source as a simplified PSA/NAMRIA 2023-11-06 snapshot. The city is the unchanged land-only reference from OSM relation 11349321 version 19, clipped to the mapped OSM coastline. Git history and the assets preserve the pinned inputs. No original upstream conversion or simplification script was found in the checkout. The exact upstream steps that produced the mismatch remain unknown. [Barangay source recorded in the asset](https://github.com/altcoder/philippines-psgc-shapefiles/tree/main/data/2023/BgySubMuns), [OSM city relation](https://www.openstreetmap.org/relation/11349321), [OSM coastline](https://wiki.openstreetmap.org/wiki/Tag:natural=coastline)
- The unrendered GeoJSON already put 22 barangays beyond the pinned city. The point at latitude `10.6273779`, longitude `123.01947488369984` lies in the old Vista Alegre polygon and outside the city near Murcia. The corrected polygon excludes it. Vista Alegre lost 72,111.43 m² of exterior area. The source coordinates alone reproduced the defect before any map rendering or coordinate transformation.
- The generator intersects every barangay with the pinned city in WGS84 using GEOS double precision. It preserves names, codes and feature properties. It retains every polygon component and interior ring in the intersection and discards only non-area remnants. It stops on invalid input, invalid output or an empty polygon result. Of the 61 source polygons, 59 outputs are polygons and two are multipolygons (Barangay 2 and Pahanocoy). Villamonte retains its original hole containing Montevista. [Shapely intersection](https://shapely.readthedocs.io/en/stable/reference/shapely.intersection.html)
- Registration and both GIS portals use the shared display asset. Citizen submission and Report Details use the same reference when drawing an outline for a server-resolved barangay. The resolution response still supplies jurisdiction identity and status. Report Details uses the same Leaflet map when enlarged. The browser revalidates the manifest, keys datasets by digest and skips Leaflet's per-zoom boundary simplification. The measured separation of outside vertices in the unsimplified Web Mercator overlay was at most 1.2 cm, below 0.04 pixels at zoom 19. [Leaflet path documentation](https://leafletjs.com/reference-2.0.0.html)

## Geometry versions and checksums

| Dataset | Version | SHA-256 of LF-normalized content |
| --- | --- | --- |
| City before and after | `bacolod-map-reference-v3`, OSM relation 11349321 version 19 | `e3918e98d774c3e555a6c583a739f82cd3a8864b7cd0931a09a9d64854514e61` |
| Barangay source preserved from the v3 bundle | PSA/NAMRIA 2023-11-06 | `0ccc3cbb15797a886f01ec9db4674598feb38ce9493083750aba6802d45e3d10` |
| Corrected barangay display | `bacolod-barangay-display-v4` | `ceabd32dee2a6ca37605fb5611435880cd41921c0d5da7fe37556f7a72e490ca` |

The raw city checksum on this CRLF checkout was `7edfa632b9ec7b756a614196c23b0efa62352c3342372e128116326decbd8b87` both times. The application verifies LF-normalized digests. The manifest keeps the city version used by registration and adds a separate display version under `barangays`.

## Audit results

The historical script reproduced 61 valid polygons, 77 overlap pairs above 1 m², 101.26 ha uncovered and 51.99 ha outside the city. Its original method projects vertices first and joins them with straight UTM segments. Clipping introduces vertices along shared WGS84 edges. Projecting the split and unsplit lines independently yields different chords and the historical method reports a rounded 0.01 ha exterior on the corrected asset. For containment, the comparison audit overlays the source and city in WGS84 first, densifies measurement-only edges to at most 0.0001° (about 11 m) and projects the results to WGS84 / UTM zone 51N (EPSG:32651) for area.

| Metric with the same comparison method before and after | Source | Corrected |
| --- | ---: | ---: |
| Valid non-empty features and unique names and codes | 61/61 | 61/61 |
| Barangay union outside city | 519,951.16 m² | 0.00 m² |
| Vista Alegre outside city | 72,111.43 m² | 0.00 m² |
| Pairwise overlaps above 1 m² | 77 | 77 |
| Sum of reported pairwise overlap areas | 12,375.55 m² | 12,375.55 m² |
| Total uncovered city area | 1,012,689.93 m² | 1,012,689.92 m² |
| Newly uncovered city area | — | 0.00 m² |

The audit uses a verification-only coordinate tolerance of `1e-11` degrees (approximately one micrometre) and an area tolerance of `0.0001 m²` for floating-point overlay comparisons. The largest individual measured exterior residue after clipping was approximately `1.63e-7 m²`. The 1 m² threshold follows the historical overlap inventory. The negligible change in aggregate gap area reflects measurement of split edges. The spatial comparison detected zero new uncovered area. No tolerance, buffer or simplification is applied when generating coordinates.

The [before-and-after inventory](NL03_NL04_GEOMETRY_INVENTORY.json) includes all 22 barangays with exterior area, all 77 significant overlap pairs, and 457 pre-existing uncovered components above 1 m² (245 within the verification tolerance of a city edge). Each gap entry includes adjacent barangays where identifiable and a representative coordinate. The largest remaining overlap is Mansilingan / Vista Alegre at 1,186.56 m². The largest uncovered component is along the city edge near Barangays 2 and 8 at 226,098.62 m². City containment is the defensible correction supported by the pinned inputs. Resolving the remaining overlaps and gaps requires approved jurisdiction geometries.

## Verification and authorization

- `npm test` passed 1,271/1,271 Node tests. The suite exercised coastal land, eastern interior, city edge and outside-city points, unavailable and ambiguous geometry, GPS accuracy and freshness, identity and printed-address matching, residency checks, cross-barangay reporting and replay protection. The added client test covers the Vista Alegre overflow coordinate, display selection for an independently resolved barangay, and checksum-keyed fetching.
- The fresh private MySQL 8.0.46 catalog had 61 barangays, zero populated operational polygon rows and zero polygon rows carrying source and version. This reproduces the seeded baseline in isolation. The historical live local catalog was outside the test scope. `node --test --test-concurrency=1 tests/migrations/panel-residency-mysql.test.js` passed 1/1, including the preservation of existing reports and legacy identity addresses and the unique report GPS constraint.
- Twelve targeted desktop/mobile Chromium checks passed against the private SQLite browser harness with a synthetic enrollment verifier. They covered registration map selection, enrollment and manifest agreement, the Citizen submission map, Report Details inline and enlarged maps including the nearby-boundary state, and Admin GIS marker semantics.
- Four additional Chromium checks compared the actual rendered Vista Alegre Leaflet layer with the v4 asset in Admin GIS and Barangay GIS on desktop and mobile. An early GIS smoke run fell back to the configured service on localhost port 3000 and sent test authentication requests. The verified run used a private loopback port and explicitly blocked requests to port 3000. Gemini's port 4341 was unused.
- Repeated generation was byte-identical on Python 3.12.10, Shapely 2.2.0 / GEOS 3.14.1, and pyproj 3.8.0 / PROJ 9.8.1. Re-running the comparison reproduced the committed inventory. `git diff --check` passed.
- Server jurisdiction still depends on repository polygons with provenance and fails closed when they are unavailable or ambiguous. The application GPS controls, residency, report ownership and database records were preserved. Private fixture results establish local behavior. Operational sign-off still requires authoritative city approval, approved and dated barangay polygons, the real identity verifier for enrollment and field validation.

## Final scope and panel status

The pinned Bacolod City land boundary is the parent reference for all 61 display polygons. The display correction is limited to city containment and includes the completed Vista Alegre correction near Murcia. The city geometry, existing map UI and controls, and server authorization safeguards are preserved. Internal topology reconstruction and territory reassignment are deferred until authoritative geometry is available.

| Requirement | Panel status | Verification or outstanding dependency |
| --- | --- | --- |
| NL-03 city reference consistency | **VERIFIED_LOCALLY** | The pinned city geometry retains the v3 checksum. Coastal, interior, boundary-edge and outside-city checks passed. |
| NL-04 barangay display containment | **VERIFIED_LOCALLY** | Display v4 retains all 61 valid canonical barangays within the pinned city to the documented numerical tolerance. Vista Alegre's overflow is corrected. No new significant overlap or gap was introduced. |
| NL-04 internal overlaps | **DEFERRED** | 77 existing barangay overlap pairs above 1 m² require authoritative jurisdiction geometry. |
| NL-04 gaps | **DEFERRED** | 101.27 ha of uncovered city area requires authoritative jurisdiction geometry. |
| NL-03 official city boundary approval | **BLOCKED** | Pending CPDO approval. |
| NL-04 operational barangay authorization | **BLOCKED** | Pending an approved, dated and versioned barangay polygon dataset. Authorization remains fail-closed. |

## Modified files

| File | Purpose |
| --- | --- |
| `data/geometry/bacolod-barangay-boundaries-source-v3.json` | Preserved pinned source and provenance for offline reproducibility. |
| `frontend/assets/bacolod-barangay-boundaries.json` | Generated v4 display dataset. |
| `frontend/assets/bacolod-boundary-version.json` | Display version and digest with the existing city pin. |
| `frontend/js/map/mapConfig.js` | Shared map fetching, rendering and choice of reference geometry. |
| `scripts/generate_barangay_display_geometry.py` | Deterministic generator and byte-for-byte check. |
| `scripts/audit_barangay_geometry.py` | Historical reproduction, comparison and verification with a defect inventory. |
| `tests/integration/client-geofence.test.js` | Vista Alegre, shared outline selection, city points and cache regression. |
| `docs/NL03_NL04_GEOMETRY_VERIFICATION.md`, `docs/NL03_NL04_GEOMETRY_INVENTORY.json`, `.gitignore` | Panel handoff, area measurements and repository allowlist for the two deliverables. |

## Reproduce or integrate after Gemini finishes

In an isolated worktree with Node dependencies and the Python versions above, run:

```powershell
python -B scripts/audit_barangay_geometry.py --source
python -B scripts/generate_barangay_display_geometry.py --check
python -B scripts/audit_barangay_geometry.py --compare
npm test
git diff --check
```

To regenerate the display asset and manifest, run the generator without `--check`. To regenerate the inventory, pass `--compare --output docs/NL03_NL04_GEOMETRY_INVENTORY.json` to the audit.

After Gemini completes Report Details regression, apply the isolated handoff patch from the original repo root. Inspect the target worktree and use the dry-run check before applying. If the check fails, reconcile the conflicting paths against Gemini's current files and rerun verification before updating the panel.

```powershell
Set-Location 'C:/Users/cleme/Documents/GitHub/Neighborlens-AI'
git status --short
$geometryPatch = 'C:/Users/cleme/.codex/worktrees/f8f8/Neighborlens-AI/.data/nl03-nl04/NL03-NL04.patch'
git apply --check $geometryPatch
if ($LASTEXITCODE -ne 0) { throw 'Geometry patch conflicts with the target worktree.' }
git apply $geometryPatch
if ($LASTEXITCODE -ne 0) { throw 'Geometry patch could not be applied.' }
git diff --check
python -B scripts/generate_barangay_display_geometry.py --check
python -B scripts/audit_barangay_geometry.py --compare
```

Use the status rows above when integrating into the shared panel verification document. The handoff contains no database migration.
