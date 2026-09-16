"""Session-only provider overrides. Never mutate os.environ or user/project files."""
from __future__ import annotations

import json
from typing import Any


def endpoint_of(config: dict) -> dict | None:
    value = config.get("customEndpoint")
    return value if isinstance(value, dict) else None


def redact(value: Any, endpoint: dict | None) -> Any:
    token = (endpoint or {}).get("token")
    if not token: return value
    if isinstance(value, str): return value.replace(token, "[redacted]")
    if isinstance(value, dict): return {k: redact(v, endpoint) for k, v in value.items()}
    if isinstance(value, list): return [redact(v, endpoint) for v in value]
    return value


def claude_env(endpoint: dict, model: str, effort: str | None) -> dict[str, str]:
    if endpoint.get("credentialError"): raise ValueError(endpoint["credentialError"])
    token = endpoint.get("token") or ""
    auth = endpoint.get("auth")
    if auth != "none" and not token: raise ValueError("Endpoint credential is missing")
    result = {
        "ANTHROPIC_BASE_URL": endpoint["baseUrl"],
        "ANTHROPIC_API_KEY": token if auth == "api-key" else "",
        "ANTHROPIC_AUTH_TOKEN": token if auth == "bearer" else "",
        "CLAUDE_CODE_OAUTH_TOKEN": "",
        "CLAUDE_CODE_USE_BEDROCK": "0", "CLAUDE_CODE_USE_VERTEX": "0", "CLAUDE_CODE_USE_FOUNDRY": "0",
        "ANTHROPIC_MODEL": model,
        "ANTHROPIC_SMALL_FAST_MODEL": model,
        "CLAUDE_CODE_SUBAGENT_MODEL": model,
        # Endpoint parameters are applied by the relay, not by the native CLI.
        "CLAUDE_CODE_EFFORT_LEVEL": "auto",
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
        "CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS": "1",
    }
    # An unauthenticated endpoint must not fall through to a stored OAuth login.
    # The local CLI requires a credential; a non-secret sentinel satisfies it.
    if auth == "none": result["ANTHROPIC_API_KEY"] = "charon-no-auth"
    for family in ("OPUS", "SONNET", "HAIKU", "FABLE"):
        result[f"ANTHROPIC_DEFAULT_{family}_MODEL"] = model
    return result


def codex_overrides(endpoint: dict, model: str, effort: str | None) -> tuple[list[str], dict[str, str]]:
    if endpoint.get("credentialError"): raise ValueError(endpoint["credentialError"])
    token = endpoint.get("token") or ""
    auth = endpoint.get("auth")
    if auth != "none" and not token: raise ValueError("Endpoint credential is missing")
    provider: dict = {
        "name": endpoint.get("name") or "Custom endpoint",
        "base_url": endpoint["baseUrl"].rstrip("/") + "/v1",
        "wire_api": "responses", "requires_openai_auth": False,
        "supports_websockets": False,
    }
    if auth == "bearer": provider["env_key"] = "CHARON_ENDPOINT_TOKEN"
    if auth == "api-key": provider["env_http_headers"] = {"x-api-key": "CHARON_ENDPOINT_TOKEN"}
    def toml(value: Any) -> str:
        if isinstance(value, dict): return "{" + ", ".join(json.dumps(k) + "=" + toml(v) for k, v in value.items()) + "}"
        return json.dumps(value)
    overrides = [
        'model_provider="charon_custom"',
        'model=' + json.dumps(model),
        'model_providers.charon_custom=' + toml(provider),
        # Do not inherit a native-account reasoning or service-tier preference.
        'model_reasoning_summary="none"',
        'model_supports_reasoning_summaries=false',
        'web_search="disabled"',
        'approvals_reviewer="user"',
        'shell_environment_policy.exclude=["CHARON_ENDPOINT_TOKEN"]',
    ]
    overrides.append('model_reasoning_effort="none"')
    check = (endpoint.get("checks") or {}).get("codex") or {}
    if check.get("model") == model and isinstance(check.get("contextWindow"), int):
        overrides.append("model_context_window=" + str(check["contextWindow"]))
    return overrides, {"CHARON_ENDPOINT_TOKEN": token}
