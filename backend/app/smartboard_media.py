"""Validation of what the model returns for the SmartBoard: images and simulation code.

Nothing here trusts the provider. An image must really decode as PNG/JPEG/WEBP of sane size and dimensions (SVG is refused: it can carry script),
and simulation code must be a bounded, script-bearing HTML fragment that does not use the primitives the sandbox forbids.
The simulation rules live in ai/whiteboard/simulation.py (shared with the scene validator); they are defence in depth, NOT the security boundary
(that is the iframe sandbox without allow-same-origin + CSP).
"""
from __future__ import annotations

import base64
import binascii
import re
import struct
from dataclasses import dataclass

from ai.whiteboard.simulation import BLOCKED_SIM_PATTERNS, MAX_SIM_CHARS, blocked_reasons, has_dynamic_behavior, has_script  # noqa: F401  (re-exported)

MAX_IMAGE_BYTES = 4 * 1024 * 1024
MAX_IMAGE_SIDE = 4096
MIN_IMAGE_SIDE = 8
ALLOWED_IMAGE_MIMES = ("image/png", "image/jpeg", "image/webp")


class MediaRejected(ValueError):
    """The provider output is not acceptable. The message is safe to show to the user."""


@dataclass(frozen=True)
class ValidImage:
    mime: str
    b64: str
    width: int
    height: int
    size: int

    @property
    def data_url(self) -> str:
        return f"data:{self.mime};base64,{self.b64}"


def _png_size(b: bytes):
    if b[:8] == b"\x89PNG\r\n\x1a\n" and b[12:16] == b"IHDR" and len(b) >= 24:
        return "image/png", *struct.unpack(">II", b[16:24])
    return None


def _jpeg_size(b: bytes):
    if b[:3] != b"\xff\xd8\xff":
        return None
    i = 2
    while i + 9 < len(b):
        if b[i] != 0xFF:
            i += 1
            continue
        marker = b[i + 1]
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        seglen = struct.unpack(">H", b[i + 2:i + 4])[0]
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            h, w = struct.unpack(">HH", b[i + 5:i + 9])
            return "image/jpeg", w, h
        i += 2 + seglen
    return None


def _webp_size(b: bytes):
    if b[:4] != b"RIFF" or b[8:12] != b"WEBP" or len(b) < 30:
        return None
    kind = b[12:16]
    if kind == b"VP8 ":
        w, h = struct.unpack("<HH", b[26:30])
        return "image/webp", w & 0x3FFF, h & 0x3FFF
    if kind == b"VP8L":
        bits = struct.unpack("<I", b[21:25])[0]
        return "image/webp", (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
    if kind == b"VP8X":
        return "image/webp", 1 + int.from_bytes(b[24:27], "little"), 1 + int.from_bytes(b[27:30], "little")
    return None


def validate_image(b64: object, declared_mime: object = None) -> ValidImage:
    """Strictly decode and inspect a provider image. The type is taken from the BYTES, never from the provider's claim."""
    if not isinstance(b64, str) or not b64.strip():
        raise MediaRejected("The image service returned no image data.")
    if len(b64) > MAX_IMAGE_BYTES * 4 // 3 + 8:
        raise MediaRejected("The generated image is too large.")
    try:
        raw = base64.b64decode(b64, validate=True)
    except (binascii.Error, ValueError):
        raise MediaRejected("The image service returned corrupted image data.")
    if not raw or len(raw) > MAX_IMAGE_BYTES:
        raise MediaRejected("The generated image is empty or too large.")
    found = _png_size(raw) or _jpeg_size(raw) or _webp_size(raw)
    if not found:
        raise MediaRejected("The image service returned an unsupported or invalid image format.")
    mime, w, h = found
    if declared_mime and str(declared_mime).lower() not in ALLOWED_IMAGE_MIMES:
        raise MediaRejected("The image service returned an unsupported image type.")
    if not (MIN_IMAGE_SIDE <= w <= MAX_IMAGE_SIDE and MIN_IMAGE_SIDE <= h <= MAX_IMAGE_SIDE):
        raise MediaRejected("The generated image has unsupported dimensions.")
    try:                                                    # headers can lie: really decode (bounded by the dimension check above)
        from io import BytesIO
        from PIL import Image
        with Image.open(BytesIO(raw)) as im:
            im.load()
            if im.size != (w, h):
                raise MediaRejected("The generated image is inconsistent.")
    except MediaRejected:
        raise
    except Exception:
        raise MediaRejected("The image service returned corrupted image data.")
    return ValidImage(mime=mime, b64=base64.b64encode(raw).decode("ascii"), width=w, height=h, size=len(raw))


# --------------------------------------------------------------------------------------------------------------- simulations
_FENCE = re.compile(r"```(?:html|HTML)?\s*\n?(.*?)```", re.S)


def extract_simulation_code(text: object) -> str:
    """The model is told to return raw HTML but often fences it. Prefer the fenced block; otherwise use the text as is."""
    if not isinstance(text, str):
        raise MediaRejected("The model returned no simulation.")
    m = _FENCE.search(text)
    return (m.group(1) if m else text.replace("```html", "").replace("```", "")).strip()


def validate_simulation(code: object) -> str:
    if not isinstance(code, str) or not code.strip():
        raise MediaRejected("The model returned an empty simulation.")
    if len(code) > MAX_SIM_CHARS:
        raise MediaRejected("The generated simulation is too large.")
    if not has_script(code):
        raise MediaRejected("The model did not produce an interactive simulation (no script).")
    bad = blocked_reasons(code)
    if bad:
        raise MediaRejected("The generated simulation was blocked for unsafe code: " + ", ".join(bad) + ".")
    if not has_dynamic_behavior(code):
        # A script that neither animates nor listens for input only draws a picture. Reporting that as a working simulation would be a fake success.
        raise MediaRejected("The generated simulation does not animate or respond to input, so it is not an interactive simulation. Please try again.")
    return code


# --------------------------------------------------------------------------------------------------------------- vector drawings
MAX_VECTOR_ELEMENTS = 200
_COORD = 5000.0
_PATH_OK = re.compile(r"^[MmLlHhVvCcSsQqTtAaZz0-9eE+\-., \t\r\n]*$")
_COLOR_OK = re.compile(r"^(#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20}|rgba?\([0-9 ,.%]{3,40}\))$")
_NUM_FIELDS = {"rect": ("x", "y", "width", "height"), "circle": ("x", "y", "radius"), "triangle": ("x", "y", "width", "height"),
               "line": ("x1", "y1", "x2", "y2"), "path": ()}


def _num(v: object, lo: float = -_COORD, hi: float = _COORD) -> float | None:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    f = float(v)
    return f if f == f and lo <= f <= hi else None          # NaN and out-of-range are rejected, not clamped: a wild value means a broken drawing


def validate_vector(parsed: object) -> list[dict]:
    """Keep only well-formed, bounded shapes. Unknown types, odd fields and unsafe strings are dropped; if nothing valid is left the result is an error."""
    items = parsed.get("elements") if isinstance(parsed, dict) else None
    if not isinstance(items, list):
        raise MediaRejected("The model did not return a drawing.")
    out: list[dict] = []
    for it in items[:MAX_VECTOR_ELEMENTS]:
        if not isinstance(it, dict) or it.get("type") not in _NUM_FIELDS:
            continue
        kind = it["type"]
        el: dict = {"type": kind}
        ok = True
        for f in _NUM_FIELDS[kind]:
            n = _num(it.get(f), 0 if f in ("width", "height", "radius") else -_COORD)
            if n is None:
                ok = False
                break
            el[f] = n
        if not ok:
            continue
        if kind == "path":
            pd = it.get("pathData")
            if not isinstance(pd, str) or not pd.strip() or len(pd) > 20_000 or not _PATH_OK.match(pd):
                continue
            el["pathData"] = pd
        color = it.get("color", "#000000")
        el["color"] = color if isinstance(color, str) and _COLOR_OK.match(color) else "#000000"
        if "filled" in it:
            el["filled"] = bool(it["filled"])
        sw = _num(it.get("strokeWidth", 2), 0, 100)
        el["strokeWidth"] = sw if sw is not None else 2
        out.append(el)
    if not out:
        raise MediaRejected("The model returned no usable shapes.")
    return out
