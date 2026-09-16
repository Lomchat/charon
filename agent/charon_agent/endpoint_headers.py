"""Provider transport headers, without forwarding ambient account credentials."""
from urllib.parse import urlsplit

from . import __version__


def endpoint_headers(endpoint: dict, path: str, session_id: str) -> dict:
    headers = {"Content-Type": "application/json", "User-Agent": f"Charon/{__version__}"}
    token = str(endpoint.get("token") or "")
    auth = endpoint.get("auth", "none")
    address = urlsplit(endpoint.get("baseUrl") or "")
    opencode = (address.scheme == "https" and address.hostname == "opencode.ai"
                and address.path.rstrip("/") == "/zen/go")
    if opencode:
        headers["x-opencode-session"] = session_id
        # Go uses the same credential for both APIs, but different auth headers.
        if auth != "none":
            auth = "api-key" if path.split("?", 1)[0].startswith("/v1/messages") else "bearer"
    if auth == "bearer": headers["Authorization"] = "Bearer " + token
    elif auth == "api-key": headers["x-api-key"] = token
    elif auth != "none": raise ValueError("Invalid endpoint authentication")
    return headers
