"""Explicit provider catalog routes shared with the hub and browser.

No suffix guessing, host substring matching or cross-provider credential forwarding.
Fal's platform /v1/models lists fal products, not LLM ids inside its OpenRouter router.
"""
import json
from importlib.resources import files
from urllib.parse import urlsplit

CATALOGS = json.loads(files(__package__).joinpath('endpoint_catalogs.json').read_text(encoding='utf-8'))
NO_CATALOG = "Automatic model discovery is not available for this endpoint. Enter a model ID or use an existing saved model."


def endpoint_catalog(base_url: str) -> dict | None:
    try:
        url = urlsplit(base_url)
        if url.scheme != 'https' or url.username or url.password or url.query or url.fragment or url.port not in (None, 443):
            return None
        base = f'https://{url.hostname}{url.path.rstrip("/")}'
        return next((catalog for catalog in CATALOGS if catalog['baseUrl'] == base), None)
    except (TypeError, ValueError):
        return None
