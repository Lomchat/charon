"""Private per-session HTTP relay for credential and optional-parameter isolation.

No protocol conversion. The upstream credential stays out of CLI env/settings;
unknown reasoning settings are omitted even if a CLI supplies a native default.
"""
from __future__ import annotations

import asyncio
import http.server
import json
import secrets
import threading
import urllib.error
import urllib.request
from typing import Callable

from .custom_endpoints import _NoRedirect
from .endpoint_responses import response_stream
from .endpoint_usage import EndpointUsage


# A model request carries the whole conversation, including base64 screenshots.
# This private HTTP limit is separate from the agent's JSON-RPC frame limit.
MAX_REQUEST_BYTES = 256 * 1024 * 1024


def request_body(body: dict, endpoint: dict, engine: str) -> dict:
    result = dict(body)
    check = (endpoint.get("checks") or {}).get(engine) or {}
    levels = check.get("effortLevels") if check.get("model") == body.get("model") and check.get("ok") else []
    if engine == "codex":
        reasoning = result.get("reasoning")
        if not isinstance(reasoning, dict) or reasoning.get("effort") not in (levels or []):
            result.pop("reasoning", None)
        result.pop("service_tier", None)
    elif engine == "claude":
        config = dict(result.get("output_config") or {})
        if config.get("effort") not in (levels or []): config.pop("effort", None)
        if config: result["output_config"] = config
        else: result.pop("output_config", None)
    return result


class EndpointProxy:
    def __init__(self, endpoint: Callable[[], dict], engine: str, on_usage=None):
        self.endpoint = endpoint
        self.engine = engine
        self.token = secrets.token_hex(32)
        loop = asyncio.get_running_loop() if on_usage is not None else None
        owner = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args): pass

            def do_GET(self): self.forward()
            def do_POST(self): self.forward()

            def forward(self):
                usage = None
                streaming = False
                supplied = self.headers.get("Authorization", "").removeprefix("Bearer ") or self.headers.get("x-api-key", "")
                if not secrets.compare_digest(supplied, owner.token):
                    self.send_error(401); return
                if not self.path.startswith("/v1/") or ".." in self.path:
                    self.send_error(404); return
                try:
                    size = int(self.headers.get("Content-Length", "0"))
                    if size < 0 or size > MAX_REQUEST_BYTES:
                        self.send_error(413, "Custom endpoint request exceeds the 256 MiB relay limit"); return
                    endpoint = owner.endpoint()
                    data = self.rfile.read(size) if self.command == "POST" else None
                    if data: data = json.dumps(request_body(json.loads(data), endpoint, owner.engine)).encode()
                    headers = {"Content-Type": "application/json"}
                    for key in ("anthropic-version", "anthropic-beta", "Accept"):
                        if self.headers.get(key): headers[key] = self.headers[key]
                    # No ambient SDK auth or provider-account headers cross this boundary.
                    if endpoint.get("auth") == "bearer": headers["Authorization"] = "Bearer " + endpoint["token"]
                    elif endpoint.get("auth") == "api-key": headers["x-api-key"] = endpoint["token"]
                    req = urllib.request.Request(endpoint["baseUrl"].rstrip("/") + self.path, data=data, headers=headers, method=self.command)
                    if self.command == "POST" and self.path.split("?", 1)[0] in ("/v1/responses", "/v1/messages"):
                        usage = EndpointUsage(owner.engine)
                    try:
                        upstream = urllib.request.build_opener(_NoRedirect()).open(req, timeout=120)
                    except urllib.error.HTTPError as exc:
                        upstream = exc
                    with upstream:
                        self.send_response(upstream.status)
                        self.send_header("Content-Type", upstream.headers.get("Content-Type", "application/json"))
                        self.end_headers()
                        streaming = upstream.headers.get_content_type() == "text/event-stream"
                        if (owner.engine == "codex" and self.path.split("?", 1)[0] == "/v1/responses"
                                and upstream.headers.get_content_type() == "text/event-stream"):
                            for chunk in response_stream(upstream, usage.event if usage else None):
                                self.wfile.write(chunk); self.wfile.flush()
                            return
                        while True:
                            chunk = upstream.read1(65536)
                            if not chunk: break
                            if usage: usage.feed(chunk, streaming=streaming)
                            self.wfile.write(chunk); self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError):
                    pass
                except Exception:
                    # Never reflect credentials or upstream exception details to a CLI log.
                    try: self.send_error(502, "Custom endpoint request failed")
                    except OSError: pass
                finally:
                    if usage is not None and on_usage is not None and not loop.is_closed():
                        # The HTTP worker must not mutate asyncio queues/logs.
                        loop.call_soon_threadsafe(on_usage, usage.result(streaming=streaming))

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=lambda: self.server.serve_forever(poll_interval=0.1), daemon=True)
        self.thread.start()

    def connection(self) -> dict:
        return {**self.endpoint(), "baseUrl": f"http://127.0.0.1:{self.server.server_port}", "auth": "bearer", "token": self.token}

    def stop(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=1)
