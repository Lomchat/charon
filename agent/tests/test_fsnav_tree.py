"""Tests for the read-only file tree RPCs (fsnav.fs_list / fs_read, agent >= 0.25.0).

What's worth pinning here is containment and honesty:

  * `contained_path` judges the SPELLING of a path, so `..` and an absolute
    path elsewhere are refused while a symlink inside the tree is followed
    wherever it points — a link is something the user put there on purpose;
  * a write goes THROUGH a symlink, never over it: the atomic rename would
    otherwise turn the link into a regular file behind the editor's back;
  * text vs binary is decided by git's own heuristic (a NUL in the first
    block), because that is what decides whether the viewer renders characters
    or hands the bytes to the browser;
  * a file too big to ship says so instead of returning a silent prefix.

stdlib unittest only. Run with:
    python3 agent/tests/test_fsnav_tree.py
"""
import io
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import unittest
import zipfile

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

    def test_symlink_out_of_the_tree_is_followed(self):
        # A link inside the tree is deliberate: the project that points at
        # /srv/shared is browsed from here or not at all.
        outside = tempfile.mkdtemp(prefix="charon-outside-")
        try:
            with open(os.path.join(outside, "shared.txt"), "w") as f:
                f.write("shared\n")
            os.symlink(outside, os.path.join(self.root, "linked"))
            r = F.fs_list(self.root, "linked")
            self.assertTrue(r["ok"], r)
            self.assertEqual([e["name"] for e in r["entries"]], ["shared.txt"])
            self.assertEqual(r["path"], "linked")
            self.assertEqual(F.fs_read(self.root, "linked/shared.txt")["content"], "shared\n")
        finally:
            shutil.rmtree(outside, ignore_errors=True)

    def test_a_link_says_where_it_points(self):
        # The tree's ↗ tooltip and the editor header both read this: a link
        # nobody can resolve without an ssh session is a link nobody reads.
        outside = tempfile.mkdtemp(prefix="charon-outside-")
        target = os.path.join(outside, "shared.md")
        with open(target, "w") as f:
            f.write("shared\n")
        os.symlink(target, os.path.join(self.root, "absolute.md"))
        os.symlink("README.md", os.path.join(self.root, "relative.md"))
        os.symlink("nowhere.md", os.path.join(self.root, "broken.md"))
        try:
            by = {e["name"]: e for e in F.fs_list(self.root)["entries"]}
            self.assertEqual(by["absolute.md"]["link_target"], target)
            self.assertEqual(by["relative.md"]["link_target"], "README.md")
            self.assertEqual(by["broken.md"]["link_target"], "nowhere.md")
            self.assertNotIn("link_target", by["README.md"])

            # The raw target is what `ls -l` shows; the resolved one rides
            # along only when it adds something.
            rel = F.fs_read(self.root, "relative.md")
            self.assertTrue(rel["symlink"])
            self.assertEqual(rel["link_target"], "README.md")
            self.assertEqual(rel["link_resolved"], os.path.join(self.root, "README.md"))
            self.assertFalse(F.fs_read(self.root, "README.md")["symlink"])
            self.assertNotIn("link_resolved", F.fs_read(self.root, "absolute.md"))

            # …including on the cheap probe, and on a link with nothing behind
            # it — that is exactly when the header has to explain itself.
            self.assertEqual(F.fs_stat(self.root, "relative.md")["link_target"], "README.md")
            dangling = F.fs_stat(self.root, "broken.md")
            self.assertFalse(dangling["exists"])
            self.assertEqual(dangling["link_target"], "nowhere.md")
        finally:
            shutil.rmtree(outside, ignore_errors=True)

    def test_dotdot_is_collapsed_before_a_link_is_ever_opened(self):
        # Containment is lexical, so `..` never walks out of a link's target:
        # `linked/..` is the root, and one more level is still an escape.
        outside = tempfile.mkdtemp(prefix="charon-outside-")
        try:
            os.symlink(outside, os.path.join(self.root, "linked"))
            back = F.fs_list(self.root, "linked/..")
            self.assertTrue(back["ok"], back)
            self.assertIn("README.md", [e["name"] for e in back["entries"]])
            self.assertFalse(F.fs_list(self.root, "linked/../..")["ok"])
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

    # ── fs_stat ────────────────────────────────────────────────────────────
    def test_stat_is_a_cheap_stable_version_token(self):
        first = F.fs_stat(self.root, "README.md")
        second = F.fs_stat(self.root, "README.md")
        self.assertTrue(first["ok"])
        self.assertTrue(first["exists"])
        self.assertEqual(first["version"], second["version"])
        self.assertEqual(first["version"], F.fs_read(self.root, "README.md")["version"])

    def test_stat_version_changes_after_an_atomic_replace(self):
        before = F.fs_stat(self.root, "README.md")["version"]
        tmp = os.path.join(self.root, "replacement")
        with open(tmp, "w") as f:
            f.write("# changed, same-ish size\n")
        os.replace(tmp, os.path.join(self.root, "README.md"))
        after = F.fs_stat(self.root, "README.md")["version"]
        self.assertNotEqual(before, after)

    def test_stat_missing_and_escape_are_explicit(self):
        missing = F.fs_stat(self.root, "gone.txt")
        self.assertTrue(missing["ok"])
        self.assertFalse(missing["exists"])
        self.assertIsNone(missing["version"])
        self.assertFalse(F.fs_stat(self.root, "../../etc/passwd")["ok"])


class WriteTest(unittest.TestCase):
    """fs_write — the only RPC in this module that can destroy work."""

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="charon-write-")
        with open(os.path.join(self.root, "a.txt"), "w") as f:
            f.write("one\n")

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def read(self, rel="a.txt"):
        with open(os.path.join(self.root, rel)) as f:
            return f.read()

    def test_write_returns_the_new_sha(self):
        r = F.fs_write(self.root, "a.txt", "two\n")
        self.assertTrue(r["ok"], r)
        self.assertEqual(self.read(), "two\n")
        self.assertEqual(r["sha256"], F.fs_read(self.root, "a.txt")["sha256"])
        self.assertEqual(r["version"], F.fs_stat(self.root, "a.txt")["version"])

    def test_expected_sha_round_trip(self):
        # The editor's normal path: read, edit, save with the sha it read.
        before = F.fs_read(self.root, "a.txt")["sha256"]
        r = F.fs_write(self.root, "a.txt", "edited\n", expected_sha256=before)
        self.assertTrue(r["ok"], r)
        self.assertEqual(self.read(), "edited\n")

    def test_stale_write_is_refused_and_changes_nothing(self):
        # THE invariant: a coding agent wrote the file while the browser had it
        # open. Saving must not silently discard that.
        before = F.fs_read(self.root, "a.txt")["sha256"]
        with open(os.path.join(self.root, "a.txt"), "w") as f:
            f.write("written by an agent\n")
        r = F.fs_write(self.root, "a.txt", "my edit\n", expected_sha256=before)
        self.assertFalse(r["ok"])
        self.assertEqual(r["reason"], "stale")
        self.assertEqual(self.read(), "written by an agent\n")
        # …and it hands back the CURRENT sha so the client can offer a reload.
        self.assertEqual(r["sha256"], F.fs_read(self.root, "a.txt")["sha256"])

    def test_force_overwrite_when_no_expectation_is_given(self):
        r = F.fs_write(self.root, "a.txt", "forced\n", expected_sha256=None)
        self.assertTrue(r["ok"])
        self.assertEqual(self.read(), "forced\n")

    def test_empty_expectation_means_must_not_exist(self):
        ok = F.fs_write(self.root, "new.txt", "hi\n", expected_sha256="")
        self.assertTrue(ok["ok"], ok)
        clash = F.fs_write(self.root, "a.txt", "hi\n", expected_sha256="")
        self.assertFalse(clash["ok"])
        self.assertEqual(clash["reason"], "stale")

    def test_deleted_file_is_a_stale_write_not_a_resurrection(self):
        before = F.fs_read(self.root, "a.txt")["sha256"]
        os.unlink(os.path.join(self.root, "a.txt"))
        r = F.fs_write(self.root, "a.txt", "back\n", expected_sha256=before)
        self.assertFalse(r["ok"])
        self.assertEqual(r["reason"], "stale")
        self.assertIn("deleted", r["error"])

    def test_escape_is_refused(self):
        victim = tempfile.NamedTemporaryFile(mode="w", delete=False, suffix=".txt")
        victim.write("precious")
        victim.close()
        try:
            r = F.fs_write(self.root, victim.name, "pwned", expected_sha256=None)
            self.assertFalse(r["ok"])
            self.assertEqual(r["reason"], "bad_path")
            with open(victim.name) as f:
                self.assertEqual(f.read(), "precious")
        finally:
            os.unlink(victim.name)

    def test_a_directory_is_refused(self):
        os.makedirs(os.path.join(self.root, "d"))
        r = F.fs_write(self.root, "d", "x")
        self.assertFalse(r["ok"])

    def test_saving_a_link_writes_through_it_and_keeps_it(self):
        # The atomic rename lands on the TARGET: a link that survives only
        # until its first save is a link the editor quietly broke.
        outside = tempfile.mkdtemp(prefix="charon-outside-")
        target = os.path.join(outside, "shared.md")
        with open(target, "w") as f:
            f.write("shared\n")
        link = os.path.join(self.root, "shared.md")
        os.symlink(target, link)
        try:
            opened = F.fs_read(self.root, "shared.md")
            r = F.fs_write(self.root, "shared.md", "edited\n",
                           expected_sha256=opened["sha256"])
            self.assertTrue(r["ok"], r)
            self.assertTrue(os.path.islink(link))
            with open(target) as f:
                self.assertEqual(f.read(), "edited\n")
            self.assertEqual(F.fs_stat(self.root, "shared.md")["version"], r["version"])
        finally:
            shutil.rmtree(outside, ignore_errors=True)

    def test_mode_is_preserved(self):
        # Saving a shell script must not make it non-executable.
        p = os.path.join(self.root, "run.sh")
        with open(p, "w") as f:
            f.write("#!/bin/sh\n")
        os.chmod(p, 0o755)
        F.fs_write(self.root, "run.sh", "#!/bin/sh\necho hi\n")
        self.assertEqual(os.stat(p).st_mode & 0o777, 0o755)

    def test_no_temp_file_is_left_behind(self):
        F.fs_write(self.root, "a.txt", "x\n")
        self.assertEqual([n for n in os.listdir(self.root) if n.startswith(".charon-w-")], [])

    def test_too_large_is_refused(self):
        r = F.fs_write(self.root, "a.txt", "x" * (F.MAX_TEXT_BYTES + 1))
        self.assertFalse(r["ok"])
        self.assertEqual(r["reason"], "too_large")
        self.assertEqual(self.read(), "one\n")   # untouched

    def test_stale_delete_is_refused_and_current_file_survives(self):
        before = F.fs_read(self.root, "a.txt")["sha256"]
        with open(os.path.join(self.root, "a.txt"), "w") as f:
            f.write("newer agent work\n")
        r = F.fs_delete(self.root, "a.txt", expected_sha256=before)
        self.assertFalse(r["ok"])
        self.assertEqual(r["reason"], "stale")
        self.assertEqual(self.read(), "newer agent work\n")

    def test_sha_gated_delete_removes_the_exact_file(self):
        expected = F.fs_read(self.root, "a.txt")["sha256"]
        r = F.fs_delete(self.root, "a.txt", expected_sha256=expected)
        self.assertTrue(r["ok"], r)
        self.assertFalse(os.path.exists(os.path.join(self.root, "a.txt")))


class SymlinkTest(unittest.TestCase):
    """The context-menu link is relative, local and never clobbers."""

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="charon-symlink-")
        os.makedirs(os.path.join(self.root, "nested"))
        with open(os.path.join(self.root, "nested", "AGENTS.md"), "w") as f:
            f.write("shared instructions\n")

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_creates_relative_link_and_both_names_share_content(self):
        r = F.fs_symlink(
            self.root, "nested/AGENTS.md", "nested/CLAUDE.md",
        )
        self.assertTrue(r["ok"], r)
        link = os.path.join(self.root, "nested", "CLAUDE.md")
        self.assertTrue(os.path.islink(link))
        self.assertEqual(os.readlink(link), "AGENTS.md")
        with open(os.path.join(self.root, "nested", "AGENTS.md"), "a") as f:
            f.write("one source\n")
        with open(link) as f:
            self.assertEqual(f.read(), "shared instructions\none source\n")

    def test_delete_removes_the_link_and_preserves_its_target(self):
        created = F.fs_symlink(
            self.root, "nested/AGENTS.md", "nested/CLAUDE.md",
        )
        self.assertTrue(created["ok"], created)

        deleted = F.fs_delete(self.root, "nested/CLAUDE.md")
        self.assertTrue(deleted["ok"], deleted)
        self.assertFalse(os.path.lexists(os.path.join(self.root, "nested", "CLAUDE.md")))
        target = os.path.join(self.root, "nested", "AGENTS.md")
        self.assertTrue(os.path.isfile(target))
        with open(target) as f:
            self.assertEqual(f.read(), "shared instructions\n")

    def test_rename_moves_the_link_and_never_what_it_points_at(self):
        # THE rule for rename and delete: they act on the directory entry the
        # user clicked, never on the file behind it. Resolving the path here
        # would rename the target and leave the link dangling.
        outside_dir = tempfile.mkdtemp(prefix="charon-symlink-outside-")
        target = os.path.join(outside_dir, "real.md")
        with open(target, "w") as f:
            f.write("target\n")
        os.symlink(target, os.path.join(self.root, "link.md"))
        try:
            r = F.fs_rename(self.root, "link.md", "moved.md")
            self.assertTrue(r["ok"], r)
            moved = os.path.join(self.root, "moved.md")
            self.assertTrue(os.path.islink(moved))
            self.assertEqual(os.readlink(moved), target)
            self.assertEqual(os.listdir(outside_dir), ["real.md"])
        finally:
            shutil.rmtree(outside_dir, ignore_errors=True)

    def test_a_broken_link_is_still_an_entry_to_move_and_never_clobbered(self):
        # `exists()` says no on a broken link, but the user sees the row and
        # the rename is about that row.
        os.symlink("nowhere.md", os.path.join(self.root, "broken.md"))
        moved = F.fs_rename(self.root, "broken.md", "still-broken.md")
        self.assertTrue(moved["ok"], moved)
        self.assertTrue(os.path.islink(os.path.join(self.root, "still-broken.md")))

        with open(os.path.join(self.root, "victim.md"), "w") as f:
            f.write("keep\n")
        os.symlink("nowhere.md", os.path.join(self.root, "second.md"))
        clash = F.fs_rename(self.root, "victim.md", "second.md")
        self.assertFalse(clash["ok"])
        self.assertEqual(clash["reason"], "exists")
        with open(os.path.join(self.root, "victim.md")) as f:
            self.assertEqual(f.read(), "keep\n")

    def test_delete_through_a_linked_folder_removes_the_named_file(self):
        # Not the same case as the link itself: here the clicked entry IS the
        # file inside the linked folder, so deleting it deletes that file. The
        # LINK's own deletion (above) is what must never reach its target.
        outside_dir = tempfile.mkdtemp(prefix="charon-symlink-outside-")
        outside_file = os.path.join(outside_dir, "keep.txt")
        with open(outside_file, "w") as f:
            f.write("keep\n")
        os.symlink(outside_dir, os.path.join(self.root, "linked"))
        try:
            deleted = F.fs_delete(self.root, "linked/keep.txt")
            self.assertTrue(deleted["ok"], deleted)
            self.assertFalse(os.path.exists(outside_file))
            self.assertTrue(os.path.isdir(outside_dir))
        finally:
            shutil.rmtree(outside_dir, ignore_errors=True)

    def test_existing_counterpart_is_never_replaced(self):
        counterpart = os.path.join(self.root, "nested", "CLAUDE.md")
        with open(counterpart, "w") as f:
            f.write("keep me\n")
        r = F.fs_symlink(
            self.root, "nested/AGENTS.md", "nested/CLAUDE.md",
        )
        self.assertFalse(r["ok"])
        self.assertEqual(r["reason"], "exists")
        self.assertFalse(os.path.islink(counterpart))
        with open(counterpart) as f:
            self.assertEqual(f.read(), "keep me\n")

    def test_cross_folder_link_is_refused(self):
        r = F.fs_symlink(self.root, "nested/AGENTS.md", "CLAUDE.md")
        self.assertFalse(r["ok"])
        self.assertEqual(r["reason"], "bad_path")
        self.assertFalse(os.path.lexists(os.path.join(self.root, "CLAUDE.md")))

    def test_missing_directory_and_outside_target_are_refused(self):
        missing = F.fs_symlink(
            self.root, "nested/AGENTS.md", "missing/CLAUDE.md",
        )
        self.assertFalse(missing["ok"])
        self.assertEqual(missing["reason"], "missing")

        outside = tempfile.NamedTemporaryFile(mode="w", delete=False)
        outside.write("outside")
        outside.close()
        try:
            escaped = F.fs_symlink(self.root, outside.name, "AGENTS.md")
            self.assertFalse(escaped["ok"])
            self.assertEqual(escaped["reason"], "bad_path")
        finally:
            os.unlink(outside.name)


class FileStreamTest(unittest.TestCase):
    """Large downloads stream exact ranges and remain root-contained."""

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="charon-file-stream-")
        self.path = os.path.join(self.root, "artifact.bin")
        with open(self.path, "wb") as f:
            f.write(bytes(range(256)) * 32769)  # 256 bytes beyond the 8MiB preview cap

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_streams_the_complete_file_without_a_preview_cap(self):
        output = io.BytesIO()
        code, error = F.stream_file_to(self.root, "artifact.bin", output)
        self.assertEqual((code, error), (0, None))
        with open(self.path, "rb") as f:
            self.assertEqual(output.getvalue(), f.read())

    def test_streams_one_exact_http_range(self):
        output = io.BytesIO()
        code, error = F.stream_file_to(
            self.root, "artifact.bin", output, offset=1234, length=9876,
        )
        self.assertEqual((code, error), (0, None))
        with open(self.path, "rb") as f:
            f.seek(1234)
            self.assertEqual(output.getvalue(), f.read(9876))

    def test_rejects_stale_metadata_and_invalid_ranges_before_writing(self):
        version = F.fs_stat(self.root, "artifact.bin")["version"]
        with open(self.path, "ab") as f:
            f.write(b"changed")
        stale = io.BytesIO()
        code, _ = F.stream_file_to(
            self.root, "artifact.bin", stale, expected_version=version,
        )
        self.assertEqual(code, F.STREAM_STALE)
        self.assertEqual(stale.getvalue(), b"")

        invalid = io.BytesIO()
        code, _ = F.stream_file_to(
            self.root, "artifact.bin", invalid,
            offset=os.path.getsize(self.path) + 1, length=1,
        )
        self.assertEqual(code, F.STREAM_BAD_RANGE)
        self.assertEqual(invalid.getvalue(), b"")

    def test_downloads_a_linked_file_and_still_refuses_a_spelled_escape(self):
        outside = tempfile.NamedTemporaryFile(delete=False)
        outside.write(b"linked payload")
        outside.close()
        os.symlink(outside.name, os.path.join(self.root, "linked.bin"))
        try:
            output = io.BytesIO()
            code, error = F.stream_file_to(self.root, "linked.bin", output)
            self.assertEqual((code, error), (0, None))
            self.assertEqual(output.getvalue(), b"linked payload")

            spelled = io.BytesIO()
            code, _ = F.stream_file_to(self.root, f"../{os.path.basename(outside.name)}", spelled)
            self.assertEqual(code, F.STREAM_BAD_PATH)
            self.assertEqual(spelled.getvalue(), b"")
        finally:
            os.unlink(outside.name)


class DirectoryZipStreamTest(unittest.TestCase):
    """Folder downloads are valid streaming ZIPs and never follow links."""

    class UnseekableOutput(io.BytesIO):
        def seekable(self):
            return False

        def seek(self, *args, **kwargs):
            raise io.UnsupportedOperation("stream is not seekable")

        def tell(self):
            raise io.UnsupportedOperation("stream has no position")

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="charon-zip-stream-")
        os.makedirs(os.path.join(self.root, "project", "nested", "empty"))
        with open(os.path.join(self.root, "project", "hello.txt"), "wb") as f:
            f.write(b"hello\n")
        with open(os.path.join(self.root, "project", "nested", "data.bin"), "wb") as f:
            f.write(bytes(range(256)) * 4097)

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_streams_a_valid_zip_to_an_unseekable_output(self):
        output = self.UnseekableOutput()
        code, error = F.stream_directory_zip_to(self.root, "project", output)
        self.assertEqual((code, error), (0, None))
        with zipfile.ZipFile(io.BytesIO(output.getvalue())) as archive:
            self.assertEqual(archive.read("project/hello.txt"), b"hello\n")
            self.assertEqual(
                archive.read("project/nested/data.bin"),
                bytes(range(256)) * 4097,
            )
            self.assertIn("project/nested/empty/", archive.namelist())
            self.assertIsNone(archive.testzip())

    def test_stores_an_outside_symlink_instead_of_following_it(self):
        outside = tempfile.NamedTemporaryFile(delete=False)
        outside.write(b"must not enter the archive")
        outside.close()
        os.symlink(outside.name, os.path.join(self.root, "project", "outside-link"))
        try:
            output = io.BytesIO()
            code, error = F.stream_directory_zip_to(self.root, "project", output)
            self.assertEqual((code, error), (0, None))
            with zipfile.ZipFile(io.BytesIO(output.getvalue())) as archive:
                info = archive.getinfo("project/outside-link")
                self.assertTrue(stat.S_ISLNK(info.external_attr >> 16))
                self.assertEqual(archive.read(info), os.fsencode(outside.name))
                self.assertNotIn(b"must not enter the archive", output.getvalue())
        finally:
            os.unlink(outside.name)

    def test_rejects_a_file_and_an_escape_before_writing(self):
        for path, expected in [
            ("project/hello.txt", F.STREAM_NOT_DIRECTORY),
            ("../outside", F.STREAM_BAD_PATH),
        ]:
            output = io.BytesIO()
            code, _ = F.stream_directory_zip_to(self.root, path, output)
            self.assertEqual(code, expected)
            self.assertEqual(output.getvalue(), b"")


class ReceiveFileTest(unittest.TestCase):
    """The explorer's drop: exact length, atomic commit, never a silent clobber."""

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="charon-receive-")
        os.makedirs(os.path.join(self.root, "assets"))
        with open(os.path.join(self.root, "assets", "logo.png"), "wb") as f:
            f.write(b"old")
        os.chmod(os.path.join(self.root, "assets", "logo.png"), 0o640)

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def _receive(self, path, data, length=None, **kw):
        calls = []
        code, error = F.receive_file_from(
            self.root, path, io.BytesIO(data), len(data) if length is None else length,
            ready=lambda: calls.append(True), **kw)
        return code, error, bool(calls)

    def _parts(self, rel="assets"):
        return [n for n in os.listdir(os.path.join(self.root, rel))
                if n.startswith(F.RECEIVE_TMP_PREFIX)]

    def test_writes_the_exact_bytes_under_the_original_name(self):
        payload = bytes(range(256)) * 5000
        code, error, ready = self._receive("assets/photo.bin", payload)
        self.assertEqual((code, error, ready), (0, None, True))
        with open(os.path.join(self.root, "assets", "photo.bin"), "rb") as f:
            self.assertEqual(f.read(), payload)
        self.assertEqual(self._parts(), [])

    def test_a_new_file_follows_the_umask_not_mkstemp(self):
        old = os.umask(0o022)
        try:
            self._receive("assets/page.html", b"<p>")
        finally:
            os.umask(old)
        mode = stat.S_IMODE(os.stat(os.path.join(self.root, "assets", "page.html")).st_mode)
        self.assertEqual(mode, 0o644)

    def test_refuses_an_existing_file_before_ready(self):
        code, _, ready = self._receive("assets/logo.png", b"new")
        self.assertEqual(code, F.STREAM_EXISTS)
        self.assertFalse(ready)
        with open(os.path.join(self.root, "assets", "logo.png"), "rb") as f:
            self.assertEqual(f.read(), b"old")

    def test_overwrite_replaces_and_keeps_the_mode(self):
        code, error, _ = self._receive("assets/logo.png", b"new", overwrite=True)
        self.assertEqual((code, error), (0, None))
        target = os.path.join(self.root, "assets", "logo.png")
        with open(target, "rb") as f:
            self.assertEqual(f.read(), b"new")
        self.assertEqual(stat.S_IMODE(os.stat(target).st_mode), 0o640)

    def test_overwrite_writes_through_a_symlink(self):
        os.symlink("logo.png", os.path.join(self.root, "assets", "alias.png"))
        code, _, _ = self._receive("assets/alias.png", b"through", overwrite=True)
        self.assertEqual(code, 0)
        self.assertTrue(os.path.islink(os.path.join(self.root, "assets", "alias.png")))
        with open(os.path.join(self.root, "assets", "logo.png"), "rb") as f:
            self.assertEqual(f.read(), b"through")

    def test_a_short_stream_commits_nothing(self):
        code, error, ready = self._receive("assets/cut.bin", b"12345", length=10)
        self.assertEqual(code, F.STREAM_IO_ERROR)
        self.assertTrue(ready)
        self.assertIn("5 of 10", error)
        self.assertFalse(os.path.exists(os.path.join(self.root, "assets", "cut.bin")))
        self.assertEqual(self._parts(), [])

    def test_a_folder_is_never_replaced(self):
        code, _, ready = self._receive("assets", b"x", overwrite=True)
        self.assertEqual(code, F.STREAM_NOT_FILE)
        self.assertFalse(ready)

    def test_missing_folder_and_escapes_are_refused_before_ready(self):
        for path, expected in [
            ("nope/file.txt", F.STREAM_MISSING),
            ("assets/logo.png/inner.txt", F.STREAM_NOT_DIRECTORY),
            ("../escape.txt", F.STREAM_BAD_PATH),
            ("", F.STREAM_BAD_PATH),
        ]:
            code, _, ready = self._receive(path, b"x")
            self.assertEqual(code, expected, path)
            self.assertFalse(ready, path)

    def test_an_empty_file_is_a_file(self):
        code, _, _ = self._receive("assets/.keep", b"")
        self.assertEqual(code, 0)
        self.assertEqual(os.path.getsize(os.path.join(self.root, "assets", ".keep")), 0)

    def test_sweeps_only_stale_upload_temps(self):
        stale = os.path.join(self.root, "assets", F.RECEIVE_TMP_PREFIX + "old" + F.RECEIVE_TMP_SUFFIX)
        fresh = os.path.join(self.root, "assets", F.RECEIVE_TMP_PREFIX + "live" + F.RECEIVE_TMP_SUFFIX)
        for p in (stale, fresh):
            with open(p, "wb") as f:
                f.write(b"x")
        past = time.time() - F.RECEIVE_STALE_S - 60
        os.utime(stale, (past, past))
        self._receive("assets/new.txt", b"y")
        self.assertFalse(os.path.exists(stale))
        self.assertTrue(os.path.exists(fresh))


class ReceiveFileCliTest(unittest.TestCase):
    """The hub's side of the contract: `ready` first, exit codes after."""

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="charon-receive-cli-")

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def _run(self, path, data, *extra):
        import base64
        enc = lambda s: base64.urlsafe_b64encode(s.encode()).decode().rstrip("=")  # noqa: E731
        return subprocess.run(
            [sys.executable, "-m", "charon_agent", "--receive-file", enc(self.root), enc(path),
             "--length", str(len(data)), *extra],
            input=data, capture_output=True, timeout=30,
            cwd=os.path.join(os.path.dirname(__file__), ".."),
        )

    def test_ready_then_commit_then_refuse_then_overwrite(self):
        first = self._run("a b.txt", b"one")
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(first.stdout, b"ready\n")
        again = self._run("a b.txt", b"two")
        self.assertEqual(again.returncode, F.STREAM_EXISTS)
        self.assertEqual(again.stdout, b"")
        forced = self._run("a b.txt", b"two", "--overwrite")
        self.assertEqual(forced.returncode, 0, forced.stderr)
        with open(os.path.join(self.root, "a b.txt"), "rb") as f:
            self.assertEqual(f.read(), b"two")


if __name__ == "__main__":
    unittest.main(verbosity=2)
