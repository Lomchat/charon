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

    def test_remote_url_is_carried_for_the_web_link(self):
        # `remote -v` in place of `remote`: same subprocess, and the URL is what
        # the hub turns into the "open on GitHub" link next to the chip.
        self.assertIsNone(G.git_status(self.dir)["remote_url"])
        sh(self.dir, "remote", "add", "upstream", "https://example.com/u/r.git")
        sh(self.dir, "remote", "add", "origin", "git@github.com:o/r.git")
        r = G.git_status(self.dir)
        self.assertEqual(set(r["remotes"]), {"origin", "upstream"})
        self.assertEqual(r["remote_url"], "git@github.com:o/r.git")   # origin wins

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


@unittest.skipUnless(HAS_GIT, "git binary not available")
class GitWorkspaceTest(unittest.TestCase):
    """A folder OF projects is a normal cwd, and used to answer "not a repo".

    `rev-parse --show-toplevel` only walks UP, so /srv with ten checkouts under
    it reported nothing at all. `git_workspace` scans DOWN, bounded.
    """

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="charon-ws-test-")
        self.roots = []
        for rel in ("alpha", "nest/beta"):
            p = os.path.join(self.dir, rel)
            os.makedirs(p, exist_ok=True)
            sh(p, "init", "-q", "-b", "main")
            sh(p, "config", "user.email", "t@e")
            sh(p, "config", "user.name", "T")
            sh(p, "config", "commit.gpgsign", "false")
            write(p, "a.txt", "one\n")
            sh(p, "add", "-A")
            sh(p, "commit", "-qm", "init")
            write(p, "a.txt", "one\ntwo\n")
            write(p, "new.txt", "x\n")
            self.roots.append(p)
        G._scan_cache.clear()

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)
        G._scan_cache.clear()

    def test_finds_every_repo_below_a_plain_folder(self):
        w = G.git_workspace(self.dir)
        self.assertTrue(w["ok"])
        self.assertEqual(w["mode"], "multi")
        self.assertEqual(sorted(r["root"] for r in w["repos"]), sorted(self.roots))
        # Each entry is a full git_status payload, so the panel needs nothing else.
        for r in w["repos"]:
            self.assertTrue(r["is_repo"])
            self.assertEqual(r["branch"], "main")
            self.assertEqual({f["status"] for f in r["files"]}, {"M", "?"})
        # …plus the two display keys the hub would otherwise recompute.
        by_name = {r["name"]: r for r in w["repos"]}
        self.assertEqual(by_name["alpha"]["rel"], "alpha")
        self.assertEqual(by_name["beta"]["rel"], os.path.join("nest", "beta"))

    def test_a_cwd_inside_a_repo_is_still_single_and_scoped_to_the_toplevel(self):
        # The pre-existing contract: a session started in a subdirectory sees
        # the whole changeset, and no scan happens at all.
        sub = os.path.join(self.roots[0], "deeper")
        os.makedirs(sub, exist_ok=True)
        w = G.git_workspace(sub)
        self.assertEqual(w["mode"], "single")
        self.assertEqual(len(w["repos"]), 1)
        self.assertEqual(w["repos"][0]["root"], self.roots[0])
        self.assertEqual(w["repos"][0]["rel"], os.path.relpath(self.roots[0], sub))

    def test_a_plain_folder_with_nothing_in_it_is_none_not_an_error(self):
        empty = tempfile.mkdtemp(prefix="charon-ws-empty-")
        try:
            w = G.git_workspace(empty)
            self.assertTrue(w["ok"])
            self.assertEqual(w["mode"], "none")
            self.assertEqual(w["repos"], [])
            self.assertIsNone(w.get("reason"))
        finally:
            shutil.rmtree(empty, ignore_errors=True)

    def test_depth_is_a_real_bound(self):
        deep = os.path.join(self.dir, "a/b/c/d/repo")
        os.makedirs(deep, exist_ok=True)
        sh(deep, "init", "-q", "-b", "main")
        found, _ = G._discover_repos(self.dir, 3)
        self.assertNotIn(deep, found)
        found6, _ = G._discover_repos(self.dir, 6)
        self.assertIn(deep, found6)

    def test_never_descends_into_a_checkout_or_a_junk_dir(self):
        # A vendored repo inside node_modules is not one of your projects, and
        # a submodule is the parent repo's business — both would be noise, and
        # walking them is where a recursive scan goes to die.
        for rel in ("alpha/node_modules/dep", "alpha/vendor/lib", "alpha/sub/inner"):
            p = os.path.join(self.dir, rel)
            os.makedirs(p, exist_ok=True)
            sh(p, "init", "-q", "-b", "main")
        found, _ = G._discover_repos(self.dir, 6)
        self.assertEqual(sorted(found), sorted(self.roots))

    def test_a_symlink_loop_cannot_hang_the_scan(self):
        try:
            os.symlink(self.dir, os.path.join(self.dir, "loop"))
        except (OSError, NotImplementedError):
            self.skipTest("symlinks unavailable")
        found, _ = G._discover_repos(self.dir, 6)
        self.assertEqual(sorted(found), sorted(self.roots))

    def test_discovery_is_cached_until_refresh(self):
        G.git_workspace(self.dir)
        extra = os.path.join(self.dir, "gamma")
        os.makedirs(extra, exist_ok=True)
        sh(extra, "init", "-q", "-b", "main")
        self.assertEqual(len(G.git_workspace(self.dir)["repos"]), 2)      # cached
        self.assertEqual(len(G.git_workspace(self.dir, refresh=True)["repos"]), 3)

    def test_the_repo_cap_is_reported_not_silently_applied(self):
        for i in range(G.MAX_REPOS + 3):
            p = os.path.join(self.dir, f"r{i:03d}")
            os.makedirs(p, exist_ok=True)
            sh(p, "init", "-q", "-b", "main")
        found, truncated = G._discover_repos(self.dir, 3)
        self.assertEqual(len(found), G.MAX_REPOS)
        self.assertTrue(truncated)

    def test_a_broken_dot_git_at_the_base_does_not_hide_the_projects(self):
        # Measured on a real /srv: a `.git` that git itself rejects (empty,
        # half-created, a stale worktree pointer, ownership it refuses) used
        # to read as "this IS the checkout", so the scan stopped dead at the
        # top and reported zero repos with several right underneath.
        os.makedirs(os.path.join(self.dir, ".git"), exist_ok=True)
        G._scan_cache.clear()
        w = G.git_workspace(self.dir)
        self.assertEqual(w["mode"], "multi")
        self.assertEqual(sorted(r["root"] for r in w["repos"]), sorted(self.roots))


@unittest.skipUnless(HAS_GIT, "git binary not available")
class GitBranchTest(unittest.TestCase):
    """Branch listing + switching (agent >= 0.31.0).

    A branch list is only a navigation tool if it says how far each branch has
    drifted, and a switch is the one write here that can lose work — hence
    `git switch` with no --force and no autostash: a dirty tree comes back as
    reason='dirty' and the user decides.
    """

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="charon-branch-test-")
        sh(self.dir, "init", "-q", "-b", "main")
        sh(self.dir, "config", "user.email", "t@e")
        sh(self.dir, "config", "user.name", "T")
        sh(self.dir, "config", "commit.gpgsign", "false")
        write(self.dir, "a.txt", "one\n")
        sh(self.dir, "add", "-A")
        sh(self.dir, "commit", "-qm", "first")
        sh(self.dir, "branch", "feature/x")
        sh(self.dir, "checkout", "-q", "feature/x")
        write(self.dir, "b.txt", "two\n")
        sh(self.dir, "add", "-A")
        sh(self.dir, "commit", "-qm", "second")
        sh(self.dir, "checkout", "-q", "main")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_lists_branches_with_drift_and_marks_the_current_one(self):
        r = G.git_branches(self.dir)
        self.assertTrue(r["ok"])
        self.assertEqual(r["current"], "main")
        self.assertFalse(r["detached"])
        by = {b["short"]: b for b in r["branches"]}
        self.assertEqual(set(by), {"main", "feature/x"})
        self.assertTrue(by["main"]["current"])
        self.assertFalse(by["feature/x"]["remote"])
        # feature/x is one commit ahead of where we stand. That number is the
        # whole point: it says what switching would bring.
        if by["feature/x"]["ahead_head"] is not None:      # git >= 2.41
            self.assertEqual(by["feature/x"]["ahead_head"], 1)
            self.assertEqual(by["feature/x"]["behind_head"], 0)
        self.assertIsNotNone(by["feature/x"]["committed_at"])
        self.assertEqual(by["feature/x"]["subject"], "second")

    def test_a_branch_checked_out_here_reports_its_worktree(self):
        by = {b["short"]: b for b in G.git_branches(self.dir)["branches"]}
        self.assertTrue(by["main"]["worktree"])

    def test_switch_moves_head(self):
        r = G.git_checkout(self.dir, {"branch": "feature/x"})
        self.assertTrue(r["ok"], r)
        self.assertEqual(G.git_branches(self.dir)["current"], "feature/x")

    def test_create_carries_the_working_tree_over(self):
        # The "I started editing on the wrong branch" recovery — allowed dirty
        # on purpose, because nothing is lost.
        write(self.dir, "a.txt", "one\nedited\n")
        r = G.git_checkout(self.dir, {"branch": "wip/thing", "create": True})
        self.assertTrue(r["ok"], r)
        self.assertTrue(r["created"])
        self.assertEqual(G.git_branches(self.dir)["current"], "wip/thing")
        st = G.git_status(self.dir)
        self.assertEqual([f["path"] for f in st["files"]], ["a.txt"])

    def test_creating_an_existing_branch_is_refused_not_silently_reused(self):
        r = G.git_checkout(self.dir, {"branch": "feature/x", "create": True})
        self.assertFalse(r["ok"])
        self.assertEqual(r["reason"], "exists")

    def test_a_switch_that_would_lose_work_is_refused_with_the_paths(self):
        # b.txt exists only on feature/x, so an uncommitted b.txt on main is
        # exactly the collision git protects against. We never --force it.
        write(self.dir, "b.txt", "mine\n")
        r = G.git_checkout(self.dir, {"branch": "feature/x"})
        self.assertFalse(r["ok"])
        self.assertEqual(r["reason"], "dirty")
        self.assertEqual(G.git_branches(self.dir)["current"], "main")   # unmoved
        with open(os.path.join(self.dir, "b.txt")) as f:
            self.assertEqual(f.read(), "mine\n")                        # unharmed

    def test_a_bad_branch_name_never_reaches_git(self):
        for bad in ("", "--force", "a/../b", "x/"):
            r = G.git_checkout(self.dir, {"branch": bad})
            self.assertFalse(r["ok"])
            self.assertEqual(r["reason"], "bad_branch")

    def test_delete_is_the_safe_one_only(self):
        # feature/x holds a commit main does not: -d refuses, and we never
        # reach for -D on the user's behalf.
        r = G.git_delete_branch(self.dir, {"branch": "feature/x"})
        self.assertFalse(r["ok"])
        self.assertEqual(r["reason"], "unmerged")
        self.assertIn("feature/x", {b["short"] for b in G.git_branches(self.dir)["branches"]})
        # A merged branch goes without argument.
        sh(self.dir, "branch", "spare")
        self.assertTrue(G.git_delete_branch(self.dir, {"branch": "spare"})["ok"])

    def test_deleting_the_branch_you_are_on_is_refused(self):
        r = G.git_delete_branch(self.dir, {"branch": "main"})
        self.assertFalse(r["ok"])
        self.assertIn(r["reason"], ("current", "error"))

    def test_a_plain_folder_answers_is_repo_false_not_a_crash(self):
        plain = tempfile.mkdtemp(prefix="charon-branch-plain-")
        try:
            r = G.git_branches(plain)
            self.assertTrue(r["ok"])
            self.assertFalse(r["is_repo"])
        finally:
            shutil.rmtree(plain, ignore_errors=True)


@unittest.skipUnless(HAS_GIT, "git binary not available")
class GitHistoryTest(unittest.TestCase):
    """`git_log` / `git_show` (agent >= 0.32.0) — the read-only half of history."""

    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix="charon-hist-test-")
        sh(self.dir, "init", "-q", "-b", "main")
        sh(self.dir, "config", "user.email", "t@e")
        sh(self.dir, "config", "user.name", "T")
        sh(self.dir, "config", "commit.gpgsign", "false")
        write(self.dir, "a.txt", "one\n")
        sh(self.dir, "add", "-A")
        sh(self.dir, "commit", "-qm", "first: it's a subject, with a comma")
        write(self.dir, "b.txt", "bee\n")
        sh(self.dir, "add", "-A")
        sh(self.dir, "commit", "-qm", "second")
        write(self.dir, "a.txt", "one\ntwo\n")
        sh(self.dir, "add", "-A")
        sh(self.dir, "commit", "-qm", "third: touches a.txt")

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_lists_commits_newest_first_with_their_metadata(self):
        r = G.git_log(self.dir, {"limit": 10})
        self.assertTrue(r["ok"])
        self.assertEqual([c["subject"] for c in r["commits"]],
                         ["third: touches a.txt", "second", "first: it's a subject, with a comma"])
        top = r["commits"][0]
        # `sh()` forces GIT_AUTHOR_NAME, which outranks the repo config.
        self.assertEqual(top["author"], "T")
        # The subject above holds both an apostrophe and a comma — the record
        # separators are \x1f/\x1e precisely so neither splits a field.
        self.assertIn("it's a subject, with a comma", r["commits"][2]["subject"])
        self.assertTrue(top["sha"].startswith(top["short"]))
        self.assertIsInstance(top["at"], int)
        # `%D` is a comma-joined decoration string; splitting it here means the
        # UI never has to parse a display string.
        self.assertIn("HEAD -> main", top["refs"])
        self.assertFalse(r["has_more"])

    def test_pages(self):
        first = G.git_log(self.dir, {"limit": 2})
        self.assertEqual(len(first["commits"]), 2)
        self.assertTrue(first["has_more"])          # an exact fill may have more
        second = G.git_log(self.dir, {"limit": 2, "skip": 2})
        self.assertEqual([c["subject"] for c in second["commits"]],
                         ["first: it's a subject, with a comma"])
        self.assertFalse(second["has_more"])

    def test_file_history_only_shows_commits_touching_that_file(self):
        r = G.git_log(self.dir, {"path": "b.txt"})
        self.assertEqual([c["subject"] for c in r["commits"]], ["second"])

    def test_a_path_outside_the_repo_is_refused(self):
        r = G.git_log(self.dir, {"path": "../../etc/passwd"})
        self.assertFalse(r["ok"])
        self.assertEqual(r["reason"], "bad_path")

    def test_show_returns_metadata_files_and_patch(self):
        sha = G.git_log(self.dir, {"limit": 1})["commits"][0]["sha"]
        r = G.git_show(self.dir, {"sha": sha})
        self.assertTrue(r["ok"])
        self.assertEqual(r["commit"]["subject"], "third: touches a.txt")
        self.assertEqual([f["path"] for f in r["files"]], ["a.txt"])
        self.assertEqual(r["files"][0]["added"], 1)
        self.assertEqual(r["files"][0]["deleted"], 0)
        self.assertIn("+two", r["patch"])

    def test_show_can_be_narrowed_to_one_path(self):
        sha = G.git_log(self.dir, {"limit": 1})["commits"][0]["sha"]
        r = G.git_show(self.dir, {"sha": sha, "path": "b.txt"})
        self.assertTrue(r["ok"])
        self.assertEqual(r["files"], [])            # that commit didn't touch b.txt
        self.assertEqual(r["patch"].strip(), "")

    def test_a_ref_that_is_really_an_option_never_reaches_git(self):
        # `git show --upload-pack=…` is a remote-code-execution shape; the
        # allow-list of characters is what keeps argv honest.
        for bad in ("", "--upload-pack=x", "a;b", "$(id)"):
            r = G.git_show(self.dir, {"sha": bad})
            self.assertFalse(r["ok"], bad)
            self.assertEqual(r["reason"], "bad_ref")

    def test_an_empty_repo_is_an_empty_list_not_an_error(self):
        empty = tempfile.mkdtemp(prefix="charon-hist-empty-")
        try:
            sh(empty, "init", "-q", "-b", "main")
            r = G.git_log(empty)
            self.assertTrue(r["ok"])
            self.assertEqual(r["commits"], [])
        finally:
            shutil.rmtree(empty, ignore_errors=True)
