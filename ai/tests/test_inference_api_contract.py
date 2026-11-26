import importlib
import asyncio
import json
import os
import sys
import types
from hashlib import sha256
from io import BytesIO
from pathlib import Path

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")
pytest.importorskip("cv2")
from fastapi.testclient import TestClient
from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

PAPER_NAMES = {0: "broken_streetlight", 1: "clogged_drainage", 2: "pothole", 3: "road_crack"}


class _Scalar:
    def __init__(self, value):
        self.value = value

    def item(self):
        return self.value


class _Box:
    def __init__(self, class_id, score):
        self.cls = [_Scalar(class_id)]
        self.conf = [_Scalar(score)]
        self.xyxy = [types.SimpleNamespace(tolist=lambda: [1.0, 2.0, 11.0, 22.0])]


class FakeYOLO:
    names = PAPER_NAMES
    scripted = []
    last_conf = None

    def __init__(self, weights):
        self.weights = weights

    def predict(self, source, imgsz, conf, **kwargs):
        FakeYOLO.last_conf = conf
        boxes = [_Box(class_id, score) for class_id, score in FakeYOLO.scripted if score >= conf]
        return [types.SimpleNamespace(names=self.names, boxes=boxes)]

    def embed(self, **kwargs):
        return None


@pytest.fixture()
def api(monkeypatch):
    module = importlib.import_module("ai.inference.inference_api")
    monkeypatch.setattr(module, "YOLO", FakeYOLO)
    yield module


def jpeg_bytes(shade=120):
    buffer = BytesIO()
    Image.new("RGB", (32, 32), (shade, shade, shade)).save(buffer, format="JPEG")
    return buffer.getvalue()


def predict(module, scripted, confidence=0.30):
    FakeYOLO.scripted = scripted
    client = TestClient(module.create_app("paper_aligned.pt", confidence))
    response = client.post("/predict", files={"image": ("x.jpg", jpeg_bytes(), "image/jpeg")})
    assert response.status_code == 200
    return response.json()


@pytest.mark.parametrize("class_id, name", sorted(PAPER_NAMES.items()))
def test_predict_preserves_each_canonical_class(api, class_id, name):
    body = predict(api, [(class_id, 0.8)])
    assert body["detected"] is True
    assert body["canonical_category"] == name
    assert body["category"] == name
    assert body["detections"][0]["class"] == name
    assert body["evidence_relevance"] == "UNAVAILABLE"
    assert body["source"] == "yolo_backend"
    assert body["severity_status"] == "NOT_ASSESSED"
    assert body["severity_reason"] == "SEVERITY_PROVIDER_UNAVAILABLE"
    assert body["detections"][0]["severity_level"] is None


def test_measurement_provider_receives_scene_and_only_the_eligible_primary_region(api):
    calls = []
    measurement = {"source": "test-gauge", "version": "1", "evidence": {"depth_mm": 30}, "uncertainty": {"depth_mm": 1}}

    async def measure(image, category, region):
        calls.append((image.size, category, region))
        return measurement

    client = TestClient(api.create_app("paper_aligned.pt", 0.30, measurement_provider=measure))
    FakeYOLO.scripted = [(2, 0.9), (3, 0.4)]
    first = ("x.jpg", jpeg_bytes(), "image/jpeg")
    response = client.post("/predict", files={"image": first})
    assert response.status_code == 200
    body = response.json()
    assert calls == [((32, 32), "pothole", (1, 2, 10, 20))]
    assert body["severity_status"] == "REVIEW_REQUIRED"
    assert body["severity_reason"] == "MEASUREMENTS_REQUIRE_POLICY"
    assert body["detections"][0]["severity_measurement"] == measurement
    assert body["detections"][0]["severity_level"] is None
    assert "severity_measurement" not in body["detections"][1]
    pair = client.post("/verify-pair", files={"image1": first, "image2": ("y.jpg", jpeg_bytes(121), "image/jpeg")})
    assert pair.status_code == 200
    assert pair.json()["image1_detections"][0]["severity_measurement"] == measurement
    assert pair.json()["image2_detections"][0]["severity_measurement"] == measurement
    assert pair.json()["summary"]["highest_severity"] is None


@pytest.mark.parametrize("case, reason", [
    ("missing", "INSUFFICIENT_MEASUREMENTS"),
    ("invalid", "INVALID_MEASUREMENTS"),
    ("timeout", "SEVERITY_PROVIDER_TIMEOUT"),
    ("exception", "INVALID_MEASUREMENTS"),
])
def test_bad_or_missing_measurement_does_not_break_detection(api, case, reason):
    async def measure(*_args):
        if case == "timeout":
            await asyncio.sleep(1)
        if case == "invalid":
            return {"source": "test-gauge", "version": "1", "evidence": {"depth_mm": float("inf")}, "uncertainty": {"depth_mm": 1}}
        if case == "exception":
            raise RuntimeError("Test provider unavailable")
        return None

    FakeYOLO.scripted = [(2, 0.8)]
    client = TestClient(api.create_app("paper_aligned.pt", 0.30, measurement_provider=measure, measurement_timeout=0.01))
    response = client.post("/predict", files={"image": ("x.jpg", jpeg_bytes(), "image/jpeg")})
    assert response.status_code == 200
    body = response.json()
    assert body["detected"] is True
    assert body["severity_status"] == "NOT_ASSESSED"
    assert body["severity_reason"] == reason


def test_road_crack_is_not_unsupported(api):
    body = predict(api, [(3, 0.55)])
    assert body["source"] != "yolo_backend_unsupported"
    assert body["detected"] is True


@pytest.mark.parametrize("orientation, expected_size", [(1, (64, 32)), (3, (64, 32)), (6, (32, 64)), (8, (32, 64))])
def test_prediction_coordinates_use_exif_oriented_image(api, monkeypatch, orientation, expected_size):
    seen = []
    original_predict = FakeYOLO.predict

    def record_source(self, source, **kwargs):
        seen.append(source.size)
        assert source.getexif().get(274, 1) == 1
        return original_predict(self, source, **kwargs)

    monkeypatch.setattr(FakeYOLO, "predict", record_source)
    FakeYOLO.scripted = [(3, 0.827)]
    image = Image.new("RGB", (64, 32), "gray")
    exif = image.getexif()
    exif[274] = orientation
    content = BytesIO()
    image.save(content, format="JPEG", exif=exif)
    client = TestClient(api.create_app("paper_aligned.pt", 0.30))
    response = client.post("/predict", files={"image": ("rotated.jpg", content.getvalue(), "image/jpeg")})
    assert response.status_code == 200
    body = response.json()
    assert seen == [expected_size]
    assert body["image_size"] == dict(zip(("width", "height"), expected_size))
    assert body["detections"][0]["bounding_box"] == {"x": 1.0, "y": 2.0, "width": 10.0, "height": 20.0}


@pytest.mark.parametrize("score, eligible", [(0.31, True), (0.30, True), (0.2999, False), (0.22, False), (0.15, False)])
def test_predict_confidence_boundary_has_no_hidden_fallback(api, score, eligible):
    body = predict(api, [(2, score)])
    assert body["detected"] is eligible
    assert body["min_confidence"] == 0.30
    assert body["detections"][0]["eligible"] is eligible
    if not eligible:
        assert body["canonical_category"] is None
        assert body["reason"] == "LOW_CONFIDENCE"
        assert body["confidence"] == pytest.approx(score)
        assert body["inference_status"] == "low_confidence"


def test_rounding_never_promotes_a_score_just_below_the_threshold(api):
    body = predict(api, [(2, 0.29996)])
    assert body["detected"] is False
    assert body["detections"][0]["confidence"] < 0.30


def test_portrait_signal_blocks_only_predictions_localized_to_the_face(api, monkeypatch):
    class FaceFixture:
        def detect(self, _image):
            return [(0, 4, 12, 13)]

    monkeypatch.setattr(api, "load_face_regions", lambda _path: FaceFixture())
    client = TestClient(api.create_app("paper_aligned.pt", 0.30, enable_portrait_filter=True))
    first = ("first.jpg", jpeg_bytes(120), "image/jpeg")
    second = ("second.jpg", jpeg_bytes(121), "image/jpeg")
    FakeYOLO.scripted = [(0, 0.8)]
    response = client.post("/predict", files={"image": first})
    assert response.status_code == 200
    assert response.json()["reason"] == "face_overlap"
    assert response.json()["detected"] is False
    for route in ("/verify-pair", "/api/v1/damage/verify-pair"):
        response = client.post(route, files={"image1": first, "image2": second})
        assert response.status_code == 200
        assert response.json()["status"] == "EVIDENCE_REVIEW_REQUIRED"
        assert response.json()["image1_assessment"]["reason"] == "face_overlap"
        assert response.json()["candidate"] is None

    def with_damage(_self, **_options):
        portrait = _Box(0, 0.8)
        damage = _Box(2, 0.51)
        damage.xyxy = [types.SimpleNamespace(tolist=lambda: [18, 15, 31, 30])]
        return [types.SimpleNamespace(names=PAPER_NAMES, boxes=[portrait, damage])]

    monkeypatch.setattr(FakeYOLO, "predict", with_damage)
    response = client.post("/predict", files={"image": first})
    assert response.status_code == 200
    assert response.json()["canonical_category"] == "pothole"
    assert [box["class"] for box in response.json()["detections"]] == ["pothole"]

    class UnavailableFixture:
        def detect(self, _image):
            raise api.cv2.error("Face detection failed")

    monkeypatch.setattr(api, "load_face_regions", lambda _path: UnavailableFixture())
    drain_client = TestClient(api.create_app("paper_aligned.pt", 0.30, enable_portrait_filter=True))
    response = drain_client.post("/predict", files={"image": first})
    assert response.status_code == 200
    assert response.json()["reason"] == "evidence_screening_unavailable"
    assert response.json()["detected"] is False
    assert response.json()["detections"] == []


def test_object_screening_preserves_damage_outside_the_detected_subject(api, monkeypatch):
    # The scripted defect boxes are both eligible at the same confidence.
    def detections(_self, **_options):
        outside = _Box(2, 0.8)
        outside.xyxy = [types.SimpleNamespace(tolist=lambda: [18, 15, 31, 30])]
        return [types.SimpleNamespace(names=PAPER_NAMES, boxes=[_Box(0, 0.8), outside])]

    subjects = [("person", 0, 0, 17, 20)]
    monkeypatch.setattr(api, "ObjectRegions", lambda _path: types.SimpleNamespace(detect=lambda _image: subjects))
    monkeypatch.setattr(FakeYOLO, "predict", detections)
    photo = {"image": ("one.jpg", jpeg_bytes(), "image/jpeg")}
    with TestClient(api.create_app("paper_aligned.pt", 0.30, object_model="fixture.pt")) as client:
        body = client.post("/predict", files=photo).json()
        assert [row["class"] for row in body["detections"]] == ["pothole"]
        subjects[:] = [("person", 0, 0, 32, 32)]
        body = client.post("/predict", files=photo).json()
        assert body["reason"] == "unrelated_subject_overlap"
        assert body["candidate"] is None
        assert body["severity_status"] == "NOT_ASSESSED"
        assert body["visual_extent"] is None


def test_streetlight_lookalike_veto_is_local_and_class_specific(api, monkeypatch):
    subjects = [("vase", 0, 0, 17, 20)]
    monkeypatch.setattr(api, "ObjectRegions", lambda _path: types.SimpleNamespace(detect=lambda _image: subjects))
    photo = {"image": ("one.jpg", jpeg_bytes(), "image/jpeg")}

    def detections(_self, **_options):
        return [types.SimpleNamespace(names=PAPER_NAMES, boxes=[_Box(0, 0.8), _Box(2, 0.75)])]

    monkeypatch.setattr(FakeYOLO, "predict", detections)
    with TestClient(api.create_app("paper_aligned.pt", 0.30, object_model="fixture.pt")) as client:
        body = client.post("/predict", files=photo).json()
        assert [row["class"] for row in body["detections"]] == ["pothole"]
        subjects[:] = [("vase", 23, 22, 32, 32)]
        body = client.post("/predict", files=photo).json()
        assert body["canonical_category"] == "broken_streetlight"


def test_pavement_retry_only_returns_a_screened_preview(api, monkeypatch):
    subjects = []

    def detections(_self, *, imgsz, **_options):
        boxes = [_Box(2, 0.43)] if imgsz == 512 else []
        return [types.SimpleNamespace(names=PAPER_NAMES, boxes=boxes)]

    monkeypatch.setattr(api, "load_face_regions", lambda _path: types.SimpleNamespace(detect=lambda _image: []))
    monkeypatch.setattr(api, "ObjectRegions", lambda _path: types.SimpleNamespace(detect=lambda _image: subjects))
    monkeypatch.setattr(FakeYOLO, "predict", detections)
    photo = {"image": ("one.jpg", jpeg_bytes(), "image/jpeg")}
    with TestClient(api.create_app("paper_aligned.pt", 0.30, enable_portrait_filter=True,
                                   object_model="fixture.pt")) as client:
        response = client.post("/predict", files=photo).json()
        assert not response["detected"]
        assert response["severity_status"] == "NOT_ASSESSED"
        assert response["detections"] == []
        assert response["detection_preview"]["class"] == "pothole"
        assert response["detection_preview"]["source"] == "contrast"

        subjects[:] = [("person", 0, 0, 32, 32)]
        assert "detection_preview" not in client.post("/predict", files=photo).json()


@pytest.mark.parametrize("top_margin", [0, 150])
def test_portrait_fixture_uses_real_opencv_without_identifying_people(api, monkeypatch, top_margin):
    weights = os.environ.get("NEIGHBORLENS_TEST_YUNET_MODEL")
    if not weights:
        pytest.skip("Set NEIGHBORLENS_TEST_YUNET_MODEL to the pinned YuNet file.")

    def on_portrait(_self, **_options):
        box = _Box(0, 0.7262)
        box.xyxy = [types.SimpleNamespace(tolist=lambda: [3.53, top_margin + 0.83, 140.0, top_margin + 151.26])]
        return [types.SimpleNamespace(names=PAPER_NAMES, boxes=[box])]

    monkeypatch.setattr(FakeYOLO, "predict", on_portrait)
    with Image.open(ROOT / "tests/fixtures/report-evidence/public-portrait.jpg") as portrait:
        frame = Image.new("RGB", (portrait.width, top_margin + portrait.height), (36, 36, 36))
        frame.paste(portrait, (0, top_margin))
    buffer = BytesIO()
    frame.save(buffer, format="JPEG")
    client = TestClient(api.create_app("paper_aligned.pt", 0.30, enable_portrait_filter=True, portrait_model=weights))
    response = client.post("/predict", files={"image": ("portrait.jpg", buffer.getvalue(), "image/jpeg")})
    assert response.status_code == 200
    assert response.json()["reason"] == "face_overlap"
    assert response.json()["detections"] == []
    assert response.json()["detected"] is False


@pytest.mark.parametrize("class_id, category", sorted(PAPER_NAMES.items()))
def test_default_inference_accepts_valid_damage_without_haar(api, monkeypatch, class_id, category):
    monkeypatch.delattr(api.cv2, "CascadeClassifier", raising=False)

    def unexpected_load():
        pytest.fail("The default application must not load the optional portrait filter.")

    monkeypatch.setattr(api, "load_face_regions", unexpected_load)
    client = TestClient(api.create_app("paper_aligned.pt", 0.30))
    first = ("first.jpg", jpeg_bytes(120), "image/jpeg")
    second = ("second.jpg", jpeg_bytes(121), "image/jpeg")
    FakeYOLO.scripted = [(class_id, 0.864)]
    for route, files in (
        ("/predict", {"image": first}),
        ("/verify-pair", {"image1": first, "image2": second}),
        ("/api/v1/damage/verify-pair", {"image1": first, "image2": second}),
    ):
        response = client.post(route, files=files)
        assert response.status_code == 200
        assert response.json()["canonical_category"] == category
        assert response.json()["detected"] is True


@pytest.mark.parametrize("missing", ["api", "assets", "checksum"])
def test_portrait_opt_in_fails_before_loading_weights_if_dependencies_are_missing(api, monkeypatch, tmp_path, missing):
    def unexpected_load(*_args):
        pytest.fail("Invalid portrait configuration must fail before model deserialization.")

    weights = tmp_path / "face.onnx"
    if missing == "api":
        monkeypatch.delattr(api.cv2, "FaceDetectorYN", raising=False)
    elif missing == "checksum":
        weights.write_bytes(b"unknown model")
    with pytest.raises(RuntimeError, match="portrait filter"):
        api.create_app("paper_aligned.pt", 0.30, model_factory=unexpected_load,
                       enable_portrait_filter=True, portrait_model=weights)


def test_startup_refuses_legacy_checkpoint(api, monkeypatch):
    monkeypatch.setattr(FakeYOLO, "names", {0: "damaged_road", 1: "clogged_drainage", 2: "damaged_street_light", 3: "damaged_traffic_light"})
    from ai.inference.damage_contract import ModelContractError

    with pytest.raises(ModelContractError):
        api.create_app("models/production/best.pt", 0.30)


def test_health_reports_class_contract(api):
    client = TestClient(api.create_app("paper_aligned.pt", 0.30))
    body = client.get("/health").json()
    assert {int(k): v for k, v in body["classes"].items()} == PAPER_NAMES
    assert body["min_confidence"] == 0.30


def test_single_and_pair_reuse_one_injected_model_per_app(api):
    instances = []

    class RecordingModel(FakeYOLO):
        def __init__(self, weights):
            super().__init__(weights)
            self.calls = []
            instances.append(self)

        def predict(self, **kwargs):
            self.calls.append(("predict", kwargs))
            return [types.SimpleNamespace(names=self.names, boxes=[_Box(2, 0.69998)])]

        def embed(self, **kwargs):
            self.calls.append(("embed", kwargs))
            raise RuntimeError("Embeddings unavailable")

    with TestClient(api.create_app("paper_aligned.pt", 0.30, 512, model_factory=RecordingModel)) as client:
        assert len(instances) == 1
        assert client.get("/health").status_code == 200
        assert instances[0].calls == []
        single = client.post("/predict", files={"image": ("one.jpg", jpeg_bytes(), "image/jpeg")})
        pair = client.post("/verify-pair", files={
            "image1": ("one.jpg", jpeg_bytes(), "image/jpeg"),
            "image2": ("two.jpg", jpeg_bytes(170), "image/jpeg"),
        })

    assert len(instances) == 1
    calls = instances[0].calls
    assert [name for name, _ in calls] == ["predict", "embed"] * 3
    for (_, prediction), (_, embedding) in zip(calls[::2], calls[1::2]):
        assert prediction == {
            "source": embedding["source"], "imgsz": 512, "conf": 0.05,
            "rect": False, "max_det": 100, "augment": True, "verbose": False,
        }
        assert embedding == {"source": prediction["source"], "imgsz": 512, "verbose": False}
    assert single.status_code == pair.status_code == 200
    assert single.json()["confidence"] == 0.6999
    assert pair.json()["status"] == "DETECTED"
    assert pair.json()["summary"]["scene_status"] == "UNAVAILABLE"
    api.create_app("other.pt", 0.30, model_factory=RecordingModel)
    assert [instance.weights for instance in instances] == ["paper_aligned.pt", "other.pt"]
    assert instances[1].calls == []


@pytest.mark.parametrize("manifest", [
    {"production_sha256": "0" * 64},
    {"version": "missing_checksum"},
    ["not an object"],
])
def test_invalid_production_manifest_is_rejected_before_model_load(api, tmp_path, manifest):
    weights = tmp_path / "best.pt"
    weights.write_bytes(b"untrusted checkpoint")
    (tmp_path / "model_manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    def unexpected_load(_):
        pytest.fail("Invalid manifest reached the model loader")

    with pytest.raises(api.ModelContractError, match="model_manifest.json"):
        api.create_app(str(weights), 0.30, model_factory=unexpected_load)


def test_verified_manifest_preserves_reported_identity(api, tmp_path):
    weights = tmp_path / "best.pt"
    weights.write_bytes(b"approved fixture")
    (tmp_path / "model_manifest.json").write_text(json.dumps({
        "production_sha256": sha256(weights.read_bytes()).hexdigest(),
        "version": "approved_v9",
        "release_label": "v9",
        "target_eligible": False,
    }), encoding="utf-8")

    class ManifestModel(FakeYOLO):
        model = types.SimpleNamespace(yaml={"yaml_file": "yolov8m.yaml"})

    with TestClient(api.create_app(str(weights), 0.30, model_factory=ManifestModel)) as client:
        info = client.get("/health").json()["model_info"]
    assert info["architecture"] == "YOLOv8m"
    assert info["version"] == "approved_v9"
    assert info["release_label"] == "v9"
    assert info["target_eligible"] is False
    assert info["classes"] == {str(key): value for key, value in PAPER_NAMES.items()}


def write_run(tmp_path, target_eligible):
    run_dir = tmp_path / "neighborlens_v3_1_interim"
    (run_dir / "weights").mkdir(parents=True)
    (run_dir / "train_config.json").write_text(f'{{"target_eligible": {str(target_eligible).lower()}}}', encoding="utf-8")
    weights = run_dir / "weights" / "best.pt"
    weights.write_bytes(b"")
    return weights


def test_describe_model_reads_run_identity_from_checkpoint_and_train_config(api, tmp_path):
    weights = write_run(tmp_path, False)
    info = api.describe_model(str(weights), {"train_args": {"name": "neighborlens_v3_1_interim", "model": "yolov8m.pt"}}, {"yaml_file": "yolov8m.yaml"})
    assert info["name"] == "NeighborLens YOLOv8m"
    assert info["architecture"] == "YOLOv8m"
    assert info["version"] == "neighborlens_v3_1_interim"
    assert info["release_label"] == "v3.1 Interim Baseline"
    assert info["checkpoint"] == "neighborlens_v3_1_interim/weights/best.pt"
    assert info["target_eligible"] is False
    assert {int(k): v for k, v in info["classes"].items()} == PAPER_NAMES


def test_describe_model_does_not_call_a_target_eligible_run_a_baseline(api, tmp_path):
    weights = write_run(tmp_path, True)
    info = api.describe_model(str(weights), {"train_args": {"name": "neighborlens_v3_1_interim"}}, None)
    assert info["target_eligible"] is True
    assert info["release_label"] == "v3.1 Interim"
    assert info["architecture"] is None
    assert info["name"] == "NeighborLens"


def test_describe_model_reports_unknown_eligibility_without_train_config(api, tmp_path):
    weights = tmp_path / "custom" / "weights" / "best.pt"
    weights.parent.mkdir(parents=True)
    info = api.describe_model(str(weights), None, {"yaml_file": "yolov8s.yaml"})
    assert info["target_eligible"] is None
    assert info["version"] == "custom"
    assert info["release_label"] == "custom"
    assert info["name"] == "NeighborLens YOLOv8s"


def test_predict_and_health_never_label_the_model_as_coco(api):
    body = predict(api, [(3, 0.64)])
    client = TestClient(api.create_app("paper_aligned.pt", 0.30))
    health = client.get("/health").json()
    for payload in (body, health):
        assert "coco" not in str(payload).lower()
    assert body["model_info"]["classes"] == health["model_info"]["classes"]
    assert body["image_size"] == {"width": 32, "height": 32}
    assert body["detections"][0]["bounding_box"] == {"x": 1.0, "y": 2.0, "width": 10.0, "height": 20.0}


@pytest.mark.parametrize("flags", [[], ["--enable-portrait-filter"]])
def test_cli_uses_production_weights_and_screening_by_default(api, monkeypatch, flags):
    assert api.DEFAULT_PRODUCTION_WEIGHTS == ROOT / "models" / "production" / "best.pt"
    captured = {}

    def create_app(weights, confidence, imgsz, *, enable_portrait_filter, portrait_model, object_model):
        captured.update(weights=weights, portrait=enable_portrait_filter, portrait_model=portrait_model, object_model=object_model)
        return object()

    monkeypatch.setattr(api, "create_app", create_app)
    fake_uvicorn = types.ModuleType("uvicorn")
    fake_uvicorn.run = lambda app, host, port: None
    monkeypatch.setitem(sys.modules, "uvicorn", fake_uvicorn)
    monkeypatch.setattr(sys, "argv", ["inference_api.py", *flags])
    api.main()
    assert captured["portrait"] is True
    assert captured["portrait_model"] == api.DEFAULT_PORTRAIT_WEIGHTS
    assert captured["object_model"] == api.DEFAULT_OBJECT_WEIGHTS
    assert Path(captured["weights"]) == ROOT / "models" / "production" / "best.pt"


@pytest.mark.parametrize("first,second,expected", [
    ([("road_crack", 0.605)], [("road_crack", 0.344)], "DETECTED"),
    ([("pothole", 0.8)], [("road_crack", 0.8)], "PAIR_MISMATCH"),
    ([("pothole", 0.8)], [("pothole", 0.2)], "LOW_CONFIDENCE"),
    ([("pothole", 0.2)], [("pothole", 0.25)], "LOW_CONFIDENCE"),
    ([("pothole", 0.2)], [("road_crack", 0.25)], "PAIR_MISMATCH"),
    ([("pothole", 0.8)], [], "PAIR_MISMATCH"),
    ([], [], "NO_DETECTION"),
    ([("car", 0.9)], [("car", 0.9)], "UNSUPPORTED"),
    ([("pothole", 0.9), ("road_crack", 0.6)], [("road_crack", 0.9), ("pothole", 0.6)], "PAIR_MISMATCH"),
])
def test_pair_class_agreement_is_independent_of_low_scene_similarity(api, monkeypatch, first, second, expected):
    scripted = iter([first, second])
    def detections(*args):
        return [api.DetectionItem(damage_id=f"d-{index}", damage_type=name, confidence_score=score,
            eligible=name in PAPER_NAMES.values() and score >= 0.3,
            bounding_box=api.BoundingBox(x=1, y=2, width=10, height=20)) for index, (name, score) in enumerate(next(scripted))], [1.0]
    monkeypatch.setattr(api.YoloDetector, "detect", detections)
    monkeypatch.setattr(api, "compute_homography_alignment", lambda *args: (False, 0.0, 0, None))
    monkeypatch.setattr(api, "cosine_similarity", lambda *args: 0.15)
    client = TestClient(api.create_app("paper_aligned.pt", 0.3))
    response = client.post("/verify-pair", files={"image1": ("one.jpg", jpeg_bytes(), "image/jpeg"), "image2": ("two.jpg", jpeg_bytes(170), "image/jpeg")})
    assert response.status_code == 200
    body = response.json()
    assert body["evidence_relevance"] == "UNAVAILABLE"
    assert body["status"] == expected
    assert body["detected"] is (expected == "DETECTED")
    assert body["is_valid_match"] is False
    assert body["summary"]["scene_status"] == "MISMATCH"
    assert body["summary"]["highest_severity"] is None
    assert len(body["image1_detections"]) == len(first)
    assert body["min_confidence"] == 0.3
    if expected == "LOW_CONFIDENCE":
        assert body["candidate"]["accepted"] is False
        assert body["provisional_class_agreement"] is True


@pytest.mark.parametrize("scene_failure", [False, True])
def test_high_scene_similarity_or_comparison_failure_never_changes_detection(api, monkeypatch, scene_failure):
    FakeYOLO.scripted = [(3, 0.8)]
    monkeypatch.setattr(FakeYOLO, "embed", lambda *args, **kwargs: None)
    original = api.YoloDetector.detect
    def detections(*args):
        items, _ = original(*args)
        return items, [1.0]
    monkeypatch.setattr(api.YoloDetector, "detect", detections)
    def alignment(*args):
        if scene_failure:
            raise RuntimeError("private scene failure")
        return True, 0.8, 30, None
    monkeypatch.setattr(api, "compute_homography_alignment", alignment)
    monkeypatch.setattr(api, "cosine_similarity", lambda *args: 0.95)
    client = TestClient(api.create_app("paper_aligned.pt", 0.3))
    body = client.post("/verify-pair", files={"image1": ("one.jpg", jpeg_bytes(), "image/jpeg"), "image2": ("two.jpg", jpeg_bytes(170), "image/jpeg")}).json()
    assert body["detected"] is True
    assert body["canonical_category"] == "road_crack"
    assert body["summary"]["scene_status"] == ("UNAVAILABLE" if scene_failure else "MATCH")
    assert "private scene failure" not in str(body)


def test_pair_without_scene_embeddings_still_detects_the_agreeing_class(api, monkeypatch):
    FakeYOLO.scripted = [(3, 0.8)]
    monkeypatch.setattr(api, "compute_homography_alignment", lambda *args: (False, 0.0, 0, None))
    client = TestClient(api.create_app("paper_aligned.pt", 0.3))
    body = client.post("/verify-pair", files={"image1": ("one.jpg", jpeg_bytes(), "image/jpeg"), "image2": ("two.jpg", jpeg_bytes(170), "image/jpeg")}).json()
    assert body["detected"] is True
    assert body["summary"]["scene_status"] == "UNAVAILABLE"
    assert body["confidence"] == 0.8


def test_pair_rejects_corrupt_input_instead_of_reporting_no_detection(api):
    client = TestClient(api.create_app("paper_aligned.pt", 0.3))
    response = client.post("/verify-pair", files={"image1": ("one.jpg", b"not an image", "image/jpeg"), "image2": ("two.jpg", jpeg_bytes(170), "image/jpeg")})
    assert response.status_code == 400
    assert "detected" not in response.json()


def test_pair_rejects_identical_bytes_before_alignment_or_yolo(api, monkeypatch):
    def unexpected(*args):
        pytest.fail("Duplicate evidence reached inference")
    monkeypatch.setattr(api, "compute_homography_alignment", unexpected)
    monkeypatch.setattr(api.YoloDetector, "detect", unexpected)
    client = TestClient(api.create_app("paper_aligned.pt", 0.3))
    response = client.post("/verify-pair", files={
        "image1": ("one.jpg", jpeg_bytes(), "image/jpeg"),
        "image2": ("renamed.jpg", jpeg_bytes(), "image/jpeg"),
    })
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "DUPLICATE_EVIDENCE"
