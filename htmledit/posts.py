"""1記事=1ページの個別記事と、一覧ページ (スニペット/ページネーション) の管理.

- 個別ページ: public/posts/YYYY/MM/DD/HHMMSS.html (タイトル / 本文全文 / 写真 を含む、日付で階層分け)
- 一覧ページ: public/index.html と public/page/2.html 以降 (スニペット article を最大 20 件ずつ)
- スニペットは data-post-id="YYYYMMDD-HHMMSS" で識別し、個別ページの保存・削除時に再構築する
- 本文に画像がある場合は最初の1枚をサムネイルとして一覧に表示する
"""

from __future__ import annotations

import html
import logging
import re
import threading
from datetime import datetime
from pathlib import Path, PurePosixPath

from . import sites
from .sites import Site, SiteError

logger = logging.getLogger("htmledit.posts")

POST_ID_RE = re.compile(r"^\d{8}-\d{6}$")
PAGE_SIZE = 20
SNIPPET_MAX_LINES = 3
SNIPPET_MAX_CHARS = 100

INDEX_PAGE = "public/index.html"
POST_PAGE_PREFIX = "public/posts"

_SMALL_TEXT_STYLE = "font-size: 0.8em; color: #888;"
_THUMB_STYLE = "height: 120px; width: auto; border-radius: 8px; float: right; margin: 0 0 8px 12px;"
_TITLE_LINK_STYLE = "color: inherit; text-decoration: none;"
_READ_MORE_STYLE = (
    "display: inline-block; padding: 2px 11px; border: 1px solid #d5dbe2;"
    " border-radius: 999px; font-size: 0.8em; color: #5a6470; text-decoration: none;"
)
_BACK_LINK_LABEL = "一覧ページへ戻る"
_NAV_STYLE = (
    "display: flex; flex-wrap: wrap; gap: 4px 16px; justify-content: center;"
    " align-items: center; margin: 24px 0 4px; font-size: 13px; color: #8a929c;"
)

_TITLE_RE = re.compile(r"<title\b[^>]*>[\s\S]*?</title\s*>", re.I)
_STAMP_RE = re.compile(r"<p\b(?=[^>]*font-size)[^>]*>[\s\S]*?</p\s*>", re.I)
_MANAGED_OPEN_RE = re.compile(r"<article\b(?=[^>]*\bdata-post-id\s*=)([^>]*)>", re.I)

# コードブロック (pre.site-code-block) の右上にコピーボタンを付ける環境。
# editor.js の CODE_COPY_STYLE / CODE_COPY_SCRIPT (プレビュー用) と内容を合わせること。
_CODE_COPY_STYLE = '<style id="site-code-copy-style">\n' + "\n".join(
    [
        "    pre.site-code-block {",
        "      position: relative;",
        "      box-sizing: border-box;",
        "      padding: 12px 96px 12px 14px;",
        "      margin: 12px 0;",
        "      background: #f6f7f8;",
        "      border: 1px solid #e3e6ea;",
        "      border-radius: 8px;",
        "      overflow-x: auto;",
        "      white-space: pre;",
        "      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;",
        "      font-size: 0.9em;",
        "      line-height: 1.55;",
        "    }",
        "    .site-code-copy {",
        "      position: absolute;",
        "      top: 6px;",
        "      right: 6px;",
        "      padding: 5px 10px;",
        "      border: 1px solid #d3d8de;",
        "      border-radius: 6px;",
        "      background: #ffffff;",
        "      color: #5a6570;",
        "      font-size: 12px;",
        "      line-height: 1;",
        "      cursor: pointer;",
        "    }",
        "    .site-code-copy:hover { background: #eef1f4; }",
        "    .site-code-copy:disabled { opacity: 0.75; cursor: default; }",
    ]
) + "\n    </style>"
_CODE_COPY_SCRIPT = (
    '<script id="site-code-copy-script">\n'
    '(function () {\n'
    '  "use strict";\n'
    '  function copyText(text) {\n'
    '    if (navigator.clipboard && navigator.clipboard.writeText) {\n'
    '      navigator.clipboard.writeText(text).catch(function () { fallbackCopy(text); });\n'
    '      return;\n'
    '    }\n'
    '    fallbackCopy(text);\n'
    '  }\n'
    '  function fallbackCopy(text) {\n'
    '    var area = document.createElement("textarea");\n'
    '    area.value = text;\n'
    '    area.style.position = "fixed";\n'
    '    area.style.opacity = "0";\n'
    '    document.body.appendChild(area);\n'
    '    area.select();\n'
    '    try { document.execCommand("copy"); } catch (error) { /* 無視 */ }\n'
    '    document.body.removeChild(area);\n'
    '  }\n'
    '  function init() {\n'
    '    var blocks = document.querySelectorAll("pre.site-code-block");\n'
    '    Array.prototype.forEach.call(blocks, function (pre) {\n'
    '      if (pre.getAttribute("data-code-copy") === "1") { return; }\n'
    '      pre.setAttribute("data-code-copy", "1");\n'
    '      var code = pre.textContent;\n'
    '      var btn = document.createElement("button");\n'
    '      btn.type = "button";\n'
    '      btn.className = "site-code-copy";\n'
    '      btn.textContent = "コピー";\n'
    '      btn.addEventListener("click", function () {\n'
    '        copyText(code);\n'
    '        btn.textContent = "コピーしました";\n'
    '        btn.disabled = true;\n'
    '        window.setTimeout(function () {\n'
    '          btn.textContent = "コピー";\n'
    '          btn.disabled = false;\n'
    '        }, 1600);\n'
    '      });\n'
    '      pre.appendChild(btn);\n'
    '    });\n'
    '  }\n'
    '  if (document.readyState === "loading") {\n'
    '    document.addEventListener("DOMContentLoaded", init);\n'
    '  } else {\n'
    '    init();\n'
    '  }\n'
    '})();\n'
    '</script>'
)
_CODE_COPY_BLOCK = _CODE_COPY_STYLE + "\n" + _CODE_COPY_SCRIPT + "\n"

# 引用 (blockquote) を帯つきのブロックで表示する環境。
# editor.js の QUOTE_STYLE_MARKUP (プレビュー用) と内容を合わせること。
QUOTE_STYLE_MARKUP = (
    '<style id="site-quote-style">\n'
    "    blockquote {"
    " margin: 12px 0; padding: 10px 14px; border-left: 4px solid #9aa7b4;"
    " background: #f4f6f8; color: #4a5560; border-radius: 0 8px 8px 0;"
    " }\n"
    "    </style>"
)

# 見出し (h1〜h4) の装飾スタイル。
# 公開ページ用 (htmledit 本体の UI やエディターに波及しないよう .container / article 配下に限定)。
HEADINGS_STYLE_MARKUP = (
    '<style id="site-headings-style">\n'
    "    .container h1,\n"
    "    article h1 {\n"
    "      display: flow-root;\n"
    "      background: #dfefff;\n"
    "      box-shadow: 0 0 0 5px #dfefff;\n"
    "      border: dashed 2px white;\n"
    "      padding: 0.2em 0.5em;\n"
    "      margin: 1.2em 5px 0.6em;\n"
    "      font-size: 1.5em;\n"
    "      line-height: 1.4;\n"
    "      color: #2b3138;\n"
    "    }\n"
    "    .container h2,\n"
    "    article h2 {\n"
    "      display: flow-root;\n"
    "      position: relative;\n"
    "      background: #f1f8ff;\n"
    "      padding: 0.35em 0.5em;\n"
    "      border-left: solid 2em #5c9ee7;\n"
    "      margin: 1.4em 0 0.6em;\n"
    "      font-size: 1.3em;\n"
    "      line-height: 1.4;\n"
    "      color: #2b3138;\n"
    "    }\n"
    "    .container h2::before,\n"
    "    article h2::before {\n"
    '      content: "";\n'
    "      position: absolute;\n"
    "      left: -1.5em;\n"
    "      top: 50%;\n"
    "      transform: translateY(-50%);\n"
    "      width: 1em;\n"
    "      height: 1em;\n"
    '      background: url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 512 512\' fill=\'white\'%3E%3Cpath d=\'M410.3 231l11.3-11.3-33.9-33.9-62.1-62.1L291.7 89.8l-11.3 11.3-22.6 22.6L58.6 322.9c-10.4 10.4-18 23.3-22.2 37.4L1 480.7c-2.5 8.4-.2 17.5 6.1 23.7s15.3 8.5 23.7 6.1l120.3-35.4c14.1-4.2 27-11.8 37.4-22.2L387.7 253.7 410.3 231zM160 399.4l-9.1 22.7c-4 3.1-8.5 5.4-13.3 6.9L59.4 452l23-78.2c1.5-4.8 3.8-9.3 6.9-13.3l22.7-9.1 32 32zM362.7 18.7L341.3 40.1l33.9 33.9 21.4-21.4c6.2-6.2 6.2-16.4 0-22.6l-11.3-11.3c-6.2-6.2-16.4-6.2-22.6 0z\'/%3E%3C/svg%3E") no-repeat center / contain;\n'
    "    }\n"
    "    .container h3,\n"
    "    article h3 {\n"
    "      display: flow-root;\n"
    "      position: relative;\n"
    "      background: #ffd98a;\n"
    "      padding: 4px 10px 4px 28px;\n"
    "      font-size: 20px;\n"
    "      line-height: 1.4;\n"
    "      color: #474747;\n"
    "      border-radius: 0 10px 10px 0;\n"
    "      margin: 1.4em 0 0.6em 20px;\n"
    "    }\n"
    "    .container h3::before,\n"
    "    article h3::before {\n"
    '      content: "";\n'
    "      box-sizing: border-box;\n"
    "      position: absolute;\n"
    "      width: 40px;\n"
    "      height: 40px;\n"
    "      left: -20px;\n"
    "      top: 50%;\n"
    "      transform: translateY(-50%);\n"
    "      background-color: #ffa337;\n"
    "      border: solid 3px white;\n"
    "      border-radius: 50%;\n"
    '      background-image: url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 512 512\' fill=\'white\'%3E%3Cpath d=\'M505.1 19.1c-1.2-5.5-6.7-11-12.2-12.2C460.7 0 435.5 0 410.4 0 307.2 0 245.3 55.2 199.1 128H94.8c-16.3 0-35.6 11.9-42.9 26.5L2.5 253.3A28.4 28.4 0 0 0 0 264a24 24 0 0 0 24 24h103.8l-22.5 22.5c-11.4 11.4-13 32.3 0 45.3l50.9 50.9c11.2 11.2 32.2 13.2 45.3 0l22.5-22.5V488a24 24 0 0 0 24 24 28.6 28.6 0 0 0 10.7-2.5l98.7-49.4c14.6-7.3 26.5-26.5 26.5-42.9V312.8c72.6-46.3 128-108.4 128-211.1 0-25.2 0-50.4-7-82.6zM384 168a40 40 0 1 1 40-40 40 40 0 0 1-40 40z\'/%3E%3C/svg%3E");\n'
    "      background-repeat: no-repeat;\n"
    "      background-position: center;\n"
    "      background-size: 20px 20px;\n"
    "    }\n"
    "    .container h4,\n"
    "    article h4 {\n"
    "      display: flow-root;\n"
    "      position: relative;\n"
    "      isolation: isolate;\n"
    "      margin: 1.4em 0 0.6em 20px;\n"
    "      font-size: 20px;\n"
    "      line-height: 1.4;\n"
    "      color: #333;\n"
    "      text-shadow: 0 0 2px white;\n"
    "    }\n"
    "    .container h4::before,\n"
    "    article h4::before {\n"
    '      content: "";\n'
    "      position: absolute;\n"
    "      background: #9de5ff;\n"
    "      width: 50px;\n"
    "      height: 50px;\n"
    "      border-radius: 50%;\n"
    "      top: 50%;\n"
    "      left: -15px;\n"
    "      transform: translateY(-50%);\n"
    "      z-index: -1;\n"
    "    }\n"
    "    </style>"
)


def _ensure_in_head(html_text: str, marker: str, block: str) -> str:
    """marker が無いページに </head> 直前で block を注入する."""
    if not html_text or marker in html_text:
        return html_text
    close = re.search(r"</head\s*>", html_text, re.I)
    if not close:
        return _ensure_in_body(html_text, marker, block)
    return html_text[: close.start()] + block + "\n" + html_text[close.start():]


def _ensure_in_body(html_text: str, marker: str, block: str) -> str:
    """marker が無いページに </body> 直前で block を注入する."""
    if not html_text or marker in html_text:
        return html_text
    close = re.search(r"</body\s*>", html_text, re.I)
    if not close:
        return html_text
    return html_text[: close.start()] + block + html_text[close.start():]


def _ensure_code_copy(html_text: str) -> str:
    """公開ページにコードブロックのコピーボタン環境が無ければ </body> 直前に注入する."""
    return _ensure_in_body(html_text, 'id="site-code-copy-script"', _CODE_COPY_BLOCK)


def _ensure_quote_style(html_text: str) -> str:
    """公開ページに引用ブロックのスタイルが無ければ </body> 直前に注入する."""
    return _ensure_in_body(html_text, 'id="site-quote-style"', QUOTE_STYLE_MARKUP)


def _ensure_headings_style(html_text: str) -> str:
    """公開ページの見出しスタイルを最新の内容に揃える (head 直前に注入する)."""
    if not html_text:
        return html_text
    # 旧バージョンのスタイル (body 内 / head 内) を除去して最新版を注入し直す
    pattern = re.compile(
        r'<style\b[^>]*\bid=["\']site-headings-style["\'][^>]*>[\s\S]*?</style\s*>\n?', re.I
    )
    html_text = pattern.sub("", html_text)
    return _ensure_in_head(html_text, 'id="site-headings-style"', HEADINGS_STYLE_MARKUP)


def _ensure_site_env(html_text: str) -> str:
    """公開ページに付属環境 (コードコピー / 引用スタイル / 見出しスタイル) を揃えて注入する."""
    return _ensure_headings_style(_ensure_quote_style(_ensure_code_copy(html_text)))
_MANAGED_ID_RE = re.compile(r'data-post-id\s*=\s*"([^"]*)"', re.I)

_LOCK = threading.RLock()


# --------------------------------------------------------------------------
# HTML 断片ユーティリティ
# --------------------------------------------------------------------------

def _class_list(tag: str) -> list[str]:
    match = re.search(r'class\s*=\s*(?:"([^"]*)"|\'([^\']*)\'|([^\s>]+))', tag, re.I)
    if not match:
        return []
    value = match.group(1) or match.group(2) or match.group(3) or ""
    return [part for part in value.strip().split() if part]


def _container_span(html_text: str):
    """<article|section|div class="posts"> の開始タグ〜閉じタグを探す.

    戻り値は (開始タグ始点, 開始タグ終点, 内側始点, 内側終点)
    内側 = 開始タグの直後 〜 閉じタグの直前。見つからなければ None。
    """
    open_re = re.compile(r"<(article|section|div)\b[^>]*>", re.I)
    for match in open_re.finditer(html_text):
        tag = match.group(1).lower()
        if "posts" not in _class_list(match.group(0)):
            continue
        close_re = re.compile(rf"<(/?){tag}\b[^>]*>", re.I)
        depth = 0
        for token in close_re.finditer(html_text, match.start()):
            if token.group(1):
                depth -= 1
                if depth == 0:
                    return (match.start(), match.end(), match.end(), token.start())
                continue
            depth += 1
        return (match.start(), match.end(), match.end(), len(html_text))
    return None


def _iterate_blocks(inner: str) -> list[dict]:
    """data-post-id を持つ <article> ブロックを列挙する."""
    result = []
    pos = 0
    while True:
        match = _MANAGED_OPEN_RE.search(inner, pos)
        if not match:
            return result
        close = re.compile(r"</article\s*>", re.I).search(inner, match.end())
        inner_end = close.start() if close else len(inner)
        close_index = close.end() if close else len(inner)
        post_id = ""
        id_match = _MANAGED_ID_RE.search(match.group(1))
        if id_match:
            post_id = id_match.group(1)
        if post_id and POST_ID_RE.match(post_id):
            result.append(
                {
                    "id": post_id,
                    "attrs": match.group(1),
                    "inner": inner[match.end() : inner_end],
                    "start": match.start(),
                    "end": close_index,
                }
            )
        pos = close_index if close_index > match.end() else match.end() + 1


def _strip_blocks(inner: str, blocks: list[dict]) -> str:
    """data-post-id ブロックを取り除いた残り (手動コンテンツ) を返す."""
    parts = []
    last = 0
    for block in blocks:
        parts.append(inner[last : block["start"]])
        last = block["end"]
    parts.append(inner[last:])
    return "".join(parts)


def _plain_text(html_text: str) -> str:
    text = re.sub(r"<(script|style)\b[\s\S]*?</\1\s*>", " ", html_text, flags=re.I)
    text = re.sub(r"<br\s*/?\s*>", "\n", text, flags=re.I)
    text = re.sub(r"</(?:p|div|h[1-6]|li|blockquote|pre|section|article|figure)\s*>", "\n", text, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text)
    text = re.sub(r"[ \t\xa0]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n", text)
    lines = [line.strip() for line in text.split("\n")]
    return "\n".join(line for line in lines if line).strip()


def _drop_paragraph(text: str, needle: str) -> str:
    """needle を含む <p> 要素を取り除く."""
    index = text.find(needle)
    while index != -1:
        start = -1
        for match in re.finditer(r"<p\b", text[:index], re.I):
            start = match.start()
        end = text.find("</p>", index)
        if start != -1 and end != -1:
            text = text[:start] + text[end + 4 :]
            index = text.find(needle)
        else:
            break
    return text


def _article_source(article_inner: str) -> tuple[str, str]:
    """個別ページ article 内から (タイトル, 本文HTML) を取り出す.

    戻るリンクと投稿日時行はスニペット生成の対象から除外する。
    """
    text = _drop_paragraph(article_inner, _BACK_LINK_LABEL)
    text = _STAMP_RE.sub(" ", text)
    match = re.search(r"<h1\b[^>]*>([\s\S]*?)</h1\s*>", text, re.I)
    title = _plain_text(match.group(1)) if match else ""
    if match:
        body = text[: match.start()] + text[match.end() :]
    else:
        body = text
    return title.strip(), body.strip()


# コードブロック (pre.site-code-block)。一覧のスニペットでも <pre> のまま保持する。
_CODE_BLOCK_RE = re.compile(
    r'<pre\b(?=[^>]*class\s*=\s*["\'][^"\']*site-code-block[^"\']*["\'])[^>]*>([\s\S]*?)</pre\s*>',
    re.I,
)


def _code_text(inner: str) -> str:
    """<pre> の中身からコード文字列を取り出す."""
    text = re.sub(r"<br\s*/?\s*>", "\n", inner or "", flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    return "\n".join(line.rstrip() for line in html.unescape(text).split("\n")).strip("\n")


def _snippet_parts(body_html: str) -> tuple[list, bool]:
    """本文から最初の 3 行 (最大 100 文字程度) のスニペットを取り出す.

    戻り値は (チャンク, 切り詰めたか)。チャンクは現在常に ("p", 行リスト)
    (コードブロックは一覧のスニペットではテキスト行として表示し、記事ページ
    でだけ <pre> として表示する)。件施行前の都合でチャンク構造は保持。
    """
    source = body_html or ""
    items = []  # [("p", 行テキスト)]

    def push_text(segment: str) -> None:
        for line in _plain_text(segment).split("\n"):
            if line:
                items.append(("p", line))

    def push_code(inner: str) -> None:
        for line in _code_text(inner).split("\n"):
            if line.strip():
                items.append(("p", line))

    position = 0
    for match in _CODE_BLOCK_RE.finditer(source):
        if match.start() > position:
            push_text(source[position : match.start()])
        push_code(match.group(1))
        position = match.end()
    if position < len(source):
        push_text(source[position:])

    multiple_images = len(re.findall(r"<img\b", source, re.I)) > 1
    kept = []  # [kind と行]
    total = 0
    truncated = False
    for index, (kind, line) in enumerate(items):
        if len(kept) >= SNIPPET_MAX_LINES:
            truncated = True
            break
        if kept and total + len(line) > SNIPPET_MAX_CHARS:
            truncated = True
            break
        if not kept and len(line) > SNIPPET_MAX_CHARS:
            kept.append((kind, line[: SNIPPET_MAX_CHARS - 1] + "…"))
            truncated = True
            break
        kept.append((kind, line))
        total += len(line) + 1
        if len(kept) >= SNIPPET_MAX_LINES and index < len(items) - 1:
            truncated = True
            break
    if not truncated and len(items) > len(kept):
        truncated = True
    if multiple_images:
        truncated = True

    chunks = []
    for kind, line in kept:
        if chunks and chunks[-1][0] == kind:
            chunks[-1][1].append(line)
        else:
            chunks.append((kind, [line]))
    return chunks, truncated


def _timestamp_text(post_id: str) -> str:
    try:
        stamp = datetime.strptime(post_id, "%Y%m%d-%H%M%S")
    except ValueError:
        return ""
    weekdays = "月火水木金土日"
    return (
        f"{stamp.year}年{stamp.month:02d}月{stamp.day:02d}日"
        f"（{weekdays[stamp.weekday()]}）{stamp:%H:%M}"
    )


def _parse_flags(attrs: str) -> tuple[bool, bool]:
    """article タグに保存した投稿オプション (日時 / 区切り線) を取り出す."""

    def flag(name: str) -> bool:
        match = re.search(rf'data-post-{name}\s*=\s*"([^"]*)"', attrs, re.I)
        if not match:
            return True
        return match.group(1).strip().lower() not in ("", "0", "false", "no", "off")

    return flag("timestamp"), flag("divider")


def _parse_tags(attrs: str) -> str:
    """article タグの data-post-tags 属性からタグ一覧 (カンマ区切り) を取り出す."""
    match = re.search(r'data-post-tags\s*=\s*"([^"]*)"', attrs, re.I)
    return _normalize_tags(match.group(1) if match else "")


def _normalize_tags(tags: str) -> str:
    """タグ入力を正規化する (カンマ/読点/空白/改行区切り → カンマ区切り, 重複除去)."""
    if isinstance(tags, (list, tuple)):
        parts: list[str] = [str(tag) for tag in tags]
    else:
        parts = re.split(r"[,、;；\s]+", str(tags or ""))
    seen: set[str] = set()
    normalized = []
    for part in parts:
        tag = part.strip()
        if tag and tag not in seen:
            seen.add(tag)
            normalized.append(tag)
    return ", ".join(normalized)


def _tags_text(tags: str) -> str:
    """日付の横に表示するタグ文字列 (「tag:メモ, tag:旅行」形式) を返す."""
    normalized = _normalize_tags(tags)
    if not normalized:
        return ""
    return ", ".join(f"tag: {html.escape(tag, quote=True)}" for tag in normalized.split(", "))


def _stamp_text(post_id: str, tags: str = "") -> str:
    """記事の表示用日時 (タグ指定時は日付の横に「tag:…」を併記) を返す."""
    stamp = _timestamp_text(post_id)
    tags_text = _tags_text(tags)
    if stamp and tags_text:
        return f"{stamp} {tags_text}"
    return stamp or tags_text


def _first_image_src(body_html: str) -> str:
    """本文 HTML から最初の <img> の src を取り出す (なければ空文字)."""
    match = re.search(r'<img\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|\'([^\']*)\'|([^\s>]+))', body_html, re.I)
    if not match:
        return ""
    return (match.group(1) or match.group(2) or match.group(3) or "").strip()


def _thumb_src(src: str, on_index: bool) -> str:
    """個別ページ基準の画像パスを一覧ページの位置に合わせて補正する.

    個別ページの階層は posts/YYYY/MM/DD/*.html など深さが変わるため、
    先頭の ../ を一旦すべて外して public/ 基準に正規化してから付け直す。
    - index.html (public/): ../../images/a.jpg → images/a.jpg
    - page/N.html (public/page/): ../../images/a.jpg → ../images/a.jpg
    外部 URL / パス解決不能なものは空文字でサムネイルを無効化する。
    """
    text = (src or "").strip()
    if not text or text.startswith("#") or text.startswith("//") or text.startswith(r"\\"):
        return ""
    if re.match(r"^[a-zA-Z][a-zA-Z0-9+.\-]*:", text):
        return text
    if text.startswith("/"):
        return ""  # サイトルート相対はサブディレクトリ配置で壊れ得るため諦める
    # ../ はすべて外す (無い場合も index 基準の参照とみなしてそのまま使う)
    text = re.sub(r"^(\.\./)+", "", text)
    return text if on_index else "../" + text


def _post_page_relpath(post_id: str) -> str:
    """個別ページの public/ からの相対パス (posts/YYYY/MM/DD/HHMMSS.html) を返す."""
    return f"posts/{post_id[:4]}/{post_id[4:6]}/{post_id[6:8]}/{post_id}.html"


# --------------------------------------------------------------------------
# HTML 生成
# --------------------------------------------------------------------------

def _snippet_inner(post_id: str, title: str, body_html: str, with_timestamp: bool, with_divider: bool, link: str, thumb_src: str = "", tags: str = "") -> str:
    chunks, _ = _snippet_parts(body_html)
    # タイトルは青字・下線にしない (シンプルに本文色で)
    lines = []
    if thumb_src:
        lines.append(f'<p style="text-align: right; margin: 0 0 8px;"><img src="{thumb_src}" alt="" style="{_THUMB_STYLE}" /></p>')
    lines.append(f'<h4><a href="{link}" style="{_TITLE_LINK_STYLE}">{html.escape(title or "無題")}</a></h4>')
    read_more_link = f'<a href="{link}" style="{_READ_MORE_STYLE}">続きを読む</a>'
    read_more_label = "&nbsp;" + read_more_link  # 本文末尾とくっつかないよう一行空ける
    rendered = []
    for kind, chunk_lines in chunks:
        if kind == "code":
            rendered.append('<pre class="site-code-block">' + html.escape("\n".join(chunk_lines)) + "</pre>")
        else:
            rendered.append("<p>" + "<br />\n  ".join(html.escape(line) for line in chunk_lines) + "</p>")
    # 一覧ページは記事の抜粋なので、本文が短くても個別ページへの導線を必ず出す
    if rendered and rendered[-1].startswith("<p>"):
        rendered[-1] = rendered[-1].replace("</p>", read_more_label + "</p>")
    else:
        rendered.append(f"<p>{read_more_link}</p>")
    lines.extend(rendered)
    if with_timestamp:
        stamp = _stamp_text(post_id, tags)
        if stamp:
            lines.append(f'<p style="{_SMALL_TEXT_STYLE}">{stamp}</p>')
    if with_divider:
        lines.append("<hr />")
    return "\n  ".join(lines)


def _post_article(post_id: str, title: str, body_html: str, with_timestamp: bool, with_divider: bool, back_link: str, tags: str = "") -> str:
    tag_attr = f' data-post-tags="{html.escape(_normalize_tags(tags), quote=True)}"' if _normalize_tags(tags) else ""
    attrs = " ".join(
        [
            f'class="post-page" data-post-id="{post_id}"',
            f'data-post-timestamp="{"1" if with_timestamp else "0"}"',
            f'data-post-divider="{"1" if with_divider else "0"}"{tag_attr}',
        ]
    )
    inner = [f"<h1>{html.escape(title or '無題')}</h1>"]
    if body_html:
        inner.append(body_html)
    if with_timestamp:
        stamp = _stamp_text(post_id, tags)
        if stamp:
            inner.append(f'<p style="{_SMALL_TEXT_STYLE}">{stamp}</p>')
    if with_divider:
        inner.append("<hr />")
    inner.append(f'<p style="{_SMALL_TEXT_STYLE}"><a href="{back_link}">&laquo; {_BACK_LINK_LABEL}</a></p>')
    return f"<article {attrs}>\n  " + "\n  ".join(inner) + "\n</article>"


def _adjust_relative_hrefs(doc: str, depth: int = 1) -> str:
    """個別ページ (posts/YYYY/MM/DD/) 内の相対リンクを .. の連鎖付きに補正する.

    対象は <a> / <link> の href と <img> の src (サイトロゴなどヘッダー画像も
    個別ページの階層で参照できるように)。depth = 個別ページの public/ 内での
    ディレクトリの深さ (posts/ID.html なら 1)。script/style の中身は触らない。
    """
    pattern = re.compile(r'(<(?:a|link)\b[^>]*\bhref\s*=\s*|<img\b[^>]*\bsrc\s*=\s*)(["\'])([^"\']+?)\2', re.I)
    mask_re = re.compile(r"<(script|style)\b[\s\S]*?</\1\s*>", re.I)

    def replace(match) -> str:
        quote, value = match.group(2), match.group(3)
        text = value.strip()
        if (
            not text
            or text.startswith("../")
            or text.startswith("/")
            or text.startswith("#")
            or re.match(r"^[a-zA-Z][a-zA-Z0-9+.\-]*:", text)
        ):
            return match.group(0)
        return match.group(1) + quote + "../" * depth + value + quote

    parts = []
    last = 0
    for mask in mask_re.finditer(doc):
        parts.append(pattern.sub(replace, doc[last : mask.start()]))
        parts.append(mask.group(0))
        last = mask.end()
    parts.append(pattern.sub(replace, doc[last:]))
    return "".join(parts)


def _replace_title(doc: str, page_title: str) -> str:
    escaped = html.escape(page_title, quote=False)
    if _TITLE_RE.search(doc):
        return _TITLE_RE.sub(lambda _: f"<title>{escaped}</title>", doc, count=1)
    return doc


def _replace_main_inner(doc: str, article_html: str) -> str:
    match = re.search(r"<main\b[^>]*>", doc, re.I)
    if not match:
        body_close = re.compile(r"</body\s*>", re.I).search(doc)
        if body_close:
            return doc[: body_close.start()] + article_html + "\n" + doc[body_close.start() :]
        return doc + article_html + "\n"
    close_re = re.compile(r"<(/?)main\b[^>]*>", re.I)
    depth = 0
    for token in close_re.finditer(doc, match.start()):
        if token.group(1):
            depth -= 1
            if depth == 0:
                return doc[: match.end()] + "\n" + article_html + "\n  " + doc[token.start() :]
            continue
        depth += 1
    return doc


def _render_post_document(index_html: str, article_html: str, page_title: str, depth: int = 1) -> str:
    if not index_html:
        return (
            "<!doctype html>\n"
            '<html lang="ja">\n'
            "<head>\n"
            '    <meta charset="utf-8" />\n'
            '    <meta name="viewport" content="width=device-width, initial-scale=1" />\n'
            f"    <title>{html.escape(page_title, quote=False)}</title>\n"
            "    <style>\n"
            "    * { box-sizing: border-box; }\n"
            "    body { margin: 0; font-family: system-ui, sans-serif; color: #2b3138; line-height: 1.7; }\n"
            "    .container { max-width: 760px; margin: 0 auto; padding: 12px 20px 48px; }\n"
            "    h1 { font-size: 24px; }\n"
            "    img { max-width: 100%; height: auto; border-radius: 8px; }\n"
            "    hr { border: none; border-top: 1px solid #e2e6ea; margin: 24px 0; }\n"
            "    </style>\n"
            "</head>\n"
            "<body>\n"
            '  <main class="container">\n'
            f"  {article_html}\n"
            "  </main>\n"
            "</body>\n"
            "</html>\n"
        )
    doc = _adjust_relative_hrefs(index_html, depth)
    doc = _replace_title(doc, page_title)
    return _replace_main_inner(doc, article_html)


def _snippet_block(post_id: str, inner_html: str) -> str:
    return f'<article class="post" data-post-id="{post_id}" data-post-generated="1">\n  {inner_html}\n  </article>'


def _nav_html(current: int, total: int, on_index: bool) -> str:
    if total <= 1:
        return ""

    def link(page_number: int) -> str:
        if page_number == current:
            return "#"
        if page_number == 1:
            return "" if on_index else "../index.html"
        return f"page/{page_number}.html" if on_index else f"{page_number}.html"

    parts = []
    if current > 1:
        parts.append(f'<a href="{link(current - 1)}">&laquo; 前へ</a>')
    for page_number in range(1, total + 1):
        if page_number == current:
            parts.append(f"<strong>{page_number}</strong>")
        else:
            parts.append(f'<a href="{link(page_number)}">{page_number}</a>')
    if current < total:
        parts.append(f'<a href="{link(current + 1)}">次へ &raquo;</a>')
    return f'<nav class="post-nav" style="{_NAV_STYLE}">' + " ".join(parts) + "</nav>"


def _list_inner(unmanaged: str, rendered: list[dict], current: int, total: int, on_index: bool) -> str:
    """投稿一覧コンテナの中身を組み立てる."""
    parts = []
    if on_index and unmanaged.strip():
        # 手動コンテンツから古いページネーション nav を除去する (再構築されるため)
        unmanaged = re.sub(
            r'<nav class="post-nav"[^>]*>[\s\S]*?</nav\s*>',
            "",
            unmanaged,
            flags=re.I,
        )
        # 再構築を重ねても余分な空行が溜まらないよう、連続空行は圧縮する
        collapsed = []
        blank = False
        for line in unmanaged.split("\n"):
            if line.strip():
                blank = False
                collapsed.append(line)
            else:
                if blank:
                    continue
                blank = True
                collapsed.append("")
        parts.append("\n".join(collapsed).rstrip("\n"))
    for item in rendered:
        parts.append(_snippet_block(item["id"], item["inner"]))
    nav = _nav_html(current, total, on_index)
    if nav:
        parts.append(nav)
    return "\n" + "\n".join(parts) + "\n  "


# --------------------------------------------------------------------------
# 収集と再構築
# --------------------------------------------------------------------------

def _collect_posts(root: Path, index_html: str) -> list[dict]:
    """個別ページを情報源として投稿一覧を組み立てる (ID の新しい順).

    個別ページが存在しない一覧ブロック (手書き) は元の内容のまま残す。
    """
    posts: dict[str, dict] = {}
    posts_dir = root / "public" / "posts"
    if posts_dir.is_dir():
        for path in sorted(posts_dir.rglob("*.html")):
            post_id = path.stem
            if not POST_ID_RE.match(post_id):
                continue
            try:
                page = path.read_text("utf-8")
            except OSError:
                continue
            match = _MANAGED_OPEN_RE.search(page)
            if not match:
                continue
            close = re.compile(r"</article\s*>", re.I).search(page, match.end())
            if not close:
                continue
            timestamp, divider = _parse_flags(match.group(1))
            title, body_html = _article_source(page[match.end() : close.start()])
            posts[post_id] = {
                "id": post_id,
                "title": title,
                "body": body_html,
                "thumb": _first_image_src(body_html),
                "timestamp": timestamp,
                "divider": divider,
                "tags": _parse_tags(match.group(1)),
                # 一覧からのリンクは個別ページの実在位置を使う (旧形式 posts/ID.html もそのまま)
                "file": path.relative_to(root / "public").as_posix(),
                "fallback_inner": None,
            }

    # index.html 内の手書きブロックで個別ページが無いものはそのまま残す
    # (sync が生成したブロックは個別ページが無くなれば一覧からも消す)
    container = _container_span(index_html)
    if container:
        inner = index_html[container[2] : container[3]]
        for block in _iterate_blocks(inner):
            if block["id"] in posts:
                continue
            if re.search(r"\bdata-post-generated\s*=", block["attrs"], re.I):
                continue
            timestamp, divider = _parse_flags(block["attrs"])
            title, body_html = _article_source(block["inner"])
            posts[block["id"]] = {
                "id": block["id"],
                "title": title,
                "body": body_html,
                # 手書きブロックは index 基準の相対パスが分からないためサムネイルにしない
                "thumb": "",
                "timestamp": timestamp,
                "divider": divider,
                "tags": _parse_tags(block["attrs"]),
                "file": _post_page_relpath(block["id"]),
                "fallback_inner": block["inner"] if not title else None,
            }

    return [posts[post_id] for post_id in sorted(posts, reverse=True)]


def _snippet_for(entry: dict, link: str, on_index: bool) -> str:
    """一覧に表示する article の中身を返す."""
    thumb = _thumb_src(entry.get("thumb") or "", on_index)
    tags = entry.get("tags") or ""
    if entry["title"]:
        return _snippet_inner(
            entry["id"],
            entry["title"],
            entry.get("body") or "",
            entry.get("timestamp", True),
            entry.get("divider", True),
            link,
            thumb,
            tags,
        )
    if entry.get("fallback_inner"):
        return entry["fallback_inner"]
    return _snippet_inner(entry["id"], "", entry.get("body") or "", entry.get("timestamp", True), entry.get("divider", True), link, thumb, tags)


def rebalance(site: Site) -> dict:
    """一覧ページ (index.html / page/N.html) を投稿の内容から再構築する."""
    with _LOCK:
        root = Path(site.path)
        index_path = root / "public" / "index.html"
        if not index_path.is_file():
            return {"ok": True, "posts": 0, "pages": 0, "paths": []}
        index_html = index_path.read_text("utf-8")
        span = _container_span(index_html)
        if not span:
            return {"ok": True, "posts": 0, "pages": 0, "paths": []}
        open_end, inner_start, inner_end = span[1], span[2], span[3]
        inner = index_html[inner_start:inner_end]
        blocks = _iterate_blocks(inner)
        unmanaged = _strip_blocks(inner, blocks)
        entries = _collect_posts(root, index_html)
        if not entries:
            return {"ok": True, "posts": 0, "pages": 0, "paths": []}

        chunks = [entries[i : i + PAGE_SIZE] for i in range(0, len(entries), PAGE_SIZE)]
        total = len(chunks)
        paths = [INDEX_PAGE] + [f"public/page/{n}.html" for n in range(2, total + 1)]
        for index, chunk in enumerate(chunks):
            on_index = index == 0
            # 一覧からのリンクは個別ページの実在位置 (posts/YYYY/MM/DD/*.html など) を使う
            rendered = [{"id": entry["id"], "inner": _snippet_for(entry, entry["file"] if on_index else "../" + entry["file"], on_index)} for entry in chunk]
            swapped = index_html[:open_end] + _list_inner(unmanaged, rendered, index + 1, total, on_index) + index_html[inner_end:]
            sites.write_file(site, paths[index], _ensure_site_env(swapped))

        # 投稿が減って不要になった過去ログページを削除する
        pages_dir = root / "public" / "page"
        if pages_dir.is_dir():
            for path in sorted(pages_dir.glob("*.html")):
                match = re.match(r"^(\d+)\.html$", path.name, re.I)
                if match and int(match.group(1)) > total:
                    path.unlink()
        return {"ok": True, "posts": len(entries), "pages": total, "paths": paths}


def publish(
    site: Site,
    post_id: str,
    title: str,
    body_html: str = "",
    with_timestamp: bool = True,
    with_divider: bool = True,
    tags: str = "",
) -> dict:
    """個別ページ (public/posts/YYYY/MM/DD/ID.html) を作成し、一覧ページを再構築する."""
    with _LOCK:
        post_id = (post_id or "").strip()
        if not POST_ID_RE.match(post_id):
            raise SiteError("投稿 ID は YYYYMMDD-HHMMSS 形式で指定してください。")
        title = (title or "").strip() or "無題"
        tags = _normalize_tags(tags)
        root = Path(site.path)
        index_path = root / "public" / "index.html"
        index_html = ""
        site_title = ""
        if index_path.is_file():
            index_html = index_path.read_text("utf-8")
            match = _TITLE_RE.search(index_html)
            if match:
                site_title = _plain_text(match.group(0))
        page_title = f"{title} - {site_title}" if site_title and site_title != title else title
        rel_page = _post_page_relpath(post_id)
        depth = len(PurePosixPath(rel_page).parent.parts)
        article_html = _post_article(
            post_id, title, body_html, with_timestamp, with_divider, "../" * depth + "index.html", tags
        )
        doc = _render_post_document(index_html, article_html, page_title, depth)
        post_path = f"public/{rel_page}"
        sites.write_file(site, post_path, _ensure_site_env(doc))
        summary = rebalance(site)
        return {"ok": True, "post": post_path, **summary}


def sync_saved_post(site: Site, relative: str) -> dict | None:
    """public/posts/YYYY/MM/DD/ID.html の保存を検知して一覧ページを再構築する."""
    normalized = (relative or "").strip().lstrip("/")
    # posts/ 直下 (旧形式) と posts/YYYY/MM/DD/ 配下 (階層化) の両方に対応する
    if not re.match(rf"^{re.escape(POST_PAGE_PREFIX)}/.+\.html$", normalized, re.I):
        return None
    post_id = Path(normalized).stem
    if not POST_ID_RE.match(post_id):
        return None
    try:
        return rebalance(site)
    except Exception as exc:  # 保存自体は成功させる
        logger.warning("投稿同期に失敗しました (%s): %s", normalized, exc)
        return {"ok": False, "error": str(exc)}
