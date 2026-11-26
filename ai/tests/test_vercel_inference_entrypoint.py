import importlib.util
import sys
import types
from hashlib import sha256
from io import BytesIO
from pathlib import Path
from shutil import copyfile

import pytest

pytest.importorskip("fastapi")
cv2 = pytest.importorskip("cv2")
from fastapi.testclient import TestClient
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
DEPLOY_ROOT = ROOT / "inference-vercel"
SECRET = "isolated-inference-test-secret-32-characters"
REMOTE_CHECKPOINT_SHA256 = "f218ccde1a6d27455250fa40a6b38515170fba746512be7c10198fc46d1e6ef2"
CHECKPOINT_PATH = "models/production/best.pt"
FIXTURE_CHECKPOINT = b"NeighborLens isolated packaging fixture (stub model)"
PACKAGED_SOURCES = (
    "ai/inference/inference_api.py",
    "ai/inference/damage_contract.py",
    "ai/inference/yolo_detector.py",
    "ai/inference/portrait_evidence.py",
    "ai/inference/object_evidence.py",
    "ai/inference/detection_preview.py",
    "models/evidence/face_detection_yunet_2026may.onnx",
    "models/evidence/YuNet-LICENSE.txt",
    "models/checkpoints/yolo26n.pt",
    "ai/inference/scene_scoring.py",
    "ai/inference/severity_evidence.py",
    "ai/inference/mask_geometry.py",
    "ai/inference/visual_extent.py",
    CHECKPOINT_PATH,
)


class FakeYOLO:
    names = {0: "broken_streetlight", 1: "clogged_drainage", 2: "pothole", 3: "road_crack"}
    ckpt = None
    model = None

    def __init__(self, weights):
        assert Path(weights).name == "yolo26n.pt" or Path(weights).read_bytes() == FIXTURE_CHECKPOINT

    def predict(self, **kwargs):
        return [types.SimpleNamespace(names=self.names, boxes=[])]

    def embed(self, **kwargs):
        return None


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def build(tmp_path):
    builder = load_module("inference_build", DEPLOY_ROOT / "build.py")
    builder.REPO = tmp_path
    builder.ROOT = tmp_path / "inference-vercel"
    builder.ROOT.mkdir()
    copyfile(DEPLOY_ROOT / "app.py", builder.ROOT / "app.py")
    for relative in PACKAGED_SOURCES:
        path = tmp_path / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        if relative == CHECKPOINT_PATH:
            path.write_bytes(FIXTURE_CHECKPOINT)
        else:
            copyfile(ROOT / relative, path)
    (tmp_path / "models/production/model_manifest.json").write_text("{}", encoding="utf-8")
    return builder


@pytest.fixture
def staged_build(build, monkeypatch):
    # Only this temporary build instance trusts the stub bytes.
    monkeypatch.setattr(build, "EXPECTED_SHA256", sha256(FIXTURE_CHECKPOINT).hexdigest())
    build.main()
    return build.ROOT


def inference_modules():
    return [
        name for name in sys.modules
        if name == "ai.inference" or name.startswith("ai.inference.")
    ]


@pytest.fixture
def load_staged_app(staged_build, monkeypatch):
    fake = types.ModuleType("ultralytics")
    fake.YOLO = FakeYOLO
    monkeypatch.setitem(sys.modules, "ultralytics", fake)
    monkeypatch.setenv("INFERENCE_SHARED_SECRET", SECRET)
    monkeypatch.setenv("CUDA_VISIBLE_DEVICES", "-1")
    # Restrict namespace resolution to the staged package. Missing modules
    # must fail even if they happen to exist in the checkout.
    package = types.ModuleType("ai")
    package.__path__ = [str(staged_build / "ai")]
    monkeypatch.setitem(sys.modules, "ai", package)
    for name in inference_modules():
        monkeypatch.delitem(sys.modules, name)
    from ai.inference import object_evidence
    monkeypatch.setattr(object_evidence.ObjectRegions, "detect", lambda *_: [])
    try:
        yield lambda: load_module("inference_deployment_entrypoint", staged_build / "app.py")
    finally:
        for name in inference_modules():
            sys.modules.pop(name)


@pytest.fixture
def client(load_staged_app):
    with TestClient(load_staged_app().app) as http:
        yield http


def jpeg():
    output = BytesIO()
    Image.new("RGB", (32, 32), (100, 100, 100)).save(output, "JPEG")
    return output.getvalue()


def test_staging_copies_only_allowlisted_inputs(staged_build):
    files = {
        path.relative_to(staged_build).as_posix()
        for path in staged_build.rglob("*") if path.is_file()
    }
    assert files == {"app.py", *PACKAGED_SOURCES}
    assert (staged_build / CHECKPOINT_PATH).read_bytes() == FIXTURE_CHECKPOINT


def test_remote_pin_rejects_unapproved_checkpoint(build):
    assert build.EXPECTED_SHA256 == REMOTE_CHECKPOINT_SHA256
    with pytest.raises(RuntimeError, match="deployment refused"):
        build.main()


def test_staging_rejects_modified_fixture_checkpoint(build, monkeypatch):
    monkeypatch.setattr(build, "EXPECTED_SHA256", sha256(FIXTURE_CHECKPOINT).hexdigest())
    (build.REPO / CHECKPOINT_PATH).write_bytes(FIXTURE_CHECKPOINT + b"corruption")
    with pytest.raises(RuntimeError, match="deployment refused"):
        build.main()


def test_health_and_single_image_access(client):
    assert client.get("/health").json()["ok"] is True
    assert client.get("/api/health").json() == client.get("/health").json()
    photo = {"image": ("image.jpg", jpeg(), "image/jpeg")}
    assert client.post("/predict", files=photo).status_code == 401
    assert client.post("/predict", files=photo, headers={"X-Inference-Key": "invalid"}).status_code == 401
    response = client.post("/predict", files=photo, headers={"X-Inference-Key": SECRET})
    assert response.status_code == 200
    assert response.json()["detections"] == []
    assert response.json()["evidence_screening"] == "region-v2"


def test_staged_app_accepts_eligible_evidence_without_haar(load_staged_app, monkeypatch):
    monkeypatch.delattr(cv2, "CascadeClassifier", raising=False)
    box = types.SimpleNamespace(
        cls=[types.SimpleNamespace(item=lambda: 2)],
        conf=[types.SimpleNamespace(item=lambda: 0.86)],
        xyxy=[types.SimpleNamespace(tolist=lambda: [2, 2, 17, 20])],
    )
    monkeypatch.setattr(FakeYOLO, "predict", lambda self, **kwargs: [types.SimpleNamespace(names=self.names, boxes=[box])])
    photo = {"image": ("pothole.jpg", jpeg(), "image/jpeg")}
    with TestClient(load_staged_app().app) as http:
        response = http.post("/predict", files=photo, headers={"X-Inference-Key": SECRET})
    assert response.status_code == 200
    assert response.json()["canonical_category"] == "pothole"


@pytest.mark.parametrize("route", ["/api/v1/damage/verify-pair", "/verify-pair"])
def test_pair_rejects_identical_photos(client, route):
    headers = {"X-Inference-Key": SECRET}
    pair = {"image1": ("one.jpg", jpeg(), "image/jpeg"), "image2": ("two.jpg", jpeg(), "image/jpeg")}
    assert client.post(route, files=pair).status_code == 401
    response = client.post(route, files=pair, headers=headers)
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "DUPLICATE_EVIDENCE"


@pytest.mark.parametrize("route", ["/api/v1/damage/verify-pair", "/verify-pair"])
def test_pair_accepts_distinct_road_photos(client, route):
    photos = ROOT / "data/raw/damages_road"
    pair = {
        "image1": ("2.jpg", (photos / "2.jpg").read_bytes(), "image/jpeg"),
        "image2": ("25.jpg", (photos / "25.jpg").read_bytes(), "image/jpeg"),
    }
    response = client.post(route, files=pair, headers={"X-Inference-Key": SECRET})
    assert response.status_code == 200
    body = response.json()
    assert "summary" in body
    assert body["status"] == "NO_DETECTION"


def test_invalid_images_and_oversize_requests(client):
    headers = {"X-Inference-Key": SECRET}
    assert client.post("/predict", files={"image": ("bad.jpg", b"not an image", "image/jpeg")}, headers=headers).status_code == 400
    assert client.post("/predict", files={"image": ("x.txt", b"not an image", "text/plain")}, headers=headers).status_code == 415
    too_large = b"a" * (4 * 1024 * 1024 + 1)
    assert client.post("/predict", content=too_large, headers=headers).status_code == 413


def test_missing_service_secret_fails_startup(monkeypatch, load_staged_app):
    monkeypatch.delenv("INFERENCE_SHARED_SECRET", raising=False)
    with pytest.raises(RuntimeError, match="INFERENCE_SHARED_SECRET"):
        load_staged_app()
