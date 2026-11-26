import io
import unittest
from unittest.mock import patch

from PIL import Image, ImageDraw, UnidentifiedImageError

from ai.identity.benchmark_fraud_scores import evaluate, evaluate_pad
from ai.identity.capture_ocr import capture_evidence
from ai.identity.forensics import decode_frame


class IdentityForensicsTests(unittest.TestCase):
    def test_pad_metrics_report_worn_and_missing_cohorts(self):
        rows = [
            {"sample_id": str(i), "split": split, "category": group,
             "document_id": str(i), "session_id": str(i), "fraud_score": score}
            for i, (split, group, score) in enumerate([
                ("validation", "genuine", .99), ("test", "genuine", .1),
                ("test", "genuine_worn", .8), ("test", "monitor_recapture", .9)
            ])
        ]
        result = evaluate_pad(rows, .5)
        self.assertEqual(result["bpcer"], .5)
        self.assertEqual(result["worn_false_rejection_rate"], 1)
        self.assertEqual(result["attack_metrics"]["monitor_recapture"]["apcer"], 0)
        self.assertIsNone(result["attack_metrics"]["phone_recapture"])
        for key in ["document_id", "session_id"]:
            leaked = [{**rows[0], key: rows[1][key]}, *rows[1:]]
            with self.assertRaisesRegex(ValueError, key):
                evaluate_pad(leaked, .5)

    def test_capture_ocr_retries_dense_text_without_changing_the_original(self):
        output = io.BytesIO()
        Image.new("RGB", (900, 560), "white").save(output, format="JPEG")
        original = output.getvalue()
        with patch("ai.identity.capture_ocr._read_text", side_effect=[
            "LAND TRANSPORTATION OFFICE",
            "LAND TRANSPORTATION OFFICE\nLICENSE NO. N17-23-556789",
        ]) as read:
            self.assertEqual(capture_evidence("ocr", original)["captureDocument"], {
                "documentType": "DRIVERS_LICENSE", "idNumber": "N1723556789"
            })
            self.assertEqual(read.call_args_list[0].args[1:3], (original, "11"))
            self.assertEqual(read.call_args_list[1].args[2], "6")
            self.assertTrue(read.call_args_list[1].args[1].startswith(b"\x89PNG"))

    def test_capture_ocr_does_not_choose_between_conflicting_numbers(self):
        with patch("ai.identity.capture_ocr._read_text", return_value=(
            "DRIVER'S LICENSE\nN17-23-556789\nN17-23-556788"
        )) as read:
            self.assertIsNone(capture_evidence("ocr", b"unused")["captureDocument"])
            read.assert_called_once()

    def test_capture_ocr_accepts_ocr_dash_variants_without_correcting_digits(self):
        with patch("ai.identity.capture_ocr._read_text", return_value=(
            "DRIVER'S LICENSE\nN17 – 23 — 556789"
        )) as read:
            self.assertEqual(capture_evidence("ocr", b"unused")["captureDocument"], {
                "documentType": "DRIVERS_LICENSE", "idNumber": "N1723556789"
            })
            read.assert_called_once()

    def test_search_interface_requires_search_text_and_distinct_visible_controls(self):
        card = "LAND TRANSPORTATION OFFICE\nN17-23-556789\n"
        for context, expected in [
            ("GOOGLE IMAGES\nVISIT\nSAVE\n", True),
            ("GOOGLE LENS\nSHARE\nSHARE\n", False),
            ("VISIT\nSHARE\nSAVE\n", False),
            ("SCRATCHED PRINTING\nSAVE OUR CITY\n", False),
        ]:
            with self.subTest(context=context), patch("ai.identity.capture_ocr._read_text", return_value=card + context):
                evidence = capture_evidence("ocr", b"unused")
                self.assertEqual(evidence["searchInterfaceDetected"], expected)
                self.assertEqual(evidence["captureDocument"]["idNumber"], "N1723556789")

    def test_decode_only_supported_single_frame_images(self):
        card = Image.new("RGB", (600, 400), "white")
        ImageDraw.Draw(card).text((20, 20), "SYNTHETIC TEST IMAGE", fill="black")
        output = io.BytesIO()
        card.save(output, format="JPEG")
        self.assertEqual(decode_frame(output.getvalue()).size, (600, 400))
        with self.assertRaises(UnidentifiedImageError):
            decode_frame(b"not an image")
        output = io.BytesIO()
        card.save(output, format="GIF")
        with self.assertRaises(ValueError):
            decode_frame(output.getvalue())

    def test_benchmark_keeps_attack_categories_and_errors_separate(self):
        scores = [
            {"sample_id": "a", "category": "genuine", "fraud_score": "0.80"},
            {"sample_id": "b", "category": "genuine", "fraud_score": "0.20"},
            {"sample_id": "c", "category": "monitor_recapture", "fraud_score": "0.90"},
            {"sample_id": "d", "category": "ai_edited", "fraud_score": "0.30"},
        ]
        report = evaluate(scores, 0.5, 0.1, 0.1)
        self.assertFalse(report["passed"])
        self.assertEqual(report["attack_metrics"]["monitor_recapture"], {
            "accuracy": 2 / 3, "precision": 0.5, "recall": 1, "f1": 2 / 3,
            "false_positive_rate": 0.5, "false_negative_rate": 0,
        })
        self.assertEqual(report["attack_metrics"]["ai_edited"]["false_negative_rate"], 1)
        self.assertEqual(report["attack_metrics"]["ai_edited"]["f1"], 0)
        with self.assertRaises(ValueError):
            evaluate(scores + scores[:1], 0.5, 0.1, 0.1)
