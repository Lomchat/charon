"""Selection guards for the independently managed Codex CLI."""

import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from charon_agent.codex_session import _external_codex_bin  # noqa: E402


class TestCodexCliSelection(unittest.TestCase):
    def _launcher(self, directory: str, *, ok: bool) -> str:
        path = Path(directory) / "codex"
        path.write_text(
            "#!/bin/sh\n"
            + ("echo 'codex-cli 0.147.0'\n" if ok else "exit 9\n"),
            encoding="utf-8",
        )
        path.chmod(path.stat().st_mode | stat.S_IXUSR)
        return str(path)

    def test_explicit_working_cli_is_selected(self):
        with tempfile.TemporaryDirectory() as tmp:
            launcher = self._launcher(tmp, ok=True)
            with patch.dict(os.environ, {"CHARON_CODEX_BIN": launcher}):
                self.assertEqual(_external_codex_bin(), launcher)

    def test_unusable_cli_is_not_selected(self):
        with tempfile.TemporaryDirectory() as tmp:
            launcher = self._launcher(tmp, ok=False)
            with patch.dict(os.environ, {"CHARON_CODEX_BIN": launcher}):
                self.assertNotEqual(_external_codex_bin(), launcher)


if __name__ == "__main__":
    unittest.main()
