"""ターミナル (PTY) と opencode の管理.

- ブラウザの xterm.js と WebSocket で接続し、bash を PTY 上で動かす
- opencode が未インストールならインストールする
"""

from __future__ import annotations

import json
import os
import pty
import shlex
import shutil
import signal
import subprocess
import threading
import time
from pathlib import Path

from . import websocket
from .config import APP_ROOT, CONFIG

TERMINAL_WELCOME = (
    "\r\n\x1b[90m— htmledit terminal (opencode も使えます) —\x1b[0m\r\n"
)

INSTALL_COMMAND = "curl -fsSL https://opencode.ai/install | bash"
OPENCODE_BIN = "opencode"


def _candidate_paths() -> list[str]:
    home = os.path.expanduser("~")
    return [
        str(Path(home) / ".opencode" / "bin" / "opencode"),
        "/usr/local/bin/opencode",
        "/usr/bin/opencode",
    ]


def find_opencode() -> str | None:
    """opencode の実体パスを探す."""
    found = shutil.which(OPENCODE_BIN, path=terminal_env()["PATH"])
    if found:
        return found
    for candidate in _candidate_paths():
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def terminal_env() -> dict[str, str]:
    """ターミナル (および opencode) に渡す環境変数."""
    env = os.environ.copy()
    home = os.path.expanduser("~")
    extra = [
        str(Path(home) / ".opencode" / "bin"),
        str(Path(home) / ".local" / "bin"),
        "/usr/local/bin",
    ]
    paths = [item for item in extra if os.path.isdir(item)]
    current = env.get("PATH", "/usr/local/bin:/usr/bin:/bin")
    env["PATH"] = ":".join(paths + [current])
    env["TERM"] = "xterm-256color"
    env["COLORTERM"] = "truecolor"
    if not env.get("HOME"):
        env["HOME"] = home
    return env


class TerminalSession:
    """1 つのセッション (PTY).

    command を指定すると bash ではなくそのコマンドを直接起動する
    (selfcode と同じ方式。TUI は PTY の子プロセスである方が安定する)。
    """

    def __init__(self, session_id: str, cwd: str, cols: int = 120, rows: int = 35, command: str = "") -> None:
        self.id = session_id
        self.cwd = cwd
        self.command = command
        self.cols = cols
        self.rows = rows
        self.buffer = ""
        self.lock = threading.RLock()
        self.master_fd, slave_fd = pty.openpty()
        websocket.set_window_size(self.master_fd, cols, rows)
        if command:
            parts = shlex.split(command)
            binary = parts[0]
            args = parts[1:]
            env = terminal_env()
        else:
            shell = shutil.which("bash") or "/bin/sh"
            binary = shell
            args = ["-i"]
            env = terminal_env()
        self.process = subprocess.Popen(
            [binary, *args],
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            cwd=cwd,
            env=env,
            start_new_session=True,
            close_fds=True,
        )
        os.close(slave_fd)
        self._alive = True

    def write(self, data: str) -> None:
        if not self._alive:
            return
        with self.lock:
            try:
                os.write(self.master_fd, data.encode("utf-8", "replace"))
            except OSError:
                self._alive = False

    def resize(self, cols: int, rows: int) -> None:
        self.cols = max(20, int(cols))
        self.rows = max(5, int(rows))
        with self.lock:
            websocket.set_window_size(self.master_fd, self.cols, self.rows)

    def read(self, size: int = 65536) -> bytes:
        return os.read(self.master_fd, size)

    def close(self) -> None:
        self._alive = False
        try:
            os.close(self.master_fd)
        except OSError:
            pass
        try:
            if self.process.poll() is None:
                os.killpg(os.getpgid(self.process.pid), signal.SIGHUP)
        except (OSError, ProcessLookupError):
            pass


class TerminalManager:
    """セッション ID ごとのターミナルを保持する."""

    def __init__(self) -> None:
        self._sessions: dict[str, TerminalSession] = {}
        self._lock = threading.RLock()

    def get(self, session_id: str, cwd: str, command: str = "") -> TerminalSession:
        with self._lock:
            session = self._sessions.get(session_id)
            if session is not None and session.process.poll() is None:
                if session.cwd == cwd and session.command == command:
                    return session
                # ディレクトリやコマンドが変わったら作り直す (selfcode と同じ挙動)
                session.close()
            session = TerminalSession(session_id, cwd, command=command)
            self._sessions[session_id] = session
            return session

    def close(self, session_id: str) -> None:
        with self._lock:
            session = self._sessions.pop(session_id, None)
        if session:
            session.close()

    def close_all(self) -> None:
        with self._lock:
            sessions = list(self._sessions.values())
            self._sessions.clear()
        for session in sessions:
            session.close()


TERMINALS = TerminalManager()


class OpencodeManager:
    """opencode のインストール状況とインストール処理."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._installing = False
        self._log: list[str] = []
        self._installed_at: float = 0.0

    def status(self) -> dict:
        path = find_opencode()
        with self._lock:
            return {
                "installed": bool(path),
                "path": path or "",
                "installing": self._installing,
                "log": self._log[-40:],
                "installedAt": self._installed_at,
            }

    def install(self) -> dict:
        with self._lock:
            if self._installing:
                return self.status()
            self._installing = True
            self._log = ["インストールを開始します..."]
        threading.Thread(target=self._run_install, name="opencode-install", daemon=True).start()
        return self.status()

    def _run_install(self) -> None:
        try:
            proc = subprocess.Popen(
                ["/bin/sh", "-c", INSTALL_COMMAND],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                env=terminal_env(),
                cwd=str(APP_ROOT),
                text=True,
                bufsize=1,
            )
            assert proc.stdout is not None
            for line in proc.stdout:
                with self._lock:
                    self._log.append(line.rstrip())
                    self._log = self._log[-200:]
            proc.wait()
            with self._lock:
                if proc.returncode == 0:
                    self._log.append("インストールが完了しました。")
                else:
                    self._log.append(f"インストールに失敗しました (code={proc.returncode})")
        except Exception as exc:  # pragma: no cover - 想定外
            with self._lock:
                self._log.append(f"インストールに失敗しました: {exc}")
        finally:
            with self._lock:
                self._installing = False
                if find_opencode():
                    self._installed_at = time.time()

    def wait_for_ready(self, timeout: float = 120.0) -> str | None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            path = find_opencode()
            if path:
                return path
            time.sleep(1.0)
        return None


OPENCODE = OpencodeManager()
