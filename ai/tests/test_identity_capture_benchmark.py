import csv
import hashlib
import tempfile
import unittest
from pathlib import Path

import numpy as np

from ai.identity.benchmark_capture_cohorts import load_captures, metrics, threshold_for_sharpness
from ai.identity.benchmark_id_signals import document_quad, low_document_chroma, rectify_document, spectral_peak


class IdentityCaptureBenchmarkTests(unittest.TestCase):
    def test_document_annotation_is_bound_to_exact_frame(self):
        annotation = {"_via_img_metadata": {"synthetic": {"filename": "frame.jpg", "size": 200,
            "regions": [{"region_attributes": {"field_name": "doc_quad"},
                         "shape_attributes": {"all_points_x": [10, 170, 170, 10], "all_points_y": [10, 10, 110, 110]}}],
        }}}
        quad = document_quad(annotation, "frame.jpg", 200)
        warped = rectify_document(np.full((120, 180, 3), 120, dtype=np.uint8), quad)
        self.assertEqual(warped.shape, (100, 160, 3))
        with self.assertRaisesRegex(ValueError, "Annotation/frame mismatch"):
            document_quad(annotation, "frame.jpg", 201)

    def test_local_features_react_to_known_synthetic_signals(self):
        plain = np.full((320, 480, 3), 160, dtype=np.uint8)
        color = plain.copy()
        color[:, :240] = [100, 30, 120]
        self.assertGreater(low_document_chroma(plain), low_document_chroma(color))
        y, x = np.mgrid[:320, :480]
        stripes = (160 + 24 * np.sin(2 * np.pi * (0.17 * x + 0.09 * y))).astype(np.uint8)
        self.assertGreater(spectral_peak(np.repeat(stripes[..., None], 3, axis=-1)), spectral_peak(plain))

    def test_confusion_metrics_and_fixed_baseline(self):
        report = metrics([0.1, 0.8], [0.7, 0.2], 0.5)
        self.assertEqual([report[key] for key in ("tn", "fp", "tp", "fn")], [1, 1, 1, 1])
        for key in ("precision", "recall", "f1", "false_positive_rate", "false_negative_rate"):
            self.assertEqual(report[key], 0.5)
        self.assertIsNone(metrics([0], [0], 0.5)["precision"])
        self.assertEqual(threshold_for_sharpness([-50, -40], [-30, -20]), -35)

    def test_manifest_rejects_original_document_shared_across_splits(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "manifest.csv"
            fields = ["clip", "document", "split", "camera", "condition", "path", "sha256"]
            with path.open("w", newline="", encoding="utf-8") as output:
                writer = csv.DictWriter(output, fields)
                writer.writeheader()
                for split, clip in [("validation", "mock/01.or0001"), ("test", "mock/01.re0001")]:
                    data = split.encode()
                    (root / split).write_bytes(data)
                    writer.writerow({"clip": clip, "document": "mock/01", "split": split, "camera": split,
                                     "condition": split, "path": split, "sha256": hashlib.sha256(data).hexdigest()})
            with self.assertRaisesRegex(ValueError, "leaks across splits"):
                load_captures(path)
