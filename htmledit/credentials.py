"""サイトごとの認証情報 (ユーザーID / PAT) の保管.

`data/credentials.json` (権限 0600) に保存する。PAT は API の応答には
含めず、`hasToken` の有無だけを返す。
"""

from __future__ import annotations

import json
import os
import threading
from dataclasses import dataclass
from pathlib import Path

from .config import CONFIG

FILE_NAME = "credentials.json"


@dataclass
class Credential:
    """1 サイト分の認証情報."""

    username: str = ""
    token: str = ""

    @property
    def has_token(self) -> bool:
        return bool(self.token)

    def to_public(self) -> dict:
        """API 応答用の表現 (PAT は含めない)."""
        return {"username": self.username, "hasToken": self.has_token}

    def to_dict(self) -> dict:
        """保存用の表現."""
        return {"username": self.username, "token": self.token}

    @classmethod
    def from_dict(cls, data: dict) -> "Credential":
        return cls(
            username=str(data.get("username", "") or ""),
            token=str(data.get("token", "") or ""),
        )


class CredentialStore:
    """認証情報の保存と取得.

    スレッドセーフ。ファイルは排他ロックを取ったまま読み書きする。
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._sites: dict[str, Credential] = {}
        self._loaded_path: Path | None = None

    @property
    def path(self) -> Path:
        return CONFIG.data_dir / FILE_NAME

    # -- 内部処理 -------------------------------------------------------

    def _load(self) -> None:
        path = self.path
        if self._loaded_path == path:
            return
        self._sites = {}
        self._loaded_path = path
        try:
            raw = path.read_text("utf-8")
        except (FileNotFoundError, NotADirectoryError):
            return
        except OSError:
            return
        try:
            data = json.loads(raw)
        except json.JSONDecodeError:
            return
        if not isinstance(data, dict):
            return
        sites = data.get("sites")
        if not isinstance(sites, dict):
            return
        for site_id, item in sites.items():
            if isinstance(item, dict):
                self._sites[str(site_id)] = Credential.from_dict(item)

    def _save(self) -> None:
        path = self.path
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "sites": {
                site_id: cred.to_dict() for site_id, cred in sorted(self._sites.items())
            }
        }
        text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
        tmp = path.with_name(path.name + ".tmp")
        fd = os.open(str(tmp), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(text)
        except Exception:
            tmp.unlink(missing_ok=True)
            raise
        os.replace(tmp, path)
        os.chmod(path, 0o600)

    # -- 公開 API -------------------------------------------------------

    def get(self, site_id: str) -> Credential:
        """サイトに登録された認証情報を返す (未登録なら空の認証情報)."""
        with self._lock:
            self._load()
            current = self._sites.get(site_id, Credential())
            return Credential(username=current.username, token=current.token)

    def set(self, site_id: str, username: str = "", token: str = "") -> Credential:
        """認証情報を登録・更新する.

        空の値では既存の値を上書きしない (PAT を空欄にした場合は維持する)。
        """
        with self._lock:
            self._load()
            current = self._sites.get(site_id, Credential())
            updated = Credential(
                username=username or current.username,
                token=token or current.token,
            )
            self._sites[site_id] = updated
            self._save()
            return Credential(username=updated.username, token=updated.token)

    def delete(self, site_id: str) -> None:
        """サイトの認証情報を削除する."""
        with self._lock:
            self._load()
            if site_id in self._sites:
                del self._sites[site_id]
                self._save()

    def all(self) -> dict[str, Credential]:
        """すべての認証情報を返す."""
        with self._lock:
            self._load()
            return {
                site_id: Credential(username=cred.username, token=cred.token)
                for site_id, cred in self._sites.items()
            }


STORE = CredentialStore()
