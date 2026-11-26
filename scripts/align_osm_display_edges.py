"""Align unambiguous barangay display edges with the pinned OSM land city."""
import argparse
from hashlib import sha256
import json
from pathlib import Path

from shapely.geometry import mapping, shape
from shapely.ops import unary_union

from audit_barangay_geometry import EDGE_TOLERANCE_DEGREES, ROOT, checked_shape, load, polygon_parts

VERSION = "bacolod-display-osm-land-v3"
SOURCE_SHA256 = "cfd886c22df44413c640a3f883e88f0a9671b138eaeeff9c2d256a17b0790985"


def aligned_features(features, city):
    polygons = {f["properties"]["name"]: checked_shape(f["geometry"], f["properties"]["name"]) for f in features}
    uncovered = city.difference(unary_union(list(polygons.values())))
    additions = {name: [] for name in polygons}
    ambiguous = []
    for piece in polygon_parts(uncovered):
        # Use tolerance for classifying contact only; never buffer the assigned polygon.
        if city.boundary.intersection(piece.buffer(EDGE_TOLERANCE_DEGREES)).length <= 1e-9:
            continue
        neighbors = [name for name, polygon in polygons.items()
                     if piece.distance(polygon) <= EDGE_TOLERANCE_DEGREES]
        if len(neighbors) == 1:
            additions[neighbors[0]].append(piece)
        else:
            ambiguous.append((piece, neighbors))

    additions = {name: parts for name, parts in additions.items() if parts}

    aligned = []
    for feature in features:
        name = feature["properties"]["name"]
        if name not in additions:
            aligned.append(feature)
            continue
        geometry = mapping(unary_union([polygons[name], *additions[name]]).normalize())
        checked_shape(geometry, name)
        aligned.append({**feature, "geometry": geometry})
    return aligned, additions, ambiguous


def generate(source, check):
    assets = ROOT / "frontend/assets"
    manifest_path = assets / "bacolod-boundary-version.json"
    manifest, _ = load(manifest_path)
    display = manifest["display"]
    source_data, checksum = load(source)
    if checksum != SOURCE_SHA256:
        raise ValueError("Expected the pinned OSM display v1 barangay asset")
    city_path = assets / display["city"]["file"]
    city, _ = load(city_path)
    operational, operational_hash = load(assets / manifest["city"]["file"])
    if city["geometry"] != operational["geometry"] or operational_hash != manifest["city"]["sha256"]:
        raise ValueError("Display city is not the pinned OSM geometry")
    aligned, additions, _ = aligned_features(source_data["features"], shape(city["geometry"]))
    barangays = {**source_data, "features": aligned, "version": VERSION,
                "edgeAlignment": {"barangays": sorted(additions), "baseDisplaySha256": checksum, "use": "Display only"}}
    display["version"] = VERSION
    for key, dataset in (("city", {**city, "version": VERSION}), ("barangays", barangays)):
        payload = (json.dumps(dataset, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        entry = display[key]
        entry["sha256"] = sha256(payload).hexdigest()
        write_or_check(assets / entry["file"], payload, check)
    write_or_check(manifest_path, (json.dumps(manifest, indent=2) + "\n").encode("utf-8"), check)


def write_or_check(path, data, check):
    if check:
        if path.read_bytes().replace(b"\r\n", b"\n") != data:
            raise ValueError(f"Generated output differs: {path.name}")
    else:
        path.write_bytes(data)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("base_display", type=Path, help="Pinned OSM display v1 barangay asset")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    generate(args.base_display, args.check)
