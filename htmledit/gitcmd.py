"""git CLI のラッパー.

外部依存を増やさないため git コマンドを直接呼ぶ。認証情報は
GITHUB_TOKEN 環境変数があれば credential helper 経由で渡す(ディスクには残さない)。
"""

from __future__ import annotations

import os
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from .config import CONFIG

TOKEN_HELPER = '!f() { echo "username=${GIT_AUTH_USERNAME:-x-access-token}"; echo "password=${GIT_AUTH_TOKEN}"; }; f'


class GitError(RuntimeError):
    """git コマンドの失敗."""

    def __init__(self, message: str, stderr: str = "", returncode: int = 1) -> None:
        super().__init__(message)
        self.stderr = stderr
        self.returncode = returncode


@dataclass
class Auth:
    """Git の認証情報 (ユーザーID / PAT)."""

    username: str = ""
    token: str = ""

    @property
    def enabled(self) -> bool:
        return bool(self.token)


@dataclass
class GitResult:
    args: list[str]
    returncode: int
    stdout: str
    stderr: str

    @property
    def ok(self) -> bool:
        return self.returncode == 0

    @property
    def out(self) -> str:
        return self.stdout.strip()


def _env(auth: Auth | None = None) -> dict[str, str]:
    env = os.environ.copy()
    env["GIT_TERMINAL_PROMPT"] = "0"
    env["GIT_SSH_COMMAND"] = env.get("GIT_SSH_COMMAND", "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new")
    env["LC_ALL"] = env.get("LC_ALL", "C.UTF-8")
    env["LANG"] = env.get("LANG", "C.UTF-8")
    env["GIT_EDITOR"] = "true"
    resolved = resolve_auth(auth)
    if resolved is not None:
        env["GIT_AUTH_USERNAME"] = resolved.username
        env["GIT_AUTH_TOKEN"] = resolved.token
    return env


def resolve_auth(auth: Auth | None = None) -> Auth | None:
    """サイト固有の認証情報を優先し、無ければ環境変数の GITHUB_TOKEN を使う."""
    if auth is not None and auth.token:
        return Auth(username=auth.username or "x-access-token", token=auth.token)
    if CONFIG.github_token:
        return Auth(username="x-access-token", token=CONFIG.github_token)
    return None


def _auth_args() -> list[str]:
    return ["-c", "credential.helper=", "-c", f"credential.helper={TOKEN_HELPER}"]


def run_git(
    args: list[str],
    cwd: str | Path | None = None,
    timeout: int | None = None,
    check: bool = False,
    use_auth: bool = False,
    auth: Auth | None = None,
    stdin: str | None = None,
) -> GitResult:
    """git を実行して結果を返す."""
    cmd: list[str] = ["git"]
    if use_auth and resolve_auth(auth) is not None:
        cmd += _auth_args()
    cmd += args
    try:
        proc = subprocess.run(
            cmd,
            cwd=str(cwd) if cwd else None,
            env=_env(auth),
            input=stdin.encode("utf-8") if stdin is not None else None,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout or CONFIG.git_timeout,
        )
    except subprocess.TimeoutExpired as exc:
        raise GitError(f"git コマンドがタイムアウトしました: {' '.join(args)}") from exc
    except FileNotFoundError as exc:  # pragma: no cover - git が無い環境
        raise GitError("git が見つかりません。git をインストールしてください。") from exc

    result = GitResult(
        args=cmd,
        returncode=proc.returncode,
        stdout=proc.stdout.decode("utf-8", "replace"),
        stderr=proc.stderr.decode("utf-8", "replace"),
    )
    if check and not result.ok:
        raise GitError(_error_message(result), result.stderr, result.returncode)
    return result


def _error_message(result: GitResult) -> str:
    message = (result.stderr or result.stdout).strip()
    if not message:
        message = f"git {' '.join(result.args[1:])} が失敗しました (code={result.returncode})"
    return message


def is_git_repo(path: str | Path) -> bool:
    result = run_git(["rev-parse", "--is-inside-work-tree"], cwd=path)
    return result.ok and result.out == "true"


def clone(url: str, dest: str | Path, branch: str = "", auth: Auth | None = None) -> GitResult:
    args = ["clone", "--origin", "origin"]
    if branch:
        args += ["--branch", branch]
    args += [url, str(dest)]
    return run_git(args, use_auth=True, auth=auth, timeout=CONFIG.git_timeout * 2)


def ensure_identity(path: str | Path) -> None:
    """コミットに使う user.name / user.email が無ければ設定する."""
    name = run_git(["config", "--get", "user.name"], cwd=path)
    if not name.ok or not name.out:
        run_git(["config", "user.name", CONFIG.commit_user_name], cwd=path)
    email = run_git(["config", "--get", "user.email"], cwd=path)
    if not email.ok or not email.out:
        run_git(["config", "user.email", CONFIG.commit_user_email], cwd=path)
    run_git(["config", "core.quotepath", "false"], cwd=path)


def current_branch(path: str | Path) -> str:
    result = run_git(["rev-parse", "--abbrev-ref", "HEAD"], cwd=path)
    if not result.ok:
        return ""
    branch = result.out
    return "" if branch == "HEAD" else branch


def remote_url(path: str | Path, name: str = "origin") -> str:
    result = run_git(["remote", "get-url", name], cwd=path)
    return result.out if result.ok else ""


def set_remote_url(path: str | Path, url: str, name: str = "origin") -> None:
    run_git(["remote", "set-url", name, url], cwd=path)


def upstream_of(path: str | Path, branch: str = "") -> str:
    branch = branch or current_branch(path)
    if not branch:
        return ""
    result = run_git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], cwd=path)
    if result.ok and result.out:
        return result.out
    result = run_git(["config", "--get", f"branch.{branch}.merge"], cwd=path)
    if result.ok and result.out:
        return f"origin/{result.out}"
    return ""


@dataclass
class FileChange:
    status: str
    path: str
    staged: bool = False
    unstaged: bool = False
    rename_from: str = ""


@dataclass
class RepoStatus:
    branch: str = ""
    upstream: str = ""
    ahead: int = 0
    behind: int = 0
    detached: bool = False
    changes: list[FileChange] = field(default_factory=list)
    last_commit: dict = field(default_factory=dict)

    @property
    def dirty(self) -> bool:
        return bool(self.changes)

    def to_dict(self) -> dict:
        return {
            "branch": self.branch,
            "upstream": self.upstream,
            "ahead": self.ahead,
            "behind": self.behind,
            "detached": self.detached,
            "dirty": self.dirty,
            "changes": [vars(change) for change in self.changes],
            "lastCommit": self.last_commit,
        }


def _parse_branch_line(line: str) -> tuple[str, str, int, int, bool]:
    """`## main...origin/main [ahead 1, behind 2]` を解析する."""
    body = line[3:].strip() if line.startswith("## ") else line.strip()
    detached = "(no branch)" in body or body.startswith("HEAD")
    ahead = behind = 0
    upstream = ""
    if "..." in body:
        branch, _, rest = body.partition("...")
        upstream = rest.split("[")[0].strip()
        if "[" in rest and "]" in rest:
            info = rest[rest.index("[") + 1 : rest.index("]")]
            for part in info.split(","):
                part = part.strip()
                if part.startswith("ahead"):
                    ahead = int(part.split()[1])
                elif part.startswith("behind"):
                    behind = int(part.split()[1])
    else:
        branch = body
    return branch.strip(), upstream, ahead, behind, detached


def get_status(path: str | Path) -> RepoStatus:
    status = RepoStatus()
    result = run_git(["status", "--porcelain=v1", "--branch", "--untracked-files=all"], cwd=path)
    if not result.ok:
        raise GitError(_error_message(result))
    lines = result.stdout.splitlines()
    for index, line in enumerate(lines):
        if index == 0 and line.startswith("## "):
            branch, upstream, ahead, behind, detached = _parse_branch_line(line)
            status.branch = branch
            status.upstream = upstream
            status.ahead = ahead
            status.behind = behind
            status.detached = detached
            continue
        if len(line) < 3:
            continue
        index_state = line[:2]
        file_path = line[2:].strip()
        rename_from = ""
        if " -> " in file_path:
            rename_from, file_path = file_path.split(" -> ", 1)
        status.changes.append(
            FileChange(
                status=index_state.strip() or index_state,
                path=file_path,
                staged=index_state[0] not in (" ", "?", "!"),
                unstaged=index_state[1] not in (" ", "?"),
                rename_from=rename_from,
            )
        )
    status.last_commit = get_last_commit(path)
    return status


def get_last_commit(path: str | Path) -> dict:
    result = run_git(
        ["log", "-1", "--pretty=format:%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%D"],
        cwd=path,
    )
    if not result.ok or not result.out:
        return {}
    parts = result.out.split("\x1f")
    keys = ["hash", "author", "email", "date", "subject", "refs"]
    commit = dict(zip(keys, parts))
    commit["shortHash"] = commit.get("hash", "")[:7]
    commit["refs"] = [ref.strip() for ref in commit.get("refs", "").split(",") if ref.strip()]
    return commit


def get_log(path: str | Path, limit: int = 20, skip: int = 0) -> list[dict]:
    result = run_git(
        ["log", f"-{max(1, min(limit, 200))}", f"--skip={max(0, skip)}", "--pretty=format:%H%x1f%an%x1f%aI%x1f%s%x1f%D"],
        cwd=path,
    )
    if not result.ok:
        return []
    commits = []
    for line in result.stdout.splitlines():
        parts = line.split("\x1f")
        commit = dict(zip(["hash", "author", "date", "subject", "refs"], parts))
        commit["shortHash"] = commit.get("hash", "")[:7]
        commit["refs"] = [ref.strip() for ref in commit.get("refs", "").split(",") if ref.strip()]
        commits.append(commit)
    return commits


def pull(path: str | Path, auth: Auth | None = None) -> GitResult:
    return run_git(["pull", "--ff-only"], cwd=path, use_auth=True, auth=auth)


def fetch(path: str | Path, auth: Auth | None = None) -> GitResult:
    return run_git(["fetch", "--prune", "origin"], cwd=path, use_auth=True, auth=auth)


def commit(path: str | Path, message: str, paths: list[str] | None = None) -> GitResult:
    args = ["add", "-A"]
    if paths:
        args += ["--", *paths]
    add_result = run_git(args, cwd=path)
    if not add_result.ok:
        raise GitError(_error_message(add_result))
    return run_git(["commit", "-m", message], cwd=path)


def push(path: str | Path, branch: str = "", set_upstream: bool = False, auth: Auth | None = None) -> GitResult:
    args = ["push"]
    if set_upstream:
        args.append("--set-upstream")
    args.append("origin")
    if branch:
        args.append(branch)
    return run_git(args, cwd=path, use_auth=True, auth=auth)


def discard_changes(path: str | Path, paths: list[str] | None = None) -> GitResult:
    args = ["checkout", "--"]
    if paths:
        args += paths
    else:
        args = ["reset", "--hard", "HEAD"]
        run_git(["clean", "-fd"], cwd=path)
    return run_git(args, cwd=path)
