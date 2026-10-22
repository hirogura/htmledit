"""WebSocket (RFC 6455) の最小実装.

標準ライブラリだけでブラウザとの WebSocket 通信を行う。
"""

from __future__ import annotations

import base64
import hashlib
import os
import struct

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

OP_CONT = 0x0
OP_TEXT = 0x1
OP_BINARY = 0x2
OP_CLOSE = 0x8
OP_PING = 0x9
OP_PONG = 0xA


def accept_key(client_key: str) -> str:
    """Sec-WebSocket-Accept の値を返す."""
    digest = hashlib.sha1((client_key.strip() + GUID).encode("utf-8")).digest()
    return base64.b64encode(digest).decode("ascii")


def encode_frame(payload: bytes, opcode: int = OP_TEXT) -> bytes:
    """WebSocket フレームをエンコードする."""
    header = bytearray()
    header.append(0x80 | opcode)
    length = len(payload)
    if length < 126:
        header.append(length)
    elif length < 65536:
        header.append(126)
        header += struct.pack("!H", length)
    else:
        header.append(127)
        header += struct.pack("!Q", length)
    return bytes(header) + payload


def _read_exact(stream, size: int) -> bytes:
    chunks = []
    remaining = size
    while remaining > 0:
        chunk = stream.read(remaining)
        if not chunk:
            raise ConnectionError("接続が切断されました")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def read_frame(stream) -> tuple[int, bytes]:
    """1 フレームを読み込んで (opcode, payload) を返す."""
    head = _read_exact(stream, 2)
    opcode = head[0] & 0x0F
    masked = bool(head[1] & 0x80)
    length = head[1] & 0x7F
    if length == 126:
        length = struct.unpack("!H", _read_exact(stream, 2))[0]
    elif length == 127:
        length = struct.unpack("!Q", _read_exact(stream, 8))[0]
    mask = b""
    if masked:
        mask = _read_exact(stream, 4)
    payload = _read_exact(stream, length) if length else b""
    if masked and payload:
        payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
    return opcode, payload


def handshake_response(client_key: str) -> bytes:
    """WebSocket 升级のレスポンスヘッダを返す."""
    return (
        "HTTP/1.1 101 Switching Protocols\r\n"
        "Upgrade: websocket\r\n"
        "Connection: Upgrade\r\n"
        f"Sec-WebSocket-Accept: {accept_key(client_key)}\r\n"
        "\r\n"
    ).encode("ascii")


def set_window_size(fd: int, cols: int, rows: int) -> None:
    """PTY のウィンドウサイズを設定する."""
    try:
        import fcntl
        import struct as _struct
        import termios

        fcntl.ioctl(fd, termios.TIOCSWINSZ, _struct.pack("HHHH", rows, cols, 0, 0))
    except Exception:  # pragma: no cover - 環境依存
        pass


def random_id(prefix: str = "") -> str:
    return prefix + base64.urlsafe_b64encode(os.urandom(9)).decode("ascii").rstrip("=")
