"""Offline, nonprofit research adapter for GRIP-UNINA TruFor."""

import hashlib
import io
import math
import sys
import zipfile
from pathlib import Path, PurePosixPath

import cv2
import numpy as np
import torch
from PIL import Image, ImageOps


MAX_IMAGE_BYTES = 2 * 1024 * 1024
MAX_IMAGE_PIXELS = 4_000_000
TRUFOR_ARCHIVE_SHA256 = "953f1f7eda0dd2c5ece322ae9c185ba1079c1265aa5fdf319ef5a20604d206d8"


def decode_frame(data):
    if not data or len(data) > MAX_IMAGE_BYTES:
        raise ValueError("Invalid image size.")
    with Image.open(io.BytesIO(data)) as source:
        if source.format not in ("JPEG", "PNG") or source.width * source.height > MAX_IMAGE_PIXELS:
            raise ValueError("Unsupported image.")
        if getattr(source, "n_frames", 1) != 1 or min(source.size) < 64:
            raise ValueError("Unsupported image dimensions.")
        image = ImageOps.exif_transpose(source).convert("RGB")
    return image


class TruFor:
    """Use the upstream model code and detector head with pinned local weights."""

    def __init__(self, source, archive, device="cpu"):
        source = Path(source).resolve()
        with Path(archive).open("rb") as checkpoint_file:
            if hashlib.file_digest(checkpoint_file, "sha256").hexdigest() != TRUFOR_ARCHIVE_SHA256:
                raise ValueError("TruFor archive checksum mismatch.")
            checkpoint_file.seek(0)
            with zipfile.ZipFile(checkpoint_file) as bundle:
                member, = [entry for entry in bundle.infolist()
                           if PurePosixPath(entry.filename).name == "trufor.pth.tar"]
                if member.file_size > 400_000_000:
                    raise ValueError("TruFor checkpoint is too large.")
                # The pinned archive contains NumPy scalar training metadata alongside tensors.
                scalar_type = type(np.float64(0).dtype)
                with torch.serialization.safe_globals([
                    np.dtype, scalar_type, (np._core.multiarray.scalar, "numpy.core.multiarray.scalar"),
                ]):
                    checkpoint = torch.load(io.BytesIO(bundle.read(member)), map_location="cpu", weights_only=True)

        sys.path.insert(0, str(source))
        try:
            from config import _C
            from models.cmx.builder_np_conf import myEncoderDecoder

            config = _C.clone()
            config.merge_from_file(str(source / "trufor.yaml"))
            config.freeze()
            model = myEncoderDecoder(cfg=config)
        finally:
            sys.path.remove(str(source))
        model.load_state_dict(checkpoint["state_dict"], strict=True)
        self.device = torch.device(device)
        self.model = model.eval().to(self.device)
        self.label = "GRIP-UNINA TruFor research"

    @torch.inference_mode()
    def score(self, image):
        image.thumbnail((1024, 1024), Image.Resampling.LANCZOS)
        rgb = torch.from_numpy(np.array(image)).permute(2, 0, 1).unsqueeze(0)
        rgb = rgb.to(device=self.device, dtype=torch.float32).div_(255)
        _, _, logit, _ = self.model(rgb)
        score = logit.sigmoid().item()
        if not math.isfinite(score):
            raise ValueError("Model produced an invalid score.")
        return score


def spectral_peak(rgb):
    """Measure periodic image patterns for research, without classifying the capture."""
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY).astype(np.float32)
    margin_y, margin_x = (edge // 10 for edge in gray.shape)
    gray = gray[margin_y:gray.shape[0] - margin_y, margin_x:gray.shape[1] - margin_x]
    height, width = gray.shape
    edge = min(224, height // 2, width // 2)
    if edge < 32:
        return None
    window = np.outer(np.hanning(edge), np.hanning(edge))
    coords = np.fft.fftshift(np.fft.fftfreq(edge))
    x, y = np.meshgrid(coords, coords)
    radius = np.hypot(x, y)
    band = (radius >= 0.08) & (radius <= 0.40) & (np.abs(x) > 0.035) & (np.abs(y) > 0.035)
    peaks = []
    for cy in (height // 3, height * 2 // 3):
        for cx in (width // 3, width * 2 // 3):
            patch = gray[cy - edge // 2:cy - edge // 2 + edge, cx - edge // 2:cx - edge // 2 + edge]
            highpass = patch - cv2.GaussianBlur(patch, (0, 0), 1.5)
            spectrum = np.log1p(np.abs(np.fft.fftshift(np.fft.fft2(highpass * window))))
            background = cv2.blur(spectrum, (9, 9))
            peaks.append(float(np.max((spectrum - background)[band])))
    return float(np.median(peaks))


def assess_frames(model, frames):
    """Assess exactly one ID image using available forensic signals."""

    if len(frames) != 1:
        raise ValueError("Exactly one ID image is required.")

    # Decode and validate the uploaded image.
    image = decode_frame(frames[0])
    rgb = np.asarray(image)

    # Calculate image sharpness.
    gray = cv2.cvtColor(
        rgb,
        cv2.COLOR_RGB2GRAY
    )

    sharpness = float(
        cv2.Laplacian(gray, cv2.CV_64F).var()
    )

    if not math.isfinite(sharpness):
        raise ValueError("Invalid image sharpness measurement.")

    # Run the configured research model, when available.
    fraud_score = None

    if model is not None:
        fraud_score = float(model.score(image))

        if not math.isfinite(fraud_score):
            raise ValueError("Invalid forensic model score.")

    return {
        "documentFraudScores": (
            [fraud_score]
            if fraud_score is not None
            else None
        ),
        "monitorRecaptureScore": None,
        "monitorRecaptureSpectralPeak": spectral_peak(rgb),
        "capturePhashDistance": None,
        "laplacianVariance": [sharpness],
    }
