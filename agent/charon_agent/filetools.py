"""File viewers' agent half (agent >= 0.108.0, CLAUDE.md §14.112).

Everything the hub's rendered views need that a browser cannot do from the
file's bytes alone: read a byte RANGE (logs, files past fs_read's cap), look
inside a SQLite database or an archive, and convert what browsers cannot
decode (TIFF/HEIC → PNG through Pillow, Office documents → PDF through
LibreOffice). Stdlib only; Pillow and LibreOffice are used when the box has
them and reported as `reason: "unavailable"` when it does not.

Same containment as fsnav: every path is `root` + a relative path judged by
`contained_path`. Everything here is READ-ONLY on the inspected file, except
`archive_extract`, which only ever creates a NEW sibling folder.
"""
from __future__ import annotations

import base64
import gzip
import hashlib
import io
import os
import shutil
import stat as stat_mod
import subprocess
import tarfile
import tempfile
import time
import urllib.parse
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any

from .fsnav import _version_from_stat, contained_path

# server.py imports this module at boot: a Python built without `_sqlite3`
# (source builds under /usr/local) must still start the daemon. The SQLite
# view then answers `reason: "unavailable"` like a missing Pillow.
try:
    import sqlite3
except ImportError:
    sqlite3 = None  # type: ignore[assignment]

# ── Byte ranges ─────────────────────────────────────────────────────────────

MAX_RANGE_BYTES = 1024 * 1024


def fs_read_range(root: str, path: str, offset: int, length: int) -> dict[str, Any]:
    """`length` bytes from `offset`; a NEGATIVE offset counts from the end.

    The log view's whole protocol: the tail on open, earlier chunks on demand,
    new bytes while following. One RPC on the persistent channel instead of an
    SSH stream per poll.
    """
    target = contained_path(root, path)
    if target is None:
        return {"ok": False, "error": "path outside the root"}
    try:
        st = os.stat(target)
        if not stat_mod.S_ISREG(st.st_mode):
            return {"ok": False, "error": "not a file"}
        size = st.st_size
        start = int(offset)
        if start < 0:
            start = max(0, size + start)
        start = min(start, size)
        want = max(0, min(int(length), MAX_RANGE_BYTES, size - start))
        with open(target, "rb") as f:
            f.seek(start)
            data = f.read(want)
        return {"ok": True, "size": size, "offset": start, "length": len(data),
                "data": base64.b64encode(data).decode(), "version": _version_from_stat(st)}
    except FileNotFoundError:
        return {"ok": False, "error": "not found", "reason": "missing"}
    except PermissionError:
        return {"ok": False, "error": "permission denied"}
    except (OSError, ValueError) as e:
        return {"ok": False, "error": str(e)}


# ── SQLite, read-only ───────────────────────────────────────────────────────

SQLITE_MAX_ROWS = 1000
SQLITE_CELL_CHARS = 4000
SQLITE_TIMEOUT_S = 10.0
SQLITE_COUNT_BUDGET_S = 4.0
_SQLITE_MAGIC = b"SQLite format 3\x00"

# What a read-only browse may ask the engine for. `mode=ro` already refuses
# writes; the authorizer also refuses ATTACH (another file on the box),
# transactions, and every pragma that is not a pure read.
_READ_PRAGMAS = {
    "table_info", "table_xinfo", "index_list", "index_info", "index_xinfo",
    "foreign_key_list", "table_list", "collation_list", "function_list",
    "compile_options", "page_count", "page_size", "freelist_count", "encoding",
    "user_version", "application_id", "journal_mode", "schema_version",
}


def _sqlite_authorizer(action: int, arg1: Any, arg2: Any, _db: Any, _trigger: Any) -> int:
    ok = sqlite3.SQLITE_OK
    if action in (sqlite3.SQLITE_SELECT, sqlite3.SQLITE_READ, sqlite3.SQLITE_FUNCTION,
                  getattr(sqlite3, "SQLITE_RECURSIVE", 33)):
        return ok
    if action == sqlite3.SQLITE_PRAGMA:
        name = (arg1 or "").lower()
        # `PRAGMA x = y` is a write; `PRAGMA table_info(t)` passes `t` as arg2.
        return ok if name in _READ_PRAGMAS else sqlite3.SQLITE_DENY
    return sqlite3.SQLITE_DENY


def _sqlite_open(root: str, path: str) -> tuple[sqlite3.Connection | None, dict[str, Any] | None]:
    target = contained_path(root, path)
    if target is None:
        return None, {"ok": False, "error": "path outside the root"}
    if sqlite3 is None:
        return None, {"ok": False, "reason": "unavailable",
                      "error": "this VPS's Python was built without sqlite3"}
    try:
        with open(target, "rb") as f:
            if f.read(16) != _SQLITE_MAGIC:
                return None, {"ok": False, "error": "not a SQLite database", "reason": "format"}
        uri = "file:" + urllib.parse.quote(target) + "?mode=ro"
        conn = sqlite3.connect(uri, uri=True, timeout=2.0, check_same_thread=False)
    except FileNotFoundError:
        return None, {"ok": False, "error": "not found", "reason": "missing"}
    except PermissionError:
        return None, {"ok": False, "error": "permission denied"}
    except (OSError, sqlite3.Error) as e:
        return None, {"ok": False, "error": str(e)}
    conn.set_authorizer(_sqlite_authorizer)
    return conn, None


def _with_deadline(conn: sqlite3.Connection, seconds: float) -> None:
    deadline = time.monotonic() + seconds
    # A non-zero return interrupts the statement ("interrupted").
    conn.set_progress_handler(lambda: 1 if time.monotonic() > deadline else 0, 20_000)


def _cell(v: Any) -> Any:
    if v is None or isinstance(v, (bool, int)):
        return v
    if isinstance(v, float):
        return v if v == v and v not in (float("inf"), float("-inf")) else str(v)
    if isinstance(v, (bytes, bytearray, memoryview)):
        b = bytes(v)
        return {"$blob": len(b), "hex": b[:32].hex()}
    s = str(v)
    return s if len(s) <= SQLITE_CELL_CHARS else {"$text": s[:SQLITE_CELL_CHARS], "length": len(s)}


def sqlite_schema(root: str, path: str) -> dict[str, Any]:
    """Tables, views, indexes and triggers, with row counts where cheap."""
    conn, err = _sqlite_open(root, path)
    if err:
        return err
    assert conn is not None
    try:
        _with_deadline(conn, SQLITE_TIMEOUT_S)
        rows = conn.execute(
            "SELECT type, name, tbl_name, sql FROM sqlite_master "
            "WHERE name NOT LIKE 'sqlite_%' ORDER BY type = 'table' DESC, type, name"
        ).fetchall()
        objects = [{"type": t, "name": n, "table": tb, "sql": s} for t, n, tb, s in rows]
        # Counts can be slow on huge tables: one shared budget, then `null`.
        budget = time.monotonic() + SQLITE_COUNT_BUDGET_S
        for o in objects:
            if o["type"] not in ("table", "view"):
                continue
            o["columns"] = [
                {"name": c[1], "type": c[2], "pk": bool(c[5])}
                for c in conn.execute(f'PRAGMA table_info("{_q(o["name"])}")').fetchall()
            ]
            if o["type"] != "table" or time.monotonic() > budget:
                o["rows"] = None
                continue
            try:
                _with_deadline(conn, max(0.1, budget - time.monotonic()))
                o["rows"] = conn.execute(f'SELECT count(*) FROM "{_q(o["name"])}"').fetchone()[0]
            except sqlite3.Error:
                o["rows"] = None
        return {"ok": True, "objects": objects, "size": os.path.getsize(contained_path(root, path) or "")}
    except sqlite3.Error as e:
        return {"ok": False, "error": str(e)}
    finally:
        conn.close()


def _q(name: str) -> str:
    return str(name).replace('"', '""')


def sqlite_query(root: str, path: str, sql: str, params: list[Any] | None = None,
                 limit: int = 200) -> dict[str, Any]:
    """ONE read-only statement; at most `limit` (≤1000) rows come back."""
    if not (sql or "").strip():
        return {"ok": False, "error": "empty query"}
    conn, err = _sqlite_open(root, path)
    if err:
        return err
    assert conn is not None
    cap = max(1, min(int(limit or 200), SQLITE_MAX_ROWS))
    t0 = time.monotonic()
    try:
        _with_deadline(conn, SQLITE_TIMEOUT_S)
        cur = conn.execute(sql, list(params or []))
        columns = [d[0] for d in (cur.description or [])]
        rows = cur.fetchmany(cap + 1)
        truncated = len(rows) > cap
        return {
            "ok": True, "columns": columns,
            "rows": [[_cell(v) for v in r] for r in rows[:cap]],
            "truncated": truncated, "elapsed_ms": int((time.monotonic() - t0) * 1000),
        }
    except sqlite3.DatabaseError as e:
        msg = str(e)
        if "not authorized" in msg:
            msg = "read-only: only SELECT statements (and read pragmas) are allowed"
        elif "interrupted" in msg:
            msg = f"stopped after {int(SQLITE_TIMEOUT_S)} s"
        return {"ok": False, "error": msg}
    # Python 3.10 refuses a multi-statement string with sqlite3.Warning, which
    # is not an sqlite3.Error: it must stay a refusal, never escape.
    except (sqlite3.Error, sqlite3.Warning, ValueError) as e:
        return {"ok": False, "error": str(e)}
    finally:
        conn.close()


# ── Archives ────────────────────────────────────────────────────────────────

ARCHIVE_MAX_ENTRIES = 10_000
ARCHIVE_READ_MAX = 8 * 1024 * 1024
EXTRACT_MAX_BYTES = 2 * 1024 * 1024 * 1024
EXTRACT_MAX_FILES = 100_000
_TAR_SUFFIXES = (".tar.gz", ".tar.bz2", ".tar.xz", ".tgz", ".tbz2", ".txz", ".tar")
_ZIP_SUFFIXES = (".zip", ".jar", ".whl", ".apk", ".epub", ".xpi", ".nupkg")


def _archive_kind(target: str) -> str | None:
    if zipfile.is_zipfile(target):
        return "zip"
    try:
        if tarfile.is_tarfile(target):
            return "tar"
    except OSError:
        pass
    if target.lower().endswith(".gz"):
        return "gzip"
    return None


def archive_list(root: str, path: str) -> dict[str, Any]:
    target = contained_path(root, path)
    if target is None:
        return {"ok": False, "error": "path outside the root"}
    try:
        kind = _archive_kind(target)
        entries: list[dict[str, Any]] = []
        total = 0
        if kind == "zip":
            with zipfile.ZipFile(target) as zf:
                infos = zf.infolist()
                total = len(infos)
                for i in infos[:ARCHIVE_MAX_ENTRIES]:
                    entries.append({
                        "name": i.filename, "size": i.file_size, "packed": i.compress_size,
                        "dir": i.is_dir(), "mtime": _zip_mtime(i),
                        "encrypted": bool(i.flag_bits & 0x1),
                    })
        elif kind == "tar":
            with tarfile.open(target) as tf:
                for n, m in enumerate(tf):
                    total += 1
                    if n >= ARCHIVE_MAX_ENTRIES:
                        continue
                    entries.append({
                        "name": m.name + ("/" if m.isdir() and not m.name.endswith("/") else ""),
                        "size": m.size, "dir": m.isdir(), "mtime": int(m.mtime),
                        "link": m.linkname if (m.issym() or m.islnk()) else None,
                    })
        elif kind == "gzip":
            inner = os.path.basename(target)[:-3] or "data"
            # The trailer's ISIZE (size mod 2³²): no need to inflate it all.
            with open(target, "rb") as f:
                f.seek(-4, os.SEEK_END)
                size = int.from_bytes(f.read(4), "little")
            total = 1
            entries.append({"name": inner, "size": size, "dir": False, "mtime": None})
        else:
            return {"ok": False, "error": "not a zip, tar or gzip archive", "reason": "format"}
        return {"ok": True, "kind": kind, "entries": entries, "total": total,
                "truncated": total > len(entries)}
    except FileNotFoundError:
        return {"ok": False, "error": "not found", "reason": "missing"}
    except PermissionError:
        return {"ok": False, "error": "permission denied"}
    except (OSError, zipfile.BadZipFile, tarfile.TarError, EOFError) as e:
        return {"ok": False, "error": f"unreadable archive: {e}"}


def _zip_mtime(i: zipfile.ZipInfo) -> int | None:
    try:
        return int(time.mktime(i.date_time + (0, 0, -1)))
    except (OverflowError, ValueError):
        return None


def archive_read(root: str, path: str, member: str, max_bytes: int = ARCHIVE_READ_MAX) -> dict[str, Any]:
    """One member's bytes (capped), for the preview pane."""
    target = contained_path(root, path)
    if target is None:
        return {"ok": False, "error": "path outside the root"}
    cap = max(1, min(int(max_bytes or ARCHIVE_READ_MAX), ARCHIVE_READ_MAX))
    try:
        kind = _archive_kind(target)
        if kind == "zip":
            with zipfile.ZipFile(target) as zf:
                info = zf.getinfo(member)
                if info.is_dir():
                    return {"ok": False, "error": "that is a folder"}
                with zf.open(info) as f:
                    data = f.read(cap + 1)
                size = info.file_size
        elif kind == "tar":
            with tarfile.open(target) as tf:
                m = tf.getmember(member)
                if not m.isfile():
                    return {"ok": False, "error": "not a regular file"}
                f = tf.extractfile(m)
                data = f.read(cap + 1) if f else b""
                size = m.size
        elif kind == "gzip":
            with gzip.open(target, "rb") as g:
                data = g.read(cap + 1)
            size = None
        else:
            return {"ok": False, "error": "not a zip, tar or gzip archive", "reason": "format"}
        return {"ok": True, "size": size, "truncated": len(data) > cap,
                "data": base64.b64encode(data[:cap]).decode()}
    except KeyError:
        return {"ok": False, "error": "no such entry in the archive"}
    except RuntimeError as e:
        # zipfile: "File … is encrypted, password required for extraction".
        return {"ok": False, "error": str(e)}
    except (OSError, zipfile.BadZipFile, tarfile.TarError, EOFError) as e:
        return {"ok": False, "error": f"unreadable archive: {e}"}


def safe_member_path(name: str) -> str | None:
    """A member name as a relative path INSIDE the destination, or None.

    Absolute names, `..` anywhere, drive letters and empty names are refused:
    the zip-slip / tar-slip class, judged on the spelling before anything is
    written.
    """
    n = (name or "").replace("\\", "/")
    if not n or n.startswith("/") or "\0" in n or (len(n) > 1 and n[1] == ":"):
        return None
    parts = [p for p in PurePosixPath(n).parts if p not in ("", ".")]
    if not parts or any(p == ".." for p in parts):
        return None
    return "/".join(parts)


def _extract_dest_name(archive_name: str) -> str:
    low = archive_name.lower()
    for suf in _TAR_SUFFIXES + _ZIP_SUFFIXES + (".gz",):
        if low.endswith(suf) and len(archive_name) > len(suf):
            return archive_name[: -len(suf)]
    return archive_name + ".d"


def archive_extract(root: str, path: str) -> dict[str, Any]:
    """Extract next to the archive into a NEW folder named after it.

    Never overwrites: an existing destination is refused. Written into a
    temporary sibling first and renamed at the end, so a failure (bomb limits,
    a bad member) leaves nothing half-extracted behind. Links, devices and
    FIFOs are skipped — regular files and folders only.
    """
    target = contained_path(root, path)
    if target is None:
        return {"ok": False, "error": "path outside the root"}
    parent = os.path.dirname(target)
    dest_name = _extract_dest_name(os.path.basename(target))
    dest = os.path.join(parent, dest_name)
    if os.path.lexists(dest):
        return {"ok": False, "error": f"{dest_name}/ already exists", "reason": "exists"}
    kind = _archive_kind(target) if os.path.isfile(target) else None
    if kind is None:
        return {"ok": False, "error": "not a zip, tar or gzip archive", "reason": "format"}
    tmp = tempfile.mkdtemp(prefix=f".{dest_name}.extracting-", dir=parent)
    files = 0
    written = 0
    skipped = 0

    def budget(n: int) -> None:
        nonlocal written
        written += n
        if written > EXTRACT_MAX_BYTES:
            raise ValueError(f"more than {EXTRACT_MAX_BYTES >> 30} GiB uncompressed — refused")

    def write_stream(rel: str, src: Any, mode: int | None) -> None:
        nonlocal files
        files += 1
        if files > EXTRACT_MAX_FILES:
            raise ValueError(f"more than {EXTRACT_MAX_FILES} files — refused")
        out = os.path.join(tmp, rel)
        os.makedirs(os.path.dirname(out), exist_ok=True)
        with open(out, "wb") as dst:
            while chunk := src.read(1 << 20):
                budget(len(chunk))
                dst.write(chunk)
        if mode is not None:
            os.chmod(out, (mode & 0o777) & ~0o022 | 0o600)

    try:
        if kind == "zip":
            with zipfile.ZipFile(target) as zf:
                for info in zf.infolist():
                    rel = safe_member_path(info.filename)
                    if rel is None:
                        skipped += 1
                        continue
                    if info.is_dir():
                        os.makedirs(os.path.join(tmp, rel), exist_ok=True)
                        continue
                    mode = (info.external_attr >> 16) & 0o777 or None
                    if mode is not None and stat_mod.S_ISLNK(info.external_attr >> 16):
                        skipped += 1
                        continue
                    with zf.open(info) as src:
                        write_stream(rel, src, mode)
        elif kind == "tar":
            with tarfile.open(target) as tf:
                for m in tf:
                    rel = safe_member_path(m.name)
                    if rel is None or not (m.isfile() or m.isdir()):
                        skipped += 1
                        continue
                    if m.isdir():
                        os.makedirs(os.path.join(tmp, rel), exist_ok=True)
                        continue
                    src = tf.extractfile(m)
                    if src is None:
                        skipped += 1
                        continue
                    write_stream(rel, src, m.mode)
        else:
            inner = os.path.basename(target)[:-3] or "data"
            with gzip.open(target, "rb") as src:
                write_stream(inner, src, None)
        os.rename(tmp, dest)
    except (ValueError, OSError, zipfile.BadZipFile, tarfile.TarError, EOFError, RuntimeError) as e:
        shutil.rmtree(tmp, ignore_errors=True)
        return {"ok": False, "error": str(e)}
    rel_dest = os.path.relpath(dest, os.path.realpath(os.path.expanduser(root)))
    return {"ok": True, "dest": rel_dest, "files": files, "bytes": written, "skipped": skipped}


# ── Conversions ─────────────────────────────────────────────────────────────

IMAGE_MAX_PX = 4096
IMAGE_MAX_PNG = 24 * 1024 * 1024
CONVERT_TIMEOUT_S = 120
CONVERT_CACHE_KEEP = 30


def _agent_home() -> Path:
    return Path(os.environ.get("CHARON_AGENT_HOME") or Path.home() / ".charon")


def convert_image(root: str, path: str) -> dict[str, Any]:
    """An image browsers cannot decode (TIFF, HEIC…) → PNG, via Pillow."""
    target = contained_path(root, path)
    if target is None:
        return {"ok": False, "error": "path outside the root"}
    try:
        from PIL import Image, ImageOps  # noqa: PLC0415 — optional, lazy
    except ImportError:
        return {"ok": False, "reason": "unavailable",
                "error": "Pillow is not installed in this VPS's agent venv"}
    heif = target.lower().endswith((".heic", ".heif"))
    if heif:
        try:
            import pillow_heif  # type: ignore  # noqa: PLC0415
            pillow_heif.register_heif_opener()
        except ImportError:
            return {"ok": False, "reason": "unavailable",
                    "error": "HEIC needs pillow-heif in this VPS's agent venv (pip install pillow-heif)"}
    try:
        with Image.open(target) as im:
            frames = getattr(im, "n_frames", 1)
            im.seek(0)
            img = ImageOps.exif_transpose(im) or im
            ow, oh = img.size
            for px in (IMAGE_MAX_PX, 2048, 1024):
                pic = img.copy()
                pic.thumbnail((px, px))
                if pic.mode not in ("RGB", "RGBA", "L", "LA"):
                    pic = pic.convert("RGBA" if "A" in pic.getbands() else "RGB")
                buf = io.BytesIO()
                pic.save(buf, format="PNG")
                if buf.tell() <= IMAGE_MAX_PNG:
                    break
            data = buf.getvalue()
        return {"ok": True, "data": base64.b64encode(data).decode(), "width": pic.size[0],
                "height": pic.size[1], "orig_width": ow, "orig_height": oh, "frames": frames}
    except FileNotFoundError:
        return {"ok": False, "error": "not found", "reason": "missing"}
    except Exception as e:  # noqa: BLE001 — Pillow raises a zoo of types
        return {"ok": False, "error": f"cannot decode this image: {e}"}


def _office_binary() -> str | None:
    return shutil.which("soffice") or shutil.which("libreoffice")


def convert_pdf(root: str, path: str) -> dict[str, Any]:
    """An Office document → PDF through LibreOffice, cached per file version.

    Answers a (root, path) the hub can stream like any file: the cache folder
    under the agent home, so a reopened deck costs nothing.
    """
    target = contained_path(root, path)
    if target is None:
        return {"ok": False, "error": "path outside the root"}
    office = _office_binary()
    if not office:
        return {"ok": False, "reason": "unavailable",
                "error": "LibreOffice is not installed on this VPS (apt install libreoffice)"}
    try:
        st = os.stat(target)
    except FileNotFoundError:
        return {"ok": False, "error": "not found", "reason": "missing"}
    cache = _agent_home() / "cache" / "convert"
    cache.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha256(f"{target}\0{st.st_size}\0{st.st_mtime_ns}".encode()).hexdigest()[:32]
    out = cache / f"{key}.pdf"
    if not out.exists():
        with tempfile.TemporaryDirectory(dir=cache) as work:
            # A private profile: a desktop LibreOffice the user left open
            # holds the default one's lock and would make this hang.
            profile = Path(work) / "profile"
            cmd = [office, "--headless", "--norestore", "--nolockcheck",
                   f"-env:UserInstallation={profile.as_uri()}",
                   "--convert-to", "pdf", "--outdir", work, target]
            try:
                r = subprocess.run(cmd, capture_output=True, timeout=CONVERT_TIMEOUT_S, check=False)
            except subprocess.TimeoutExpired:
                return {"ok": False, "error": f"LibreOffice took more than {CONVERT_TIMEOUT_S} s"}
            produced = [p for p in Path(work).glob("*.pdf")]
            if r.returncode != 0 or not produced:
                detail = (r.stderr or r.stdout or b"").decode("utf-8", "replace").strip()[-300:]
                return {"ok": False, "error": f"LibreOffice could not convert this file{': ' + detail if detail else ''}"}
            os.replace(produced[0], out)
        _prune(cache, CONVERT_CACHE_KEEP)
    return {"ok": True, "root": str(cache), "path": out.name, "size": out.stat().st_size}


def _prune(folder: Path, keep: int) -> None:
    try:
        pdfs = sorted(folder.glob("*.pdf"), key=lambda p: p.stat().st_mtime, reverse=True)
        for old in pdfs[keep:]:
            old.unlink(missing_ok=True)
    except OSError:
        pass
