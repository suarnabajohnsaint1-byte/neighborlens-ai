"""Check the bundled display references. Requires Shapely and pyproj."""
import argparse
from collections import Counter
from hashlib import sha256
from itertools import combinations
import json
from pathlib import Path
import subprocess

from pyproj import Transformer
from shapely import transform
from shapely.geometry import Point, Polygon, shape
from shapely.ops import unary_union
from shapely.validation import explain_validity

ROOT = Path(__file__).resolve().parents[1]
CITY_FILE = ROOT / "frontend/assets/bacolod-city-boundary.json"
DISPLAY_FILE = ROOT / "frontend/assets/bacolod-barangay-boundaries.json"
SOURCE_FILE = ROOT / "data/geometry/bacolod-barangay-boundaries-source-v3.json"
# About one micrometre at Bacolod. Independent of the 1 m² reporting threshold.
EDGE_TOLERANCE_DEGREES = 1e-11
AREA_TOLERANCE_M2 = 0.0001
SIGNIFICANT_AREA_M2 = 1


def load(path):
    # Match the frontend and server manifest checks and Git's normalized text.
    data = path.read_bytes().replace(b"\r\n", b"\n")
    return json.loads(data), sha256(data).hexdigest()


def checked_shape(geometry, name):
    kind = geometry.get("type")
    if kind not in ("Polygon", "MultiPolygon"):
        raise ValueError(f"{name}: unsupported geometry type {kind}")
    coordinates = geometry["coordinates"]
    polygons = [coordinates] if kind == "Polygon" else coordinates
    if not polygons or any(not polygon for polygon in polygons):
        raise ValueError(f"{name}: missing polygon coordinates")
    for polygon in polygons:
        for ring in polygon:
            if len(ring) < 4 or ring[0] != ring[-1]:
                raise ValueError(f"{name}: unclosed or incomplete ring")
            if any(len(point) < 2 or not -180 <= point[0] <= 180 or not -90 <= point[1] <= 90 for point in ring):
                raise ValueError(f"{name}: invalid WGS84 coordinate ranges")

    parsed = shape(geometry)
    if parsed.is_empty or not parsed.is_valid:
        raise ValueError(f"{name}: {explain_validity(parsed)}")
    return parsed


def barangay_shapes(collection, root):
    catalog = subprocess.check_output(
        ["node", "-e", "console.log(JSON.stringify(require('./server/infrastructure/database/barangayCatalog').BACOLOD_BARANGAY_CATALOG.map(b => b.name)))"],
        cwd=root, text=True,
    )
    features = collection["features"]
    if collection.get("type") != "FeatureCollection" or any(f.get("type") != "Feature" for f in features):
        raise ValueError("Expected a GeoJSON FeatureCollection of barangays")
    names = Counter(f["properties"]["name"] for f in features)
    codes = Counter(f["properties"]["code"] for f in features)
    if len(features) != 61 or set(names) != set(json.loads(catalog)) or any(n != 1 for n in (*names.values(), *codes.values())):
        raise ValueError("Boundary identifiers or names disagree with the barangay catalog")
    if any(not isinstance(code, str) or not code for code in codes):
        raise ValueError("Missing barangay identifier")
    return {f["properties"]["name"]: checked_shape(f["geometry"], f["properties"]["name"]) for f in features}


def polygon_parts(geometry):
    if geometry.is_empty:
        return
    if geometry.geom_type == "Polygon":
        yield geometry
    elif geometry.geom_type in ("MultiPolygon", "GeometryCollection"):
        for part in geometry.geoms:
            yield from polygon_parts(part)


def audit(root, dataset=None):
    """Retain the historical project-vertices-first measurements for comparison."""
    assets = root / "frontend/assets"
    collection, barangay_hash = load(dataset or assets / DISPLAY_FILE.name)
    city, city_hash = load(assets / CITY_FILE.name)
    geographic = barangay_shapes(collection, root)
    city_shape = checked_shape(city["geometry"], "Bacolod City")

    project = Transformer.from_crs(4326, 32651, always_xy=True).transform
    projected = {name: transform(g, project, interleaved=False) for name, g in geographic.items()}
    city_m = transform(city_shape, project, interleaved=False)
    union = unary_union(list(projected.values()))
    overlaps = [(a, b, g.intersection(h).area) for (a, g), (b, h) in combinations(projected.items(), 2)]
    villamonte = projected["Villamonte"]
    neighboring = {}
    for name in ["Mandalagan", "Estefania", "Taculing", "Barangay 41", "Vista Alegre", "Montevista"]:
        other = projected[name]
        neighboring[name] = {
            "separation_m": round(villamonte.distance(other), 2),
            "overlap_m2": round(villamonte.intersection(other).area, 2),
            "identical_border_m": round(villamonte.boundary.intersection(other.boundary).length, 2),
        }
    holes = []
    reference = geographic["Villamonte"]
    parts = reference.geoms if reference.geom_type == "MultiPolygon" else [reference]
    for ring in (ring for part in parts for ring in part.interiors):
        hole = Polygon(ring)
        point = hole.representative_point()
        hole_m = transform(hole, project, interleaved=False)
        holes.append({
            "point": {"latitude": point.y, "longitude": point.x},
            "area_ha": round(hole_m.area / 10000, 4),
            "matches": [name for name, boundary in geographic.items() if boundary.contains(point)],
            "montevista_coverage_pct": round(hole_m.intersection(projected["Montevista"]).area / hole_m.area * 100, 4),
        })
    lat, lng = 10.6854, 122.9873
    estimated_label = Point(lng, lat)
    return {
        "overlay_method": "legacy_vertex_projection_then_overlay",
        "barangay_source": collection.get("source"),
        "city_source": city["properties"].get("source"),
        "barangay_sha256": barangay_hash,
        "city_sha256": city_hash,
        "features_by_geometry_type": Counter(g.geom_type for g in geographic.values()),
        "villamonte_area": {"m2": round(villamonte.area, 2), "ha": round(villamonte.area / 10000, 2),
                           "km2": round(villamonte.area / 1000000, 5)},
        "villamonte_reference_adjacency": neighboring,
        "villamonte_holes": holes,
        "estimated_basemap_label": {
            "latitude": lat, "longitude": lng,
            "matches": [name for name, geometry in geographic.items() if geometry.contains(estimated_label)],
            "distance_from_villamonte_m": round(villamonte.distance(transform(estimated_label, project, interleaved=False)), 2),
        },
        "overlaps_over_one_m2": [[a, b, round(area, 2)] for a, b, area in overlaps if area > SIGNIFICANT_AREA_M2],
        "city_uncovered_ha": round(city_m.difference(union).area / 10000, 2),
        "barangays_outside_city_ha": round(union.difference(city_m).area / 10000, 2),
    }


def compare(source, corrected, city, root):
    """Overlay in GeoJSON coordinates, then measure the resulting areas in UTM."""
    if [f["properties"] for f in source["features"]] != [f["properties"] for f in corrected["features"]]:
        raise ValueError("Barangay identifiers or names changed")
    before = barangay_shapes(source, root)
    after = barangay_shapes(corrected, root)
    parent = checked_shape(city["geometry"], "Bacolod City")
    numerical_envelope = parent.buffer(EDGE_TOLERANCE_DEGREES)
    project = Transformer.from_crs(4326, 32651, always_xy=True).transform

    def area(geometry):
        # Densify only the measurement geometry before the nonlinear projection.
        # Match the same straight WGS84 edges even when an overlay splits them.
        return transform(geometry.segmentize(0.0001), project, interleaved=False).area

    outside = []
    for name, original in before.items():
        result = after[name]
        source_outside = original.difference(parent)
        display_outside = result.difference(parent)
        if (not numerical_envelope.covers(result)
                or area(display_outside) > AREA_TOLERANCE_M2
                or area(result.symmetric_difference(original.intersection(parent))) > AREA_TOLERANCE_M2):
            raise ValueError(f"{name}: display geometry differs from the pinned city intersection")
        if not source_outside.is_empty:
            sample = max(polygon_parts(source_outside), key=area).representative_point()
            outside.append({
                "barangay": name, "before_m2": area(source_outside), "after_m2": area(display_outside),
                "sample": {"latitude": sample.y, "longitude": sample.x},
            })

    overlaps = []
    for a, b in combinations(before, 2):
        before_m2 = area(before[a].intersection(before[b]))
        after_m2 = area(after[a].intersection(after[b]))
        if after_m2 > before_m2 + AREA_TOLERANCE_M2:
            raise ValueError(f"{a} / {b}: overlap increased")
        if max(before_m2, after_m2) > SIGNIFICANT_AREA_M2:
            overlaps.append({"barangays": [a, b], "before_m2": before_m2, "after_m2": after_m2})

    before_union, after_union = unary_union(list(before.values())), unary_union(list(after.values()))
    before_gap, after_gap = parent.difference(before_union), parent.difference(after_union)
    added_gap = area(after_gap.difference(before_gap))
    if added_gap > AREA_TOLERANCE_M2:
        raise ValueError(f"Clipping introduced {added_gap} m² of new gap area")

    # Report each significant pre-existing uncovered component. Include smaller
    # components in the aggregate totals.
    gaps = []
    for gap in polygon_parts(before_gap):
        gap_area = area(gap)
        if gap_area > SIGNIFICANT_AREA_M2:
            point = gap.representative_point()
            gaps.append({
                "barangays": [name for name, boundary in before.items()
                              if gap.distance(boundary) <= EDGE_TOLERANCE_DEGREES],
                "city_edge": gap.distance(parent.boundary) <= EDGE_TOLERANCE_DEGREES,
                "before_m2": gap_area, "after_m2": area(gap.intersection(after_gap)),
                "sample": {"latitude": point.y, "longitude": point.x},
            })
    return {
        "area_crs": "EPSG:32651",
        "display_version": corrected.get("version"),
        "valid_features": {"before": len(before), "after": len(after)},
        "outside_union_m2": {"before": area(before_union.difference(parent)),
                             "after": area(after_union.difference(parent))},
        "outside_by_barangay": outside,
        "overlap_pairs_over_one_m2": {stage: sum(row[stage + "_m2"] > SIGNIFICANT_AREA_M2 for row in overlaps)
                                       for stage in ("before", "after")},
        "overlaps": overlaps,
        "uncovered_city_m2": {"before": area(before_gap), "after": area(after_gap)},
        "added_gap_m2": added_gap,
        "gaps_over_one_m2": sorted(gaps, key=lambda gap: -gap["before_m2"]),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--source", action="store_true", help="run the historical audit on the preserved source")
    mode.add_argument("--compare", action="store_true", help="verify clipping and inventory changes against the source")
    parser.add_argument("--output", type=Path, help="write the JSON report as UTF-8")
    args = parser.parse_args()
    report = (compare(load(SOURCE_FILE)[0], load(DISPLAY_FILE)[0], load(CITY_FILE)[0], ROOT)
              if args.compare else audit(ROOT, SOURCE_FILE if args.source else DISPLAY_FILE))
    output = json.dumps(report, indent=2) + "\n"
    if args.output:
        args.output.write_text(output, encoding="utf-8", newline="\n")
    else:
        print(output, end="")
