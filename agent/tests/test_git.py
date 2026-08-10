"""Tests for the source-control RPCs (charon_agent.git, agent >= 0.24.0).

Everything runs against a REAL throwaway repo built by `git init` in a temp
dir — the porcelain-v2 `-z` grammar has enough shape (rename records emit a
second NUL field, untracked entries have no numstat, `--numstat` prints '-'
for binaries) that a mocked parser would only test my reading of the manual.

The invariants worth pinning, in order of how much damage getting them wrong
would do:
  * `_safe_rel` refuses anything resolving outside the repo — it guards a
    delete path (`git_discard`) and a read path (`git_diff`).
  * a partial commit records ONLY the selected paths. Several coding agents
    share these working trees, so sweeping a neighbour's in-flight file into
    a commit is the feature's worst failure mode.
  * failures degrade into {ok: False, reason} — never an exception, which
    the hub could only render as an opaque -32603.

stdlib unittest only. Run with:
    python3 agent/tests/test_git.py
"""
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from charon_agent import git as G  # noqa: E402

HAS_GIT = shutil.which("git") is not None


def sh(cwd, *args):
    env = os.environ.copy()
    env.update({"GIT_AUTHOR_NAME": "T", "GIT_AUTHOR_EMAIL": "t@e",
                "GIT_COMMITTER_NAME": "T", "GIT_COMMITTER_EMAIL": "t@e"})
    return subprocess.run(["git", *args], cwd=cwd, env=env, check=True,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def write(root, rel, text):
    p = os.path.join(root, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w") as f:
        f.write(text)


@unittest.skipUnless(HAS_GIT, "git binary not available")
class GitStatusTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="charon-git-test-")
        sh(self.dir, "init", "-q", "-b", "main")
        sh(self.dir, "config", "user.email", "t@e")
        sh(self.dir, "config", "user.name", "T")
        sh(self.dir, "config", "commit.gpgsign", "false")
        write(self.dir, "kept.txt", "one\ntwo\nthree\n")
        write(self.dir, "gone.txt", "bye\n")
        write(self.dir, "sub/nested.txt", "a\n")
        sh(self.dir, "add", "-A")
        sh(self.dir, "commit", "-qm", "init")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_clean_repo(self):
        r = G.git_status(self.dir)
        self.assertTrue(r["ok"])
        self.assertTrue(r["is_repo"])
        self.assertEqual(r["branch"], "main")
        self.assertEqual(r["files"], [])
        self.assertEqual((r["added"], r["deleted"]), (0, 0))
        self.assertIsNone(r["upstream"])

    def test_not_a_repo_is_not_an_error(self):
        # The hub renders nothing for a non-repo cwd, so this must NOT look
        # like a failure — otherwise every non-git session shows an error chip.
        plain = tempfile.mkdtemp(prefix="charon-plain-")
        try:
            r = G.git_status(plain)
            self.assertTrue(r["ok"])
            self.assertFalse(r["is_repo"])
        finally:
            shutil.rmtree(plain, ignore_errors=True)

    def test_missing_cwd(self):
        r = G.git_status("/nonexistent/charon/xyz")
        self.assertTrue(r["ok"])
        self.assertFalse(r["is_repo"])
        self.assertEqual(r["reason"], "no_cwd")

    def test_modified_deleted_untracked(self):
        write(self.dir, "kept.txt", "one\ntwo\nthree\nfour\n")
        os.unlink(os.path.join(self.dir, "gone.txt"))
        write(self.dir, "fresh.txt", "x\ny\n")
        r = G.git_status(self.dir)
        by = {f["path"]: f for f in r["files"]}
        self.assertEqual(by["kept.txt"]["status"], "M")
        self.assertEqual((by["kept.txt"]["added"], by["kept.txt"]["deleted"]), (1, 0))
        self.assertEqual(by["gone.txt"]["status"], "D")
        self.assertEqual(by["fresh.txt"]["status"], "?")
        self.assertTrue(by["fresh.txt"]["untracked"])
        # An untracked file has no numstat; we count its lines ourselves so a
        # brand-new 200-line file doesn't display as "+0".
        self.assertEqual(by["fresh.txt"]["added"], 2)
        self.assertEqual(r["file_count"], 3)

    def test_untracked_files_are_listed_individually(self):
        # -uall, not the default -unormal which collapses a new directory to
        # "newdir/" — a collapsed entry has no diff and can't be committed
        # path-wise from the panel.
        write(self.dir, "newdir/a.txt", "a\n")
        write(self.dir, "newdir/b.txt", "b\n")
        paths = {f["path"] for f in G.git_status(self.dir)["files"]}
        self.assertEqual(paths, {"newdir/a.txt", "newdir/b.txt"})

    def test_binary_untracked_has_no_count(self):
        with open(os.path.join(self.dir, "blob.bin"), "wb") as f:
            f.write(b"\x00\x01\x02" * 100)
        by = {f["path"]: f for f in G.git_status(self.dir)["files"]}
        self.assertTrue(by["blob.bin"]["binary"])
        self.assertIsNone(by["blob.bin"]["added"])

    def test_staged_rename_keeps_orig_path(self):
        sh(self.dir, "mv", "kept.txt", "renamed.txt")
        by = {f["path"]: f for f in G.git_status(self.dir)["files"]}
        self.assertIn("renamed.txt", by)
        self.assertEqual(by["renamed.txt"]["status"], "R")
        self.assertEqual(by["renamed.txt"]["orig_path"], "kept.txt")

    def test_unborn_head(self):
        empty = tempfile.mkdtemp(prefix="charon-unborn-")
        try:
            sh(empty, "init", "-q", "-b", "main")
            write(empty, "a.txt", "hello\n")
            r = G.git_status(empty)
            self.assertTrue(r["ok"])
            self.assertIsNone(r["head"])
            self.assertEqual(r["files"][0]["path"], "a.txt")
        finally:
            shutil.rmtree(empty, ignore_errors=True)

    def test_recent_subjects_are_opt_in(self):
        # The status call is POLLED; paying an extra `git log` on every poll to
        # carry subjects only the commit-message generator wants is waste.
        self.assertEqual(G.git_status(self.dir)["recent_subjects"], [])
        self.assertEqual(
            G.git_status(self.dir, include_recent=True)["recent_subjects"], ["init"]
        )

    def test_recent_subjects_on_an_unborn_head(self):
        empty = tempfile.mkdtemp(prefix="charon-unborn2-")
        try:
            sh(empty, "init", "-q", "-b", "main")
            self.assertEqual(
                G.git_status(empty, include_recent=True)["recent_subjects"], []
            )
        finally:
            shutil.rmtree(empty, ignore_errors=True)

    def test_root_is_the_toplevel_not_the_cwd(self):
        # A session started in a subdir must still see the whole changeset.
        write(self.dir, "kept.txt", "changed\n")
        r = G.git_status(os.path.join(self.dir, "sub"))
        self.assertEqual(os.path.realpath(r["root"]), os.path.realpath(self.dir))
        self.assertIn("kept.txt", {f["path"] for f in r["files"]})


@unittest.skipUnless(HAS_GIT, "git binary not available")
class GitDiffTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="charon-git-diff-")
        sh(self.dir, "init", "-q", "-b", "main")
        sh(self.dir, "config", "user.email", "t@e")
        sh(self.dir, "config", "user.name", "T")
        write(self.dir, "a.txt", "one\n")
        sh(self.dir, "add", "-A")
        sh(self.dir, "commit", "-qm", "init")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_tracked_diff(self):
        write(self.dir, "a.txt", "two\n")
        r = G.git_diff(self.dir, "a.txt")
        self.assertTrue(r["ok"])
        self.assertTrue(r["tracked"])
        self.assertIn("-one", r["patch"])
        self.assertIn("+two", r["patch"])

    def test_untracked_diff_against_devnull(self):
        write(self.dir, "new.txt", "hello\n")
        r = G.git_diff(self.dir, "new.txt")
        self.assertTrue(r["ok"])
        self.assertFalse(r["tracked"])
        self.assertIn("+hello", r["patch"])

    def test_staged_changes_are_included(self):
        # The panel commits worktree state vs HEAD, so the diff it shows must
        # be vs HEAD too — otherwise a staged file renders as "no changes".
        write(self.dir, "a.txt", "staged\n")
        sh(self.dir, "add", "a.txt")
        r = G.git_diff(self.dir, "a.txt")
        self.assertIn("+staged", r["patch"])

    def test_absolute_path_accepted(self):
        write(self.dir, "a.txt", "abs\n")
        r = G.git_diff(self.dir, os.path.join(self.dir, "a.txt"))
        self.assertTrue(r["ok"])
        self.assertEqual(r["path"], "a.txt")

    def test_escape_is_refused(self):
        for bad in ["../../../etc/passwd", "/etc/passwd", "sub/../../outside"]:
            r = G.git_diff(self.dir, bad)
            self.assertFalse(r["ok"], bad)
            self.assertEqual(r["reason"], "bad_path", bad)


@unittest.skipUnless(HAS_GIT, "git binary not available")
class GitCommitTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="charon-git-commit-")
        sh(self.dir, "init", "-q", "-b", "main")
        sh(self.dir, "config", "user.email", "t@e")
        sh(self.dir, "config", "user.name", "T")
        write(self.dir, "a.txt", "a\n")
        sh(self.dir, "add", "-A")
        sh(self.dir, "commit", "-qm", "init")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def _log(self):
        out = subprocess.run(["git", "log", "--format=%s"], cwd=self.dir,
                             stdout=subprocess.PIPE).stdout.decode()
        return out.split("\n")

    def test_commit_selected_paths_only(self):
        # THE invariant: another session's in-flight file must not ride along.
        write(self.dir, "mine.txt", "mine\n")
        write(self.dir, "theirs.txt", "theirs\n")
        r = G.git_commit(self.dir, {"message": "feat: mine", "paths": ["mine.txt"]})
        self.assertTrue(r["ok"], r)
        self.assertTrue(r["committed"])
        self.assertIsNotNone(r["sha"])
        names = subprocess.run(["git", "show", "--name-only", "--format=", "HEAD"],
                               cwd=self.dir, stdout=subprocess.PIPE).stdout.decode().split()
        self.assertEqual(names, ["mine.txt"])
        left = {f["path"] for f in G.git_status(self.dir)["files"]}
        self.assertEqual(left, {"theirs.txt"})

    def test_commit_all(self):
        write(self.dir, "x.txt", "x\n")
        write(self.dir, "y.txt", "y\n")
        r = G.git_commit(self.dir, {"message": "chore: everything", "all": True})
        self.assertTrue(r["ok"], r)
        self.assertEqual(G.git_status(self.dir)["files"], [])

    def test_commit_records_a_deletion(self):
        os.unlink(os.path.join(self.dir, "a.txt"))
        r = G.git_commit(self.dir, {"message": "rm a", "paths": ["a.txt"]})
        self.assertTrue(r["ok"], r)
        self.assertEqual(G.git_status(self.dir)["files"], [])

    def test_empty_message_refused(self):
        r = G.git_commit(self.dir, {"message": "   ", "all": True})
        self.assertFalse(r["ok"])
        self.assertEqual(r["reason"], "no_message")

    def test_no_selection_refused(self):
        r = G.git_commit(self.dir, {"message": "x", "paths": []})
        self.assertFalse(r["ok"])
        self.assertEqual(r["reason"], "bad_paths")

    def test_nothing_to_commit(self):
        r = G.git_commit(self.dir, {"message": "x", "all": True})
        self.assertFalse(r["ok"])
        self.assertEqual(r["reason"], "no_changes")

    def test_path_escape_refused(self):
        r = G.git_commit(self.dir, {"message": "x", "paths": ["../evil"]})
        self.assertFalse(r["ok"])
        self.assertEqual(r["reason"], "bad_paths")

    def test_push_failure_does_not_hide_the_commit(self):
        # The commit landed; reporting ok:False would push the user to commit
        # again. It's a push problem and must be labelled as one.
        write(self.dir, "b.txt", "b\n")
        r = G.git_commit(self.dir, {"message": "feat: b", "all": True, "push": True})
        self.assertTrue(r["ok"], r)
        self.assertTrue(r["committed"])
        self.assertFalse(r["pushed"])
        self.assertEqual(r["push_reason"], "no_remote")


@unittest.skipUnless(HAS_GIT, "git binary not available")
class GitDiscardTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="charon-git-discard-")
        sh(self.dir, "init", "-q", "-b", "main")
        sh(self.dir, "config", "user.email", "t@e")
        sh(self.dir, "config", "user.name", "T")
        write(self.dir, "a.txt", "original\n")
        sh(self.dir, "add", "-A")
        sh(self.dir, "commit", "-qm", "init")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_discard_tracked_restores_head(self):
        write(self.dir, "a.txt", "wrecked\n")
        sh(self.dir, "add", "a.txt")  # even staged, discard means "back to HEAD"
        r = G.git_discard(self.dir, {"paths": ["a.txt"]})
        self.assertTrue(r["ok"], r)
        with open(os.path.join(self.dir, "a.txt")) as f:
            self.assertEqual(f.read(), "original\n")
        self.assertEqual(G.git_status(self.dir)["files"], [])

    def test_discard_untracked_unlinks(self):
        write(self.dir, "junk.txt", "junk\n")
        r = G.git_discard(self.dir, {"paths": ["junk.txt"]})
        self.assertTrue(r["ok"], r)
        self.assertFalse(os.path.exists(os.path.join(self.dir, "junk.txt")))

    def test_discard_refuses_paths_outside_the_repo(self):
        victim = tempfile.NamedTemporaryFile(delete=False)
        victim.write(b"precious")
        victim.close()
        try:
            r = G.git_discard(self.dir, {"paths": [victim.name]})
            self.assertFalse(r["ok"])
            self.assertEqual(r["reason"], "bad_paths")
            self.assertTrue(os.path.exists(victim.name))
        finally:
            os.unlink(victim.name)

    def test_discard_needs_an_explicit_selection(self):
        # No repo-wide discard: `all` is not a thing here, by design.
        for params in ({"paths": []}, {"all": True}, {}):
            r = G.git_discard(self.dir, params)
            self.assertFalse(r["ok"])
            self.assertEqual(r["reason"], "bad_paths")


class PureHelpersTest(unittest.TestCase):
    """No git binary needed."""

    def test_parse_numstat_plain(self):
        got = G._parse_numstat_z("3\t1\tsrc/a.ts\0" "0\t7\tb.md\0")
        self.assertEqual(got, {"src/a.ts": (3, 1), "b.md": (0, 7)})

    def test_parse_numstat_binary(self):
        self.assertEqual(G._parse_numstat_z("-\t-\timg.png\0"), {"img.png": (None, None)})

    def test_parse_numstat_rename(self):
        # -z rename records split the two paths into their own NUL fields.
        got = G._parse_numstat_z("2\t2\t\0old/a.ts\0new/a.ts\0")
        self.assertEqual(got, {"new/a.ts": (2, 2)})

    def test_letter_prefers_the_index_status(self):
        self.assertEqual(G._letter(".", "M"), "M")
        self.assertEqual(G._letter("A", "M"), "A")
        self.assertEqual(G._letter("R", "."), "R")

    def test_classify(self):
        cases = {
            "fatal: detected dubious ownership in repository at '/srv/x'": "ownership",
            "*** Please tell me who you are.": "identity",
            "fatal: could not read Username for 'https://github.com': terminal prompts disabled": "auth",
            "git@github.com: Permission denied (publickey).": "auth",
            "! [rejected] main -> main (non-fast-forward)": "rejected",
            "fatal: No configured push destination": "no_remote",
            "nothing to commit, working tree clean": "no_changes",
            "git status: timed out after 20s": "timeout",
            "something else entirely": "error",
        }
        for text, want in cases.items():
            self.assertEqual(G._classify(text), want, text)


if __name__ == "__main__":
    unittest.main(verbosity=2)
