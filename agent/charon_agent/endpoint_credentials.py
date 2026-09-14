"""AES-256-GCM for endpoint tokens in agent state, using the system OpenSSL.

The zipapp remains stdlib-only. OpenSSL's EVP performs authenticated encryption;
the per-instance key is a separate 0600 file, never part of state or RPC output.
"""
from __future__ import annotations

import base64
import copy
import ctypes as c
import ctypes.util
import os
from pathlib import Path


def _crypt(data: bytes, key: bytes, iv: bytes, tag: bytes | None = None) -> tuple[bytes, bytes]:
    lib = c.CDLL(ctypes.util.find_library("crypto") or "libcrypto.so.3")
    signatures = {
        "EVP_CIPHER_CTX_new": ([], c.c_void_p),
        "EVP_CIPHER_CTX_free": ([c.c_void_p], None),
        "EVP_aes_256_gcm": ([], c.c_void_p),
        "EVP_CipherInit_ex": ([c.c_void_p, c.c_void_p, c.c_void_p, c.c_void_p, c.c_void_p, c.c_int], c.c_int),
        "EVP_CipherUpdate": ([c.c_void_p, c.c_void_p, c.POINTER(c.c_int), c.c_void_p, c.c_int], c.c_int),
        "EVP_CipherFinal_ex": ([c.c_void_p, c.c_void_p, c.POINTER(c.c_int)], c.c_int),
        "EVP_CIPHER_CTX_ctrl": ([c.c_void_p, c.c_int, c.c_int, c.c_void_p], c.c_int),
    }
    for name, (args, result) in signatures.items():
        fn = getattr(lib, name); fn.argtypes = args; fn.restype = result
    ctx = lib.EVP_CIPHER_CTX_new()
    if not ctx:
        raise RuntimeError("Endpoint credential encryption unavailable")
    try:
        def check(result: int) -> None:
            if result != 1:
                raise ValueError("Endpoint credential authentication failed")
        check(lib.EVP_CipherInit_ex(ctx, lib.EVP_aes_256_gcm(), None, key, iv, int(tag is None)))
        out = c.create_string_buffer(len(data) + 32)
        size = c.c_int()
        check(lib.EVP_CipherUpdate(ctx, out, c.byref(size), data, len(data)))
        count = size.value
        if tag is not None:
            check(lib.EVP_CIPHER_CTX_ctrl(ctx, 0x11, 16, tag))  # EVP_CTRL_GCM_SET_TAG
        check(lib.EVP_CipherFinal_ex(ctx, c.byref(out, count), c.byref(size)))
        result = out.raw[:count + size.value]
        tag_out = c.create_string_buffer(16)
        if tag is None:
            check(lib.EVP_CIPHER_CTX_ctrl(ctx, 0x10, 16, tag_out))  # EVP_CTRL_GCM_GET_TAG
        return result, tag_out.raw
    finally:
        lib.EVP_CIPHER_CTX_free(ctx)


def _key(state_path: Path, create: bool) -> bytes:
    path = state_path.parent / ".endpoint-key"
    if create and not path.exists():
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as f:
                f.write(os.urandom(32)); f.flush(); os.fsync(f.fileno())
        except FileExistsError:
            pass
    key = path.read_bytes()
    if len(key) != 32:
        raise ValueError("Invalid endpoint encryption key")
    return key


def transform_state(data: dict, path: Path, *, encrypt: bool) -> dict:
    result = copy.deepcopy(data)
    key = None
    for row in result.get("sessions", []):
        for field in ("provider_config", "codex_config"):
            endpoint = (row.get(field) or {}).get("customEndpoint")
            if not isinstance(endpoint, dict):
                continue
            if encrypt:
                token = endpoint.pop("token", "")
                if token:
                    key = key or _key(path, True)
                    iv = os.urandom(12)
                    ct, tag = _crypt(token.encode(), key, iv)
                    endpoint["tokenCipher"] = base64.b64encode(iv + tag + ct).decode()
            elif endpoint.get("tokenCipher"):
                try:
                    key = key or _key(path, False)
                    blob = base64.b64decode(endpoint["tokenCipher"], validate=True)
                    if len(blob) < 28:
                        raise ValueError("Invalid encrypted endpoint credential")
                    endpoint["token"] = _crypt(blob[28:], key, blob[:12], blob[12:28])[0].decode()
                    endpoint.pop("tokenCipher", None)
                except (OSError, ValueError, UnicodeError):
                    # One lost credential must not discard unrelated sessions.
                    # Preserve ciphertext for recovery; never use native auth.
                    endpoint["credentialError"] = "Re-enter this endpoint credential in Charon."
                    row["status"] = "error"
    return result


def public_config(config: dict) -> dict:
    result = dict(config)
    if isinstance(result.get("customEndpoint"), dict):
        result["customEndpoint"] = {k: v for k, v in result["customEndpoint"].items()
                                    if k not in ("token", "tokenCipher", "secret")}
    return result
