"""htmledit の API に対する結合テスト (標準ライブラリのみ).

実行: python3 -m unittest discover -s tests -v
"""

from __future__ import annotations

import json
import os
import shutil
import socket
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
os.environ["HTMLEDIT_MEMO_FILE"] = str(TMP / "memo.md")
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

    def request_upload(self, path, data, content_type):
        url = f"http://127.0.0.1:{self.port}{path}"
        req = urllib.request.Request(
            url,
            data=data,
            headers={"Content-Type": content_type, "X-Requested-With": "htmledit"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as response:
                return response.status, json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8")
            try:
                return exc.code, json.loads(body)
            except json.JSONDecodeError:
                return exc.code, {"error": body}

    def request_raw(self, path):
        url = f"http://127.0.0.1:{self.port}{path}"
        req = urllib.request.Request(url, headers={"X-Requested-With": "htmledit"}, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=30) as response:
                return response.status, response.read().decode("utf-8", "replace"), response.headers.get("Content-Type", "")
        except urllib.error.HTTPError as exc:
            return exc.code, exc.read().decode("utf-8", "replace"), exc.headers.get("Content-Type", "")

    def test_version(self):
        status, payload = self.request("GET", "/api/version")
        self.assertEqual(status, 200)
        self.assertEqual(payload["version"], "0.6.0")
        self.assertEqual(payload["label"], "v.0.6.0")

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
            {"source": "assets/photo.png", "page": "index.html"},
        )
        self.assertEqual(status, 200, payload)
        # images/YYYY/MM/DD/ 形式に保存される
        self.assertRegex(payload["path"], r"^public/images/\d{4}/\d{2}/\d{2}/photo\.png$")
        self.assertEqual(payload["reference"], payload["path"])
        self.assertTrue(
            (Path(CONFIG.data_dir) / "repos" / site_id / payload["path"]).exists()
        )

        # 同名ファイルがある場合は連番になる
        status, payload = self.request(
            "POST",
            f"/api/sites/{site_id}/assets",
            {"source": "assets/photo.png", "page": "index.html"},
        )
        self.assertEqual(status, 200, payload)
        self.assertRegex(payload["path"], r"^public/images/\d{4}/\d{2}/\d{2}/photo-1\.png$")

        # サブディレクトリのページからの相対パス
        status, payload = self.request(
            "POST",
            f"/api/sites/{site_id}/assets",
            {"source": "assets/photo.png", "page": "sub/page.html"},
        )
        self.assertEqual(status, 200, payload)
        self.assertRegex(payload["reference"], r"^\.\./public/images/\d{4}/\d{2}/\d{2}/photo-2\.png$")

        # 存在しないファイルはエラー
        status, payload = self.request(
            "POST",
            f"/api/sites/{site_id}/assets",
            {"source": "assets/missing.png", "page": "index.html"},
        )
        self.assertEqual(status, 400)

        self.request("DELETE", f"/api/sites/{site_id}", {})

    def test_upload_asset(self):
        status, payload = self.request("POST", "/api/sites", {"url": str(self.remote)})
        site_id = payload["site"]["id"]

        png = (
            b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06"
            b"\x00\x00\x00\x1f\x15\xc4\x89"
        )
        status, payload = self.request_upload(
            f"/api/sites/{site_id}/assets/upload?name=photo.png&page=index.html",
            png,
            "image/png",
        )
        self.assertEqual(status, 200, payload)
        self.assertRegex(payload["path"], r"^public/images/\d{4}/\d{2}/\d{2}/photo\.png$")
        self.assertEqual(payload["reference"], payload["path"])
        self.assertEqual(payload["size"], len(png))
        saved = Path(CONFIG.data_dir) / "repos" / site_id / payload["path"]
        self.assertTrue(saved.exists())
        self.assertEqual(saved.read_bytes(), png)

        # 危険なファイル名は安全な名前に変換される
        status, payload = self.request_upload(
            f"/api/sites/{site_id}/assets/upload?name=../../evil%20%3Cimg%3E.png",
            png,
            "image/png",
        )
        self.assertEqual(status, 200, payload)
        self.assertNotIn("..", payload["path"])
        self.assertRegex(payload["path"], r"^public/images/\d{4}/\d{2}/\d{2}/evil_img\.png$")

        # 画像以外は拒否される
        status, payload = self.request_upload(
            f"/api/sites/{site_id}/assets/upload?name=x.txt", b"hello", "text/plain"
        )
        self.assertEqual(status, 400)

        self.request("DELETE", f"/api/sites/{site_id}", {})

    def test_site_file_serving(self):
        status, payload = self.request("POST", "/api/sites", {"url": str(self.remote)})
        site_id = payload["site"]["id"]

        status, body, content_type = self.request_raw(
            f"/site/{site_id}/assets/style.css"
        )
        self.assertEqual(status, 200)
        self.assertIn("text/css", content_type)
        self.assertIn("color:#333", body)

        # 存在しないファイルは 404
        status, _, _ = self.request_raw(f"/site/{site_id}/assets/missing.css")
        self.assertEqual(status, 404)

        # サイト外への参照は拒否される
        status, _, _ = self.request_raw(f"/site/{site_id}/../../etc/passwd")
        self.assertEqual(status, 404)

        self.request("DELETE", f"/api/sites/{site_id}", {})

    def test_memo_api(self):
        status, payload = self.request("GET", "/api/memo")
        self.assertEqual(status, 200, payload)
        self.assertIn("memo.md", payload["path"])

        status, payload = self.request("PUT", "/api/memo", {"content": "# メモ\nテスト\n"})
        self.assertEqual(status, 200, payload)
        self.assertTrue(Path(payload["path"]).exists())

        status, payload = self.request("GET", "/api/memo")
        self.assertEqual(payload["content"], "# メモ\nテスト\n")

    def test_opencode_status(self):
        status, payload = self.request("GET", "/api/opencode/status")
        self.assertEqual(status, 200, payload)
        self.assertIn("installed", payload)
        self.assertIn("installing", payload)

    def test_terminal_websocket(self):
        import base64
        import struct
        import time

        port = self.port
        key = base64.b64encode(os.urandom(16)).decode()
        sock = socket.create_connection(("127.0.0.1", port), timeout=10)
        try:
            sock.sendall(
                (
                    f"GET /ws/terminal?id=test-session HTTP/1.1\r\n"
                    f"Host: 127.0.0.1:{port}\r\n"
                    "Upgrade: websocket\r\n"
                    "Connection: Upgrade\r\n"
                    f"Sec-WebSocket-Key: {key}\r\n"
                    "Sec-WebSocket-Version: 13\r\n\r\n"
                ).encode()
            )
            response = sock.recv(4096)
            self.assertIn(b"101 Switching Protocols", response)

            payload = json.dumps({"type": "command", "data": "echo htmledit-terminal-ok"}).encode()
            mask = os.urandom(4)
            header = bytearray([0x81])
            header.append(0x80 | len(payload))
            header += mask
            header += bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
            sock.sendall(bytes(header))

            sock.settimeout(10)
            buffer = b""
            deadline = time.time() + 10
            while time.time() < deadline and b"htmledit-terminal-ok" not in buffer:
                try:
                    chunk = sock.recv(65536)
                except socket.timeout:
                    break
                if not chunk:
                    break
                buffer += chunk
            self.assertIn(b"htmledit-terminal-ok", buffer)
        finally:
            sock.close()

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
