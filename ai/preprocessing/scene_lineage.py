import hashlib
import itertools
import multiprocessing
import re
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import cv2
import imagehash
import numpy as np
from PIL import Image

SPLITS = ("train", "valid", "test")
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
ROBOFLOW_SUFFIX = re.compile(r"\.rf\.[0-9a-f]{32}$")
FEATURE_SIZE = 512
WATERMARK_CROP_FRACTION = 0.12
RATIO_TEST = 0.75
RANSAC_PIXEL_TOLERANCE = 3.0
DUPLICATE_MIN_INLIERS = 200
REVIEW_MIN_INLIERS = 40
PHASH_DUPLICATE_DISTANCE = 6


def roboflow_stem(file_name):
    return ROBOFLOW_SUFFIX.sub("", Path(file_name).stem)


def sha256_of(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def phash_pair(path):
    with Image.open(path) as image:
        image = image.convert("RGB")
        return (
            imagehash.phash(image),
            imagehash.phash(image.transpose(Image.FLIP_LEFT_RIGHT)),
        )


def _sift_features(path):
    gray = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
    if gray is None:
        return None
    keep_rows = int(gray.shape[0] * (1.0 - WATERMARK_CROP_FRACTION))
    gray = cv2.resize(gray[:keep_rows], (FEATURE_SIZE, FEATURE_SIZE))
    sift = cv2.SIFT_create(nfeatures=1500)
    key_points, descriptors = sift.detectAndCompute(gray, None)
    if descriptors is None or len(key_points) < 10:
        return None
    points = np.float32([point.pt for point in key_points])
    flipped_points = points.copy()
    flipped_points[:, 0] = FEATURE_SIZE - 1 - flipped_points[:, 0]
    flipped_gray = cv2.flip(gray, 1)
    flipped_kp, flipped_desc = sift.detectAndCompute(flipped_gray, None)
    flipped = None
    if flipped_desc is not None and len(flipped_kp) >= 10:
        flipped = (np.float32([point.pt for point in flipped_kp]), flipped_desc)
    return points, descriptors, flipped


def _match_inliers(first, second):
    points_a, desc_a = first
    points_b, desc_b = second
    matcher = cv2.BFMatcher()
    matches = matcher.knnMatch(desc_a, desc_b, k=2)
    good = [pair[0] for pair in matches if len(pair) == 2 and pair[0].distance < RATIO_TEST * pair[1].distance]
    if len(good) < 8:
        return 0
    source = points_a[[match.queryIdx for match in good]]
    target = points_b[[match.trainIdx for match in good]]
    _, mask = cv2.findHomography(source, target, cv2.RANSAC, RANSAC_PIXEL_TOLERANCE)
    return int(mask.sum()) if mask is not None else 0


def pair_inliers(features_a, features_b):
    if features_a is None or features_b is None:
        return 0, False
    direct = _match_inliers(features_a[:2], features_b[:2])
    mirrored = 0
    if features_a[2] is not None:
        mirrored = _match_inliers(features_a[2], features_b[:2])
    if mirrored > direct:
        return mirrored, True
    return direct, False


_WORKER_FEATURES = []


def select_mp_context(available_methods=None):
    methods = multiprocessing.get_all_start_methods() if available_methods is None else available_methods
    return multiprocessing.get_context("fork" if "fork" in methods else "spawn")


def _extract_one(path):
    return _sift_features(path)


def _init_compare_worker(features):
    global _WORKER_FEATURES
    _WORKER_FEATURES = features


def _compare_chunk(index_pairs):
    results = []
    for i, j in index_pairs:
        inliers, mirrored = pair_inliers(_WORKER_FEATURES[i], _WORKER_FEATURES[j])
        if inliers >= REVIEW_MIN_INLIERS:
            results.append((i, j, inliers, mirrored))
    return results


def sift_pair_scores(paths, workers=None, pairs=None, context=None):
    context = context or select_mp_context()
    paths = [str(path) for path in paths]
    with ProcessPoolExecutor(max_workers=workers, mp_context=context) as pool:
        features = list(pool.map(_extract_one, paths, chunksize=4))
    if pairs is None:
        pairs = list(itertools.combinations(range(len(paths)), 2))
    pairs = list(pairs)
    chunk_size = 200
    chunks = [pairs[start:start + chunk_size] for start in range(0, len(pairs), chunk_size)]
    results = []
    with ProcessPoolExecutor(
        max_workers=workers,
        mp_context=context,
        initializer=_init_compare_worker,
        initargs=(features,),
    ) as pool:
        for part in pool.map(_compare_chunk, chunks):
            results.extend(part)
    return results


class UnionFind:
    def __init__(self, size):
        self.parent = list(range(size))

    def find(self, item):
        while self.parent[item] != item:
            self.parent[item] = self.parent[self.parent[item]]
            item = self.parent[item]
        return item

    def union(self, first, second):
        root_a, root_b = self.find(first), self.find(second)
        if root_a != root_b:
            self.parent[max(root_a, root_b)] = min(root_a, root_b)


def collect_images(dataset_root):
    dataset_root = Path(dataset_root)
    records = []
    for split in SPLITS:
        images_dir = dataset_root / split / "images"
        if not images_dir.is_dir():
            continue
        for path in sorted(images_dir.iterdir()):
            if path.is_file() and path.suffix.lower() in IMAGE_EXTENSIONS:
                records.append({"split": split, "path": path, "file": path.name})
    return records


def build_scene_groups(dataset_root, workers=None):
    records = collect_images(dataset_root)
    union = UnionFind(len(records))
    evidence = defaultdict(list)

    by_sha = defaultdict(list)
    for index, record in enumerate(records):
        record["sha256"] = sha256_of(record["path"])
        record["stem"] = roboflow_stem(record["file"])
        record["phash"], record["phash_flipped"] = phash_pair(record["path"])
        by_sha[record["sha256"]].append(index)
    for members in by_sha.values():
        for other in members[1:]:
            union.union(members[0], other)
            evidence[(members[0], other)].append("sha256")

    for i, j in itertools.combinations(range(len(records)), 2):
        distance = min(
            records[i]["phash"] - records[j]["phash"],
            records[i]["phash"] - records[j]["phash_flipped"],
        )
        if distance <= PHASH_DUPLICATE_DISTANCE:
            union.union(i, j)
            evidence[(i, j)].append(f"phash<={distance}")

    review_pairs = []
    for i, j, inliers, mirrored in sift_pair_scores([record["path"] for record in records], workers):
        if inliers >= DUPLICATE_MIN_INLIERS:
            union.union(i, j)
            evidence[(i, j)].append(f"sift_inliers={inliers}{'_mirrored' if mirrored else ''}")
        else:
            review_pairs.append(
                {
                    "a": records[i]["file"],
                    "a_split": records[i]["split"],
                    "b": records[j]["file"],
                    "b_split": records[j]["split"],
                    "inliers": inliers,
                    "mirrored": mirrored,
                }
            )

    roots = sorted({union.find(index) for index in range(len(records))})
    scene_ids = {root: f"scene_{number:04d}" for number, root in enumerate(roots, start=1)}
    for index, record in enumerate(records):
        record["scene_id"] = scene_ids[union.find(index)]
    review_pairs.sort(key=lambda item: -item["inliers"])
    evidence_rows = [
        {"a": records[i]["file"], "b": records[j]["file"], "evidence": sorted(set(reasons))}
        for (i, j), reasons in sorted(evidence.items())
    ]
    return records, review_pairs, evidence_rows
