"""Generate the versioned barangay display asset from the pinned source."""
import argparse
from hashlib import sha256
import json

from shapely.geometry import MultiPolygon, mapping

from audit_barangay_geometry import (
    CITY_FILE, DISPLAY_FILE, ROOT, SOURCE_FILE, barangay_shapes, checked_shape, load, polygon_parts,
)

CITY_SHA256 = "e3918e98d774c3e555a6c583a739f82cd3a8864b7cd0931a09a9d64854514e61"
SOURCE_SHA256 = "0ccc3cbb15797a886f01ec9db4674598feb38ce9493083750aba6802d45e3d10"
DISPLAY_VERSION = "bacolod-barangay-display-v4"
MANIFEST_FILE = DISPLAY_FILE.with_name("bacolod-boundary-version.json")


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def generate():
    source, source_hash = load(SOURCE_FILE)
    city, city_hash = load(CITY_FILE)
    manifest, _ = load(MANIFEST_FILE)
    if source_hash != SOURCE_SHA256 or city_hash != CITY_SHA256:
        raise ValueError("The source barangays or pinned city geometry changed")
    if manifest["city"] != {"file": CITY_FILE.name, "sha256": CITY_SHA256}:
        raise ValueError("The manifest no longer pins the original city geometry")
    parent = checked_shape(city["geometry"], "Bacolod City")
    originals = barangay_shapes(source, ROOT)
    features = []
    for feature in source["features"]:
        name = feature["properties"]["name"]
        original = originals[name]
        if parent.covers(original):
            features.append(feature)
            continue
        parts = list(polygon_parts(original.intersection(parent)))
        if not parts:
            raise ValueError(f"{name}: clipping removed all polygon area")
        clipped = parts[0] if len(parts) == 1 else MultiPolygon(parts)
        geometry = mapping(clipped.normalize())
        checked_shape(geometry, name)
        features.append({**feature, "geometry": geometry})

    metadata = {key: value for key, value in source.items() if key != "features"}
    metadata.update(
        usage="City-clipped boundaries for map reference only",
        version=DISPLAY_VERSION,
        derivedFrom={"barangaySourceSha256": source_hash, "citySha256": city_hash},
    )
    display = (compact(metadata)[:-1] + ',\n"features":[\n' +
               ",\n".join(compact(feature) for feature in features) + "\n]}\n").encode("utf-8")
    manifest["barangays"] = {
        "file": DISPLAY_FILE.name,
        "version": DISPLAY_VERSION,
        "sha256": sha256(display).hexdigest(),
    }
    return {
        DISPLAY_FILE: display,
        MANIFEST_FILE: (json.dumps(manifest, indent=2) + "\n").encode("utf-8"),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="verify outputs without writing files")
    args = parser.parse_args()
    for path, data in generate().items():
        if args.check:
            if path.read_bytes().replace(b"\r\n", b"\n") != data:
                parser.exit(1, f"{path.name} differs from generated output\n")
        else:
            path.write_bytes(data)
