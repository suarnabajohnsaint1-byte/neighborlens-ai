# Neighborlens AI Capstone Setup Guide
### Civic infrastructure reporting with browser prototype and Node.js API

This project now includes the original browser demonstration and a backend foundation for a capstone deployment. Read [PANEL_GUIDE.md](PANEL_GUIDE.md) for the architecture, panel script, limitations, and defense questions.

## Run the backend

```powershell
npm install
npm test
npm start
```

Then open `http://localhost:3000/login.html`.

The local API is exposed under `/api`. The backend uses SQLite, JWT authentication, bcrypt password hashing, role-based authorization, upload validation, and audit logs. The default administrator is `admin` / `admin123`; use a different password and set `JWT_SECRET` before deployment.

The HTML pages provide the browser workflow and use the backend for authentication and YOLO damage inference.

### Roboflow Hosted Inference

The backend can use the Roboflow v3 model without exposing the API key to browsers. Copy `.env.example` to `.env` or set these environment variables before starting Node:

```text
DAMAGE_INFERENCE_PROVIDER=roboflow
ROBOFLOW_API_KEY=your-server-only-key
ROBOFLOW_MODEL=damages-detection-ixvjc-zolih
ROBOFLOW_VERSION=3
DAMAGE_MIN_CONFIDENCE=0.3
```

Leave `DAMAGE_INFERENCE_URL` empty when using Roboflow Hosted Inference. If `DAMAGE_INFERENCE_URL` is set, the local/custom endpoint takes precedence. Never put `ROBOFLOW_API_KEY` in frontend JavaScript or commit a real key.

---

## 📁 File Structure

```
neighborlens/
├── frontend/           ← Vanilla HTML/CSS/JS served by server/app.js
│   ├── login.html      ← Signup with strict OCR ID gate
│   ├── citizen.html    ← Report submission + Vision issue detect
│   ├── barangay.html   ← Barangay dashboard + advanced filters
│   ├── admin.html      ← City command center + advanced filters
│   ├── styles/style.css
│   └── js/
│       ├── shared/     ← api.js, reports.js (data layer + filtering), vision.js (OCR + report-scanning adapter)
│       ├── map/        ← geofence.js, mapConfig.js, reverseGeocode.js
│       ├── auth/       ← auth.js, security.js (route + role protection), idIdentityService.js
│       ├── citizen/    ← citizen.js, yoloDamageDetector.js
│       ├── barangay/   ← barangay.js
│       └── admin/      ← admin_logic.js
├── server/             ← Node.js backend (domain / application / infrastructure / presentation)
├── ai/                 ← Python YOLO inference, detection, preprocessing, training
├── data/               ← raw, processed and datasets
├── models/             ← checkpoints and production weights
└── storage/uploads/    ← runtime report images
```

---

##  How ID Verification Works (No API Key Needed)

## Python AI dependencies

Install the computer-vision dependencies before running YOLO training or inference:

```powershell
python -m pip install -r ai/requirements.txt
```

The training script uses PyTorch to select CUDA when available and falls back to CPU automatically.

The system loads two open-source libraries at runtime from CDN:

| Library | Source | Role |
|---|---|---|
| **Tesseract.js v5** | `cdn.jsdelivr.net` | OCR — reads text from the ID image |
| **Canvas 2D** | Browser API | Card shape and portrait-region checks |

### Three-check scoring system

| Check | Max Points | What it does |
|---|---|---|
| **OCR Text Match** | 55 pts | Reads ID text, matches against 20+ PH ID patterns (PhilSys, SSS, UMID, LTO, etc.) |
| **Card Shape** | 20 pts | Detects a rectangular card-shaped contour at the correct aspect ratio (~1.586:1 CR80) |
| **Portrait Region** | 25 pts | Detects skin-tone HSV range consistent with an ID photo |

**Total needed to pass: ≥ 60 points AND OCR text score ≥ 25**

The `Register` button is **disabled in HTML** (`disabled` attribute + `opacity:0.4`) and is only enabled by the JavaScript OCR engine after a successful scan. The `_idVerified` flag is only ever set `true` inside the OCR callback — it cannot be set from outside.

---

## 🛡️ Why Users Cannot Bypass the ID Check

1. The **Register button is `disabled` by default** in the HTML — not just visually hidden
2. The submit handler has a **hard gate**: `if (!_idVerified || _verifyState !== 'verified') return`
3. `_idVerified` is a **private module variable** — it is only set `true` inside the verified OCR callback
4. Even if a user opens DevTools and tries to call the function, `verifyGovernmentID()` runs the real OCR engine and returns the actual result
5. The form submission guard checks both `_idVerified` AND `_verifyState` independently

---

## 📋 Accepted Philippine Government IDs

- PhilSys (National ID)
- SSS ID
- GSIS / UMID
- PhilHealth ID
- Pag-IBIG / HDMF ID
- LTO Driver's License
- COMELEC Voter's ID
- Philippine Passport
- PRC Professional ID
- Philippine Postal ID
- Senior Citizen / OSCA ID
- PWD ID

---

## 📸 Tips for Best OCR Results

- Lay ID flat on a plain, contrasting surface
- Use good, even lighting — avoid glare or harsh shadows
- Fill the camera frame with the ID
- Ensure all text is sharp and in focus
- Use the original ID, not a photocopy

---

## 🗺️ Geofencing Setup

Edit `frontend/js/map/geofence.js` → `BARANGAY_ZONES` object. Replace the example polygon coordinates with actual barangay boundaries:

```js
'Barangay 1': {
    center:  [LAT, LNG],
    polygon: [[LAT1,LNG1],[LAT2,LNG2],[LAT3,LNG3],[LAT4,LNG4]],
    color:   '#00d2ff'
},
```

Get boundary coordinates from:
- **NAMRIA** shapefiles (National Mapping & Resource Information Authority)
- **OpenStreetMap** via https://overpass-turbo.eu
- **GADM** database: https://gadm.org

---

## 🔍 Filtering Features

Both Barangay and Admin dashboards support:

| Filter | Options |
|---|---|
| Status | All / Pending / Ongoing / Resolved |
| Classification | All / Major / Minor |
| Priority | All / Critical / High / Medium / Low |
| Category | Road Damage, Flooding, Electrical, Fallen Tree, Sanitation, Structural, Infrastructure |
| Date Range | From date → To date |
| Sort | Newest / Oldest / By Priority |
| Search | Full-text across description, location, reporter |

---

## 👤 Demo Credentials

| Role | Username | Password |
|---|---|---|
| Admin | `admin` | `admin123` |
| Citizen demo | `citizen` | `1` |

Barangay official accounts are created by the administrator from the dashboard.

---

##  Internet Required (CDN Libraries)

The app needs internet access on first load to download:
- Tesseract.js (~3 MB, cached after first use)
- YOLO inference endpoint configured for the report model

After the first load, browsers cache Tesseract. Report scanning requires a trained YOLOv8 or YOLOv10 model served by an inference endpoint. Set `window.NEIGHBORLENS_YOLO_ENDPOINT` before `yoloDamageDetector.js`, or use the default `/api/ai/damage` route when the backend is configured to proxy the model.

Interactive GIS mapping uses Leaflet with Esri WorldStreetMap as the single basemap provider for rendering citizen reports and administrative jurisdiction maps. Device coordinates are obtained via standard browser geolocation (`navigator.geolocation`). Geographic validation is handled separately by polygon geofencing to verify coordinates against Bacolod City and barangay territorial boundaries; polygon geofencing is decoupled from map tile visualization. Basemap configuration can be inspected in [mapConfig.js](js/mapConfig.js).

For the required two-photo same-damage check, [ai/inference/image_similarity.py](ai/inference/image_similarity.py) compares YOLO image embeddings with cosine similarity. The default match threshold is `0.85`. Install the Python dependency and run it with:

```powershell
python -m pip install -r ai/requirements.txt
python ai/inference/image_similarity.py damage_photo1.jpg damage_photo2.jpg --model yolov8n.pt
```

The similarity result only confirms that the two images depict the same scene. The YOLO damage detector must still classify the matched images as a crack, pothole, structural issue, or another trained damage class.

YOLO task modes are configured with `DAMAGE_TASK`:

| Task | Weights example | Output | NeighborLens use |
|---|---|---|---|
| `detect` | `yolov8n.pt` | Boxes, labels, confidence | Default road-damage scanning |
| `segment` | `yolov8n-seg.pt` | Instance masks and polygons | Exact damaged-area measurement |
| `pose` | `yolov8n-pose.pt` | Keypoints | Not used for infrastructure damage |
| `obb` | `yolov8n-obb.pt` | Rotated boxes | Angled aerial or drone imagery |
| `classify` | `yolov8n-cls.pt` | Whole-image label | Coarse image filtering |

Use `detect` for the current two-photo report workflow. Use `segment` when the inference service and trained model return polygon masks for precise crack or pothole area measurement.

The endpoint should accept a multipart field named `image` and return:

```json
{
    "model": "yolov8-neighborlens",
    "detections": [{ "class": "pothole", "confidence": 0.92 }]
}
```

### Train the NeighborLens YOLO model

Use the imported v3 dataset in `data/datasets/infrastructure_v3/` with this configuration:

```text
data/datasets/infrastructure_v3/
    train/images/  valid/images/  test/images/
    train/labels/  valid/labels/  test/labels/
```

The valid classes are:
- `damaged_road`
- `damaged_street_light`
- `damaged_traffic_light`

Each label file uses standard YOLO detection rows: `class_id center_x center_y width height`, with normalized values from 0 to 1. Install the AI dependencies and run:

```powershell
python -m pip install -r ai/requirements.txt
python ai/training/train_yolo.py
```

Training writes a checkpoint to its run directory. Start the local inference API with the active checkpoint:

```powershell
npm run ai
```

The local launcher and FastAPI default to `models/production/best.pt`. The Windows launcher uses that path when there is no override. Set `DAMAGE_INFERENCE_URL=http://127.0.0.1:8000/predict` and `DAMAGE_PAIR_INFERENCE_URL=http://127.0.0.1:8000/api/v1/damage/verify-pair` in the Node environment. [Node launcher](scripts/start-ai.js) · [FastAPI](ai/inference/inference_api.py) · [Environment example](.env.example) · [Windows launcher](<Open NeighborLens AI.bat>)

The normal inference launch screens candidate regions with the pinned YuNet and COCO checkpoints bundled with the repository. The Citizen preview requires independently verified relevance before it can show an AI candidate. A scan that needs review still permits a manual report. The source of each photo decision stays separate from severity and operational status.

### Local YOLOv8m v9 migration

The Citizen assessment and report details display the promoted YOLOv8m v9 as **YOLOv8 - NeighborLens AI**. The inference API and stored assessments retain their technical identifiers.

Run these from the repository root with the local Python AI environment. The migration checks both checkpoint hashes and class mappings, keeps a timestamped read-only backup in `models/production/archive/`, and verifies FastAPI health before completing. The manifest records the release, validation provenance, and rollback archive. The training checkpoint stays in its original run directory.

```powershell
.venv/Scripts/python.exe -m ai.training.migrate_yolov8m_v9 check
.venv/Scripts/python.exe -m ai.training.migrate_yolov8m_v9 promote
.venv/Scripts/python.exe -m ai.training.migrate_yolov8m_v9 rollback
```

Use `rollback --backup <archive-directory>` if the active manifest is missing or damaged. To re-promote from the original YOLO11s, pass `promote --backup <archive-directory>` to reuse the verified archive. Restart the running local AI service after either operation and verify `/health`. A worker that is already running keeps the model it loaded at startup. The original YOLO11s had no production manifest, so its rollback removes the v9 manifest.

Recorded epoch-39 validation on 1,259 images reports 70.279% precision, 63.449% recall, 66.815% mAP@0.5, and 38.422% mAP@0.5:0.95 in the training CSV and checkpoint. Training ended at epoch 69. The manifest also records the previously reported summary figures. Independent test evaluation is pending and the 75% mAP@0.5 research target has yet to be demonstrated.

The separate Vercel inference build pins the original YOLO11s SHA-256 and stages the checkpoint without the production manifest. A remote release would require a reviewed checksum and manifest update, independent test evaluation, and a preview build that verifies CPU startup, package size, memory, latency, and the inference endpoints with the 52,017,042-byte checkpoint. [Vercel build](inference-vercel/build.py) · [Vercel entry point](inference-vercel/app.py)
