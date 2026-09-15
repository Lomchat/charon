"""Bound inline image history for fal without deleting images or local originals.

The relay is stdlib-only; Pillow is a lazy runtime codec, installed in the SDK
venv. Ordinary requests and other endpoints do not load or require that codec.
"""
from __future__ import annotations

import base64
import copy
import hashlib
import io
import threading
from collections import OrderedDict
from urllib.parse import urlsplit


# Leave room below fal's 30 MB ceiling, including base64/framing overhead.
FAL_IMAGE_BUDGET = 20 * 1024 * 1024
MAX_CACHE_BYTES = 4 * 1024 * 1024
MAX_SOURCE_BYTES = 48 * 1024 * 1024
MAX_PIXELS = 40_000_000
_CODECS = threading.BoundedSemaphore(2)


class ImageBudgetError(ValueError):
    pass


def image_parts(body):
    """Walk protocol content, never tool arguments, schemas or JSON strings."""
    def walk(value):
        if isinstance(value, list):
            for item in value:
                yield from walk(item)
        elif isinstance(value, dict):
            kind = value.get("type")
            if kind in ("input_image", "computer_screenshot"):
                url = value.get("image_url")
                if isinstance(url, str) and url.startswith("data:image/"):
                    yield value, "image_url", url, False
            elif kind == "image":
                source = value.get("source")
                if isinstance(source, dict) and source.get("type") == "base64":
                    data, mime = source.get("data"), source.get("media_type")
                    if isinstance(data, str) and isinstance(mime, str) and mime.startswith("image/"):
                        yield source, "data", f"data:{mime};base64,{data}", True
            # Messages, function_call_output and Anthropic tool_result have
            # content/output; tool_use.input is deliberately not followed.
            for key in ("content", "output"):
                if key in value:
                    yield from walk(value[key])
    for key in ("input", "messages"):
        yield from walk(body.get(key))


def encode_image(url: str, edge: int | None, quality: int) -> str | None:
    try:
        from PIL import Image, ImageOps
    except ImportError:
        raise ImageBudgetError("Image history needs compression. Update this VPS's Charon agent to install the image codec.") from None
    try:
        header, encoded = url.split(",", 1)
        if not header.endswith(";base64") or len(encoded) > MAX_SOURCE_BYTES * 4 // 3:
            return None
        raw = base64.b64decode(encoded, validate=True)
        with _CODECS, Image.open(io.BytesIO(raw)) as source:
            if source.width * source.height > MAX_PIXELS or getattr(source, "is_animated", False):
                return None
            picture = ImageOps.exif_transpose(source)
            if edge is not None:
                picture.thumbnail((edge, edge), Image.Resampling.LANCZOS)
            # Preserve real transparency; screenshots with an opaque alpha
            # channel can use JPEG without changing their background.
            alpha = picture.convert("RGBA").getchannel("A") if "A" in picture.getbands() or "transparency" in picture.info else None
            transparent = alpha is not None and alpha.getextrema()[0] < 255
            out = io.BytesIO()
            if transparent:
                picture.save(out, format="PNG", optimize=True)
                mime = "image/png"
            else:
                picture.convert("RGB").save(out, format="JPEG", quality=quality, subsampling=0, optimize=True)
                mime = "image/jpeg"
            return f"data:{mime};base64," + base64.b64encode(out.getvalue()).decode("ascii")
    except (ValueError, OSError, Image.DecompressionBombError):
        return None


class EndpointImages:
    def __init__(self, encoder=encode_image):
        self.encoder = encoder
        self.cache = OrderedDict()
        self.cache_bytes = 0
        self.lock = threading.Lock()

    def prepare(self, body: dict, endpoint: dict) -> dict:
        url = urlsplit(endpoint.get("baseUrl", ""))
        # A provider-specific bound must not degrade self-hosted/native APIs.
        if url.hostname != "fal.run" or not url.path.startswith("/openrouter/router/"):
            return body
        parts = list(image_parts(body))
        total = sum(len(part[2]) for part in parts)
        if total <= FAL_IMAGE_BUDGET:
            return body
        result = copy.deepcopy(body)
        parts = list(image_parts(result))
        # Serialize a session's encodes, cache by bytes/profile (never URL/auth),
        # and bound retained compressed data. The original history is not cached.
        with self.lock:
            for edge, quality in ((None, 90), (1600, 85), (1024, 80), (768, 75)):
                for part, key, original, raw in parts:
                    current = f"data:{part['media_type']};base64,{part[key]}" if raw else part[key]
                    cache_key = (hashlib.sha256(original.encode()).digest(), edge, quality)
                    if cache_key in self.cache:
                        converted = self.cache.pop(cache_key)
                        self.cache[cache_key] = converted
                    else:
                        converted = self.encoder(original, edge, quality)
                        if converted is not None and len(converted) <= MAX_CACHE_BYTES:
                            self.cache[cache_key] = converted
                            self.cache_bytes += len(converted)
                            while self.cache_bytes > MAX_CACHE_BYTES or len(self.cache) > 128:
                                _, old = self.cache.popitem(last=False)
                                self.cache_bytes -= len(old)
                    if converted is None or len(converted) >= len(current):
                        continue
                    total += len(converted) - len(current)
                    if raw:
                        header, part[key] = converted.split(",", 1)
                        part["media_type"] = header[5:].split(";", 1)[0]
                    else:
                        part[key] = converted
                    # Oldest first: recent screenshots keep their full detail
                    # once sufficient room has been recovered.
                    if total <= FAL_IMAGE_BUDGET:
                        return result
        raise ImageBudgetError("Image history still exceeds fal's size limit after compression. Compact the session or use a smaller image; originals have been preserved.")
