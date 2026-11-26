"""Read a document number from the same normalized image as the fraud model."""

import re
import subprocess
from io import BytesIO
from time import monotonic

from PIL import Image, ImageFilter, ImageOps


DOCUMENT_PATTERNS = (
    (
        "DRIVERS_LICENSE",
        r"\b(?:DRIVER['’]?S?\s+LICEN[CS]E|LAND\s+TRANSPORTATION\s+OFFICE)\b",
        r"\b[A-Z][0-9]{2}[- ]?[0-9]{2}[- ]?[0-9]{6}\b",
    ),
    (
        "PHILSYS",
        r"\b(?:PHILIPPINE\s+IDENTIFICATION\s+(?:CARD|SYSTEM)|PAMBANSANG\s+PAGKAKAKILANLAN|PHILSYS)\b",
        r"\b[0-9]{4}[- ]?[0-9]{4}[- ]?[0-9]{4}[- ]?[0-9]{4}\b",
    ),
)


def _read_text(executable, image, page_mode, deadline):
    result = subprocess.run(
        [executable, "stdin", "stdout", "-l", "eng", "--psm", page_mode],
        input=image,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        timeout=max(0.01, deadline - monotonic()),
        check=True,
    )
    return result.stdout.decode("utf-8", errors="replace").upper()


def _document_candidates(text):
    text = re.sub(r"[ \t]*[-–—−][ \t]*", "-", text)
    return {
        (document_type, re.sub(r"[- ]", "", number))
        for document_type, heading, pattern in DOCUMENT_PATTERNS
        if re.search(heading, text)
        for number in re.findall(pattern, text)
    }


def _search_interface(text):
    search = re.search(
        r"\b(?:GOOGLE\s+(?:IMAGES|LENS)|SEARCH\s+BY\s+IMAGE|VISUALLY\s+SIMILAR\s+IMAGES|IMAGES\.GOOGLE\.COM)\b",
        text,
    )
    controls = re.findall(r"(?m)^\s*(VISIT|SHARE|SAVE)\s*$", text)
    return bool(search and len(set(controls)) >= 2)


def capture_evidence(executable, image):
    deadline = monotonic() + 5
    text = _read_text(executable, image, "11", deadline)
    search_interface = _search_interface(text)
    candidates = _document_candidates(text)
    if not candidates:
        # A dense card can be read as one text block when sparse segmentation
        # misses the short license-number row. Only OCR sees these pixels.
        with Image.open(BytesIO(image)) as original:
            gray = original.convert("L")
        scale = max(1, min(2, 1600 / max(gray.size)))
        enlarged = gray.resize(tuple(round(edge * scale) for edge in gray.size), Image.Resampling.LANCZOS)
        enhanced = ImageOps.autocontrast(enlarged).filter(ImageFilter.UnsharpMask(radius=1, percent=120, threshold=2))
        buffer = BytesIO()
        enhanced.save(buffer, format="PNG")
        text = _read_text(executable, buffer.getvalue(), "6", deadline)
        search_interface = search_interface or _search_interface(text)
        candidates = _document_candidates(text)
    document = None
    if len(candidates) == 1:
        document_type, id_number = candidates.pop()
        document = {"documentType": document_type, "idNumber": id_number}
    return {"captureDocument": document, "searchInterfaceDetected": search_interface}
