"""Research-only FREUID a31 inference for a nominated benchmark layout.

Architecture and crop protocol adapted from gc22-shin/FREUIDChallenge2026
(MIT, Copyright (c) 2026 FREUID Challenge 2026 team (sdlvkqmv)).
"""

import hashlib
import json
import math
from pathlib import Path

import torch
from PIL import Image
from torch import nn
from torch.nn import functional as F
from torchvision.transforms import Compose, Normalize, ToTensor


RELEASE = "a68e6d7a570fd6648f381984d0bcfca46b91943e"
WEIGHTS_SHA256 = "4b0b61edc5e499cb4e21e93bbbe373adbbd9c8f2e010e48983e517c9574a6f99"
CROPS_SHA256 = "4a1a21c4037da66d761580371a73c51256517a4f8c3c3d87b3ac3812429490c2"
CANONICAL_SIZES = {
    "BENIN/DL": (1000, 1585),
    "EGYPT/DL": (875, 1387),
    "GUINEA/DL": (1000, 1584),
    "MAURITIUS/ID": (1000, 1585),
    "MOZAMBIQUE/DL": (630, 1000),
}


class ResidualFilter(nn.Module):
    def __init__(self):
        super().__init__()
        self.register_buffer("weight", torch.zeros(3, 3, 5, 5))

    def forward(self, image):
        return F.conv2d(image, self.weight, padding=2)


class FieldScorer(nn.Module):
    def __init__(self):
        super().__init__()
        import timm

        self.srm = ResidualFilter()
        self.backbone = timm.create_model("tf_efficientnet_b3", pretrained=False, in_chans=6, num_classes=1)

    def forward(self, crops):
        return self.backbone(torch.cat([crops, self.srm(crops)], dim=1)).flatten()


def assert_digest(path, expected):
    with path.open("rb") as source:
        if hashlib.file_digest(source, "sha256").hexdigest() != expected:
            raise ValueError("FREUID artifact checksum mismatch.")


class FreuidA31:
    def __init__(self, assets, layout, device="cpu"):
        if layout not in CANONICAL_SIZES:
            raise ValueError("FREUID a31 supports five original benchmark layouts. No PhilSys layout is bundled.")
        assets = Path(assets)
        weights = assets / "best.pt"
        crops = assets / "field_boxes_v2.json"
        assert_digest(weights, WEIGHTS_SHA256)
        assert_digest(crops, CROPS_SHA256)
        self.boxes = json.loads(crops.read_text(encoding="utf-8"))[layout]
        self.size = CANONICAL_SIZES[layout]
        self.device = torch.device(device)
        self.prepare = Compose([ToTensor(), Normalize((0.485, 0.456, 0.406), (0.229, 0.224, 0.225))])
        checkpoint = torch.load(weights, map_location="cpu", weights_only=True)
        self.model = FieldScorer()
        self.model.load_state_dict({name.removeprefix("scorer."): value for name, value in checkpoint["model"].items()}, strict=True)
        self.model.eval().to(self.device)
        self.label = f"FREUID a31 research ({layout} crop layout)"

    @torch.inference_mode()
    def score(self, image):
        canonical = image.resize(self.size, Image.Resampling.BICUBIC)
        crops = [self.prepare(canonical.crop((left, top, right, bottom)).resize((320, 320), Image.Resampling.BICUBIC))
                 for top, bottom, left, right in self.boxes[:13]]
        batch = torch.stack(crops).to(self.device)
        logits = (self.model(batch) + self.model(batch.flip(-1))) / 2
        score = logits.max().sigmoid().item()
        if not math.isfinite(score):
            raise ValueError("Model produced an invalid score.")
        return score
