"""Private local capture analysis. Enrollment approval is handled separately."""

import hashlib
import hmac
import json
import os
import re
import subprocess
import logging
from contextlib import asynccontextmanager
from threading import Lock

from fastapi import FastAPI, HTTPException, Request, Response
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile
from ai.service_lifecycle import watch_launcher

from .capture_ocr import capture_evidence, check_tesseract, resolve_tesseract, validate_capture_jpeg


MAX_IMAGE_BYTES = 2 * 1024 * 1024
logger = logging.getLogger("uvicorn.error")


@asynccontextmanager
async def lifespan(app):
    watch_launcher()
    secret = os.environ.get("REGISTRATION_FRAUD_SECRET", "")
    if len(secret) < 32 or not secret.isascii():
        raise ValueError("Configure a private ASCII fraud service secret of at least 32 characters.")
    app.state.secret = secret
    app.state.fraud_enabled = not (os.environ.get("NODE_ENV") == "development" and
                                  os.environ.get("REGISTRATION_FRAUD_SCREENING_ENABLED") == "false" and
                                  not os.environ.get("VERCEL"))
    if app.state.fraud_enabled:
        from .forensics import assess_frames

        app.state.assess_frames = assess_frames
    model_name = os.environ.get("IDENTITY_RESEARCH_MODEL", "none") if app.state.fraud_enabled else "none"
    app.state.model_name = model_name
    device = os.environ.get("IDENTITY_RESEARCH_DEVICE", "cpu")
    if model_name == "none":
        app.state.model = None
    elif model_name == "trufor":
        from .forensics import TruFor

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
    app.state.ocr = resolve_tesseract(ocr)
    if app.state.ocr:
        check_tesseract(app.state.ocr)
    elif not app.state.fraud_enabled:
        raise ValueError("Tesseract was not found. Configure REGISTRATION_CAPTURE_TESSERACT.")
    app.state.model_slot = Lock()
    app.state.ocr_slot = Lock()
    yield


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


def authorize(request):
    authorization = request.headers.get("authorization", "").encode()
    expected = f"Bearer {app.state.secret}".encode()
    if not hmac.compare_digest(authorization, expected):
        raise HTTPException(403, "Forbidden.")


async def read_capture(request):
    length = request.headers.get("content-length", "")
    if not length.isascii() or not length.isdigit() or len(length) > 8 or int(length) > MAX_IMAGE_BYTES + 4096:
        raise HTTPException(413, "Invalid request size.")
    async with request.form(max_files=1, max_fields=1, max_part_size=512) as form:
        capture_id = form.get("captureId")
        uploads = form.getlist("frames")
        if not isinstance(capture_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{32}", capture_id):
            raise HTTPException(400, "Invalid capture identifier.")
        if len(uploads) != 1 or not isinstance(uploads[0], UploadFile) or uploads[0].content_type != "image/jpeg":
            raise HTTPException(400, "One JPEG capture frame is required.")
        frame = await uploads[0].read(MAX_IMAGE_BYTES + 1)
        if not frame or len(frame) > MAX_IMAGE_BYTES:
            raise HTTPException(400, "Invalid frame data.")
        return capture_id, frame


def signed_capture(capture_id, frame, data, header):
    payload = json.dumps({
        "captureId": capture_id, "framesSha256": [hashlib.sha256(frame).hexdigest()], **data,
    }, allow_nan=False).encode()
    signature = hmac.digest(app.state.secret.encode(), payload, "sha256").hex()
    return Response(payload, media_type="application/json",
                    headers={header: signature, "Cache-Control": "no-store"})


@app.get("/health")
async def health(request: Request):
    authorize(request)
    return {"service": "neighborlens-identity-api", "protocol": 1,
            "ocr": bool(app.state.ocr), "fraud": app.state.fraud_enabled,
            "model": app.state.model_name, "profile": os.environ.get("NEIGHBORLENS_IDENTITY_PROFILE"),
            "instance": os.environ.get("NEIGHBORLENS_AI_INSTANCE")}


@app.post("/ocr-capture")
async def ocr_capture(request: Request):
    authorize(request)
    if not app.state.ocr:
        raise HTTPException(503, "Tesseract OCR unavailable.")
    if not app.state.ocr_slot.acquire(blocking=False):
        raise HTTPException(503, "Tesseract OCR busy.")
    try:
        capture_id, frame = await read_capture(request)
        try:
            validate_capture_jpeg(frame)
            evidence = await run_in_threadpool(capture_evidence, app.state.ocr, frame)
        except ValueError:
            raise HTTPException(400, "Invalid capture JPEG.") from None
        except (OSError, subprocess.SubprocessError) as error:
            logger.warning("Capture OCR failed (%s).", type(error).__name__)
            raise HTTPException(503, "Tesseract could not read the capture.") from None
        return signed_capture(capture_id, frame, evidence, "X-Registration-OCR-Signature")
    finally:
        app.state.ocr_slot.release()


@app.post("/assess-capture")
async def assess_capture(request: Request):
    authorize(request)
    if not app.state.fraud_enabled:
        raise HTTPException(404, "Fraud screening disabled.")
    if not app.state.model_slot.acquire(blocking=False):
        raise HTTPException(503, "Research model busy.")
    try:
        capture_id, frame = await read_capture(request)
        try:
            signals = await run_in_threadpool(app.state.assess_frames, app.state.model, [frame])
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
                    capture_evidence, app.state.ocr, frame)
            except (OSError, subprocess.SubprocessError, ValueError) as error:
                raise HTTPException(503, "Local capture OCR unavailable.") from error
        return signed_capture(capture_id, frame, {
            "purpose": "document_fraud_research" if model is not None else "document_capture_signals",
            "assessment": "retake" if needs_retake else "review",
            "model": model.label if model is not None else None,
            **signals,
            **capture_ocr,
        }, "X-Registration-Fraud-Signature")
    finally:
        app.state.model_slot.release()
