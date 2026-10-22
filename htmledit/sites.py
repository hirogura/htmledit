"""サイトの管理(追加/削除/一覧)とファイル操作."""

from __future__ import annotations

import io
import json
import os
import re
import shutil
import threading
import time
import zipfile
from dataclasses import asdict, dataclass, field
from datetime import datetime
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


def create_file(site: Site, relative: str, content: str = "") -> dict:
    """新しいファイルを作成する."""
    target = resolve_path(site, relative)
    if target.exists():
        raise SiteError("すでに同じ名前が存在します。")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, "utf-8")
    return {"path": relative, "size": target.stat().st_size}


def create_folder(site: Site, relative: str) -> dict:
    """新しいフォルダを作成する."""
    target = resolve_path(site, relative)
    if target.exists():
        raise SiteError("すでに同じ名前が存在します。")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.mkdir(parents=True, exist_ok=True)
    return {"path": relative}


def rename(site: Site, source: str, destination: str) -> dict:
    """ファイル / フォルダの名前を変更する (同じフォルダ内のみ)."""
    src = resolve_path(site, source)
    dst = resolve_path(site, destination)
    if not src.exists():
        raise SiteError(f"ファイルが見つかりません: {source}")
    if dst.exists():
        raise SiteError("すでに同じ名前が存在します。")
    if dst.parent != src.parent:
        raise SiteError("同じフォルダ内だけで名前を変更できます。")
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), str(dst))
    return {"from": source, "path": destination}


def remove(site: Site, relative: str) -> dict:
    """ファイル / フォルダを削除する (サイトルートは削除できない)."""
    target = resolve_path(site, relative)
    root = Path(os.path.realpath(site.path))
    if target == root:
        raise SiteError("サイトのルートは削除できません。")
    if not target.exists():
        raise SiteError(f"ファイルが見つかりません: {relative}")
    if target.is_dir():
        shutil.rmtree(target)
    else:
        target.unlink()
    return {"path": relative}


def sanitize_upload_name(name: str) -> str:
    """アップロードされたファイル名を安全な名前に変換する."""
    base = os.path.basename((name or "").replace("\\", "/")).strip()
    base = re.sub(r"[^A-Za-z0-9._-]+", "_", base)
    base = re.sub(r"^\.+", "", base).strip()
    return base or "file"


def upload_file(site: Site, directory: str, filename: str, data: bytes) -> dict:
    """アップロードされたファイルを指定フォルダへ保存する (エクスプローラ用)."""
    if not data:
        raise SiteError("ファイルデータが空です。")
    base = resolve_path(site, directory) if (directory or "").strip() else Path(site.path)
    base.mkdir(parents=True, exist_ok=True)
    name = sanitize_upload_name(filename)
    target = base / name
    index = 1
    while target.exists():
        target = base / f"{Path(name).stem}-{index}{Path(name).suffix}"
        index += 1
    target.write_bytes(data)
    root = Path(os.path.realpath(site.path))
    return {"path": target.relative_to(root).as_posix(), "size": len(data)}


def archive_folder(site: Site, relative: str) -> tuple[bytes, str]:
    """フォルダを ZIP に固める (ダウンロード用)."""
    source = resolve_path(site, relative)
    if not source.is_dir():
        raise SiteError("フォルダが見つかりません。")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for item in sorted(source.rglob("*")):
            if item.is_dir():
                continue
            archive.write(item, Path(item.relative_to(source)).as_posix())
    return buffer.getvalue(), (source.name or "site") + ".zip"


def is_html(path: str) -> bool:
    return Path(path).suffix.lower() in (".html", ".htm", ".xhtml")


IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif", ".bmp", ".ico"}


def asset_dir(prefix: str = "public/images", when: float | None = None) -> str:
    """画像を保存する日付付きフォルダ (例: public/images/2026/10/22)."""
    stamp = time.localtime(when if when is not None else time.time())
    return f"{prefix}/{stamp.tm_year:04d}/{stamp.tm_mon:02d}/{stamp.tm_mday:02d}"


def sanitize_image_name(name: str) -> str:
    """アップロードされたファイル名を安全な名前に変換する."""
    base = os.path.basename((name or "").replace("\\", "/")).strip()
    base = re.sub(r"[^A-Za-z0-9._-]+", "_", base)
    stem, ext = os.path.splitext(base)
    stem = re.sub(r"_{2,}", "_", stem).strip("_")
    base = (stem or "image") + ext
    if Path(base).suffix.lower() not in IMAGE_EXTENSIONS:
        base += ".png"
    return base


def _unique_path(root: Path, relative: str) -> Path:
    """同名が既にある場合は連番を付けたパス返す."""
    target = root / relative
    if not target.exists():
        return target
    stem, suffix = target.stem, target.suffix
    index = 1
    while target.exists():
        target = target.with_name(f"{stem}-{index}{suffix}")
        index += 1
    return target


def _reference(root: Path, target: Path, page: str) -> str:
    """HTML ファイルからの相対パスを返す."""
    target_rel = target.relative_to(root).as_posix()
    if not page:
        return target_rel
    page_rel = page.strip().lstrip("/")
    page_dir = os.path.dirname(page_rel) or "."
    return os.path.relpath(target_rel, page_dir).replace(os.sep, "/")


def copy_asset(site: Site, source: str, target: str = "", page: str = "") -> dict:
    """サイト内の画像ファイルを日付付きフォルダへコピーし、HTML からの相対パスを返す."""
    source_path = resolve_path(site, source)
    if not source_path.is_file():
        raise SiteError(f"ファイルが見つかりません: {source}")

    root = Path(os.path.realpath(site.path))
    name = sanitize_image_name(os.path.basename(source_path.name))
    folder = target.strip().lstrip("/") if target.strip() else asset_dir()
    relative = f"{folder}/{name}"
    target_path = _unique_path(root, relative)

    target_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source_path, target_path)
    return {
        "path": target_path.relative_to(root).as_posix(),
        "reference": _reference(root, target_path, page),
        "size": target_path.stat().st_size,
    }


def save_upload(site: Site, filename: str, data: bytes, page: str = "") -> dict:
    """アップロードされた画像バイト列を日付付きフォルダへ保存する."""
    if not data:
        raise SiteError("画像データが空です。")
    root = Path(os.path.realpath(site.path))
    name = sanitize_image_name(filename)
    relative = f"{asset_dir()}/{name}"
    target_path = _unique_path(root, relative)

    target_path.parent.mkdir(parents=True, exist_ok=True)
    target_path.write_bytes(data)
    return {
        "path": target_path.relative_to(root).as_posix(),
        "reference": _reference(root, target_path, page),
        "size": len(data),
    }


def list_images(site: Site, prefix: str = "public/images", page: str = "") -> list[dict]:
    """指定フォルダ以下の画像を保存日の新しい順に返す (サムネイル用)."""
    root = Path(os.path.realpath(site.path))
    folder = resolve_path(site, prefix)
    if not folder.is_dir():
        return []

    found: list[tuple[float, str, dict]] = []
    for target in folder.rglob("*"):
        if not target.is_file() or target.suffix.lower() not in IMAGE_EXTENSIONS:
            continue
        try:
            stat = target.stat()
            relative = target.relative_to(root).as_posix()
        except (OSError, ValueError):
            continue
        found.append(
            (
                stat.st_mtime,
                relative,
                {
                    "name": target.name,
                    "path": relative,
                    "reference": _reference(root, target, page),
                    "size": stat.st_size,
                    "modified": datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds"),
                },
            )
        )
    # 保存日 (更新日時) の新しい順に並べる
    found.sort(key=lambda item: (item[0], item[1]), reverse=True)
    return [item[2] for item in found]
