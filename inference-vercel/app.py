"""Isolated Vercel entrypoint for the existing NeighborLens inference application."""

import hmac
import os
from pathlib import Path

from fastapi import Request
from fastapi.responses import JSONResponse

os.environ["CUDA_VISIBLE_DEVICES"] = "-1"

from ai.inference.inference_api import DEFAULT_OBJECT_WEIGHTS, DEFAULT_PORTRAIT_WEIGHTS, create_app  # noqa: E402

SECRET = os.environ.get("INFERENCE_SHARED_SECRET", "")
if len(SECRET) < 32:
    raise RuntimeError("INFERENCE_SHARED_SECRET must contain at least 32 characters.")

WEIGHTS = Path(__file__).resolve().parent / "models/production/best.pt"
app = create_app(
    str(WEIGHTS), float(os.environ.get("AI_CONFIDENCE", "0.30")), int(os.environ.get("AI_IMAGE_SIZE", "640")),
    enable_portrait_filter=True, portrait_model=DEFAULT_PORTRAIT_WEIGHTS, object_model=DEFAULT_OBJECT_WEIGHTS,
)


@app.middleware("http")
async def authorize_and_limit(request: Request, call_next):
    if request.url.path in {"/health", "/api/health"} and request.method == "GET":
        return await call_next(request)
    supplied = request.headers.get("X-Inference-Key", "")
    if not hmac.compare_digest(supplied, SECRET):
        return JSONResponse({"detail": "Unauthorized"}, status_code=401)
    if request.method == "POST":
        try:
            length = int(request.headers.get("content-length", "0"))
        except ValueError:
            return JSONResponse({"detail": "Invalid request size"}, status_code=400)
        if length > 4 * 1024 * 1024:
            return JSONResponse({"detail": "Image request is too large"}, status_code=413)
        body = await request.body()
        if len(body) > 4 * 1024 * 1024:
            return JSONResponse({"detail": "Image request is too large"}, status_code=413)
    return await call_next(request)
