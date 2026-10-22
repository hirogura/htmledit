"""htmledit の API に対する結合テスト (標準ライブラリのみ).

実行: python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

TMP = Path(tempfile.mkdtemp(prefix="htmledit-test-"))
os.environ["HTMLEDIT_DATA_DIR"] = str(TMP / "data")
os.environ["HTMLEDIT_ALLOW_LOCAL_PATHS"] = "1"
os.environ["HTMLEDIT_PORT"] = "0"

from htmledit import server  # noqa: E402
from htmledit.config import CONFIG  # noqa: E402


def git(args, cwd):
    subprocess.run(
        ["git", *args],
        cwd=str(cwd),
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )


class ApiTestCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.remote = TMP / "remote.git"
        cls.work = TMP / "work"
        git(["init", "--bare", "-b", "main", str(cls.remote)], cwd=TMP)
        cls.work.mkdir(parents=True, exist_ok=True)
        git(["init", "-b", "main", str(cls.work)], cwd=TMP)
        git(["config", "user.email", "test@example.com"], cwd=cls.work)
        git(["config", "user.name", "tester"], cwd=cls.work)
        (cls.work / "index.html").write_text(
            "<!doctype html>\n<html>\n<head><title>Test</title></head>\n"
            '<body><h1 class="title">Hello</h1></body>\n</html>\n',
            "utf-8",
        )
        (cls.work / "assets").mkdir(exist_ok=True)
        (cls.work / "assets" / "style.css").write_text("body{color:#333}\n", "utf-8")
        git(["add", "-A"], cwd=cls.work)
        git(["commit", "-m", "initial commit"], cwd=cls.work)
        git(["remote", "add", "origin", str(cls.remote)], cwd=cls.work)
        git(["push", "-u", "origin", "main"], cwd=cls.work)

        CONFIG.reload()
        cls.httpd = server.create_server("127.0.0.1", 0)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        shutil.rmtree(TMP, ignore_errors=True)

    def request(self, method, path, payload=None):
        url = f"http://127.0.0.1:{self.port}{path}"
        data = None
        headers = {"X-Requested-With": "htmledit"}
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=30) as response:
                return response.status, json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8")
            try:
                return exc.code, json.loads(body)
            except json.JSONDecodeError:
                return exc.code, {"error": body}

    def test_version(self):
        status, payload = self.request("GET", "/api/version")
        self.assertEqual(status, 200)
        self.assertEqual(payload["version"], "0.3.0")
        self.assertEqual(payload["label"], "v.0.3.0")

    def test_site_lifecycle(self):
        status, payload = self.request("POST", "/api/sites", {"url": str(self.remote)})
        self.assertEqual(status, 200, payload)
        site = payload["site"]
        self.assertTrue(site["id"])
        self.assertEqual(site["repo"], "remote")

        status, payload = self.request("GET", f"/api/sites/{site['id']}/tree")
        self.assertEqual(status, 200)
        paths = [entry["path"] for entry in payload["tree"]]
        self.assertIn("index.html", paths)
        self.assertIn("assets", paths)
        self.assertIn("assets/style.css", paths)

        status, payload = self.request("GET", f"/api/sites/{site['id']}/file?path=index.html")
        self.assertEqual(status, 200)
        self.assertIn("<h1", payload["content"])

        new_content = payload["content"].replace("Hello", "Hello htmledit")
        status, payload = self.request(
            "PUT",
            f"/api/sites/{site['id']}/file",
            {"path": "index.html", "content": new_content},
        )
        self.assertEqual(status, 200, payload)

        status, payload = self.request("GET", f"/api/sites/{site['id']}/file?path=index.html")
        self.assertIn("Hello htmledit", payload["content"])

        status, payload = self.request("GET", f"/api/sites/{site['id']}/git/status")
        self.assertEqual(status, 200, payload)
        self.assertTrue(payload["dirty"])
        self.assertEqual(payload["branch"], "main")

        status, payload = self.request(
            "POST", f"/api/sites/{site['id']}/git/commit", {"message": "update index"}
        )
        self.assertEqual(status, 200, payload)

        status, payload = self.request("GET", f"/api/sites/{site['id']}/git/log?limit=5")
        self.assertEqual(status, 200)
        self.assertEqual(payload["commits"][0]["subject"], "update index")

        status, payload = self.request("POST", f"/api/sites/{site['id']}/git/push", {})
        self.assertEqual(status, 200, payload)

        status, payload = self.request("POST", f"/api/sites/{site['id']}/git/pull", {})
        self.assertEqual(status, 200, payload)

        status, payload = self.request("DELETE", f"/api/sites/{site['id']}", {})
        self.assertEqual(status, 200, payload)

        status, payload = self.request("GET", "/api/sites")
        self.assertEqual(payload["sites"], [])

    def test_path_traversal_is_blocked(self):
        status, payload = self.request("POST", "/api/sites", {"url": str(self.remote)})
        site_id = payload["site"]["id"]
        status, payload = self.request(
            "GET", f"/api/sites/{site_id}/file?path=../../../../etc/passwd"
        )
        self.assertEqual(status, 404)
        status, payload = self.request(
            "PUT", f"/api/sites/{site_id}/file", {"path": "../escape.html", "content": "x"}
        )
        self.assertEqual(status, 400)
        self.request("DELETE", f"/api/sites/{site_id}", {})

    def test_site_credentials(self):
        status, payload = self.request(
            "POST",
            "/api/sites",
            {"url": str(self.remote), "username": "octocat", "token": "ghp_dummy_token"},
        )
        self.assertEqual(status, 200, payload)
        site = payload["site"]
        self.assertEqual(site["username"], "octocat")
        self.assertTrue(site["hasToken"])
        self.assertNotIn("token", site)

        credentials_file = Path(CONFIG.data_dir) / "credentials.json"
        self.assertTrue(credentials_file.exists())
        self.assertEqual(oct(credentials_file.stat().st_mode & 0o777), "0o600")

        status, payload = self.request(
            "PATCH", f"/api/sites/{site['id']}", {"username": "octocat2"}
        )
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["site"]["username"], "octocat2")
        self.assertTrue(payload["site"]["hasToken"])

        status, payload = self.request("DELETE", f"/api/sites/{site['id']}", {})
        self.assertEqual(status, 200, payload)
        stored = json.loads(credentials_file.read_text("utf-8"))
        self.assertNotIn(site["id"], stored.get("sites", {}))

    def test_credential_helper_uses_site_token(self):
        from htmledit import gitcmd

        result = gitcmd.run_git(
            ["credential", "fill"],
            use_auth=True,
            auth=gitcmd.Auth(username="octocat", token="ghp_test_token"),
            stdin="protocol=https\nhost=github.com\n\n",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("username=octocat", result.stdout)
        self.assertIn("password=ghp_test_token", result.stdout)

    def test_copy_asset(self):
        status, payload = self.request("POST", "/api/sites", {"url": str(self.remote)})
        site_id = payload["site"]["id"]

        # 画像ファイルを作成してから取り込む
        assets_dir = Path(CONFIG.data_dir) / "repos" / site_id / "assets"
        assets_dir.mkdir(parents=True, exist_ok=True)
        (assets_dir / "photo.png").write_bytes(b"\x89PNG\r\n\x1a\n")

        status, payload = self.request(
            "POST",
            f"/api/sites/{site_id}/assets",
            {"source": "assets/photo.png", "target": "images/photo.png", "page": "index.html"},
        )
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["path"], "images/photo.png")
        self.assertEqual(payload["reference"], "images/photo.png")
        self.assertTrue((Path(CONFIG.data_dir) / "repos" / site_id / "images" / "photo.png").exists())

        # 同名ファイルがある場合は連番になる
        status, payload = self.request(
            "POST",
            f"/api/sites/{site_id}/assets",
            {"source": "assets/photo.png", "target": "images/photo.png", "page": "index.html"},
        )
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["path"], "images/photo-1.png")

        # サブディレクトリのページからの相対パス
        status, payload = self.request(
            "POST",
            f"/api/sites/{site_id}/assets",
            {"source": "assets/photo.png", "target": "images/photo.png", "page": "sub/page.html"},
        )
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["reference"], "../images/photo-2.png")

        # サイト外へのコピーは拒否される
        status, payload = self.request(
            "POST",
            f"/api/sites/{site_id}/assets",
            {"source": "assets/photo.png", "target": "../escape.png", "page": "index.html"},
        )
        self.assertEqual(status, 400)

        self.request("DELETE", f"/api/sites/{site_id}", {})

    def test_unknown_site(self):
        status, payload = self.request("GET", "/api/sites/nope/tree")
        self.assertEqual(status, 404)


class UrlParseTestCase(unittest.TestCase):
    def test_github_urls(self):
        from htmledit.sites import parse_repo_url

        ref = parse_repo_url("https://github.com/owner/repo")
        self.assertEqual((ref.owner, ref.repo, ref.branch), ("owner", "repo", ""))
        self.assertEqual(ref.url, "https://github.com/owner/repo.git")
        self.assertTrue(ref.is_github)

        ref = parse_repo_url("https://github.com/owner/repo.git")
        self.assertEqual((ref.owner, ref.repo), ("owner", "repo"))

        ref = parse_repo_url("https://github.com/owner/repo/tree/develop")
        self.assertEqual((ref.owner, ref.repo, ref.branch), ("owner", "repo", "develop"))
        self.assertEqual(ref.url, "https://github.com/owner/repo.git")

        ref = parse_repo_url("git@github.com:owner/repo.git")
        self.assertEqual((ref.owner, ref.repo), ("owner", "repo"))
        self.assertEqual(ref.url, "git@github.com:owner/repo.git")

    def test_other_hosts_and_local(self):
        from htmledit.sites import parse_repo_url

        ref = parse_repo_url("https://gitlab.com/group/project.git")
        self.assertEqual((ref.owner, ref.repo), ("group", "project"))
        self.assertEqual(ref.url, "https://gitlab.com/group/project.git")
        self.assertFalse(ref.is_github)

        with self.assertRaises(Exception):
            parse_repo_url("")


if __name__ == "__main__":
    unittest.main()
