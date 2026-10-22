"""アプリケーション設定.

環境変数で上書きできる。設定値は data/ 配下に保存される。
"""

from __future__ import annotations

import os
from pathlib import Path

APP_ROOT = Path(__file__).resolve().parent.parent
STATIC_DIR = APP_ROOT / "static"
DEFAULT_REPO_URL = "https://github.com/hirogura/htmledit.git"

_FALSE_VALUES = {"0", "false", "no", "off", ""}


def _env(name: str, default: str = "") -> str:
    value = os.environ.get(name)
    if value is None or value == "":
        return default
    return value


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() not in _FALSE_VALUES


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError:
        return default


class Config:
    """実行時の設定."""

    def __init__(self) -> None:
        self.reload()

    def reload(self) -> "Config":
        self.host = _env("HTMLEDIT_HOST", "0.0.0.0")
        self.port = _env_int("HTMLEDIT_PORT", 3372)
        self.data_dir = Path(_env("HTMLEDIT_DATA_DIR", str(APP_ROOT / "data"))).expanduser()
        self.sites_file = self.data_dir / "sites.json"
        self.repos_dir = self.data_dir / "repos"
        self.repo_url = _env("HTMLEDIT_REPO_URL", DEFAULT_REPO_URL)
        self.branch = _env("HTMLEDIT_BRANCH", "")
        self.github_token = _env("GITHUB_TOKEN") or _env("HTMLEDIT_GITHUB_TOKEN")
        self.service_name = _env("HTMLEDIT_SERVICE_NAME", "htmledit")
        self.public_url = _env("HTMLEDIT_PUBLIC_URL", "")
        self.auth_user = _env("HTMLEDIT_AUTH_USER")
        self.auth_password = _env("HTMLEDIT_AUTH_PASSWORD")
        self.commit_user_name = _env("HTMLEDIT_COMMIT_USER_NAME", "htmledit")
        self.commit_user_email = _env("HTMLEDIT_COMMIT_USER_EMAIL", "htmledit@localhost")
        self.allow_local_paths = _env_bool("HTMLEDIT_ALLOW_LOCAL_PATHS", True)
        self.git_timeout = _env_int("HTMLEDIT_GIT_TIMEOUT", 180)
        self.max_file_size = _env_int("HTMLEDIT_MAX_FILE_SIZE", 8 * 1024 * 1024)
        return self

    def ensure_dirs(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.repos_dir.mkdir(parents=True, exist_ok=True)


CONFIG = Config()
