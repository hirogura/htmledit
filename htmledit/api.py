"""REST API の定義とハンドラー."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Callable
from pathlib import Path

from . import github, gitcmd, selfservice, sites
from .config import APP_ROOT, CONFIG
from .sites import REGISTRY, SiteError


class ApiError(Exception):
    """API が返す HTTP エラー."""

    def __init__(self, status: int, message: str, detail: Any = None) -> None:
        super().__init__(message)
        self.status = status
        self.message = message
        self.detail = detail


@dataclass
class Request:
    method: str
    path: str
    query: dict[str, list[str]] = field(default_factory=dict)
    headers: dict[str, str] = field(default_factory=dict)
    body: bytes = b""

    def json(self) -> dict:
        if not self.body:
            return {}
        try:
            payload = json.loads(self.body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ApiError(400, f"JSON を解析できません: {exc}") from exc
        if not isinstance(payload, dict):
            raise ApiError(400, "JSON オブジェクトを入力してください。")
        return payload

    def q(self, name: str, default: str = "") -> str:
        values = self.query.get(name)
        return values[0] if values else default

    def header(self, name: str, default: str = "") -> str:
        return self.headers.get(name.lower(), default)


Handler = Callable[[Request, dict[str, str]], Any]
ROUTES: list[tuple[str, re.Pattern[str], Handler]] = []


def route(method: str, pattern: str) -> Callable[[Handler], Handler]:
    compiled = re.compile(f"^{pattern}$")

    def decorator(func: Handler) -> Handler:
        ROUTES.append((method, compiled, func))
        return func

    return decorator


def dispatch(request: Request) -> Any:
    """パスとメソッドからハンドラーを探す."""
    allowed = set()
    for method, pattern, handler in ROUTES:
        match = pattern.match(request.path)
        if not match:
            continue
        if method != request.method:
            allowed.add(method)
            continue
        return handler(request, match.groupdict())
    if allowed:
        raise ApiError(405, f"許可されていないメソッドです: {request.method}")
    raise ApiError(404, f"API が存在しません: {request.path}")


def _site(site_id: str) -> sites.Site:
    try:
        return REGISTRY.get(site_id)
    except SiteError as exc:
        raise ApiError(404, str(exc)) from exc


def _require_repo(site: sites.Site) -> None:
    if not gitcmd.is_git_repo(site.path):
        raise ApiError(409, f"サイト '{site.id}' のローカルリポジトリが見つかりません。")


# --------------------------------------------------------------------------
# アプリケーション
# --------------------------------------------------------------------------

@route("GET", r"/api/version")
def version(_request: Request, _params: dict) -> dict:
    from . import VERSION, VERSION_LABEL

    payload = {
        "version": VERSION,
        "label": VERSION_LABEL,
        "publicUrl": CONFIG.public_url,
        "service": CONFIG.service_name,
        "appRoot": str(APP_ROOT),
    }
    try:
        payload["repository"] = selfservice.repository_state()
    except Exception:
        payload["repository"] = {}
    return payload


@route("GET", r"/api/self/state")
def self_state(_request: Request, _params: dict) -> dict:
    try:
        return {"ok": True, "repository": selfservice.repository_state()}
    except selfservice.SelfServiceError as exc:
        return {"ok": False, "error": str(exc), "repository": {}}


@route("POST", r"/api/self/update")
def self_update(_request: Request, _params: dict) -> dict:
    try:
        return {"ok": True, **selfservice.update()}
    except selfservice.SelfServiceError as exc:
        raise ApiError(409, str(exc)) from exc
    except gitcmd.GitError as exc:
        raise ApiError(500, str(exc)) from exc


@route("POST", r"/api/self/restart")
def self_restart(_request: Request, _params: dict) -> dict:
    return {"ok": True, **selfservice.restart()}


# --------------------------------------------------------------------------
# サイト
# --------------------------------------------------------------------------

@route("GET", r"/api/sites")
def list_sites(_request: Request, _params: dict) -> dict:
    return {"sites": [site.to_dict() for site in REGISTRY.list()]}


@route("POST", r"/api/sites")
def add_site(request: Request, _params: dict) -> dict:
    payload = request.json()
    url = str(payload.get("url", "")).strip()
    if not url:
        raise ApiError(400, "GitHub の URL を入力してください。")
    branch = str(payload.get("branch", "")).strip()
    name = str(payload.get("name", "")).strip()
    try:
        site = REGISTRY.add(url, branch=branch, name=name)
    except SiteError as exc:
        raise ApiError(400, str(exc)) from exc
    except gitcmd.GitError as exc:
        raise ApiError(500, str(exc)) from exc
    return {"site": site.to_dict()}


@route("PATCH", r"/api/sites/(?P<site_id>[^/]+)")
def update_site(request: Request, params: dict) -> dict:
    payload = request.json()
    name = str(payload.get("name", "")).strip()
    if not name:
        raise ApiError(400, "サイト名を空にはできません。")
    site = REGISTRY.rename(params["site_id"], name)
    return {"site": site.to_dict()}


@route("DELETE", r"/api/sites/(?P<site_id>[^/]+)")
def delete_site(request: Request, params: dict) -> dict:
    payload = request.json() if request.body else {}
    keep_clone = bool(payload.get("keepClone"))
    site = REGISTRY.remove(params["site_id"], delete_clone=not keep_clone)
    return {"removed": site.id}


# --------------------------------------------------------------------------
# ファイル
# --------------------------------------------------------------------------

@route("GET", r"/api/sites/(?P<site_id>[^/]+)/tree")
def site_tree(_request: Request, params: dict) -> dict:
    site = _site(params["site_id"])
    if not Path(site.path).exists():
        raise ApiError(404, "サイトのローカルリポジトリがありません。")
    return {"site": site.id, "tree": sites.build_tree(site)}


@route("GET", r"/api/sites/(?P<site_id>[^/]+)/file")
def site_file(request: Request, params: dict) -> dict:
    site = _site(params["site_id"])
    path = request.q("path")
    if not path:
        raise ApiError(400, "path が指定されていません。")
    try:
        return sites.read_file(site, path)
    except SiteError as exc:
        raise ApiError(404, str(exc)) from exc


@route("PUT", r"/api/sites/(?P<site_id>[^/]+)/file")
def save_site_file(request: Request, params: dict) -> dict:
    site = _site(params["site_id"])
    payload = request.json()
    path = str(payload.get("path", "")).strip()
    content = payload.get("content")
    if not path:
        raise ApiError(400, "path が指定されていません。")
    if not isinstance(content, str):
        raise ApiError(400, "content は文字列で指定してください。")
    try:
        result = sites.write_file(site, path, content)
    except SiteError as exc:
        raise ApiError(400, str(exc)) from exc
    return {"ok": True, **result}


# --------------------------------------------------------------------------
# Git 操作
# --------------------------------------------------------------------------

def _site_status(site: sites.Site) -> dict:
    _require_repo(site)
    try:
        status = gitcmd.get_status(site.path)
    except gitcmd.GitError as exc:
        raise ApiError(500, str(exc)) from exc
    data = status.to_dict()
    data["remoteUrl"] = gitcmd.remote_url(site.path)
    data["siteId"] = site.id
    data["owner"] = site.owner
    data["repo"] = site.repo
    return data


@route("GET", r"/api/sites/(?P<site_id>[^/]+)/git/status")
def git_status(_request: Request, params: dict) -> dict:
    return _site_status(_site(params["site_id"]))


@route("GET", r"/api/sites/(?P<site_id>[^/]+)/git/log")
def git_log(request: Request, params: dict) -> dict:
    site = _site(params["site_id"])
    _require_repo(site)
    limit = request.q("limit", "20")
    try:
        limit_value = int(limit)
    except ValueError:
        limit_value = 20
    return {"commits": gitcmd.get_log(site.path, limit=limit_value)}


@route("POST", r"/api/sites/(?P<site_id>[^/]+)/git/pull")
def git_pull(_request: Request, params: dict) -> dict:
    site = _site(params["site_id"])
    _require_repo(site)
    try:
        result = gitcmd.pull(site.path)
    except gitcmd.GitError as exc:
        raise ApiError(500, str(exc)) from exc
    if not result.ok:
        raise ApiError(409, f"pull に失敗しました: {(result.stderr or result.stdout).strip()}")
    return {"ok": True, "output": (result.stdout + result.stderr).strip()}


@route("POST", r"/api/sites/(?P<site_id>[^/]+)/git/commit")
def git_commit(request: Request, params: dict) -> dict:
    site = _site(params["site_id"])
    _require_repo(site)
    payload = request.json()
    message = str(payload.get("message", "")).strip()
    if not message:
        raise ApiError(400, "コミットメッセージを入力してください。")
    paths = payload.get("paths")
    if paths is not None and not isinstance(paths, list):
        raise ApiError(400, "paths は配列で指定してください。")
    try:
        result = gitcmd.commit(site.path, message, paths=paths)
    except gitcmd.GitError as exc:
        raise ApiError(500, str(exc)) from exc
    if not result.ok:
        raise ApiError(409, f"commit に失敗しました: {(result.stderr or result.stdout).strip()}")
    return {"ok": True, "output": (result.stdout + result.stderr).strip()}


@route("POST", r"/api/sites/(?P<site_id>[^/]+)/git/push")
def git_push(request: Request, params: dict) -> dict:
    site = _site(params["site_id"])
    _require_repo(site)
    payload = request.json() if request.body else {}
    branch = str(payload.get("branch", "")).strip()
    set_upstream = bool(payload.get("setUpstream"))
    try:
        result = gitcmd.push(site.path, branch=branch, set_upstream=set_upstream)
    except gitcmd.GitError as exc:
        raise ApiError(500, str(exc)) from exc
    if not result.ok:
        raise ApiError(409, f"push に失敗しました: {(result.stderr or result.stdout).strip()}")
    return {"ok": True, "output": (result.stdout + result.stderr).strip()}


@route("POST", r"/api/sites/(?P<site_id>[^/]+)/git/discard")
def git_discard(request: Request, params: dict) -> dict:
    site = _site(params["site_id"])
    _require_repo(site)
    payload = request.json() if request.body else {}
    paths = payload.get("paths")
    if paths is not None and not isinstance(paths, list):
        raise ApiError(400, "paths は配列で指定してください。")
    try:
        result = gitcmd.discard_changes(site.path, paths=paths)
    except gitcmd.GitError as exc:
        raise ApiError(500, str(exc)) from exc
    if not result.ok:
        raise ApiError(409, f"変更の破棄に失敗しました: {(result.stderr or result.stdout).strip()}")
    return {"ok": True}


# --------------------------------------------------------------------------
# GitHub
# --------------------------------------------------------------------------

@route("GET", r"/api/github/repo")
def github_repo(request: Request, _params: dict) -> dict:
    owner = request.q("owner")
    repo = request.q("repo")
    return github.fetch_repo_info(owner, repo)
