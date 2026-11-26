"""Unit tests for the dependency-free parts of the image matcher."""

import sys
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "inference"))

from image_similarity import (  # noqa: E402
    ImageSimilarityError,
    check_image_match,
    cosine_similarity,
    validate_image_path,
)


class StubModel:
    def __init__(self, embeddings):
        self.embeddings = iter(embeddings)
        self.calls = []

    def embed(self, source, imgsz, verbose):
        self.calls.append((source, imgsz, verbose))
        return [next(self.embeddings)]


class SimilarityTests(unittest.TestCase):
    def test_cosine_similarity_matches_identical_vectors(self) -> None:
        self.assertAlmostEqual(cosine_similarity([1.0, 2.0], [1.0, 2.0]), 1.0)

    def test_cosine_similarity_rejects_different_dimensions(self) -> None:
        with self.assertRaises(ImageSimilarityError):
            cosine_similarity([1.0], [1.0, 2.0])

    def test_image_path_requires_supported_extension(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "damage.txt"
            path.write_text("not an image", encoding="utf-8")
            with self.assertRaises(ImageSimilarityError):
                validate_image_path(path)

    def test_identical_images_use_phash_without_loading_yolo(self) -> None:
        with TemporaryDirectory() as directory:
            first = Path(directory) / "first.png"
            second = Path(directory) / "second.png"
            image = Image.new("RGB", (120, 80), (80, 120, 160))
            image.save(first)
            image.save(second)

            result = check_image_match(first, second, model=StubModel([]))

            self.assertTrue(result["is_match"])
            self.assertEqual(result["similarity_score"], 1.0)
            self.assertLessEqual(result["phash_difference"], 5)

    def test_non_duplicate_images_use_letterboxed_yolo_embeddings(self) -> None:
        with TemporaryDirectory() as directory:
            first = Path(directory) / "first.png"
            second = Path(directory) / "second.png"
            first_image = Image.new("RGB", (120, 80), (0, 0, 0))
            second_image = Image.new("RGB", (120, 80), (0, 0, 0))
            ImageDraw.Draw(first_image).rectangle((10, 10, 50, 50), fill=(255, 255, 255))
            ImageDraw.Draw(second_image).rectangle((12, 10, 52, 50), fill=(255, 255, 255))
            first_image.save(first)
            second_image.save(second)
            model = StubModel([[1.0, 0.0], [0.99, 0.01]])

            with patch("image_similarity._phash_difference", return_value=64):
                result = check_image_match(first, second, model=model)

            self.assertTrue(result["is_match"])
            self.assertEqual(result["match_reason"], "High feature vector similarity")
            self.assertEqual(result["phash_difference"], 64)
            self.assertEqual(model.calls[0][1], 640)

    def test_corrupt_image_returns_clear_error(self) -> None:
        with TemporaryDirectory() as directory:
            path = Path(directory) / "broken.png"
            path.write_bytes(b"not an image")
            with self.assertRaisesRegex(ImageSimilarityError, "Could not read image"):
                check_image_match(path, path)


if __name__ == "__main__":
    unittest.main()
