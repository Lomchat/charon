"""Tests for the read-only file tree RPCs (fsnav.fs_list / fs_read, agent >= 0.25.0).

What's worth pinning here is containment and honesty:

  * `_contained` compares REALPATHS, so a symlink pointing out of the tree is
    caught — checking the spelling of the path would not catch it, and this
    guards a read of arbitrary files;
  * text vs binary is decided by git's own heuristic (a NUL in the first
    block), because that is what decides whether the viewer renders characters
    or hands the bytes to the browser;
  * a file too big to ship says so instead of returning a silent prefix.

stdlib unittest only. Run with:
    python3 agent/tests/test_fsnav_tree.py
"""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from charon_agent import fsnav as F  # noqa: E402

HAS_GIT = shutil.which("git") is not None


class TreeTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="charon-tree-")
        os.makedirs(os.path.join(self.root, "src"))
        os.makedirs(os.path.join(self.root, ".hidden"))
        for rel, body in [
            ("README.md", "# hi\n"),
            ("src/app.ts", "export const x = 1\n"),
            (".env", "SECRET=1\n"),
        ]:
            with open(os.path.join(self.root, rel), "w") as f:
                f.write(body)
        with open(os.path.join(self.root, "logo.png"), "wb") as f:
            f.write(b"\x89PNG\r\n\x1a\n" + b"\x00\x01\x02" * 50)

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    # ── fs_list ────────────────────────────────────────────────────────────
    def test_lists_the_root(self):
        r = F.fs_list(self.root)
        self.assertTrue(r["ok"])
        names = [e["name"] for e in r["entries"]]
        self.assertEqual(set(names), {".hidden", "src", ".env", "README.md", "logo.png"})

    def test_ordering_dirs_first_then_dotfiles_last(self):
        # Mirrors the VS Code explorer so the tree reads without a sort control.
        names = [e["name"] for e in F.fs_list(self.root)["entries"]]
        self.assertEqual(names, ["src", ".hidden", "logo.png", "README.md", ".env"])

    def test_sizes_and_kinds(self):
        by = {e["name"]: e for e in F.fs_list(self.root)["entries"]}
        self.assertTrue(by["src"]["dir"])
        self.assertEqual(by["src"]["size"], 0)
        self.assertFalse(by["README.md"]["dir"])
        self.assertEqual(by["README.md"]["size"], 5)

    def test_lists_a_subdirectory(self):
        r = F.fs_list(self.root, "src")
        self.assertEqual([e["name"] for e in r["entries"]], ["app.ts"])
        self.assertEqual(r["path"], "src")

    def test_escape_is_refused(self):
        for bad in ["..", "../..", "/etc", "src/../../..", "/etc/passwd"]:
            r = F.fs_list(self.root, bad)
            self.assertFalse(r["ok"], bad)
            self.assertEqual(r["entries"], [])

    def test_symlink_out_of_the_tree_is_refused(self):
        # The spelling of this path is innocent; only the realpath reveals it.
        outside = tempfile.mkdtemp(prefix="charon-outside-")
        try:
            os.symlink(outside, os.path.join(self.root, "escape"))
            r = F.fs_list(self.root, "escape")
            self.assertFalse(r["ok"])
        finally:
            shutil.rmtree(outside, ignore_errors=True)

    def test_missing_dir_is_a_clean_failure(self):
        r = F.fs_list(self.root, "nope")
        self.assertFalse(r["ok"])
        self.assertIn("not a directory", r["error"])

    def test_a_file_is_not_a_directory(self):
        r = F.fs_list(self.root, "README.md")
        self.assertFalse(r["ok"])

    @unittest.skipUnless(HAS_GIT, "git binary not available")
    def test_gitignored_flag_is_opt_in(self):
        subprocess.run(["git", "init", "-q", self.root], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        with open(os.path.join(self.root, ".gitignore"), "w") as f:
            f.write(".env\n")
        plain = {e["name"]: e for e in F.fs_list(self.root)["entries"]}
        self.assertNotIn("ignored", plain[".env"])          # not paid for by default
        marked = {e["name"]: e for e in F.fs_list(self.root, "", with_git=True)["entries"]}
        self.assertTrue(marked[".env"]["ignored"])
        self.assertFalse(marked["README.md"]["ignored"])

    def test_with_git_on_a_non_repo_does_not_blow_up(self):
        r = F.fs_list(self.root, "", with_git=True)
        self.assertTrue(r["ok"])
        self.assertFalse(any(e.get("ignored") for e in r["entries"]))

    # ── fs_read ────────────────────────────────────────────────────────────
    def test_read_text(self):
        r = F.fs_read(self.root, "README.md")
        self.assertTrue(r["ok"])
        self.assertFalse(r["binary"])
        self.assertEqual(r["encoding"], "utf8")
        self.assertEqual(r["content"], "# hi\n")

    def test_read_binary_is_base64(self):
        import base64
        r = F.fs_read(self.root, "logo.png")
        self.assertTrue(r["ok"])
        self.assertTrue(r["binary"])
        self.assertEqual(r["encoding"], "base64")
        self.assertTrue(base64.b64decode(r["content"]).startswith(b"\x89PNG"))

    def test_read_escape_is_refused(self):
        r = F.fs_read(self.root, "../../etc/passwd")
        self.assertFalse(r["ok"])
        self.assertIn("outside", r["error"])

    def test_read_a_directory_is_refused(self):
        r = F.fs_read(self.root, "src")
        self.assertFalse(r["ok"])

    def test_read_missing_file(self):
        r = F.fs_read(self.root, "nope.txt")
        self.assertFalse(r["ok"])
        self.assertIn("not found", r["error"])

    def test_too_large_says_so_instead_of_returning_a_prefix(self):
        big = os.path.join(self.root, "big.log")
        with open(big, "w") as f:
            f.write("x" * (F.MAX_TEXT_BYTES + 10))
        r = F.fs_read(self.root, "big.log")
        self.assertTrue(r["ok"])
        self.assertTrue(r["too_large"])
        self.assertIsNone(r["content"])
        self.assertGreater(r["size"], F.MAX_TEXT_BYTES)

    def test_invalid_utf8_is_replaced_not_fatal(self):
        # A latin-1 log must render as text with replacement chars rather than
        # taking the RPC down on a decode error.
        p = os.path.join(self.root, "latin.txt")
        with open(p, "wb") as f:
            f.write(b"caf\xe9\n")
        r = F.fs_read(self.root, "latin.txt")
        self.assertTrue(r["ok"])
        self.assertFalse(r["binary"])
        self.assertIn("caf", r["content"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
