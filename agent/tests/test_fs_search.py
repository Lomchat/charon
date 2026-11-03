"""Tests for fsnav.fs_search (agent >= 0.29.0) — the ToolPanel's search tab.

What is worth pinning here is what a search must never do:

  * lie by omission — every bound it hits comes back as `truncated`, because a
    silently cut result list reads exactly like "there is nothing else";
  * leave the root — the enumeration walks, and a walk is where a symlink
    turns a project search into a tour of the filesystem;
  * choke on a repo — a NUL byte means binary and a 40MB bundle is skipped,
    both before the regex ever runs;
  * take a bad regex personally — the user is still typing it, so it comes
    back as a reason, not as an exception.

The glob translation gets its own case because it is the part users type by
hand and the part whose rules they already know from VS Code and .gitignore.

stdlib unittest only. Run with:
    python3 agent/tests/test_fs_search.py
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


def write(root: str, rel: str, body) -> str:
    path = os.path.join(root, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    mode = "wb" if isinstance(body, bytes) else "w"
    with open(path, mode) as f:
        f.write(body)
    return path


class GlobTest(unittest.TestCase):
    def match(self, spec, rel):
        return F._matches_any(rel, F._compile_globs(spec))

    def test_bare_pattern_matches_at_any_depth(self):
        # `*.ts` with no slash is the one everybody types first.
        self.assertTrue(self.match("*.ts", "app.ts"))
        self.assertTrue(self.match("*.ts", "src/deep/app.ts"))
        self.assertFalse(self.match("*.ts", "src/app.tsx"))

    def test_star_stops_at_a_separator_and_doublestar_does_not(self):
        self.assertTrue(self.match("src/*.ts", "src/app.ts"))
        self.assertFalse(self.match("src/*.ts", "src/a/app.ts"))
        self.assertTrue(self.match("src/**/*.ts", "src/a/b/app.ts"))
        # `**/` also has to match ZERO directories, or `src/**/*.ts` would be
        # a subtly different filter from what the user reads it as.
        self.assertTrue(self.match("src/**/*.ts", "src/app.ts"))

    def test_a_folder_name_covers_its_contents(self):
        self.assertTrue(self.match("tests", "tests/a/b.py"))
        self.assertTrue(self.match("node_modules", "node_modules/x/index.js"))
        self.assertFalse(self.match("tests", "src/tests_helper.py"))

    def test_braces_and_multiple_patterns(self):
        # The comma inside the braces is NOT a pattern separator — splitting
        # there turns one working glob into two that match nothing.
        self.assertTrue(self.match("*.{ts,tsx}", "a/b.tsx"))
        self.assertTrue(self.match("*.{ts,tsx}", "a/b.ts"))
        self.assertFalse(self.match("*.{ts,tsx}", "a/b.py"))
        self.assertTrue(self.match("*.md, src/**", "src/x/y.py"))
        self.assertFalse(self.match("*.md, src/**", "lib/y.py"))

    def test_a_half_typed_glob_is_harmless(self):
        # Every keystroke of `[abc]` goes through here; none may raise.
        for spec in ("[", "{", "a{b", "**", "!", "  ,  , "):
            F._compile_globs(spec)
        self.assertEqual(F._compile_globs("  ,  , "), [])
        # An unclosed bracket degrades to the literal character, so it still
        # means something predictable instead of matching everything.
        self.assertTrue(self.match("[", "sub/["))
        self.assertFalse(self.match("[", "sub/other.txt"))


class SearchTest(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="charon-search-")
        write(self.root, "README.md", "# Charon\nthe needle is here\n")
        write(self.root, "src/app.ts", "const needle = 1\nexport { needle }\n")
        write(self.root, "src/other.ts", "nothing to see\n")
        write(self.root, "src/deep/nest.py", "NEEDLE = 'shouty'\n")
        write(self.root, "logo.png", b"\x89PNG\r\n\x1a\n\x00needle\x00")
        write(self.root, "node_modules/dep/index.js", "var needle = 2\n")

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def search(self, query, **kw):
        return F.fs_search(self.root, query, **kw)

    def test_text_search_finds_matches_and_locates_them(self):
        r = self.search("needle")
        self.assertTrue(r["ok"])
        paths = {f["path"] for f in r["files"]}
        self.assertIn("README.md", paths)
        self.assertIn("src/app.ts", paths)
        hit = next(f for f in r["files"] if f["path"] == "README.md")
        self.assertEqual(hit["matches"][0]["line"], 2)
        self.assertEqual(hit["matches"][0]["text"], "the needle is here")
        start, end = hit["matches"][0]["ranges"][0]
        self.assertEqual("the needle is here"[start:end], "needle")

    def test_case_insensitive_by_default_and_sensitive_on_demand(self):
        loose = {f["path"] for f in self.search("NEEDLE")["files"]}
        self.assertIn("README.md", loose)
        strict = {f["path"] for f in self.search("NEEDLE", case_sensitive=True)["files"]}
        self.assertEqual(strict, {"src/deep/nest.py"})

    def test_whole_word_and_regex(self):
        write(self.root, "src/word.ts", "needless\nneedle\n")
        lines = [m["line"] for f in self.search("needle", whole_word=True)["files"]
                 if f["path"] == "src/word.ts" for m in f["matches"]]
        self.assertEqual(lines, [2])
        r = self.search(r"need\w+", regex=True)
        self.assertTrue(r["total_matches"] > 0)

    def test_a_bad_regex_is_a_reason_not_a_crash(self):
        r = self.search("(unclosed", regex=True)
        self.assertFalse(r["ok"])
        self.assertEqual(r["reason"], "bad_query")
        self.assertIn("regular expression", r["error"])

    def test_binaries_are_skipped(self):
        # The PNG contains the literal bytes and must still never be returned:
        # a NUL in the first block is git's own heuristic for "not text".
        self.assertNotIn("logo.png", {f["path"] for f in self.search("needle")["files"]})

    def test_default_excludes_drop_dependency_folders(self):
        self.assertNotIn("node_modules/dep/index.js",
                         {f["path"] for f in self.search("needle")["files"]})
        self.assertIn("node_modules/dep/index.js",
                      {f["path"] for f in self.search("needle", use_default_excludes=False)["files"]})

    def test_include_and_exclude_globs(self):
        only = {f["path"] for f in self.search("needle", include="*.ts")["files"]}
        self.assertEqual(only, {"src/app.ts"})
        without = {f["path"] for f in self.search("needle", exclude="*.md")["files"]}
        self.assertNotIn("README.md", without)

    def test_file_mode_matches_paths_and_reads_nothing(self):
        r = self.search("app", mode="file")
        self.assertEqual(r["mode"], "file")
        self.assertEqual([f["path"] for f in r["files"]], ["src/app.ts"])
        self.assertEqual(r["files"][0]["matches"], [])
        # A path fragment has to work, not just a basename.
        self.assertIn("src/deep/nest.py",
                      {f["path"] for f in self.search("deep/", mode="file")["files"]})

    def test_an_empty_query_returns_nothing_rather_than_everything(self):
        r = self.search("")
        self.assertTrue(r["ok"])
        self.assertEqual(r["files"], [])

    def test_truncation_is_reported(self):
        write(self.root, "many.txt", "needle\n" * 50)
        r = self.search("needle", max_results=3)
        self.assertTrue(r["truncated"])
        self.assertLessEqual(r["total_matches"], 60)

    def test_long_lines_come_back_windowed_with_usable_offsets(self):
        write(self.root, "min.js", "x" * 900 + "needle" + "y" * 900 + "\n")
        m = next(f for f in self.search("needle")["files"] if f["path"] == "min.js")["matches"][0]
        self.assertLessEqual(len(m["text"]), F.SEARCH_LINE_CHARS)
        self.assertTrue(m["clipped"])
        start, end = m["ranges"][0]
        self.assertEqual(m["text"][start:end], "needle")

    def test_a_symlink_out_of_the_root_is_not_searched(self):
        outside = tempfile.mkdtemp(prefix="charon-outside-")
        try:
            write(outside, "secret.txt", "needle in the haystack\n")
            os.symlink(outside, os.path.join(self.root, "escape"))
            os.symlink(os.path.join(outside, "secret.txt"),
                       os.path.join(self.root, "secret-link.txt"))
            paths = {f["path"] for f in self.search("needle")["files"]}
            self.assertFalse([p for p in paths if p.startswith("escape")])
            self.assertNotIn("secret-link.txt", paths)
        finally:
            shutil.rmtree(outside, ignore_errors=True)

    def test_a_root_outside_the_filesystem_is_refused(self):
        r = F.fs_search(os.path.join(self.root, "does-not-exist"), "needle")
        self.assertFalse(r["ok"])
        self.assertEqual(r["reason"], "bad_path")


@unittest.skipUnless(HAS_GIT, "git not installed")
class GitIgnoreTest(unittest.TestCase):
    """In a repo, .gitignore IS the answer to 'what is mine' — so it decides."""

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="charon-search-git-")
        subprocess.run(["git", "init", "-q"], cwd=self.root, check=True)
        write(self.root, ".gitignore", "generated/\n*.log\n")
        write(self.root, "src/app.ts", "const needle = 1\n")
        write(self.root, "generated/big.ts", "const needle = 2\n")
        write(self.root, "debug.log", "needle\n")

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_gitignored_files_are_not_searched(self):
        r = F.fs_search(self.root, "needle")
        self.assertEqual(r.get("source"), "git")
        paths = {f["path"] for f in r["files"]}
        self.assertEqual(paths, {"src/app.ts"})

    def test_untracked_but_not_ignored_files_are_searched(self):
        # A file created five seconds ago and never added is exactly the file
        # someone searches for — being unknown to git must not hide it.
        write(self.root, "src/fresh.ts", "const needle = 3\n")
        paths = {f["path"] for f in F.fs_search(self.root, "needle")["files"]}
        self.assertIn("src/fresh.ts", paths)


@unittest.skipUnless(HAS_GIT, "git not installed")
class NestedRepoTest(unittest.TestCase):
    """A folder OF projects is a normal cwd here (/srv, /var/www — §14.83).

    This is the case that killed the first implementation: it enumerated with
    `git ls-files`, which does NOT descend into a nested checkout, so a search
    across a monorepo-of-repos returned the few files that happened to live
    outside the sub-repos and called that an answer.
    """

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="charon-search-nested-")
        write(self.root, "README.md", "needle at the top\n")
        for sub in ("front", "back"):
            d = os.path.join(self.root, sub)
            os.makedirs(d)
            subprocess.run(["git", "init", "-q"], cwd=d, check=True)
            write(self.root, f"{sub}/.gitignore", "dist/\n")
            write(self.root, f"{sub}/src/index.ts", "const needle = 1\n")
            write(self.root, f"{sub}/dist/index.js", "var needle = 2\n")

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_files_inside_nested_repos_are_found(self):
        paths = {f["path"] for f in F.fs_search(self.root, "needle")["files"]}
        self.assertIn("front/src/index.ts", paths)
        self.assertIn("back/src/index.ts", paths)
        self.assertIn("README.md", paths)

    def test_each_nested_repo_applies_its_own_gitignore(self):
        r = F.fs_search(self.root, "needle")
        self.assertEqual(r.get("source"), "git")
        paths = {f["path"] for f in r["files"]}
        self.assertNotIn("front/dist/index.js", paths)
        self.assertNotIn("back/dist/index.js", paths)


class StreamingTest(unittest.TestCase):
    """With a progress callback the hits leave as they are found (0.116.0)."""

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="charon-search-stream-")
        for i in range(120):
            write(self.root, f"d{i // 10}/f{i:03}.txt", "the needle\n" if i % 3 == 0 else "hay\n")

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def test_streamed_batches_add_up_to_the_whole_answer(self):
        batches = []
        r = F.fs_search(self.root, "needle", progress=batches.append)
        self.assertTrue(r["streamed"])
        self.assertEqual(r["files"], [])
        streamed = [f["path"] for b in batches for f in b["files"]]
        self.assertEqual(len(streamed), len(set(streamed)))
        whole = [f["path"] for f in F.fs_search(self.root, "needle")["files"]]
        self.assertEqual(sorted(streamed), whole)
        self.assertEqual(r["total_files"], len(whole))
        # The first hit is not held back for a batch to fill.
        first = next(b for b in batches if b["files"])
        self.assertEqual(len(first["files"]), 1)

    def test_a_cancelled_search_stops_and_says_so(self):
        import threading
        flag = threading.Event()

        def stop_after_first(batch):
            if batch["files"]:
                flag.set()

        r = F.fs_search(self.root, "needle", progress=stop_after_first, cancel=flag)
        self.assertTrue(r["cancelled"])
        self.assertTrue(r["truncated"])
        self.assertLess(r["total_files"], 40)

    def test_without_grep_the_answer_is_the_same(self):
        with_grep = [f["path"] for f in F.fs_search(self.root, "needle")["files"]]
        saved = F._grep_ok
        try:
            F._grep_ok = False
            without = [f["path"] for f in F.fs_search(self.root, "needle")["files"]]
        finally:
            F._grep_ok = saved
        self.assertEqual(with_grep, without)

    def test_a_grep_that_cannot_answer_hands_the_batch_to_python(self):
        real = F._grep_batch
        try:
            F._grep_batch = lambda *a, **k: None
            got = [f["path"] for f in F.fs_search(self.root, "needle")["files"]]
        finally:
            F._grep_batch = real
        self.assertEqual(len(got), 40)

    def test_accents_fold_without_the_byte_shortcut(self):
        write(self.root, "fr.txt", "Un ÉTÉ chaud\n")
        self.assertIn("fr.txt", {f["path"] for f in F.fs_search(self.root, "été")["files"]})
        self.assertNotIn("fr.txt", {f["path"] for f in F.fs_search(self.root, "été", case_sensitive=True)["files"]})

    def test_whole_word_still_decided_by_python(self):
        write(self.root, "w.txt", "needles\n")
        hits = {f["path"] for f in F.fs_search(self.root, "needle", whole_word=True)["files"]}
        self.assertNotIn("w.txt", hits)

    def test_pseudo_filesystems_are_never_walked(self):
        write(self.root, "proc/1/status", "the needle\n")
        saved = F.PSEUDO_FS_DIRS
        try:
            F.PSEUDO_FS_DIRS = frozenset({os.path.join(self.root, "proc")})
            paths = {f["path"] for f in F.fs_search(self.root, "needle")["files"]}
        finally:
            F.PSEUDO_FS_DIRS = saved
        self.assertFalse([p for p in paths if p.startswith("proc/")])


@unittest.skipUnless(HAS_GIT, "git not installed")
class GitListingTest(unittest.TestCase):
    """git lists each checkout (0.116.0): its rules, inside AND below it."""

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="charon-search-ls-")
        subprocess.run(["git", "init", "-q"], cwd=self.root, check=True)
        write(self.root, ".gitignore", "generated/\ndata/\n")
        write(self.root, "src/app.ts", "const needle = 1\n")
        write(self.root, "data/huge.csv", "needle\n")
        write(self.root, "generated/forced.js", "var needle = 3\n")
        subprocess.run(["git", "add", "-f", "generated/forced.js", "src/app.ts", ".gitignore"],
                       cwd=self.root, check=True)
        # A checkout inside the checkout, with rules of its own.
        inner = os.path.join(self.root, "vendored")
        os.makedirs(inner)
        subprocess.run(["git", "init", "-q"], cwd=inner, check=True)
        write(self.root, "vendored/.gitignore", "out/\n")
        write(self.root, "vendored/lib.ts", "export const needle = 4\n")
        write(self.root, "vendored/out/gen.js", "needle\n")

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)

    def paths(self, root=None, **kw):
        return {f["path"] for f in F.fs_search(root or self.root, "needle", **kw)["files"]}

    def test_ignored_folders_stay_out_and_tracked_files_in_them_stay_in(self):
        got = self.paths()
        self.assertIn("src/app.ts", got)
        self.assertNotIn("data/huge.csv", got)
        # Tracked despite the rule: git never applies ignore rules to it.
        self.assertIn("generated/forced.js", got)

    def test_a_nested_checkout_is_searched_with_its_own_rules(self):
        got = self.paths()
        self.assertIn("vendored/lib.ts", got)
        self.assertNotIn("vendored/out/gen.js", got)

    def test_a_subfolder_of_a_checkout_keeps_the_checkout_rules(self):
        write(self.root, "src/data/x.ts", "needle\n")
        r = F.fs_search(os.path.join(self.root, "src"), "needle")
        self.assertEqual(r["source"], "git")
        self.assertEqual({f["path"] for f in r["files"]}, {"app.ts"})

    def test_a_folder_the_checkout_ignores_is_searched_whole(self):
        # Opened on purpose (a folder tab on it): its checkout's rules would
        # leave nothing, since `git ls-files` lists nothing under an ignored
        # folder.
        write(self.root, "data/deep/more.csv", "needle\n")
        r = F.fs_search(os.path.join(self.root, "data"), "needle")
        self.assertEqual({f["path"] for f in r["files"]}, {"huge.csv", "deep/more.csv"})
        # Deeper than the ignored folder: every ancestor is asked about at
        # once — the case `check-ignore -q` refused (one path only).
        r = F.fs_search(os.path.join(self.root, "data", "deep"), "needle")
        self.assertEqual({f["path"] for f in r["files"]}, {"more.csv"})

    def test_a_root_git_lists_nothing_in_is_still_searched(self):
        # Whatever the reason the rules leave nothing (a `*` in a nested
        # .gitignore), the folder the user asked for is searched whole.
        write(self.root, "src/blob/.gitignore", "*\n")
        write(self.root, "src/blob/a.txt", "needle\n")
        r = F.fs_search(os.path.join(self.root, "src", "blob"), "needle")
        self.assertIn("a.txt", {f["path"] for f in r["files"]})

    def test_the_reader_hears_from_a_search_that_finds_nothing(self):
        for i in range(2500):
            write(self.root, f"src/many/f{i}.txt", "hay\n")
        beats = []
        saved = F.SEARCH_HEARTBEAT_S
        try:
            F.SEARCH_HEARTBEAT_S = 0.0  # every chance to beat is taken
            F.fs_search(self.root, "zzqq-nowhere", progress=beats.append)
        finally:
            F.SEARCH_HEARTBEAT_S = saved
        self.assertTrue(any(b["scanned"] > 0 and not b["files"] for b in beats))

    def test_a_checkout_git_refuses_is_walked_whole(self):
        real = F._git_listing
        try:
            F._git_listing = lambda path: None
            got = self.paths()
        finally:
            F._git_listing = real
        self.assertIn("data/huge.csv", got)  # no rules, but never fewer files


class ServerStreamTest(unittest.IsolatedAsyncioTestCase):
    """The daemon side: events to the asking client, ahead of the answer."""

    async def asyncSetUp(self):
        from pathlib import Path
        from charon_agent.server import Server
        self.tmp = tempfile.mkdtemp(prefix="charon-search-srv-")
        for i in range(30):
            write(self.tmp, f"t/f{i}.txt", "needle\n")
        self.server = Server(socket_path=Path(self.tmp) / "agent.sock",
                             state_path=Path(self.tmp) / "state.json")

    async def asyncTearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    async def test_progress_events_precede_the_answer_and_cancel_is_known(self):
        sent = []

        class FakeClient:
            def send_json(self, obj):
                sent.append(obj)

        result = await self.server._handle_meta_rpc("fs_search", {
            "root": os.path.join(self.tmp, "t"), "query": "needle", "stream_id": "s1",
        }, FakeClient())
        self.assertTrue(result["streamed"])
        events = [e for e in sent if e.get("event") == "fs_search_progress"]
        self.assertTrue(events)
        self.assertTrue(all(e["search_id"] == "s1" for e in events))
        self.assertEqual(sum(len(e["files"]) for e in events), 30)
        self.assertEqual(result["total_files"], 30)
        gone = await self.server._handle_meta_rpc("fs_search_cancel", {"search_id": "s1"}, FakeClient())
        self.assertEqual(gone, {"ok": True, "found": False})

    async def test_without_a_stream_id_the_answer_carries_the_files(self):
        result = await self.server._handle_meta_rpc("fs_search", {
            "root": os.path.join(self.tmp, "t"), "query": "needle",
        }, None)
        self.assertEqual(len(result["files"]), 30)
        self.assertNotIn("streamed", result)


if __name__ == "__main__":
    unittest.main(verbosity=2)
