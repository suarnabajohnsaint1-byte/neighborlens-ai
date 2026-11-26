"""Standalone, loopback-only process for single-image FREUID diagnostics."""

import hmac
import os
from contextlib import asynccontextmanager
from threading import Lock

import torch
from fastapi import FastAPI, HTTPException, Request
from starlette.concurrency import run_in_threadpool

from .forensics import MAX_IMAGE_BYTES, decode_frame
from .freuid import FreuidA31


@asynccontextmanager
async def lifespan(app):
    secret = os.environ["REGISTRATION_FRAUD_SECRET"]
    if len(secret) < 32 or not secret.isascii():
        raise ValueError("A private screening credential is required.")
    app.state.secret = secret
    app.state.layout = os.environ["FREUID_RESEARCH_LAYOUT"]
    torch.set_num_threads(4)
    app.state.model = FreuidA31(
        os.environ["FREUID_ASSETS"], app.state.layout, os.environ.get("IDENTITY_RESEARCH_DEVICE", "cpu")
    )
    app.state.slot = Lock()
    yield


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.post("/inspect-upload")
async def inspect_upload(request: Request):
    expected = f"Bearer {app.state.secret}".encode()
    if not hmac.compare_digest(request.headers.get("authorization", "").encode(), expected):
        raise HTTPException(403, "Forbidden.")
    length = request.headers.get("content-length", "")
    if not length.isascii() or not length.isdigit() or len(length) > 7 or not 0 < int(length) <= MAX_IMAGE_BYTES:
        raise HTTPException(413, "Invalid image size.")
    if not app.state.slot.acquire(blocking=False):
        raise HTTPException(503, "FREUID is busy.")
    try:
        data = await request.body()
        try:
            image = await run_in_threadpool(decode_frame, data)
        except (ValueError, OSError) as error:
            raise HTTPException(422, "Upload a supported JPEG or PNG.") from error
        try:
            score = await run_in_threadpool(app.state.model.score, image)
        except (ValueError, RuntimeError) as error:
            raise HTTPException(503, "FREUID inference failed.") from error
        return {"model": "FREUID a31", "layout": app.state.layout, "researchScore": score}
    finally:
        app.state.slot.release()
