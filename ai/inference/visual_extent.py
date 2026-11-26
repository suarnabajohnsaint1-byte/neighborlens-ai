"""Versioned, image-plane observations for the existing damage assessment routes."""

import asyncio
import logging
import math
from concurrent.futures import ThreadPoolExecutor
from threading import BoundedSemaphore

import cv2
import numpy as np

if __package__:
    from .mask_geometry import compact_regions, crack_geometry, region_geometry
else:
    from mask_geometry import compact_regions, crack_geometry, region_geometry

SOURCE = "opencv_visual_extent"
VERSION = "1"
MAX_SIDE = 320
WORKERS = ThreadPoolExecutor(max_workers=2, thread_name_prefix="visual-extent")
SLOTS = BoundedSemaphore(2)


def road_response(gray, category):
    smooth = cv2.GaussianBlur(gray, (3, 3), 0)
    if category == "road_crack":
        kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (11, 11))
        return cv2.morphologyEx(smooth, cv2.MORPH_BLACKHAT, kernel)
    # Dark depressions are candidates. Shadows, patches and puddles share this signal.
    return 255 - cv2.GaussianBlur(smooth, (7, 7), 0)


def segmented_features(response, category):
    min_area = max(6, response.size // 2500)
    seed = None
    if category == "road_crack":
        # Hysteresis suppresses isolated pavement texture. Parameters were
        # selected for pixel-mask overlap, independently of damage severity.
        threshold, seed = np.percentile(response, [94, 99])
        min_area = max(6, round(response.size * 60 / (320 * 213)))
    else:
        threshold, _ = cv2.threshold(response, 0, 255, cv2.THRESH_BINARY | cv2.THRESH_OTSU)
    def segment(delta):
        return compact_regions(response, max(0, threshold + delta), min_area,
                               None if seed is None else seed + delta)
    mask = segment(0)
    features = region_geometry(mask)
    # Sensitivity to a 4-level intensity perturbation in either direction.
    # This measures numerical stability only, not semantic correctness.
    loose, strict = segment(-4), segment(4)
    features["threshold_stability_iou"] = round(int(strict.sum()) / max(1, int(loose.sum())), 5)
    if category == "road_crack":
        features.update(crack_geometry(mask))
    if category == "pothole":
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        largest = max(contours, key=cv2.contourArea)
        perimeter = cv2.arcLength(largest, True)
        if perimeter > 0:
            features["largest_contour_circularity"] = round(4 * math.pi * cv2.contourArea(largest) / perimeter**2, 6)
    return features, mask


def analyze_region(bgr, category, rect, *, collect_mask=None):
    result = {"source": SOURCE, "version": VERSION, "category": category, "quality": "UNUSABLE"}
    if bgr.ndim != 3 or bgr.shape[2] != 3 or bgr.dtype != np.uint8:
        return {**result, "reason": "INVALID_CROP"}
    x, y, w, h = rect
    height, width = bgr.shape[:2]
    if not all(math.isfinite(v) for v in rect) or min(x, y) < 0 or min(w, h) <= 0:
        return {**result, "reason": "INVALID_CROP"}
    left, top = math.floor(x), math.floor(y)
    right, bottom = min(width, math.ceil(x + w)), min(height, math.ceil(y + h))
    if x + w > width + .011 or y + h > height + .011 or min(right-left, bottom-top) < 12:
        return {**result, "reason": "INVALID_CROP"}
    crop = bgr[top:bottom, left:right]
    scale = min(1, MAX_SIDE / max(crop.shape[:2]))
    grid = (max(1, round(crop.shape[1] * scale)), max(1, round(crop.shape[0] * scale)))
    result.update(region=[left, top, right-left, bottom-top], grid=list(grid))
    if min(grid) < 12:
        return {**result, "reason": "INVALID_CROP"}
    gray = cv2.cvtColor(cv2.resize(crop, grid, interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
    low, high = np.percentile(gray, [2, 98])
    if high < 24 or low > 235 or high - low < 12:
        return {**result, "reason": "INSUFFICIENT_CONTRAST"}
    if cv2.Laplacian(gray, cv2.CV_32F).var() < 4:
        return {**result, "reason": "INSUFFICIENT_DETAIL"}
    if category in ("road_crack", "pothole", "clogged_drainage"):
        if category == "clogged_drainage":
            # Texture can locate material in the crop; it cannot identify the drain aperture.
            response = cv2.morphologyEx(gray, cv2.MORPH_GRADIENT, np.ones((3, 3), np.uint8))
        else:
            response = road_response(gray, category)
        try:
            features, mask = segmented_features(response, category)
        except ValueError:
            return {**result, "reason": "NO_SEPARABLE_REGION"}
        if collect_mask is not None:
            collect_mask(mask)
        reason = "DRAIN_OPENING_UNVERIFIED" if category == "clogged_drainage" else "CANDIDATE_MASK_ONLY"
    elif category == "broken_streetlight":
        edges = cv2.Canny(gray, 50, 150)
        lines = cv2.HoughLinesP(edges, 1, np.pi / 180, 12, minLineLength=max(8, min(grid)//4), maxLineGap=3)
        features = {"line_segments": 0 if lines is None else len(lines)}
        if lines is not None:
            dx, dy = np.diff(lines.reshape(-1, 2, 2), axis=1).reshape(-1, 2).T
            features["longest_line_px"] = round(float(np.hypot(dx, dy).max()), 3)
        reason = "FIXTURE_CONDITION_UNVERIFIED"
    else:
        return {**result, "reason": "UNSUPPORTED_CLASS"}
    return {**result, "quality": "EXPERIMENTAL", "reason": reason, "features": features}


async def visual_observation(bgr, detections, category, *, timeout=1.0):
    primary = max((d for d in detections if d.eligible and d.damage_type == category),
                  key=lambda d: d.confidence_score, default=None)
    if primary is None:
        return None
    fallback = {"source": SOURCE, "version": VERSION, "category": category, "quality": "UNUSABLE"}
    if not SLOTS.acquire(blocking=False):
        return {**fallback, "reason": "ANALYZER_BUSY"}
    try:
        box = primary.bounding_box
        future = WORKERS.submit(analyze_region, bgr, category, (box.x, box.y, box.width, box.height))
    except Exception:
        SLOTS.release()
        return {**fallback, "reason": "ANALYSIS_UNAVAILABLE"}
    # A timed-out native operation still owns its slot until it actually exits.
    future.add_done_callback(lambda _: SLOTS.release())
    try:
        return await asyncio.wait_for(asyncio.wrap_future(future), timeout)
    except TimeoutError:
        return {**fallback, "reason": "ANALYSIS_TIMEOUT"}
    except Exception as error:
        logging.getLogger(__name__).warning("Visual analysis unavailable (%s)", type(error).__name__)
        return {**fallback, "reason": "ANALYSIS_UNAVAILABLE"}
