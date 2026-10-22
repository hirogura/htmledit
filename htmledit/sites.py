"""サイトの管理(追加/削除/一覧)とファイル操作."""

from __future__ import annotations

import json
import os
import re
import shutil
import threading
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from urllib.parse import unquote, urlsplit

from . import gitcmd
from .config import CONFIG

_SLUG_RE = re.compile(r"[^a-zA-Z0-9._-]+")


class SiteError(RuntimeError):
    """サイト操作のエラー."""


@dataclass
class RepoRef:
    url: str
    owner: str = ""
    repo: str = ""
    branch: str = ""
    host: str = ""
    is_github: bool = False
    is_local: bool = False

    @property
    def slug(self) -> str:
        base = f"{self.owner}-{self.repo}" if self.owner else self.repo
        return base or "repo"


@dataclass
class Site:
    id: str
    name: str
    url: str
    path: str
    owner: str = ""
    repo: str = ""
    branch: str = ""
    created_at: float = field(default_factory=time.time)

    def to_dict(self) -> dict:
        data = asdict(self)
        data["hasLocal"] = os.path.isdir(self.path)
        return data


def _strip_git_suffix(value: str) -> str:
    return value[:-4] if value.endswith(".git") else value


def _split_path_parts(path: str) -> list[str]:
    return [unquote(part) for part in path.strip("/").split("/") if part]


def parse_repo_url(raw: str) -> RepoRef:
    """GitHub / Git / SSH / ローカルパスの URL を解析する."""
    text = (raw or "").strip()
    if not text:
        raise SiteError("リポジトリの URL を入力してください。")

    # ローカルパス
    if text.startswith(("/", "./", "../", "~")) or os.path.isdir(os.path.expanduser(text)):
        path = str(Path(os.path.expanduser(text)).resolve())
        if not os.path.isdir(path):
            raise SiteError(f"ローカルリポジトリが見つかりません: {path}")
        ref = RepoRef(url=path, repo=_strip_git_suffix(Path(path).name), is_local=True)
        return ref

    host = ""
    path = ""
    is_scp = False
    if re.match(r"^[\w.+-]+@[\w.-]+:", text):  # git@github.com:owner/repo.git
        is_scp = True
        _, _, remainder = text.partition("@")
        host, _, path = remainder.partition(":")
    elif "://" in text:
        split = urlsplit(text)
        host = split.hostname or ""
        path = split.path
    else:
        raise SiteError(f"URL の形式を解釈できません: {text}")

    parts = _split_path_parts(path)
    if not parts:
        raise SiteError(f"URL にリポジトリが含まれていません: {text}")

    is_github = host.lower() in ("github.com", "www.github.com")
    branch = ""
    url = text
    if is_github:
        # https://github.com/owner/repo/tree/branch 形式からブランチを取り出す
        if len(parts) >= 4 and parts[2] in ("tree", "blob"):
            branch = parts[3]
            parts = parts[:2]
        if len(parts) >= 2:
            owner, repo = parts[0], _strip_git_suffix(parts[1])
            if not is_scp:
                url = f"https://github.com/{owner}/{repo}.git"
        else:
            owner, repo = "", _strip_git_suffix(parts[0])
    elif len(parts) >= 2:
        owner, repo = parts[0], _strip_git_suffix(parts[1])
    else:
        owner, repo = "", _strip_git_suffix(parts[0])

    return RepoRef(
        url=url,
        owner=owner,
        repo=repo,
        branch=branch,
        host=host.lower(),
        is_github=is_github,
    )


class SiteRegistry:
    """sites.json に登録済みサイトを保存する."""

    def __init__(self, path: Path | None = None) -> None:
        self._path_override = path
        self._lock = threading.RLock()
        self._sites: dict[str, Site] = {}
        self.load()

    @property
    def path(self) -> Path:
        """保存先のパス (設定変更に追従する)."""
        return self._path_override or CONFIG.sites_file

    def load(self) -> None:
        with self._lock:
            self._sites = {}
            if not self.path.exists():
                return
            try:
                raw = json.loads(self.path.read_text("utf-8"))
            except (OSError, json.JSONDecodeError):
                return
            for item in raw.get("sites", []):
                try:
                    site = Site(
                        id=item["id"],
                        name=item.get("name") or item["id"],
                        url=item["url"],
                        path=item["path"],
                        owner=item.get("owner", ""),
                        repo=item.get("repo", ""),
                        branch=item.get("branch", ""),
                        created_at=item.get("created_at", time.time()),
                    )
                except KeyError:
                    continue
                self._sites[site.id] = site

    def save(self) -> None:
        with self._lock:
            CONFIG.ensure_dirs()
            payload = {"sites": [site.to_dict() for site in self._sites.values()]}
            tmp = self.path.with_suffix(".tmp")
            tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), "utf-8")
            os.replace(tmp, self.path)

    def list(self) -> list[Site]:
        with self._lock:
            return sorted(self._sites.values(), key=lambda site: site.created_at)

    def get(self, site_id: str) -> Site:
        with self._lock:
            site = self._sites.get(site_id)
        if site is None:
            raise SiteError(f"サイトが見つかりません: {site_id}")
        return site

    def _unique_id(self, base: str) -> str:
        slug = _SLUG_RE.sub("-", base).strip("-.") or "site"
        candidate = slug
        index = 2
        with self._lock:
            while candidate in self._sites:
                candidate = f"{slug}-{index}"
                index += 1
        return candidate

    def add(self, url: str, branch: str = "", name: str = "", auth: gitcmd.Auth | None = None) -> Site:
        ref = parse_repo_url(url)
        branch = branch or ref.branch or ""
        site_id = self._unique_id(ref.slug)
        dest = CONFIG.repos_dir / site_id
        CONFIG.ensure_dirs()

        if dest.exists() and gitcmd.is_git_repo(dest):
            gitcmd.set_remote_url(dest, ref.url)
        else:
            if dest.exists():
                shutil.rmtree(dest)
            result = gitcmd.clone(ref.url, dest, branch=branch, auth=auth)
            if not result.ok:
                message = (result.stderr or result.stdout).strip()
                if auth is not None and auth.token and ("Authentication failed" in message or "could not read Username" in message):
                    message = "認証に失敗しました。ユーザーID と PAT を確認してください。\n" + message
                raise SiteError(f"clone に失敗しました: {message}")

        gitcmd.ensure_identity(dest)
        current = gitcmd.current_branch(dest)
        site = Site(
            id=site_id,
            name=name or (f"{ref.owner}/{ref.repo}" if ref.owner else ref.repo),
            url=ref.url,
            path=str(dest),
            owner=ref.owner,
            repo=ref.repo,
            branch=current or branch,
        )
        with self._lock:
            self._sites[site.id] = site
        self.save()
        return site

    def remove(self, site_id: str, delete_clone: bool = True) -> Site:
        site = self.get(site_id)
        with self._lock:
            self._sites.pop(site_id, None)
        self.save()
        if delete_clone:
            path = Path(site.path)
            if path.exists() and str(path).startswith(str(CONFIG.repos_dir)):
                shutil.rmtree(path, ignore_errors=True)
        return site

    def rename(self, site_id: str, name: str) -> Site:
        site = self.get(site_id)
        site.name = name.strip() or site.name
        self.save()
        return site


REGISTRY = SiteRegistry()


# --------------------------------------------------------------------------
# ファイル操作
# --------------------------------------------------------------------------

def resolve_path(site: Site, relative: str) -> Path:
    """サイト配下の相対パスを解決し、ルート外へ出る場合は例外."""
    relative = (relative or "").strip().lstrip("/")
    if not relative:
        return Path(site.path)
    root = Path(os.path.realpath(site.path))
    target = Path(os.path.realpath(Path(root / relative)))
    if target != root and root not in target.parents:
        raise SiteError("サイト配下のパス以外にはアクセスできません。")
    return target


def build_tree(site: Site) -> list[dict]:
    """サイトルートを基準としたフォルダ/ファイル一覧."""
    root = Path(site.path)
    entries: list[dict] = []

    def walk(directory: Path, relative: str) -> None:
        try:
            items = sorted(directory.iterdir(), key=lambda item: (item.is_file(), item.name.lower()))
        except OSError:
            return
        for item in items:
            if item.name == ".git" and directory == root:
                continue
            child_rel = f"{relative}/{item.name}" if relative else item.name
            if item.is_dir():
                entries.append({"type": "dir", "name": item.name, "path": child_rel})
                walk(item, child_rel)
            elif item.is_file():
                try:
                    size = item.stat().st_size
                except OSError:
                    size = 0
                entries.append(
                    {
                        "type": "file",
                        "name": item.name,
                        "path": child_rel,
                        "size": size,
                        "ext": item.suffix.lower().lstrip("."),
                    }
                )

    walk(root, "")
    return entries


def read_file(site: Site, relative: str) -> dict:
    target = resolve_path(site, relative)
    if not target.exists() or not target.is_file():
        raise SiteError(f"ファイルが見つかりません: {relative}")
    size = target.stat().st_size
    if size > CONFIG.max_file_size:
        raise SiteError("ファイルが大きすぎます。")
    raw = target.read_bytes()
    try:
        content = raw.decode("utf-8")
        encoding = "utf-8"
    except UnicodeDecodeError:
        content = raw.decode("utf-8", "replace")
        encoding = "binary"
    return {"path": relative, "content": content, "encoding": encoding, "size": size}


def write_file(site: Site, relative: str, content: str) -> dict:
    target = resolve_path(site, relative)
    if target.is_dir():
        raise SiteError("ディレクトリには保存できません。")
    target.parent.mkdir(parents=True, exist_ok=True)
    if not content.endswith("\n"):
        content += "\n"
    target.write_text(content, "utf-8")
    return {"path": relative, "size": target.stat().st_size}


def is_html(path: str) -> bool:
    return Path(path).suffix.lower() in (".html", ".htm", ".xhtml")
