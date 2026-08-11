"""Language-server host (agent >= 0.33.0, lsp.py). CLAUDE.md §14.89

Driven against a FAKE language server — a tiny python script that speaks the
same `Content-Length` framing — so the suite needs no pyright, no node, and no
network. What is worth pinning here is the plumbing, which is where the bugs
live: frames (not lines), request/response correlation, pushed diagnostics,
the allow-list, and the bounds.
"""
import os
import shutil
import sys
import tempfile
import textwrap
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from charon_agent import lsp as L  # noqa: E402


# A language server in thirty lines: answers `initialize`, echoes hover, pushes
# a diagnostic on didOpen, and replies to server->client requests it receives.
FAKE = textwrap.dedent('''
    import json, sys, threading, time

    def send(msg):
        b = json.dumps(msg).encode()
        sys.stdout.buffer.write(b"Content-Length: %d\\r\\n\\r\\n" % len(b) + b)
        sys.stdout.buffer.flush()

    def read():
        n = 0
        while True:
            line = sys.stdin.buffer.readline()
            if not line:
                return None
            if line in (b"\\r\\n", b"\\n"):
                break
            if line.lower().startswith(b"content-length:"):
                n = int(line.split(b":")[1])
        return json.loads(sys.stdin.buffer.read(n))

    while True:
        m = read()
        if m is None:
            break
        method, mid = m.get("method"), m.get("id")
        if method == "initialize":
            send({"jsonrpc": "2.0", "id": mid, "result": {"capabilities": {"hoverProvider": True}}})
        elif method == "textDocument/didOpen":
            uri = m["params"]["textDocument"]["uri"]
            send({"jsonrpc": "2.0", "method": "textDocument/publishDiagnostics",
                  "params": {"uri": uri, "diagnostics": [
                      {"range": {"start": {"line": 1, "character": 0}, "end": {"line": 1, "character": 4}},
                       "severity": 1, "message": "fake problem"}]}})
        elif method == "textDocument/didChange":
            uri = m["params"]["textDocument"]["uri"]
            send({"jsonrpc": "2.0", "method": "textDocument/publishDiagnostics",
                  "params": {"uri": uri, "diagnostics": []}})
        elif method == "textDocument/hover":
            # A newline in the payload: a reader that splits on lines dies here.
            send({"jsonrpc": "2.0", "id": mid,
                  "result": {"contents": "line one\\nline two"}})
        elif method == "textDocument/definition":
            send({"jsonrpc": "2.0", "id": mid, "result": None})
        elif method == "slow":
            time.sleep(30)
        elif mid is not None:
            send({"jsonrpc": "2.0", "id": mid, "result": None})
''')


class LspTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="charon-lsp-test-")
        self.fake = os.path.join(self.dir, "fake-server.py")
        with open(self.fake, "w") as f:
            f.write(FAKE)
        self.file = os.path.join(self.dir, "a.py")
        with open(self.file, "w") as f:
            f.write("x = 1\ny = 2\n")
        # Point the python family at the fake, and remember what was there.
        self._saved = L.SERVERS["python"]
        L.SERVERS["python"] = [{"bin": sys.executable, "args": [self.fake], "install": "n/a"}]
        L.shutdown_all()

    def tearDown(self):
        L.shutdown_all()
        L.SERVERS["python"] = self._saved
        shutil.rmtree(self.dir, ignore_errors=True)

    # ── mapping ─────────────────────────────────────────────────────────────
    def test_language_is_taken_from_the_extension(self):
        self.assertEqual(L.language_for("/x/a.ts"), "typescript")
        # A .tsx is `typescriptreact`, NOT `typescript`: servers key their
        # behaviour on the id.
        self.assertEqual(L.language_for("/x/a.tsx"), "typescriptreact")
        self.assertEqual(L.language_for("/x/a.py"), "python")
        self.assertIsNone(L.language_for("/x/a.bin"))
        self.assertIsNone(L.language_for("/x/Makefile"))

    def test_uri_round_trip_survives_spaces(self):
        p = "/srv/my project/a b.py"
        self.assertEqual(L.uri_to_path(L.path_to_uri(p)), p)

    # ── status ──────────────────────────────────────────────────────────────
    def test_status_never_spawns_anything(self):
        # The editor asks on every file it opens; starting a server because
        # somebody glanced at a file is how you eat a small VPS.
        r = L.lsp_status({"root": self.dir, "path": self.file})
        self.assertTrue(r["ok"])
        self.assertTrue(r["available"])
        self.assertFalse(r["running"])
        self.assertEqual(r["servers"], [])

    def test_status_says_how_to_install_a_missing_server(self):
        L.SERVERS["python"] = [{"bin": "definitely-not-installed-xyz", "args": [], "install": "pip install x"}]
        r = L.lsp_status({"root": self.dir, "path": self.file})
        self.assertFalse(r["available"])
        self.assertEqual(r["install"], "pip install x")

    def test_status_on_a_file_no_server_covers(self):
        r = L.lsp_status({"root": self.dir, "path": "/x/a.bin"})
        self.assertTrue(r["ok"])
        self.assertIsNone(r["language"])
        self.assertFalse(r["available"])

    # ── the flow ────────────────────────────────────────────────────────────
    def test_open_starts_a_server_and_diagnostics_arrive(self):
        r = L.lsp_open({"root": self.dir, "path": self.file, "text": "x = 1\ny = 2\n"})
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["version"], 1)
        d = L.lsp_diagnostics({"root": self.dir, "path": self.file, "since": 0, "wait": 5})
        self.assertTrue(d["changed"])
        self.assertEqual(len(d["diagnostics"]), 1)
        self.assertEqual(d["diagnostics"][0]["message"], "fake problem")

    def test_a_second_open_is_a_change_and_bumps_the_version(self):
        L.lsp_open({"root": self.dir, "path": self.file, "text": "a"})
        r = L.lsp_open({"root": self.dir, "path": self.file, "text": "b"})
        self.assertEqual(r["version"], 2)
        d = L.lsp_diagnostics({"root": self.dir, "path": self.file, "since": 0, "wait": 5})
        self.assertEqual(d["diagnostics"], [])       # the fake clears on change

    def test_a_response_containing_newlines_survives_the_framing(self):
        # The whole reason frames exist: an LSP payload is full of newlines.
        L.lsp_open({"root": self.dir, "path": self.file, "text": "x"})
        r = L.lsp_request({
            "root": self.dir, "path": self.file, "method": "textDocument/hover",
            "position": {"line": 0, "character": 0},
        })
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["result"]["contents"], "line one\nline two")

    def test_long_poll_returns_as_soon_as_something_changes(self):
        L.lsp_open({"root": self.dir, "path": self.file, "text": "x"})
        first = L.lsp_diagnostics({"root": self.dir, "path": self.file, "since": 0, "wait": 5})
        # Nothing new: it waits, then answers changed=False rather than erroring.
        t0 = time.monotonic()
        again = L.lsp_diagnostics({
            "root": self.dir, "path": self.file, "since": first["diag_version"], "wait": 1,
        })
        self.assertFalse(again["changed"])
        self.assertGreaterEqual(time.monotonic() - t0, 0.9)
        self.assertTrue(again["ok"])

    def test_close_forgets_the_document(self):
        L.lsp_open({"root": self.dir, "path": self.file, "text": "x"})
        L.lsp_diagnostics({"root": self.dir, "path": self.file, "since": 0, "wait": 5})
        self.assertTrue(L.lsp_close({"root": self.dir, "path": self.file})["ok"])
        d = L.lsp_diagnostics({"root": self.dir, "path": self.file, "since": 0, "wait": 0})
        self.assertEqual(d["diagnostics"], [])

    def test_diagnostics_for_a_server_that_never_started_is_not_an_error(self):
        d = L.lsp_diagnostics({"root": self.dir, "path": self.file, "since": 0, "wait": 0})
        self.assertTrue(d["ok"])
        self.assertFalse(d["running"])
        self.assertEqual(d["diagnostics"], [])

    # ── refusals and bounds ─────────────────────────────────────────────────
    def test_the_request_surface_is_an_allow_list(self):
        # Not a VPN into someone's language server: executeCommand runs
        # arbitrary code in several of them.
        L.lsp_open({"root": self.dir, "path": self.file, "text": "x"})
        for bad in ("workspace/executeCommand", "shutdown", "exit", "$/cancelRequest"):
            r = L.lsp_request({"root": self.dir, "path": self.file, "method": bad})
            self.assertFalse(r["ok"], bad)
            self.assertEqual(r["reason"], "bad_params")

    def test_a_missing_binary_says_what_to_install(self):
        L.SERVERS["python"] = [{"bin": "definitely-not-installed-xyz", "args": [], "install": "pip install x"}]
        r = L.lsp_open({"root": self.dir, "path": self.file, "text": "x"})
        self.assertFalse(r["ok"])
        self.assertEqual(r["reason"], "missing")
        self.assertEqual(r["install"], "pip install x")

    def test_an_unsupported_extension_is_refused_before_anything_spawns(self):
        r = L.lsp_open({"root": self.dir, "path": os.path.join(self.dir, "a.bin"), "text": "x"})
        self.assertFalse(r["ok"])
        self.assertEqual(r["reason"], "unsupported")

    def test_open_without_text_is_rejected(self):
        r = L.lsp_open({"root": self.dir, "path": self.file})
        self.assertFalse(r["ok"])
        self.assertEqual(r["reason"], "bad_params")

    def test_stop_kills_the_process(self):
        L.lsp_open({"root": self.dir, "path": self.file, "text": "x"})
        self.assertTrue(L.lsp_status({"root": self.dir, "path": self.file})["running"])
        L.lsp_stop({"root": self.dir})
        self.assertFalse(L.lsp_status({"root": self.dir, "path": self.file})["running"])

    def test_the_server_count_is_capped(self):
        # A fleet VPS is not a workstation: the oldest idle server is stopped
        # rather than letting them accumulate.
        roots = []
        for i in range(L.MAX_SERVERS + 2):
            d = os.path.join(self.dir, f"r{i}")
            os.makedirs(d, exist_ok=True)
            f = os.path.join(d, "a.py")
            open(f, "w").write("x")
            roots.append((d, f))
            L.lsp_open({"root": d, "path": f, "text": "x"})
        self.assertLessEqual(len(L.lsp_status({"root": roots[-1][0], "path": roots[-1][1]})["servers"]),
                             L.MAX_SERVERS)


if __name__ == "__main__":
    unittest.main()


class ApplyEditTest(unittest.TestCase):
    """`lsp_apply_edit` — the write half of rename and format (§14.90).

    Same hazard as `fs_write` (§14.79): an agent may be writing these files
    right now, so nothing is clobbered blind and nothing is half-written.
    """

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="charon-edit-test-")
        self.a = os.path.join(self.dir, "a.py")
        self.b = os.path.join(self.dir, "b.py")
        with open(self.a, "w") as f:
            f.write("alpha = 1\nbeta = 2\ngamma = 3\n")
        with open(self.b, "w") as f:
            f.write("from a import alpha\n")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    @staticmethod
    def _edit(l1, c1, l2, c2, text):
        return {"range": {"start": {"line": l1, "character": c1},
                          "end": {"line": l2, "character": c2}}, "newText": text}

    def test_applies_edits_back_to_front_so_offsets_stay_valid(self):
        # Two edits on the same line: applied front-to-back the second one
        # lands in the wrong place. This is THE bug in a naive implementation.
        r = L.lsp_apply_edit({"root": self.dir, "changes": {
            L.path_to_uri(self.a): [
                self._edit(0, 0, 0, 5, "FIRST"),
                self._edit(2, 0, 2, 5, "THIRD"),
            ],
        }})
        self.assertTrue(r["ok"], r)
        with open(self.a) as f:
            self.assertEqual(f.read(), "FIRST = 1\nbeta = 2\nTHIRD = 3\n")

    def test_edits_several_files_in_one_call(self):
        r = L.lsp_apply_edit({"root": self.dir, "changes": {
            L.path_to_uri(self.a): [self._edit(0, 0, 0, 5, "renamed")],
            L.path_to_uri(self.b): [self._edit(0, 14, 0, 19, "renamed")],
        }})
        self.assertTrue(r["ok"], r)
        self.assertEqual(len(r["changed"]), 2)
        with open(self.b) as f:
            self.assertEqual(f.read(), "from a import renamed\n")

    def test_refuses_to_touch_anything_outside_the_root(self):
        outside = tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False)
        outside.write("secret = 1\n")
        outside.close()
        try:
            r = L.lsp_apply_edit({"root": self.dir, "changes": {
                L.path_to_uri(outside.name): [self._edit(0, 0, 0, 6, "hacked")],
            }})
            self.assertFalse(r["ok"])
            self.assertEqual(r["reason"], "outside_root")
            with open(outside.name) as f:
                self.assertEqual(f.read(), "secret = 1\n")     # untouched
        finally:
            os.unlink(outside.name)

    def test_validates_every_file_before_writing_any(self):
        # A rename that touches six files and dies on the fourth is the worst
        # possible outcome: the bad target is caught before anything lands.
        r = L.lsp_apply_edit({"root": self.dir, "changes": {
            L.path_to_uri(self.a): [self._edit(0, 0, 0, 5, "renamed")],
            L.path_to_uri(os.path.join(self.dir, "nope.py")): [self._edit(0, 0, 0, 1, "x")],
        }})
        self.assertFalse(r["ok"])
        self.assertEqual(r["reason"], "read")
        with open(self.a) as f:
            self.assertEqual(f.read(), "alpha = 1\nbeta = 2\ngamma = 3\n")

    def test_preserves_the_file_mode(self):
        os.chmod(self.a, 0o750)
        L.lsp_apply_edit({"root": self.dir, "changes": {
            L.path_to_uri(self.a): [self._edit(0, 0, 0, 5, "renamed")],
        }})
        self.assertEqual(os.stat(self.a).st_mode & 0o777, 0o750)

    def test_a_no_op_edit_changes_nothing(self):
        r = L.lsp_apply_edit({"root": self.dir, "changes": {
            L.path_to_uri(self.a): [self._edit(0, 0, 0, 5, "alpha")],
        }})
        self.assertTrue(r["ok"])
        self.assertEqual(r["changed"], [])

    def test_empty_input_is_refused_not_silently_successful(self):
        self.assertFalse(L.lsp_apply_edit({"root": self.dir, "changes": {}})["ok"])
        self.assertFalse(L.lsp_apply_edit({"root": "/does/not/exist", "changes": {"x": []}})["ok"])

    def test_no_temp_file_is_left_behind(self):
        L.lsp_apply_edit({"root": self.dir, "changes": {
            L.path_to_uri(self.a): [self._edit(0, 0, 0, 5, "renamed")],
        }})
        self.assertEqual([f for f in os.listdir(self.dir) if "tmp" in f], [])
