"""HTTP サーバー本体."""

from __future__ import annotations

import base64
import hmac
import json
import mimetypes
import signal
import socket
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, quote, urlsplit

from . import VERSION, api, sites, terminal, websocket
from .config import APP_ROOT, CONFIG, STATIC_DIR
from .sites import REGISTRY, SiteError

MAX_BODY = 16 * 1024 * 1024


def _content_disposition(filename: str) -> str:
    """ダウンロード時のファイル名ヘッダーを作る (UTF-8 のファイル名にも対応)."""
    ascii_name = filename.encode("ascii", "replace").decode("ascii").replace('"', "")
    return (
        f'attachment; filename="{ascii_name}"; '
        f"filename*=UTF-8''{quote(filename)}"
    )


class HtmleditHandler(BaseHTTPRequestHandler):
    server_version = f"htmledit/{VERSION}"
    protocol_version = "HTTP/1.1"

    # ------------------------------------------------------------------
    # ユーティリティ
    # ------------------------------------------------------------------
    def log_message(self, fmt: str, *args) -> None:  # noqa: A003 - 標準 API
        sys.stdout.write(f"[{self.log_date_time_string()}] {fmt % args}\n")
        sys.stdout.flush()

    def _send_bytes(self, status: int, body: bytes, content_type: str, extra: dict | None = None) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("X-Frame-Options", "SAMEORIGIN")
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _send_json(self, status: int, payload: object, extra: dict | None = None) -> None:
        body = json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
        self._send_bytes(status, body, "application/json; charset=utf-8", extra)

    def _send_error_page(self, status: int, message: str) -> None:
        body = (
            "<!doctype html><html lang='ja'><head><meta charset='utf-8'>"
            f"<title>{status}</title></head><body style='font-family:system-ui;padding:2rem'>"
            f"<h1>{status}</h1><p>{message}</p></body></html>"
        ).encode("utf-8")
        self._send_bytes(status, body, "text/html; charset=utf-8")

    def _authorized(self) -> bool:
        if not CONFIG.auth_user:
            return True
        header = self.headers.get("Authorization", "")
        if not header.lower().startswith("basic "):
            return False
        try:
            decoded = base64.b64decode(header.split(" ", 1)[1]).decode("utf-8")
        except Exception:
            return False
        user, _, password = decoded.partition(":")
        ok_user = hmac.compare_digest(user, CONFIG.auth_user)
        ok_password = hmac.compare_digest(password, CONFIG.auth_password)
        return ok_user and ok_password

    def _read_body(self) -> bytes:
        length = self.headers.get("Content-Length")
        if not length:
            return b""
        try:
            size = int(length)
        except ValueError:
            return b""
        if size <= 0:
            return b""
        if size > MAX_BODY:
            raise api.ApiError(413, "リクエストボディが大きすぎます。")
        return self.rfile.read(size)

    # ------------------------------------------------------------------
    # リクエスト処理
    # ------------------------------------------------------------------
    def _handle(self, method: str) -> None:
        split = urlsplit(self.path)
        path = split.path
        try:
            if not self._authorized():
                self._send_json(
                    401,
                    {"error": "認証が必要です。"},
                    {"WWW-Authenticate": 'Basic realm="htmledit", charset="UTF-8"'},
                )
                return

            if path.startswith("/api/"):
                self._handle_api(method, path, split.query)
                return

            if path.startswith("/ws/"):
                self._handle_websocket(method, path, split.query)
                return

            if path.startswith("/site/"):
                self._handle_site_file(method, path)
                return

            self._handle_static(method, path)
        except api.ApiError as exc:
            self._send_json(exc.status, {"error": exc.message, "detail": exc.detail})
        except BrokenPipeError:  # pragma: no cover - クライアント切断
            pass
        except Exception as exc:  # pragma: no cover - 想定外
            self.log_message("error: %s: %s", type(exc).__name__, exc)
            self._send_json(500, {"error": f"サーバーエラー: {exc}"})

    def _handle_websocket(self, method: str, path: str, query: str) -> None:
        """WebSocket (ターミナル) の接続を処理する."""
        if method != "GET":
            self._send_error_page(405, "このVerbは使用できません。")
            return
        key = self.headers.get("Sec-WebSocket-Key")
        upgrade = (self.headers.get("Upgrade") or "").lower()
        if not key or upgrade != "websocket":
            self._send_error_page(400, "WebSocket 接続が必要です。")
            return

        params = parse_qs(query, keep_blank_values=True)
        session_id = (params.get("id") or ["default"])[0]
        site_id = (params.get("site") or [""])[0]
        command = (params.get("cmd") or [""])[0].strip()
        cwd_param = (params.get("cwd") or [""])[0].strip()
        cwd = str(APP_ROOT)
        if site_id:
            # cwd はサイトルートからの相対パス
            try:
                site = REGISTRY.get(site_id)
                cwd = str(sites.resolve_path(site, cwd_param)) if cwd_param else site.path
            except SiteError:
                cwd = str(APP_ROOT)

        self.wfile.write(websocket.handshake_response(key))
        self.wfile.flush()
        self.close_connection = True

        session = terminal.TERMINALS.get(session_id, cwd, command=command)
        stop = threading.Event()
        write_lock = threading.Lock()

        def send(payload: bytes, opcode: int = websocket.OP_TEXT) -> None:
            with write_lock:
                self.wfile.write(websocket.encode_frame(payload, opcode))
                self.wfile.flush()

        def pump_output() -> None:
            while not stop.is_set():
                try:
                    data = session.read()
                except OSError:
                    break
                if not data:
                    break
                try:
                    # 必ず JSON のテキストフレームで送る
                    # (バイナリフレームだとブラウザ側で Blob になり JSON.parse に失敗する)
                    message = json.dumps(
                        {"type": "data", "data": data.decode("utf-8", "replace")},
                        ensure_ascii=False,
                    ).encode("utf-8")
                    send(message, websocket.OP_TEXT)
                except (BrokenPipeError, OSError):
                    break
            stop.set()

        reader = threading.Thread(target=pump_output, daemon=True)
        reader.start()

        try:
            send(
                json.dumps({"type": "data", "data": terminal.TERMINAL_WELCOME}).encode("utf-8"),
                websocket.OP_TEXT,
            )
            while not stop.is_set():
                opcode, payload = websocket.read_frame(self.rfile)
                if opcode == websocket.OP_CLOSE:
                    break
                if opcode == websocket.OP_PING:
                    send(payload, websocket.OP_PONG)
                    continue
                if opcode not in (websocket.OP_TEXT, websocket.OP_BINARY):
                    continue
                try:
                    message = json.loads(payload.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    continue
                kind = message.get("type")
                if kind == "input":
                    session.write(str(message.get("data", "")))
                elif kind == "resize":
                    session.resize(message.get("cols", 120), message.get("rows", 35))
                elif kind == "command":
                    session.write(str(message.get("data", "")) + "\n")
                elif kind == "kill":
                    terminal.TERMINALS.close(session_id)
                    break
        except (ConnectionError, OSError):
            pass
        finally:
            stop.set()
            reader.join(timeout=1.0)

    def _handle_site_file(self, method: str, path: str) -> None:
        """サイトのリポジトリ内のファイルを配信する.

        エディター (WYSIWYG / プレビュー) 内の相対 URL を解決するために使う。
        """
        if method not in ("GET", "HEAD"):
            self._send_error_page(405, "このVerbは使用できません。")
            return
        remainder = path[len("/site/") :]
        site_id, _, relative = remainder.partition("/")
        if not site_id or not relative:
            self._send_error_page(404, "ファイルが見つかりません。")
            return
        try:
            site = REGISTRY.get(site_id)
            target = sites.resolve_path(site, relative)
        except SiteError:
            self._send_error_page(404, "ファイルが見つかりません。")
            return
        if not target.is_file():
            self._send_error_page(404, "ファイルが見つかりません。")
            return
        content_type, _ = mimetypes.guess_type(str(target))
        if content_type is None:
            content_type = "application/octet-stream"
        if content_type.startswith("text/") or content_type in ("application/javascript", "application/json"):
            content_type += "; charset=utf-8"
        body = target.read_bytes()
        self._send_bytes(
            200,
            body,
            content_type,
            {"Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*"},
        )

    def _handle_api(self, method: str, path: str, query: str) -> None:
        body = self._read_body()
        request = api.Request(
            method=method,
            path=path,
            query=parse_qs(query),
            headers={key.lower(): value for key, value in self.headers.items()},
            body=body,
        )
        result = api.dispatch(request)
        if isinstance(result, api.RawResponse):
            extra = {}
            if result.filename:
                extra["Content-Disposition"] = _content_disposition(result.filename)
            self._send_bytes(result.status, result.body, result.content_type, extra)
            return
        self._send_json(200, result)

    def _handle_static(self, method: str, path: str) -> None:
        if method not in ("GET", "HEAD"):
            self._send_error_page(405, "このVerbは使用できません。")
            return
        relative = "index.html" if path in ("/", "") else path.lstrip("/")
        if relative.startswith("static/"):
            relative = relative[len("static/") :]
        target = (STATIC_DIR / relative).resolve()
        try:
            target.relative_to(STATIC_DIR.resolve())
        except ValueError:
            self._send_error_page(403, "アクセスが許可されていないパスです。")
            return
        if not target.is_file():
            self._send_error_page(404, "ファイルが見つかりません。")
            return
        content_type, _ = mimetypes.guess_type(str(target))
        if content_type is None:
            content_type = "application/octet-stream"
        if content_type.startswith("text/") or content_type in ("application/javascript", "application/json"):
            content_type += "; charset=utf-8"
        body = target.read_bytes()
        cache = "no-cache" if target.suffix in (".html",) else "public, max-age=300"
        self._send_bytes(200, body, content_type, {"Cache-Control": cache})

    def do_GET(self) -> None:  # noqa: N802 - 標準 API
        self._handle("GET")

    def do_HEAD(self) -> None:  # noqa: N802
        self._handle("HEAD")

    def do_POST(self) -> None:  # noqa: N802
        self._handle("POST")

    def do_PUT(self) -> None:  # noqa: N802
        self._handle("PUT")

    def do_PATCH(self) -> None:  # noqa: N802
        self._handle("PATCH")

    def do_DELETE(self) -> None:  # noqa: N802
        self._handle("DELETE")


class HtmleditServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    address_family = socket.AF_INET


def create_server(host: str | None = None, port: int | None = None) -> HtmleditServer:
    CONFIG.ensure_dirs()
    address = (host or CONFIG.host, port if port is not None else CONFIG.port)
    return HtmleditServer(address, HtmleditHandler)


def serve(host: str | None = None, port: int | None = None) -> None:
    server = create_server(host, port)
    bound_host, bound_port = server.server_address[:2]

    def shutdown(_signum, _frame):  # pragma: no cover - シグナル処理
        threading.Thread(target=server.shutdown, daemon=True).start()

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, shutdown)
        except ValueError:  # pragma: no cover - メインスレッド以外
            pass

    sys.stdout.write(f"htmledit v{VERSION} listening on http://{bound_host}:{bound_port}\n")
    sys.stdout.flush()
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        server.server_close()
