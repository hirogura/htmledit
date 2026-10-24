"""gitcmd の並行実行に関するテスト."""

import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from htmledit import gitcmd  # noqa: E402


class ConcurrentGitTestCase(unittest.TestCase):
    def test_concurrent_commands_do_not_collide_on_index_lock(self):
        """add/commit/status を並行実行しても index.lock 競合で失敗しないこと.

        投稿パネルの「投稿・保存・Push」は status の取得と commit/push を
        ほぼ同時に発行するため、サーバーは並行して git コマンドを走らせる。
        """
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp) / "repo"
            repo.mkdir()
            self.assertTrue(gitcmd.run_git(["init", "-q"], cwd=repo).ok)
            self.assertTrue(gitcmd.run_git(["config", "user.email", "t@example.com"], cwd=repo).ok)
            self.assertTrue(gitcmd.run_git(["config", "user.name", "t"], cwd=repo).ok)

            errors: list[str] = []

            def worker(index: int) -> None:
                for round_ in range(10):
                    path = repo / f"f{index}-{round_}.txt"
                    try:
                        path.write_text("x", "utf-8")
                        add = gitcmd.run_git(["add", "-A"], cwd=repo)
                        if not add.ok:
                            errors.append(f"add: {add.stderr}")
                            return
                        commit = gitcmd.commit(repo, f"commit {index}-{round_}")
                        output = (commit.stderr or "") + (commit.stdout or "")
                        if not commit.ok and "nothing to commit" not in output:
                            errors.append(f"commit: {output}")
                            return
                        status = gitcmd.run_git(["status", "--porcelain=v1", "--branch"], cwd=repo)
                        if not status.ok:
                            errors.append(f"status: {status.stderr}")
                            return
                    except Exception as exc:  # noqa: BLE001 - そのまま収集して検証する
                        errors.append(str(exc))
                        return
                    finally:
                        path.unlink(missing_ok=True)

            threads = [threading.Thread(target=worker, args=(index,)) for index in range(6)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=60)

            self.assertEqual(errors, [])
            lock_errors = [error for error in errors if "index.lock" in error]
            self.assertEqual(lock_errors, [])


if __name__ == "__main__":
    unittest.main()
