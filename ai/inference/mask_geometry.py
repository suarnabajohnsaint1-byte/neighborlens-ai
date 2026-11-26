"""Geometry on a binary candidate mask, measured on its analysis grid."""

import math

import cv2
import numpy as np


def binary_mask(mask):
    if mask.ndim != 2 or not mask.size or mask.dtype not in (np.bool_, np.uint8):
        raise ValueError("Expected a two-dimensional binary mask")
    if np.any((mask != 0) & (mask != 1)):
        raise ValueError("Mask values must be zero or one")
    return np.ascontiguousarray(mask, dtype=np.uint8)


def reference_coverage(damage, reference):
    """Visible coverage from a delineated surface/opening in the same oriented view."""
    damage, reference = binary_mask(damage), binary_mask(reference)
    if damage.shape != reference.shape or not reference.any() or (damage > reference).any():
        raise ValueError("Damage and reference masks must be comparable and damage contained in reference")
    return {"affected_area_px2": int(damage.sum()), "reference_area_px2": int(reference.sum()),
            "visible_fraction": float(damage.sum() / reference.sum())}


def thin(mask):
    """Zhang-Suen thinning. Padding keeps boundary pixels in the same coordinate system."""
    plane = np.pad(binary_mask(mask), 1)
    center = plane[1:-1, 1:-1]
    ring = [plane[:-2, 1:-1], plane[:-2, 2:], plane[1:-1, 2:], plane[2:, 2:],
            plane[2:, 1:-1], plane[2:, :-2], plane[1:-1, :-2], plane[:-2, :-2]]
    north, east, south, west = ring[::2]
    while True:
        changed = False
        for phase in (0, 1):
            neighbors = sum(ring)
            starts = sum(((a == 0) & (b == 1)).astype(np.uint8) for a, b in zip(ring, ring[1:] + ring[:1]))
            removable = ((center == 1) & (neighbors >= 2) & (neighbors <= 6) & (starts == 1))
            if phase == 0:
                removable &= (north * east * south == 0) & (east * south * west == 0)
            else:
                removable &= (north * east * west == 0) & (north * south * west == 0)
            if removable.any():
                center[removable] = 0
                changed = True
        if not changed:
            return center.copy()


def crack_geometry(mask):
    skeleton = thin(mask)
    # Count each undirected edge once. A diagonal is redundant if either
    # intervening orthogonal pixel already connects both endpoints.
    degrees = np.zeros_like(skeleton)
    length = 0.0
    for dy, dx in ((0, 1), (1, 0), (1, 1), (1, -1)):
        height, width = skeleton.shape
        rows, cols = slice(0, height - dy), slice(max(0, -dx), min(width, width - dx))
        other_rows, other_cols = slice(dy, height), slice(max(0, dx), min(width, width + dx))
        edges = skeleton[rows, cols] & skeleton[other_rows, other_cols]
        if dx and dy:
            edges &= 1 - (skeleton[rows, other_cols] | skeleton[other_rows, cols])
        degrees[rows, cols] += edges
        degrees[other_rows, other_cols] += edges
        length += int(edges.sum()) * math.hypot(dx, dy)
    branches = cv2.connectedComponents((degrees >= 3).astype(np.uint8))[0] - 1
    data = {"skeleton_length_px": round(length, 3), "branch_clusters": branches}
    if length:
        data["mean_strip_width_px"] = round(int(mask.sum()) / length, 3)
    return data


def compact_regions(response, threshold, min_size, seed_threshold=None):
    """Keep connected candidates, optionally requiring a strong ridge seed."""
    mask = (response > threshold).astype(np.uint8)
    _, labels, stats, _ = cv2.connectedComponentsWithStats(mask)
    keep = stats[:, cv2.CC_STAT_AREA] >= min_size
    if seed_threshold is not None:
        seed_labels = labels[(response >= seed_threshold) & (response > 0)]
        keep &= np.bincount(seed_labels, minlength=len(stats)) > 0
    keep[0] = False
    return keep[labels].astype(np.uint8)


def region_geometry(mask):
    mask = binary_mask(mask)
    area = int(mask.sum())
    if area == 0 or area == mask.size:
        raise ValueError("No separable foreground")
    count, _, stats, _ = cv2.connectedComponentsWithStats(mask)
    return {"candidate_area_px2": area, "crop_fraction": round(area / mask.size, 6),
            "components": count - 1,
            "largest_component_fraction": round(int(stats[1:, cv2.CC_STAT_AREA].max()) / area, 6)}
