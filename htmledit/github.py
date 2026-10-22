"""GitHub API によるリポジトリ情報の取得."""

from __future__ import annotations

import json
import urllib.error
import urllib.request

from .config import CONFIG

API_ROOT = "https://api.github.com"
TIMEOUT = 12


def _request(url: str, token: str = "") -> dict:
    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "htmledit",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = urllib.request.Request(url, headers=headers, method="GET")
    with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
        return json.loads(response.read().decode("utf-8"))


def fetch_repo_info(owner: str, repo: str) -> dict:
    """リポジトリの概要情報を取得する。失敗した場合は error を含む辞書を返す."""
    if not owner or not repo:
        return {"error": "owner / repo が指定されていません。"}
    url = f"{API_ROOT}/repos/{owner}/{repo}"
    try:
        data = _request(url, CONFIG.github_token)
    except urllib.error.HTTPError as exc:
        message = f"GitHub API エラー ({exc.code})"
        try:
            body = json.loads(exc.read().decode("utf-8"))
            message = body.get("message", message)
        except Exception:  # pragma: no cover - 応答解析失敗
            pass
        return {"error": message}
    except urllib.error.URLError as exc:
        return {"error": f"GitHub API に接続できません: {exc.reason}"}
    except Exception as exc:  # pragma: no cover - 想定外
        return {"error": f"GitHub API の取得に失敗しました: {exc}"}

    owner_data = data.get("owner") or {}
    return {
        "fullName": data.get("full_name"),
        "description": data.get("description") or "",
        "defaultBranch": data.get("default_branch") or "",
        "stars": data.get("stargazers_count", 0),
        "forks": data.get("forks_count", 0),
        "watchers": data.get("subscribers_count", 0),
        "openIssues": data.get("open_issues_count", 0),
        "language": data.get("language") or "",
        "license": (data.get("license") or {}).get("spdx_id") or "",
        "homepage": data.get("homepage") or "",
        "private": bool(data.get("private")),
        "archived": bool(data.get("archived")),
        "createdAt": data.get("created_at") or "",
        "updatedAt": data.get("updated_at") or "",
        "pushedAt": data.get("pushed_at") or "",
        "size": data.get("size", 0),
        "htmlUrl": data.get("html_url") or "",
        "ownerLogin": owner_data.get("login") or owner,
        "ownerAvatar": owner_data.get("avatar_url") or "",
    }
