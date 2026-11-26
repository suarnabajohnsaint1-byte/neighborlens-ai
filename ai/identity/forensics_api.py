"""Private local capture analysis. Enrollment approval is handled separately."""

import hashlib
import hmac
import json
import os
import re
import subprocess
from shutil import which
from contextlib import asynccontextmanager
from threading import Lock

from fastapi import FastAPI, HTTPException, Request, Response
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile

from .forensics import MAX_IMAGE_BYTES, TruFor, assess_frames
from .capture_ocr import capture_evidence


@asynccontextmanager
async def lifespan(app):
    secret = os.environ["REGISTRATION_FRAUD_SECRET"]
    if len(secret) < 32 or not secret.isascii():
        raise ValueError("Configure a private ASCII fraud service secret of at least 32 characters.")
    app.state.secret = secret
    model_name = os.environ.get("IDENTITY_RESEARCH_MODEL", "none")
    device = os.environ.get("IDENTITY_RESEARCH_DEVICE", "cpu")
    if model_name == "none":
        app.state.model = None
    elif model_name == "trufor":
        app.state.model = TruFor(
            os.environ["TRUFOR_SOURCE"],
            os.environ["TRUFOR_WEIGHTS_ARCHIVE"],
            device,
        )
    elif model_name == "freuid-a31":
        from .freuid import FreuidA31

        app.state.model = FreuidA31(os.environ["FREUID_ASSETS"], os.environ["FREUID_RESEARCH_LAYOUT"], device)
    else:
        raise ValueError("Unknown identity research model.")
    ocr = os.environ.get("REGISTRATION_CAPTURE_TESSERACT")
    app.state.ocr = which(ocr) if ocr else None
    if ocr and not app.state.ocr:
        raise ValueError("The configured capture OCR executable was not found.")
    app.state.model_slot = Lock()
    yield


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.post("/assess-capture")
async def assess_capture(request: Request):
    authorization = request.headers.get("authorization", "").encode()
    expected = f"Bearer {app.state.secret}".encode()
    if not hmac.compare_digest(authorization, expected):
        raise HTTPException(403, "Forbidden.")
    length = request.headers.get("content-length", "")
    if not length.isascii() or not length.isdigit() or len(length) > 8 or int(length) > MAX_IMAGE_BYTES + 4096:
        raise HTTPException(413, "Invalid request size.")
    if not app.state.model_slot.acquire(blocking=False):
        raise HTTPException(503, "Research model busy.")
    try:
        async with request.form(max_files=1, max_fields=1, max_part_size=512) as form:
            capture_id = form.get("captureId")
            uploads = form.getlist("frames")
            if not isinstance(capture_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{32}", capture_id):
                raise HTTPException(400, "Invalid capture identifier.")
            if len(uploads) != 1 or not all(isinstance(upload, UploadFile) for upload in uploads):
                raise HTTPException(400, "One capture frame is required.")
            frames = await uploads[0].read(MAX_IMAGE_BYTES + 1)
            if not frames or len(frames) > MAX_IMAGE_BYTES:
                raise HTTPException(400, "Invalid frame data.")
            frames = [frames]
        try:
            signals = await run_in_threadpool(assess_frames, app.state.model, frames)
        except (ValueError, OSError) as error:
            raise HTTPException(400, "The frames could not be processed.") from error
        except RuntimeError as error:
            raise HTTPException(503, "Local capture analysis unavailable.") from error
        model = app.state.model
        # A flat decoded frame contains no usable card detail. No learned quality cutoff is applied.
        needs_retake = signals["laplacianVariance"][0] == 0
        capture_ocr = {}
        if app.state.ocr:
            try:
                capture_ocr = {"captureDocument": None} if needs_retake else await run_in_threadpool(
                    capture_evidence, app.state.ocr, frames[0])
            except (OSError, subprocess.SubprocessError) as error:
                raise HTTPException(503, "Local capture OCR unavailable.") from error
        payload = json.dumps({
            "purpose": "document_fraud_research" if model is not None else "document_capture_signals",
            "assessment": "retake" if needs_retake else "review",
            "captureId": capture_id,
            "framesSha256": [hashlib.sha256(frame).hexdigest() for frame in frames],
            "model": model.label if model is not None else None,
            **signals,
            **capture_ocr,
        }, allow_nan=False).encode()
        signature = hmac.digest(app.state.secret.encode(), payload, "sha256").hex()
        return Response(payload, media_type="application/json", headers={
            "X-Registration-Fraud-Signature": signature,
            "Cache-Control": "no-store",
        })
    finally:
        app.state.model_slot.release()
