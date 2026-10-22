"""htmedlit の起動エントリーポイント: python3 -m htmledit"""

from __future__ import annotations

import argparse
import os
import sys

from .config import CONFIG


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="htmledit", description="GitHub サイトの WYSIWYG エディター")
    parser.add_argument("--host", default=None, help="待ち受けるアドレス (既定: HTMLEDIT_HOST / 127.0.0.1)")
    parser.add_argument("--port", type=int, default=None, help="待ち受けるポート (既定: 3372)")
    parser.add_argument("--data-dir", default=None, help="データ保存先ディレクトリ")
    args = parser.parse_args(argv)

    if args.data_dir:
        os.environ["HTMLEDIT_DATA_DIR"] = args.data_dir

    # 設定はサーバー読み込み前に確定させる
    CONFIG.reload()

    from .server import serve

    serve(args.host, args.port)
    return 0


if __name__ == "__main__":
    sys.exit(main())
