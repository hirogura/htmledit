"""パッケージの配布完整性テスト.

ソースコードが git に追跡されていること (`.gitignore` による取りこぼしの防止)
と、パッケージ内のすべてのモジュールが読み込めることを確認する。

実行: python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import importlib
import subprocess
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PACKAGE = ROOT / "htmledit"

sys.path.insert(0, str(ROOT))


class PackageTestCase(unittest.TestCase):
    def test_all_modules_are_importable(self):
        for path in sorted(PACKAGE.glob("*.py")):
            name = "htmledit" if path.name == "__init__.py" else f"htmledit.{path.stem}"
            with self.subTest(module=name):
                importlib.import_module(name)

    def test_sources_are_tracked_by_git(self):
        """ソースが .gitignore で除外されていないことを確認する.

        除外されると新規クローンでモジュールが欠けて起動に失敗する。
        """
        try:
            result = subprocess.run(
                ["git", "ls-files", "htmledit"],
                cwd=str(ROOT),
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                check=True,
                text=True,
            )
        except (OSError, subprocess.CalledProcessError):
            self.skipTest("git が利用できないためスキップします")

        tracked = {line.strip() for line in result.stdout.splitlines() if line.strip()}
        for path in sorted(PACKAGE.glob("*.py")):
            rel = path.relative_to(ROOT).as_posix()
            with self.subTest(path=rel):
                self.assertIn(rel, tracked, f"{rel} が git に追跡されていません (.gitignore を確認)")


if __name__ == "__main__":
    unittest.main()
