"""Optional measurement evidence from a separately validated image estimator."""

import asyncio
import logging
import math
from collections.abc import Awaitable, Callable
from typing import Annotated

from PIL import Image
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictFloat, StrictInt, StrictStr

LOGGER = logging.getLogger("neighborlens_inference_api")
Number = StrictInt | StrictFloat
MeasurementValue = Number | StrictBool | StrictStr | Annotated[list[Number], Field(min_length=1, max_length=256)]


class SeverityMeasurement(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    source: Annotated[StrictStr, Field(min_length=1, max_length=128)]
    version: Annotated[StrictStr, Field(min_length=1, max_length=128)]
    evidence: Annotated[dict[str, MeasurementValue], Field(min_length=1, max_length=24)]
    uncertainty: Annotated[dict[str, Number], Field(max_length=24)]

MeasurementProvider = Callable[[Image.Image, str, tuple[float, float, float, float]], Awaitable[dict | None]]


async def attach_measurement(image, detections, category, provider, timeout):
    if category is None:
        return detections, "NO_ELIGIBLE_DAMAGE"
    if provider is None:
        return detections, "SEVERITY_PROVIDER_UNAVAILABLE"
    index = max((i for i, item in enumerate(detections) if item.eligible and item.damage_type == category),
                key=lambda i: detections[i].confidence_score, default=None)
    if index is None:
        return detections, "NO_ELIGIBLE_DAMAGE"
    item = detections[index]
    box = item.bounding_box
    try:
        raw = await asyncio.wait_for(provider(image, category, (box.x, box.y, box.width, box.height)), timeout)
        if raw is None:
            return detections, "INSUFFICIENT_MEASUREMENTS"
        measurement = SeverityMeasurement.model_validate(raw)
        if any(not math.isfinite(value) or value < 0 for value in measurement.uncertainty.values()):
            return detections, "INVALID_MEASUREMENTS"
    except TimeoutError:
        return detections, "SEVERITY_PROVIDER_TIMEOUT"
    except Exception as error:
        LOGGER.warning("Severity evidence unavailable (%s).", type(error).__name__)
        return detections, "INVALID_MEASUREMENTS"
    result = list(detections)
    result[index] = item.model_copy(update={"severity_measurement": measurement})
    return result, "MEASUREMENTS_REQUIRE_POLICY"


def severity_status(reason):
    return "REVIEW_REQUIRED" if reason == "MEASUREMENTS_REQUIRE_POLICY" else "NOT_ASSESSED"
