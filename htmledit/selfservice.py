"""htmledit 自身のアップデートと再起動."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

from . import gitcmd
from .config import APP_ROOT, CONFIG

RESTART_DELAY = 2.0


class SelfServiceError(RuntimeError):
    """アップデート/再起動処理のエラー."""


def _repo_root() -> Path:
    if gitcmd.is_git_repo(APP_ROOT):
        return APP_ROOT
    raise SelfServiceError("htmledit のインストール先が git リポジトリではありません。")


def _target_branch() -> str:
    if CONFIG.branch:
        return CONFIG.branch
    branch = gitcmd.current_branch(APP_ROOT)
    return branch or "main"


def repository_state() -> dict:
    """htmledit 自身のリポジトリ状態."""
    root = _repo_root()
    branch = gitcmd.current_branch(root)
    remote = gitcmd.remote_url(root)
    last = gitcmd.get_last_commit(root)
    return {
        "repoUrl": CONFIG.repo_url,
        "remote": remote,
        "branch": branch,
        "lastCommit": last,
        "dirty": gitcmd.run_git(["status", "--porcelain"], cwd=root).out,
    }


def update() -> dict:
    """GitHub から htmledit 自身を最新化する."""
    root = _repo_root()
    branch = _target_branch()
    remote = gitcmd.remote_url(root)
    if not remote:
        raise SelfServiceError("origin リモートが設定されていません。")

    before = gitcmd.get_last_commit(root)
    fetch = gitcmd.fetch(root)
    if not fetch.ok:
        raise SelfServiceError(f"fetch に失敗しました: {fetch.stderr.strip() or fetch.stdout.strip()}")

    rev = gitcmd.run_git(["rev-parse", f"origin/{branch}"], cwd=root)
    if not rev.ok:
        raise SelfServiceError(f"origin/{branch} を取得できませんでした。")
    remote_hash = rev.out

    local = gitcmd.run_git(["rev-parse", "HEAD"], cwd=root)
    local_hash = local.out if local.ok else ""

    if remote_hash == local_hash:
        return {
            "updated": False,
            "message": "すでに最新です。",
            "branch": branch,
            "before": before,
            "after": gitcmd.get_last_commit(root),
        }

    merge = gitcmd.run_git(["merge", "--ff-only", f"origin/{branch}"], cwd=root)
    if not merge.ok:
        raise SelfServiceError(
            f".fast-forward アップデートに失敗しました(ローカルの変更が残っている可能性があります): "
            f"{(merge.stderr or merge.stdout).strip()}"
        )

    return {
        "updated": True,
        "message": f"{before.get('shortHash', '')} -> {gitcmd.get_last_commit(root).get('shortHash', '')} に更新しました。",
        "branch": branch,
        "before": before,
        "after": gitcmd.get_last_commit(root),
    }


def _restart_with_systemd() -> bool:
    if not shutil.which("systemctl"):
        return False
    unit = CONFIG.service_name
    check = subprocess.run(
        ["systemctl", "cat", f"{unit}.service"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if check.returncode != 0:
        return False
    subprocess.Popen(
        ["systemctl", "restart", f"{unit}.service"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    return True


def _restart_with_reexec() -> bool:
    env = os.environ.copy()
    env["PYTHONPATH"] = os.pathsep.join(
        [str(APP_ROOT)] + ([env["PYTHONPATH"]] if env.get("PYTHONPATH") else [])
    )
    try:
        os.execve(sys.executable, [sys.executable, "-m", "htmledit"], env)
    except OSError:
        return False
    return True


def restart() -> dict:
    """htmledit サービスを再起動する(レスポンス送信後に実行)."""

    def worker() -> None:
        time.sleep(RESTART_DELAY)
        try:
            if not _restart_with_systemd():
                _restart_with_reexec()
        except Exception:  # pragma: no cover - 再起動失敗は黙って無視
            pass

    threading.Thread(target=worker, name="htmledit-restart", daemon=True).start()
    return {"restarting": True, "service": CONFIG.service_name, "delay": RESTART_DELAY}
