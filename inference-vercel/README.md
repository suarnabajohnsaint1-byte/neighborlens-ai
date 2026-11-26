# NeighborLens inference project

This directory is a **separate Vercel project**. The existing website remains rooted at the repository root and keeps its own `vercel.json`.

## Before deployment

1. In Vercel, create a new project from the same Git repository and select the intended branch.
2. Set **Root Directory** to `inference-vercel`. Enable **Include source files outside of the Root Directory in the Build Step**. The build stages only the [allowlisted inference files and checkpoint](build.py). It checks the committed model's SHA-256 before deployment.
3. Keep the project's framework setting on FastAPI (the local `vercel.json` sets this). Use Python 3.12 from `.python-version`.
4. Set `INFERENCE_SHARED_SECRET` to a freshly generated random value of at least 32 characters in the inference project's server-side environment. Set `AI_CONFIDENCE=0.30` and `AI_IMAGE_SIZE=640` as needed. Neither secret nor model is sent to browser JavaScript.
5. Try a Preview build first. The pinned CPU-only PyTorch stack, OpenCV, and model may exceed the plan's function package, RAM, or cold-start budget. If the project offers large Functions, opt in through its documented project setting and recheck the built package. A successful local build does not prove a successful Vercel build.

The FastAPI app exports `app` from `app.py`. The model loads once per warm instance; requests use the CPU build of PyTorch. `/health` is public. Every other route requires `X-Inference-Key`. POST bodies over 4 MiB are rejected. Vercel also enforces its own request limit.

## Verify the inference project

Use test images with no personal information. After the Preview deployment:

- `GET https://<inference-host>/health` must return a JSON response with `ok: true` and the expected four model classes.
- An unauthenticated `POST /predict` and `POST /api/v1/damage/verify-pair` must return 401.
- Send one valid JPEG to `/predict` and two valid JPEGs to `/api/v1/damage/verify-pair`, each with the `X-Inference-Key` header. Inspect response schema, latency, memory, and function logs. Do not log photos or the secret.
- Test invalid image bytes, unsupported types, and an oversized request.

Only after those checks, update the existing **Node website** project's server-side environment:

```env
DAMAGE_INFERENCE_PROVIDER=local
DAMAGE_INFERENCE_URL=https://<inference-host>/predict
DAMAGE_PAIR_INFERENCE_URL=https://<inference-host>/api/v1/damage/verify-pair
INFERENCE_SHARED_SECRET=<same-random-secret>
```

The provider name `local` denotes the current multipart FastAPI protocol; it can call an HTTPS host. Redeploy the Node project after setting the variables. Verify a citizen's real single-photo assessment and two-photo check before treating reporting as operational. The Node adapter refuses plain HTTP or a missing service secret on Vercel.

## Limits and rollback

The tracked checkpoint is 52,072,196 bytes. Dependency bundle size and Vercel CPU/memory behavior must be measured in a Preview build. The Python package could exceed the available function size even though the model itself is relatively small. The current browser flow can also submit images above Vercel's 4.5 MB function request cap; this deployment does not change that workflow. If these limits block Vercel, deploy this same FastAPI app on a container host with adequate CPU/RAM (or a GPU) and point the Node URLs there after securing the service. Do not substitute an unvalidated checkpoint.

To roll back integration, restore the previous Node inference environment configuration and redeploy the website; do not delete the independent inference project or change production model weights while investigating. Keep `INFERENCE_SHARED_SECRET` out of Git, logs, and browser code.
