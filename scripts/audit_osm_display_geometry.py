"""Verify the OSM-based display package and its separation from the operational reference."""
import argparse
from hashlib import sha256
from itertools import combinations
import json
from pathlib import Path

from pyproj import Transformer
from shapely import transform
from shapely.geometry import shape
from shapely.ops import unary_union

from align_osm_display_edges import aligned_features
from audit_barangay_geometry import ROOT, SOURCE_FILE, barangay_shapes, checked_shape, load

AREA_TOLERANCE_M2 = 0.0001
OPERATIONAL_VERSION = "bacolod-map-reference-v3"
OPERATIONAL_CITY_SHA256 = "e3918e98d774c3e555a6c583a739f82cd3a8864b7cd0931a09a9d64854514e61"
LOCATION_HINTS_SHA256 = "ceabd32dee2a6ca37605fb5611435880cd41921c0d5da7fe37556f7a72e490ca"


def audit(inputs, municipal_source):
    assets = ROOT / "frontend/assets"
    manifest, _ = load(assets / "bacolod-boundary-version.json")

    def entry(item):
        data, checksum = load(assets / item["file"])
        if checksum != item["sha256"]:
            raise ValueError(f"Checksum mismatch: {item['file']}")
        return data, checksum

    operational, operational_hash = entry(manifest["city"])
    hints, hints_hash = entry(manifest["barangays"])
    if (manifest["version"], operational_hash, hints_hash) != (
            OPERATIONAL_VERSION, OPERATIONAL_CITY_SHA256, LOCATION_HINTS_SHA256):
        raise ValueError("The operational city or legacy location reference changed")

    display = manifest["display"]
    city, city_hash = entry(display["city"])
    barangays, barangays_hash = entry(display["barangays"])
    if any(dataset["version"] != display["version"] for dataset in (city, barangays)):
        raise ValueError("The display layers have different versions")
    originals, _ = load(SOURCE_FILE)
    if [f["properties"] for f in barangays["features"]] != [f["properties"] for f in originals["features"]]:
        raise ValueError("Canonical barangay identifiers or names changed")

    parent = checked_shape(city["geometry"], "Display city")
    operational_parent = checked_shape(operational["geometry"], "Operational city")
    if city["geometry"] != operational["geometry"]:
        raise ValueError("The visible city differs from the pinned OSM land geometry")
    features = barangay_shapes(barangays, ROOT)
    legacy = barangay_shapes(hints, ROOT)
    project = Transformer.from_crs(4326, 32651, always_xy=True).transform

    def area(geometry):
        return transform(geometry.segmentize(0.0001), project, interleaved=False).area

    cover = unary_union(list(features.values()))
    uncovered = area(parent.difference(cover))
    exterior = area(cover.difference(parent))
    overlaps = [(a, b) for a, b in combinations(features, 2)
                if area(features[a].intersection(features[b])) > 1]
    if exterior > AREA_TOLERANCE_M2 or overlaps:
        raise ValueError("Display geometry failed containment or overlap checks")

    city_edges = {}
    for name in ("Mansilingan", "Granada"):
        # The union overlay verifies all coverage. Measure the exact shared segments separately.
        shared = parent.boundary.intersection(features[name].boundary)
        length = transform(shared.segmentize(0.0001), project, interleaved=False).length
        if length <= 0:
            raise ValueError(f"{name} does not share a display city edge")
        city_edges[name] = round(length, 4)

    result = {
        "display_version": display["version"],
        "authorization_city_version": manifest["version"],
        "sha256": {"authorization_city": operational_hash, "location_reference_barangays": hints_hash,
                   "display_city": city_hash, "display_barangays": barangays_hash},
        "area_crs": "EPSG:32651",
        "valid_barangays": len(features),
        "uncovered_display_city_m2": uncovered,
        "display_barangays_outside_display_city_m2": exterior,
        "overlap_pairs_over_one_m2": overlaps,
        "municipal_edge_shared_m": city_edges,
        "display_city_outside_authorization_city_m2": area(parent.difference(operational_parent)),
        "authorization_city_outside_display_city_m2": area(operational_parent.difference(parent)),
        "changed_barangay_shapes": sum(not g.equals(legacy[name]) for name, g in features.items()),
    }
    if municipal_source:
        municipalities, _ = load(municipal_source)
        neighboring = {"Murcia", "Talisay", "Bago City"}
        supplied = {f["properties"]["name"]: shape(f["geometry"]) for f in municipalities["features"]}
        intersections = {name: area(cover.intersection(supplied[name])) for name in sorted(neighboring)}
        result["neighbor_intersections_m2"] = intersections

    if inputs:
        source_path = inputs / "full_resolution_keep_pinned.geojson"
        source_bytes = source_path.read_bytes()
        if barangays["candidateSha256"] != sha256(source_bytes).hexdigest():
            raise ValueError("OSM-contained candidate checksum changed")
        expected, additions, ambiguous = aligned_features(json.loads(source_bytes)["features"], parent)
        if barangays["features"] != json.loads(json.dumps(expected)):
            raise ValueError("Packaged barangay coordinates differ from the deterministic display alignment")
        result["aligned_components"] = {
            name: {"components": len(parts), "added_area_m2": sum(area(part) for part in parts),
                   "remaining_area_m2": sum(area(part.difference(features[name])) for part in parts)}
            for name, parts in additions.items()
        }
        result["unassigned_edge_components_above_one_m2"] = [
            {"barangays": neighbors, "area_m2": round(area(piece), 2),
             "coordinates": list(piece.representative_point().coords)[0]}
            for piece, neighbors in ambiguous if area(piece) > 1
        ]
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--candidate-directory", type=Path)
    parser.add_argument("--municipal-source", type=Path)
    arguments = parser.parse_args()
    print(json.dumps(audit(arguments.candidate_directory, arguments.municipal_source), indent=2))
