"""メモディレクトリ (ファイルエクスプローラー) の管理.

selfcode のサイドバーと同じく、メモの保存先をディレクトリ単位で扱い、
ファイル / フォルダの作成・リネーム・削除・アップロード・ダウンロードに対応する。
"""

from __future__ import annotations

import io
import os
import re
import shutil
import zipfile
from pathlib import Path

from .config import CONFIG


class MemoError(RuntimeError):
    """メモ操作のエラー."""


def root() -> Path:
    """メモのルートディレクトリ (存在しなければ作る)."""
    target = CONFIG.memo_dir
    target.mkdir(parents=True, exist_ok=True)
    return Path(os.path.realpath(target))



def resolve(relative: str, allow_root: bool = False) -> Path:
    """メモ配下の相対パスを解決し、ルート外へ出る場合は例外."""
    relative = (relative or "").strip().strip("/")
    base = root()
    if not relative:
        if allow_root:
            return base
        raise MemoError("パスを指定してください。")
    target = Path(os.path.realpath(base / relative))
    if target != base and base not in target.parents:
        raise MemoError("メモ配下のパス以外にはアクセスできません。")
    return target


def sanitize_name(name: str) -> str:
    """アップロードされたファイル名を安全な名前に変換する."""
    base = os.path.basename((name or "").replace("\\", "/")).strip()
    base = re.sub(r"[^A-Za-z0-9._-]+", "_", base)
    base = re.sub(r"^\.+", "", base).strip()
    return base or "file"


def default_file() -> str:
    """既定のメモファイルをルートからの相対パスで返す."""
    base = root()
    target = Path(os.path.realpath(CONFIG.memo_file))
    if target == base:
        return ""
    try:
        return target.relative_to(base).as_posix()
    except ValueError:
        return "memo.md"


def ensure_default_file() -> str:
    """既定のメモファイルがなければ空ファイルとして用意する."""
    relative = default_file()
    if not relative:
        return ""
    target = resolve(relative)
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("", "utf-8")
    return relative


def build_tree() -> list[dict]:
    """メモディレクトリを基準としたフォルダ/ファイル一覧."""
    base = root()
    entries: list[dict] = []

    def walk(directory: Path, relative: str) -> None:
        try:
            items = sorted(directory.iterdir(), key=lambda item: (item.is_file(), item.name.lower()))
        except OSError:
            return
        for item in items:
            if item.name.startswith("."):
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

    walk(base, "")
    return entries


def read_file(relative: str) -> dict:
    """メモ配下のファイルを読み取る."""
    target = resolve(relative)
    if not target.exists() or not target.is_file():
        raise MemoError(f"ファイルが見つかりません: {relative}")
    size = target.stat().st_size
    if size > CONFIG.max_file_size:
        raise MemoError("ファイルが大きすぎます。")
    raw = target.read_bytes()
    try:
        content = raw.decode("utf-8")
        encoding = "utf-8"
    except UnicodeDecodeError:
        content = raw.decode("utf-8", "replace")
        encoding = "binary"
    return {"path": relative, "content": content, "encoding": encoding, "size": size}


def write_file(relative: str, content: str) -> dict:
    """メモ配下のファイルへ保存する."""
    target = resolve(relative)
    if target.is_dir():
        raise MemoError("ディレクトリには保存できません。")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, "utf-8")
    return {"path": relative, "size": target.stat().st_size}


def create_file(relative: str, content: str = "") -> dict:
    """空のファイルを作成する."""
    target = resolve(relative)
    if target.exists():
        raise MemoError("すでに同じ名前が存在します。")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, "utf-8")
    return {"path": relative, "size": target.stat().st_size}


def create_folder(relative: str) -> dict:
    """フォルダを作成する."""
    target = resolve(relative)
    if target.exists():
        raise MemoError("すでに同じ名前が存在します。")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.mkdir(parents=True, exist_ok=True)
    return {"path": relative}


def rename(source: str, destination: str) -> dict:
    """ファイル / フォルダの名前変更 (同じフォルダ内のみ)."""
    src = resolve(source)
    dst = resolve(destination)
    if not src.exists():
        raise MemoError(f"ファイルが見つかりません: {source}")
    if dst.exists():
        raise MemoError("すでに同じ名前が存在します。")
    if dst.parent != src.parent:
        raise MemoError("同じフォルダ内だけで名前を変更できます。")
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(src), str(dst))
    return {"from": source, "path": destination}


def remove(relative: str) -> dict:
    """ファイル / フォルダを削除する."""
    target = resolve(relative)
    if target == root():
        raise MemoError("ルートは削除できません。")
    if not target.exists():
        raise MemoError(f"ファイルが見つかりません: {relative}")
    if target.is_dir():
        shutil.rmtree(target)
    else:
        target.unlink()
    return {"path": relative}


def save_upload(directory: str, filename: str, data: bytes) -> dict:
    """アップロードされたファイルを指定フォルダへ保存する."""
    if not data:
        raise MemoError("ファイルデータが空です。")
    base = resolve(directory, allow_root=True) if (directory or "").strip() else root()
    base.mkdir(parents=True, exist_ok=True)
    name = sanitize_name(filename)
    target = base / name
    index = 1
    while target.exists():
        target = base / f"{Path(name).stem}-{index}{Path(name).suffix}"
        index += 1
    target.write_bytes(data)
    relative = target.relative_to(root()).as_posix()
    return {"path": relative, "size": len(data)}


def archive_folder(relative: str) -> tuple[bytes, str]:
    """フォルダを ZIP に固める (ダウンロード用)."""
    source = resolve(relative)
    if not source.is_dir():
        raise MemoError("フォルダが見つかりません。")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for item in sorted(source.rglob("*")):
            if item.is_dir():
                continue
            arcname = Path(item.relative_to(source)).as_posix()
            archive.write(item, arcname)
    name = (source.name or "memo") + ".zip"
    return buffer.getvalue(), name
