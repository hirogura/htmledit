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
os.environ["HTMLEDIT_MEMO_DIR"] = str(TMP / "memo")
os.environ["HTMLEDIT_MEMO_FILE"] = str(TMP / "memo" / "memo.md")
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
        from htmledit import __version__

        status, payload = self.request("GET", "/api/version")
        self.assertEqual(status, 200)
        self.assertEqual(payload["version"], __version__)
        self.assertEqual(payload["label"], f"v.{__version__}")

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

    def test_site_url(self):
        status, payload = self.request(
            "POST",
            "/api/sites",
            {"url": str(self.remote), "siteUrl": "https://example.com"},
        )
        self.assertEqual(status, 200, payload)
        site = payload["site"]
        self.assertEqual(site["site_url"], "https://example.com")

        # 認証情報を編集する画面からの更新
        status, payload = self.request(
            "PATCH", f"/api/sites/{site['id']}", {"siteUrl": "https://example.org/blog"}
        )
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["site"]["site_url"], "https://example.org/blog")

        # 保存され、再起動後も引き継がれる
        status, payload = self.request("GET", "/api/sites")
        stored = [item for item in payload["sites"] if item["id"] == site["id"]][0]
        self.assertEqual(stored["site_url"], "https://example.org/blog")

        # 空文字で解除できる
        status, payload = self.request("PATCH", f"/api/sites/{site['id']}", {"siteUrl": ""})
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["site"]["site_url"], "")

        self.request("DELETE", f"/api/sites/{site['id']}", {})

    def test_site_url_validation(self):
        from htmledit.sites import SiteError, normalize_site_url

        self.assertEqual(normalize_site_url(""), "")
        self.assertEqual(normalize_site_url("  https://example.com  "), "https://example.com")
        self.assertEqual(normalize_site_url("example.com"), "https://example.com")
        with self.assertRaises(SiteError):
            normalize_site_url("javascript:alert(1)")
        with self.assertRaises(SiteError):
            normalize_site_url("ftp://example.com")

        status, payload = self.request(
            "POST",
            "/api/sites",
            {"url": str(self.remote), "siteUrl": "javascript:alert(1)"},
        )
        self.assertEqual(status, 400, payload)

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

    def test_list_assets(self):
        status, payload = self.request("POST", "/api/sites", {"url": str(self.remote)})
        site_id = payload["site"]["id"]
        repo = Path(CONFIG.data_dir) / "repos" / site_id

        # public/images 以下に画像を作成する
        images_dir = repo / "public" / "images" / "2026" / "10" / "22"
        images_dir.mkdir(parents=True, exist_ok=True)
        old = images_dir / "old.png"
        new = images_dir / "new.png"
        old.write_bytes(b"\x89PNG\r\n\x1a\n")
        new.write_bytes(b"\x89PNG\r\n\x1a\n")
        (images_dir / "note.txt").write_text("not an image", "utf-8")
        os.utime(old, (1000000, 1000000))
        os.utime(new, (2000000, 2000000))

        status, payload = self.request("GET", f"/api/sites/{site_id}/assets?page=index.html")
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["prefix"], "public/images")
        paths = [item["path"] for item in payload["images"]]
        # 保存日が新しい順に並ぶ
        self.assertEqual(
            paths,
            ["public/images/2026/10/22/new.png", "public/images/2026/10/22/old.png"],
        )
        # 画像以外は含まれない
        self.assertNotIn("public/images/2026/10/22/note.txt", paths)

        item = payload["images"][0]
        self.assertEqual(item["name"], "new.png")
        self.assertEqual(item["reference"], "public/images/2026/10/22/new.png")
        self.assertTrue(item["modified"])

        # サブディレクトリのページからは相対パスになる
        status, payload = self.request("GET", f"/api/sites/{site_id}/assets?page=sub/page.html")
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["images"][0]["reference"], "../public/images/2026/10/22/new.png")

        # 画像が無いフォルダは空
        status, payload = self.request("GET", f"/api/sites/{site_id}/assets?prefix=public/empty")
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["images"], [])

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

    def test_site_file_operations(self):
        status, payload = self.request("POST", "/api/sites", {"url": str(self.remote)})
        site_id = payload["site"]["id"]
        base = Path(CONFIG.data_dir) / "repos" / site_id

        # フォルダ作成 → ファイル作成
        status, payload = self.request("POST", f"/api/sites/{site_id}/folder", {"path": "notes"})
        self.assertEqual(status, 200, payload)
        status, payload = self.request(
            "POST", f"/api/sites/{site_id}/file", {"path": "notes/today.md", "content": "# today\n"}
        )
        self.assertEqual(status, 200, payload)
        self.assertTrue((base / "notes" / "today.md").exists())

        status, payload = self.request("GET", f"/api/sites/{site_id}/tree")
        paths = [entry["path"] for entry in payload["tree"]]
        self.assertIn("notes", paths)
        self.assertIn("notes/today.md", paths)

        # リネーム
        status, payload = self.request(
            "POST", f"/api/sites/{site_id}/rename", {"from": "notes/today.md", "to": "notes/daily.md"}
        )
        self.assertEqual(status, 200, payload)
        self.assertTrue((base / "notes" / "daily.md").exists())

        # アップロード
        status, payload = self.request_upload(
            f"/api/sites/{site_id}/upload?dir=notes&name=sample.txt",
            b"hello site",
            "application/octet-stream",
        )
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["path"], "notes/sample.txt")
        self.assertEqual((base / "notes" / "sample.txt").read_bytes(), b"hello site")

        # ダウンロード
        status, body, content_type = self.request_raw(
            f"/api/sites/{site_id}/download?path=notes/sample.txt"
        )
        self.assertEqual(status, 200)
        self.assertEqual(body, "hello site")

        status, body, content_type = self.request_raw(f"/api/sites/{site_id}/download?path=notes")
        self.assertEqual(status, 200)
        self.assertIn("zip", content_type)
        self.assertTrue(body.startswith("PK"))

        # 削除
        status, payload = self.request("DELETE", f"/api/sites/{site_id}/file", {"path": "notes"})
        self.assertEqual(status, 200, payload)
        self.assertFalse((base / "notes").exists())

        self.request("DELETE", f"/api/sites/{site_id}", {})

    def test_site_file_operations_block_traversal(self):
        status, payload = self.request("POST", "/api/sites", {"url": str(self.remote)})
        site_id = payload["site"]["id"]

        status, payload = self.request(
            "POST", f"/api/sites/{site_id}/file", {"path": "../escape.txt"}
        )
        self.assertEqual(status, 400, payload)

        status, payload = self.request(
            "POST", f"/api/sites/{site_id}/folder", {"path": "../escape"}
        )
        self.assertEqual(status, 400, payload)

        status, payload = self.request(
            "POST", f"/api/sites/{site_id}/rename", {"from": "index.html", "to": "../escape.html"}
        )
        self.assertEqual(status, 400, payload)

        status, payload = self.request(
            "DELETE", f"/api/sites/{site_id}/file", {"path": "../"}
        )
        self.assertEqual(status, 400, payload)

        status, _, _ = self.request_raw(f"/api/sites/{site_id}/download?path=../../etc/passwd")
        self.assertEqual(status, 404)

        self.request("DELETE", f"/api/sites/{site_id}", {})

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

            # 出力は JSON のテキストフレームで届いていること (バイナリだとブラウザで破棄される)
            frames = self._decode_frames(buffer)
            self.assertTrue(frames, "フレームが取得できません")
            for opcode, data in frames:
                self.assertEqual(opcode, 0x1, "テキストフレームopcode ではありません")
                message = json.loads(data.decode("utf-8"))
                self.assertEqual(message.get("type"), "data")
                self.assertIsInstance(message.get("data"), str)
            self.assertIn(
                "htmledit-terminal-ok",
                "".join(json.loads(data.decode("utf-8")).get("data", "") for _, data in frames),
            )
        finally:
            sock.close()

    def test_terminal_websocket_command(self):
        """cmd パラメータでコマンドを直接起動できる (selfcode と同じ方式)."""
        import base64
        import time

        port = self.port
        key = base64.b64encode(os.urandom(16)).decode()
        sock = socket.create_connection(("127.0.0.1", port), timeout=10)
        try:
            sock.sendall(
                (
                    f"GET /ws/terminal?id=cmd-session&cmd=echo%20htmledit-direct-ok HTTP/1.1\r\n"
                    f"Host: 127.0.0.1:{port}\r\n"
                    "Upgrade: websocket\r\n"
                    "Connection: Upgrade\r\n"
                    f"Sec-WebSocket-Key: {key}\r\n"
                    "Sec-WebSocket-Version: 13\r\n\r\n"
                ).encode()
            )
            response = sock.recv(4096)
            self.assertIn(b"101 Switching Protocols", response)

            sock.settimeout(10)
            buffer = b""
            deadline = time.time() + 10
            while time.time() < deadline and b"htmledit-direct-ok" not in buffer:
                try:
                    chunk = sock.recv(65536)
                except socket.timeout:
                    break
                if not chunk:
                    break
                buffer += chunk
            frames = self._decode_frames(buffer)
            text = "".join(json.loads(data.decode("utf-8")).get("data", "") for _, data in frames)
            self.assertIn("htmledit-direct-ok", text)
        finally:
            sock.close()

    def _decode_frames(self, buffer):
        """WebSocket フレームを (opcode, payload) のリストに分解する."""
        frames = []
        index = 0
        while index + 2 <= len(buffer):
            first = buffer[index]
            second = buffer[index + 1]
            opcode = first & 0x0F
            length = second & 0x7F
            index += 2
            if length == 126:
                length = int.from_bytes(buffer[index : index + 2], "big")
                index += 2
            elif length == 127:
                length = int.from_bytes(buffer[index : index + 8], "big")
                index += 8
            payload = buffer[index : index + length]
            index += length
            frames.append((opcode, payload))
        return frames

    def test_unknown_site(self):
        status, payload = self.request("GET", "/api/sites/nope/tree")
        self.assertEqual(status, 404)

    def test_post_pages_flow(self):
        status, payload = self.request("POST", "/api/sites", {"url": str(self.remote)})
        site_id = payload["site"]["id"]
        repo = Path(CONFIG.data_dir) / "repos" / site_id

        index_html = (
            "<!doctype html>\n<html lang=\"ja\">\n<head><meta charset=\"utf-8\" />\n"
            "<title>テストサイト</title></head>\n<body>\n"
            "<main class=\"container\">\n<section class=\"hero\"><h1>テストサイト</h1></section>\n"
            "<article class=\"posts\">"
            "<!-- 投稿パネルの記事はこの直下に追加される -->"
            "</article>\n</main>\n</body>\n</html>\n"
        )
        status, payload = self.request(
            "PUT", f"/api/sites/{site_id}/file", {"path": "public/index.html", "content": index_html}
        )
        self.assertEqual(status, 200, payload)

        body_html = "<p>これは記事{i:02d}の本文です。...1行目\nこれは記事{i:02d}の2行目\nこれは記事{i:02d}の3行目\nこれは記事{i:02d}の4行目</p>\n"
        for number in range(1, 22):
            post_id = f"20261023-{number:06d}"
            payload_body = body_html.format(i=number)
            if number > 1:
                # 記事 2 (=一覧では最古) 以降は画像を含める: 最初の1枚がサムネイルになる
                payload_body += '<img src="../images/img{i:02d}.jpg" alt="">\n'.format(i=number)
            status, payload = self.request(
                "POST",
                f"/api/sites/{site_id}/posts",
                {
                    "id": post_id,
                    "title": f"記事 {number:02d}",
                    "bodyHtml": payload_body,
                    "tags": "メモ, 旅行" if number == 21 else "",
                },
            )
            self.assertEqual(status, 200, payload)
        self.assertEqual(payload["pages"], 2)
        self.assertEqual(payload["paths"], ["public/index.html", "public/page/2.html"])

        # 個別ページは posts/YYYY/MM/DD/ に階層化される
        self.assertEqual(payload["post"], "public/posts/2026/10/23/20261023-000021.html")
        post_page = (repo / "public/posts/2026/10/23/20261023-000021.html").read_text("utf-8")
        self.assertIn('data-post-id="20261023-000021"', post_page)
        self.assertIn("data-post-tags=\"メモ, 旅行\"", post_page)
        # 日付の横に「tag: …」が同じスタイルの段落で表示される
        self.assertIn(
            "<p style=\"font-size: 0.8em; color: #888;\">2026年10月23日（金）00:00 tag: メモ, tag: 旅行</p>",
            post_page,
        )
        self.assertIn("tag: メモ, tag: 旅行", post_page)
        self.assertIn("<h1>記事 21</h1>", post_page)
        self.assertIn("これは記事21の4行目", post_page)
        self.assertIn("一覧ページへ戻る", post_page)
        # 深い階層から index.html への戻りリンク
        self.assertIn('href="../../../../index.html"', post_page)
        self.assertIn('data-post-id="20261023-000021"', post_page)
        self.assertIn("<h1>記事 21</h1>", post_page)
        self.assertIn("これは記事21の4行目", post_page)
        self.assertIn("一覧ページへ戻る", post_page)

        # トップページはスニペット 20 件 (新しい順) + 「続きを読む」
        index = (repo / "public/index.html").read_text("utf-8")
        self.assertEqual(index.count("data-post-id"), 20)
        self.assertIn(
            '<h4><a href="posts/2026/10/23/20261023-000021.html" style="color: inherit; text-decoration: none;">記事 21</a></h4>',
            index,
        )
        # 「続きを読む」は角丸のバッジ風リンク
        self.assertIn("border-radius: 999px", index)
        self.assertIn("続きを読む", index)
        self.assertIn("page/2.html", index)
        self.assertIn("次へ", index)
        self.assertLess(
            index.index("20261023-000021"),
            index.index("20261023-000002"),
        )
        self.assertNotIn("20261023-000001", index)

        # 本文に画像がある投稿は最初の1枚がサムネイルとして表示される
        # (posts/ 基準の相対パス ../images/... は index 基準に補正される)
        self.assertIn('<img src="images/img21.jpg"', index)
        self.assertEqual(index.count("<img "), 20)

        # 2 ページ目に残りの投稿と「前へ」
        page2 = (repo / "public/page/2.html").read_text("utf-8")
        self.assertEqual(page2.count("data-post-id"), 1)
        self.assertIn("../posts/2026/10/23/20261023-000001.html", page2)
        self.assertIn("前へ", page2)
        self.assertIn("../index.html", page2)
        # 画像の無い投稿 (記事 1) にはサムネイルが付かない
        self.assertNotIn("<img ", page2)

        # 個別ページの保存は一覧ページに同期される
        edited = post_page.replace("記事 21</h1>", "記事 21 (修正)</h1>").replace(
            "これは記事21の本文です。", "更新後の本文です"
        )
        status, payload = self.request(
            "PUT",
            f"/api/sites/{site_id}/file",
            {"path": "public/posts/2026/10/23/20261023-000021.html", "content": edited},
        )
        self.assertEqual(status, 200, payload)
        self.assertTrue(payload.get("sync", {}).get("ok"))
        index = (repo / "public/index.html").read_text("utf-8")
        self.assertIn("記事 21 (修正)", index)
        self.assertIn("更新後の本文です", index)
        self.assertIn("記事 10</a></h4>", index)

        # 投稿の削除は一覧から消え、過去ログページも整理される
        status, payload = self.request(
            "DELETE", f"/api/sites/{site_id}/file", {"path": "public/posts/2026/10/23/20261023-000021.html"}
        )
        self.assertEqual(status, 200, payload)
        index = (repo / "public/index.html").read_text("utf-8")
        self.assertNotIn("記事 21 (修正)", index)
        self.assertFalse((repo / "public/page/2.html").exists())

        # ヘッダー (topbar) にロゴ画像を設定した場合、個別ページでも
        # 相対パスが .. の連鎖付きに補正されて表示できる
        index_html = (repo / "public/index.html").read_text("utf-8")
        logo_html = (
            '<header class="site-topbar">'
            '<a href="index.html" style="color: inherit; text-decoration: none;">'
            '<img class="site-logo" src="images/logo.png" alt="サイトロゴ" style="max-height: 40px;">'
            "</a></header>"
        )
        status, payload = self.request(
            "PUT",
            f"/api/sites/{site_id}/file",
            {"path": "public/index.html", "content": index_html.replace("<body>\n", "<body>\n" + logo_html + "\n", 1)},
        )
        self.assertEqual(status, 200, payload)
        status, payload = self.request(
            "POST",
            f"/api/sites/{site_id}/posts",
            {
                "id": "20261023-000022",
                "title": "記事 22",
                "bodyHtml": '<p>ロゴ・コードブロック確認用の本文</p>\n<pre class="site-code-block">print("hello")</pre>\n',
            },
        )
        self.assertEqual(status, 200, payload)
        post22 = (repo / "public/posts/2026/10/23/20261023-000022.html").read_text("utf-8")
        self.assertIn('<img class="site-logo" src="../../../../images/logo.png"', post22)
        self.assertIn('href="../../../../index.html"', post22)
        # コードブロックには公開ページ向けコピーボタン環境 (style + script) が注入される
        self.assertIn('pre class="site-code-block"', post22)
        self.assertIn('id="site-code-copy-style"', post22)
        self.assertIn('id="site-code-copy-script"', post22)
        # 引用ブロックのスタイルも全ページに注入される
        self.assertIn('id="site-quote-style"', post22)
        self.assertIn("border-left: 4px solid", post22)
        # 見出し (h1〜h3) のスタイルも全ページに注入される
        self.assertIn('id="site-headings-style"', post22)
        self.assertIn("border: dashed 2px white", post22)
        index = (repo / "public/index.html").read_text("utf-8")
        self.assertIn('id="site-code-copy-script"', index)
        # 一覧のスニペットではコードブロックをテキスト行として表示する (デザイン上の都合)
        self.assertIn("print(&quot;hello&quot;)", index)
        snippet_html = index[index.index("20261023-000022") : index.index("20261023-000022") + 800]
        self.assertNotIn("<pre", snippet_html)
        # 本文が短い記事でも一覧には「続きを読む」を表示する
        self.assertIn("続きを読む", snippet_html)

        self.request("DELETE", f"/api/sites/{site_id}", {})


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
