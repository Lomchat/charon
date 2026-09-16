"""Per-model endpoint parameters, independent of the native CLI effort enums."""
from __future__ import annotations

import re
from urllib.parse import urlsplit


def is_opencode_go(endpoint: dict) -> bool:
    url = urlsplit(endpoint.get("baseUrl") or "")
    return url.scheme == "https" and url.netloc == "opencode.ai" and url.path.rstrip("/") == "/zen/go"


def model_metadata(endpoint: dict, model: str) -> dict:
    return next((m for m in endpoint.get("models", []) if m.get("id") == model), {})


def parameters(endpoint: dict, engine: str, model: str) -> list[dict]:
    meta = model_metadata(endpoint, model)
    check = (meta.get("checks") or {}).get(engine) or (endpoint.get("checks") or {}).get(engine) or {}
    if not check.get("ok") or check.get("model") != model:
        return []
    declared = (meta.get("parameters") or {}).get(engine)
    if isinstance(declared, list) and is_opencode_go(endpoint):
        return declared
    return [{"id": "effort", "values": [{"value": v} for v in check.get("effortLevels", [])]}]


def selected_params(endpoint: dict, engine: str, model: str, effort: str | None) -> dict[str, str]:
    if not effort:
        return {}
    if len(effort) > 256:
        raise ValueError("Invalid endpoint parameters")
    parts = effort.split("&") if "=" in effort else ["effort=" + effort]
    selected = {}
    for part in parts:
        if not re.fullmatch(r"[a-z][a-z0-9_]{0,31}=[a-z0-9][a-z0-9_.-]{0,31}", part, re.I):
            raise ValueError("Invalid endpoint parameters")
        key, value = part.split("=", 1)
        if key in selected or len(selected) >= 8:
            raise ValueError("Invalid endpoint parameters")
        selected[key] = value
    allowed = {p["id"]: {v["value"] for v in p.get("values", [])} for p in parameters(endpoint, engine, model)}
    if any(value not in allowed.get(key, set()) for key, value in selected.items()):
        raise ValueError("Unsupported endpoint model parameters")
    if selected.get("thinking") == "false" and ("effort" in selected or "budget_tokens" in selected):
        raise ValueError("Enable thinking before setting its effort or budget")
    return selected


def apply_parameters(body: dict, endpoint: dict, engine: str, effort: str | None) -> dict:
    result = dict(body)
    # Native-account defaults never become custom-endpoint settings. The session
    # selection is authoritative, including when the CLI does not know the model.
    result.pop("service_tier", None)
    if engine == "codex":
        result.pop("reasoning", None)
    else:
        config = dict(result.get("output_config") or {})
        config.pop("effort", None)
        if config: result["output_config"] = config
        else: result.pop("output_config", None)
        if is_opencode_go(endpoint): result.pop("thinking", None)
    model = body.get("model", "")
    if model != endpoint.get("model"):
        return result
    selected = selected_params(endpoint, engine, model, effort)
    level = selected.get("effort")
    thinking = selected.get("thinking")
    budget = selected.get("budget_tokens")
    if engine == "codex":
        if thinking == "false": level = "none"
        elif thinking == "true" and not level:
            values = next((p.get("values", []) for p in parameters(endpoint, engine, model) if p.get("id") == "effort"), [])
            levels = [v["value"] for v in values if v["value"] != "none"]
            if not levels: raise ValueError("This Responses model does not declare an enabled reasoning effort")
            level = "high" if "high" in levels else levels[0]
        if level: result["reasoning"] = {"effort": level}
    else:
        if thinking == "false" or level == "none":
            result["thinking"] = {"type": "disabled"}
        elif budget:
            limit = (model_metadata(endpoint, model).get("info") or {}).get("outputTokens", 32768)
            amount = int(budget)
            if amount >= limit: raise ValueError("Thinking budget exceeds the model output limit")
            result["thinking"] = {"type": "enabled", "budget_tokens": amount}
            result["max_tokens"] = max(result.get("max_tokens", 0), min(limit, amount + 4096))
        elif thinking == "true" or (level and is_opencode_go(endpoint)):
            result["thinking"] = {"type": "adaptive", "display": "summarized"}
        if level and level != "none":
            result["output_config"] = {**result.get("output_config", {}), "effort": level}
    return result
