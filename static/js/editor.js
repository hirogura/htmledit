/* global window, document */
/**
 * エディター本体。
 * - WYSIWYG モード: ページ本文 (body) を contenteditable で直接編集する
 * - ソース モード: ファイル全体をそのまま編集する
 * どちらのモードでも <head> や class/id 属性は保持される。
 */
(function () {
  "use strict";

  var BODY_OPEN_RE = /<body\b[^>]*>/i;
  var BODY_CLOSE_RE = /<\/body\s*>/i;

  /* フラットなアイコン (SVG, stroke は currentColor) */
  function flatIcon(body, viewBox) {
    return (
      '<svg viewBox="' + (viewBox || "0 0 16 16") + '" width="15" height="15" aria-hidden="true">' +
      body +
      "</svg>"
    );
  }

  function letterIcon(letter, line) {
    var body =
      '<text x="8" y="12" text-anchor="middle" font-size="13" font-weight="650" fill="currentColor">' +
      letter +
      "</text>";
    if (line) {
      body += '<path d="' + line + '" stroke="currentColor" stroke-width="1.4" fill="none"/>';
    }
    return flatIcon(body);
  }

  var TOOLBAR_GROUPS = [
    [
      { label: "B", title: "太字", command: "bold", icon: letterIcon("B") },
      {
        label: "I",
        title: "斜体",
        command: "italic",
        icon: flatIcon(
          '<path d="M10.5 3h4M1.5 13h4M9.8 3.4 6.2 12.6" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/>'
        )
      },
      {
        label: "U",
        title: "下線",
        command: "underline",
        icon: flatIcon(
          '<path d="M4 2v5.5a4 4 0 0 0 8 0V2" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' +
            '<path d="M2.5 14h11" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/>'
        )
      },
      { label: "S", title: "取り消し線", command: "strikeThrough", icon: letterIcon("S", "M2.5 7.5h11") }
    ],
    [
      { type: "select", title: "段落スタイル", options: [
        { value: "p", label: "本文" },
        { value: "h1", label: "見出し 1" },
        { value: "h2", label: "見出し 2" },
        { value: "h3", label: "見出し 3" },
        { value: "blockquote", label: "引用" },
        { value: "color:#d93025", label: "赤字" },
        { value: "color:#1a73e8", label: "青字" },
        { value: "pre", label: "等幅" }
      ] }
    ],
    [
      { label: "•", title: "箇条書き", command: "insertUnorderedList" },
      { label: "1.", title: "番号付きリスト", command: "insertOrderedList" }
    ],
    [
      {
        label: "≪",
        title: "左寄せ",
        command: "justifyLeft",
        icon: flatIcon(
          '<path d="M1.5 3.5h13M1.5 8h13M1.5 12.5h8" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/>'
        )
      },
      {
        label: "≡",
        title: "中央寄せ",
        command: "justifyCenter",
        icon: flatIcon(
          '<path d="M1.5 3.5h13M1.5 8h13M4 12.5h8" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/>'
        )
      },
      {
        label: "≫",
        title: "右寄せ",
        command: "justifyRight",
        icon: flatIcon(
          '<path d="M1.5 3.5h13M1.5 8h13M6.5 12.5h8" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/>'
        )
      }
    ],
    [
      {
        label: "ID",
        title: "ID を設定 (リンクのアンカー先)",
        command: "setElementId"
      },
      {
        label: "🔗",
        title: "リンク",
        command: "createLink",
        icon: flatIcon(
          '<path d="M6.5 9.5 9.5 6.5" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/>' +
            '<path d="M7 4.5 9 2.5a3 3 0 0 1 4.5 4.5l-2 2a3 3 0 0 1-1 .68" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/>' +
            '<path d="M9 11.5 7 13.5a3 3 0 0 1-4.5-4.5l2-2a3 3 0 0 1 1-.68" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/>'
        )
      },
      {
        label: "🖼",
        title: "画像",
        command: "insertImage",
        icon: flatIcon(
          '<rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" stroke-width="1.6" fill="none"/>' +
            '<circle cx="5.5" cy="6" r="1.4" stroke="currentColor" stroke-width="1.4" fill="none"/>' +
            '<path d="M2.5 12.5l3.5-3.5 2.5 2.5 3-3 2 2" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'
        )
      },
      {
        label: "✏",
        title: "手書き",
        command: "handwriting",
        icon: flatIcon(
          '<path d="M3 13l2-1 7-7-1-1-7 7-1 2z" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'
        )
      },
      {
        label: "</>",
        title: "コードブロック (選択した文章を囲む)",
        command: "insertCodeBlock",
        icon: flatIcon(
          '<path d="M5.4 4.5 2.2 8l3.2 3.5" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' +
            '<path d="M10.6 4.5 13.8 8l-3.2 3.5" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>' +
            '<path d="M9.3 3.4 6.7 12.6" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/>'
        )
      },
      {
        label: "⌫",
        title: "書式を消去",
        command: "removeFormat",
        icon: letterIcon("T", "M2.5 13.5 13.5 2.5")
      },
      {
        label: "📅",
        title: "現在の日時を挿入",
        command: "insertDate",
        icon: flatIcon(
          '<rect x="1.5" y="3" width="13" height="11.5" rx="1.5" stroke="currentColor" stroke-width="1.6" fill="none"/>' +
            '<path d="M1.5 6.5h13M5 1.5v3M11 1.5v3" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/>'
        )
      },
      {
        label: "─",
        title: "区切り線を挿入",
        command: "insertHorizontalRule",
        icon: flatIcon(
          '<path d="M2 4.5h12" stroke="currentColor" stroke-width="1.4" opacity="0.35"/>' +
            '<path d="M2 8h12" stroke="currentColor" stroke-width="2"/>' +
            '<path d="M2 11.5h12" stroke="currentColor" stroke-width="1.4" opacity="0.35"/>'
        )
      }
    ],
    [
      { label: "↶", title: "元に戻す", command: "undo" },
      { label: "↷", title: "やり直す", command: "redo" }
    ]
  ];

  function splitDocument(html) {
    var openMatch = BODY_OPEN_RE.exec(html);
    if (!openMatch) {
      return { prefix: "", body: html, suffix: "" };
    }
    var start = openMatch.index + openMatch[0].length;
    var rest = html.slice(start);
    var closeMatch = BODY_CLOSE_RE.exec(rest);
    if (!closeMatch) {
      return { prefix: html.slice(0, start), body: rest, suffix: "" };
    }
    return {
      prefix: html.slice(0, start),
      body: rest.slice(0, closeMatch.index),
      suffix: rest.slice(closeMatch.index)
    };
  }

  function composeDocument(parts) {
    return parts.prefix + parts.body + parts.suffix;
  }

  function escapeAttribute(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function Editor(options) {
    this.host = options.host;
    this.source = options.source;
    this.toolbar = options.toolbar;
    this.preview = options.preview;
    this.status = options.status;
    this.onChange = options.onChange || function () {};
    this.onDirtyChange = options.onDirtyChange || function () {};
    this.onSelection = options.onSelection || function () {};
    this.onDropSiteFile = options.onDropSiteFile || function () {};
    this.onDropUnsupported = options.onDropUnsupported || function () {};
    this.onUploadImage = options.onUploadImage || function () {};
    this.onInsertImage = options.onInsertImage || null;
    this.onHandwriting = options.onHandwriting || null;

    this.mode = "wysiwyg";
    this.path = "";
    this.parts = { prefix: "", body: "", suffix: "" };
    this.original = "";
    this.dirty = false;
    this.savedRange = null;
    this.previewVisible = false;
    this.selectedImage = null;
    this.selectedLink = null;

    this._buildToolbar();
    this._bind();
  }

  Editor.prototype._buildToolbar = function () {
    var self = this;
    var fragment = document.createDocumentFragment();

    TOOLBAR_GROUPS.forEach(function (group, groupIndex) {
      if (groupIndex > 0) {
        var sep = document.createElement("span");
        sep.className = "sep";
        fragment.appendChild(sep);
      }
      group.forEach(function (item) {
        if (item.type === "select") {
          var select = document.createElement("select");
          select.title = item.title;
          item.options.forEach(function (option) {
            var opt = document.createElement("option");
            opt.value = option.value;
            opt.textContent = option.label;
            select.appendChild(opt);
          });
          select.addEventListener("change", function () {
            var value = select.value;
            if (value.indexOf("color:") === 0) {
              self.applyTextColor(value.slice("color:".length));
              return;
            }
            self.execCommand("formatBlock", value);
          });
          fragment.appendChild(select);
          return;
        }
        var button = document.createElement("button");
        button.type = "button";
        if (item.icon) {
          button.innerHTML = item.icon;
        } else {
          button.textContent = item.label;
        }
        button.title = item.title;
        button.dataset.command = item.command;
        button.addEventListener("mousedown", function (event) {
          event.preventDefault();
          self.saveSelection();
        });
        button.addEventListener("click", function () {
          if (item.command === "insertImage" && self.onInsertImage) {
            self.onInsertImage();
            return;
            if (item.command === "handwriting" && self.onHandwriting) {
              self.onHandwriting();
              return;
            }
          }
          if (item.command === "handwriting" && self.onHandwriting) {
            self.onHandwriting();
            return;
          }
          if (item.command === "insertCodeBlock") {
            self.insertCodeBlock();
            return;
          }
          if (item.command === "setElementId") {
            self.setElementId();
            return;
          }
          if (item.command === "insertDate") {
            self.insertCurrentDate();
            return;
          }
          self.execCommand(item.command);
        });
        fragment.appendChild(button);
      });
    });

    this.toolbar.innerHTML = "";
    this.toolbar.appendChild(fragment);
  };

  Editor.prototype._bind = function () {
    var self = this;
    this.host.addEventListener("input", function () {
      self._markDirty();
    });
    this.source.addEventListener("input", function () {
      self._markDirty();
    });
    this.host.addEventListener("keyup", function () {
      self.saveSelection();
      self.reportSelection();
    });
    this.host.addEventListener("mouseup", function () {
      self.saveSelection();
      self.reportSelection();
    });
    this.host.addEventListener("click", function (event) {
      var target = event.target;
      var image = target && target.tagName === "IMG" ? target : null;
      var link = self.closestElement(target, "A");
      self.selectedImage = image;
      self.selectedLink = link;
      self.saveSelection();
      if (image || link) {
        self.emitSelection();
      } else {
        self.reportSelection();
      }
    });
    document.addEventListener("selectionchange", function () {
      if (document.activeElement === self.host) {
        self.saveSelection();
        self.reportSelection();
      }
    });
    this._bindDrop();
  };

  /* ------------------------------------------------------------------ */
  /* 選択状態の判定                                                     */
  /* ------------------------------------------------------------------ */
  Editor.prototype.closestElement = function (element, tagName) {
    var node = element;
    while (node && node !== this.host) {
      if (node.nodeType === 1 && node.tagName === tagName) {
        return node;
      }
      node = node.parentNode;
    }
    return null;
  };

  Editor.prototype.reportSelection = function () {
    if (this.mode !== "wysiwyg") {
      this.emitSelection();
      return;
    }
    var selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      this.emitSelection();
      return;
    }
    var range = selection.getRangeAt(0);
    if (!this.host.contains(range.commonAncestorContainer)) {
      this.emitSelection();
      return;
    }

    var node = range.startContainer;
    var element = node.nodeType === 1 ? node : node.parentElement;
    var image = this.selectedImage && this.host.contains(this.selectedImage) ? this.selectedImage : null;
    var link = this.closestElement(element, "A");

    if (!image) {
      // キャレットが画像の直前/直後にある場合
      if (element && element.previousElementSibling && element.previousElementSibling.tagName === "IMG") {
        image = element.previousElementSibling;
      } else if (element && element.tagName === "IMG") {
        image = element;
      } else if (node.nodeType === 1 && range.startOffset > 0) {
        var child = element.childNodes[range.startOffset - 1];
        if (child && child.tagName === "IMG") {
          image = child;
        }
      }
    }
    if (image && !this.host.contains(image)) {
      image = null;
    }
    if (!link && image) {
      link = this.closestElement(image.parentElement, "A");
    }
    this.selectedImage = image;
    this.selectedLink = link;
    this.emitSelection();
  };

  Editor.prototype.emitSelection = function () {
    var info = {
      link: this.selectedLink || null,
      image: this.selectedImage || null,
      text: this.selectedText()
    };
    this.updateSelectionClasses();
    if (this.onSelection) {
      this.onSelection(info);
    }
  };

  Editor.prototype.selectedText = function () {
    var selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return "";
    }
    return selection.toString();
  };

  /* ------------------------------------------------------------------ */
  /* 画像の挿入 / ドラッグ＆ドロップ                                      */
  /* ------------------------------------------------------------------ */
  Editor.prototype.insertHtmlAtCaret = function (html) {
    if (this.mode !== "wysiwyg") {
      this.setMode("wysiwyg");
    }
    this.restoreSelection();
    var inserted = false;
    try {
      if (document.queryCommandSupported && document.queryCommandSupported("insertHTML")) {
        inserted = document.execCommand("insertHTML", false, html);
      }
    } catch (error) {
      inserted = false;
    }
    if (!inserted) {
      this._insertHtmlManually(html);
    }
    this._markDirty();
    this.updatePreview();
  };

  Editor.prototype._insertHtmlManually = function (html) {
    var selection = window.getSelection();
    var range = null;
    if (selection && selection.rangeCount > 0) {
      var candidate = selection.getRangeAt(0);
      // エディター外のカーソルには挿入しない
      if (this.host.contains(candidate.commonAncestorContainer)) {
        range = candidate;
      }
    }
    if (!range) {
      this.host.insertAdjacentHTML("beforeend", html);
      return;
    }
    var container = range.startContainer;
    var holder = document.createElement("div");
    holder.innerHTML = html;
    while (holder.firstChild) {
      container.insertBefore(holder.firstChild, container.childNodes[range.startOffset] || null);
    }
  };

  Editor.prototype.insertImage = function (src, alt) {
    var attrs = ' src="' + escapeAttribute(src) + '"';
    if (alt) {
      attrs += ' alt="' + escapeAttribute(alt) + '"';
    }
    return this.insertImageElement(attrs);
  };

  /* キャレット位置に <img> を挿入し、挿入された要素を返す. */
  Editor.prototype.insertImageElement = function (attrs) {
    var known = [];
    var before = this.host.querySelectorAll("img");
    for (var i = 0; i < before.length; i++) {
      known.push(before[i]);
    }
    this.insertHtmlAtCaret("<img" + (attrs || "") + ">");
    var images = this.host.querySelectorAll("img");
    var inserted = null;
    for (var j = 0; j < images.length; j++) {
      if (known.indexOf(images[j]) === -1) {
        inserted = images[j];
      }
    }
    if (!inserted) {
      // カーソルがエディターの外にある場合は末尾へ追加する
      var holder = document.createElement("div");
      holder.innerHTML = "<img" + (attrs || "") + ">";
      inserted = holder.firstChild;
      if (inserted) {
        this.host.appendChild(inserted);
      }
    }
    return inserted;
  };

  /* 画像を明示的に選択し、プロパティ表示を更新する. */
  Editor.prototype.selectImage = function (image) {
    this.selectedImage = image || null;
    this.selectedLink = image ? this.closestElement(image.parentElement, "A") : null;
    this.emitSelection();
  };

  Editor.prototype.updateSelectionClasses = function () {
    var images = this.host.querySelectorAll("img");
    for (var i = 0; i < images.length; i++) {
      images[i].classList.toggle("is-selected", images[i] === this.selectedImage);
    }
    this.host.classList.toggle("is-image-selected", !!this.selectedImage);
    var links = this.host.querySelectorAll("a");
    for (var j = 0; j < links.length; j++) {
      links[j].classList.toggle("is-selected", links[j] === this.selectedLink);
    }
    this.host.classList.toggle("is-link-selected", !!this.selectedLink);
  };

  Editor.prototype._bindDrop = function () {
    var self = this;
    this.host.addEventListener("dragover", function (event) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      self.host.classList.add("is-drop-target");
    });
    this.host.addEventListener("dragleave", function () {
      self.host.classList.remove("is-drop-target");
    });
    this.host.addEventListener("drop", function (event) {
      event.preventDefault();
      self.host.classList.remove("is-drop-target");
      if (self.mode !== "wysiwyg") {
        self.setMode("wysiwyg");
      }
      self.restoreSelection();

      var transfer = event.dataTransfer;
      var sitePath = transfer.getData("application/x-htmledit-path");
      if (sitePath) {
        if (self.onDropSiteFile) {
          self.onDropSiteFile(sitePath);
        }
        return;
      }
      var files = transfer.files;
      if (files && files.length) {
        var imageFiles = [];
        var nonImage = null;
        for (var fi = 0; fi < files.length; fi++) {
          if (files[fi].type && files[fi].type.indexOf("image/") === 0) {
            imageFiles.push(files[fi]);
          } else if (!nonImage) {
            nonImage = files[fi];
          }
        }
        if (imageFiles.length) {
          imageFiles.forEach(function (file) {
            self._readImageFile(file);
          });
        } else if (nonImage && self.onDropUnsupported) {
          self.onDropUnsupported("画像ファイルのみドロップできます: " + nonImage.name);
        }
        return;
      }
      var uri = transfer.getData("text/uri-list") || transfer.getData("text/plain");
      if (uri) {
        uri = uri.split("\n")[0].trim();
        if (uri && !self._isLocalPath(uri)) {
          self.insertImage(uri, "");
        }
      }
    });
  };

  Editor.prototype._isLocalPath = function (value) {
    return !/^(https?:)?\/\//i.test(value) && !/^data:/i.test(value);
  };

  Editor.prototype._readImageFile = function (file) {
    var self = this;
    if (self.onUploadImage) {
      self.onUploadImage(file);
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      self.insertImage(reader.result, file.name);
      self.insertHtmlAtCaret("<br>");
    };
    reader.onerror = function () {
      if (self.onDropUnsupported) {
        self.onDropUnsupported("画像を読み込めませんでした: " + file.name);
      }
    };
    reader.readAsDataURL(file);
  };

  Editor.prototype.saveSelection = function () {
    var selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return;
    }
    var range = selection.getRangeAt(0);
    if (this.host.contains(range.commonAncestorContainer)) {
      this.savedRange = range.cloneRange();
    }
  };

  Editor.prototype.restoreSelection = function () {
    if (!this.savedRange) {
      return;
    }
    var selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(this.savedRange);
    this.host.focus();
  };

  /* 投稿日時の形式 (例: 2026年10月23日（金）10:07) - 投稿パネルと共通 */
  Editor.prototype.timestampText = function () {
    var now = new Date();
    var weekdays = ["日", "月", "火", "水", "木", "金", "土"];
    var pad = function (value) {
      return String(value).padStart(2, "0");
    };
    return (
      now.getFullYear() +
      "年" +
      (now.getMonth() + 1) +
      "月" +
      now.getDate() +
      "日（" +
      weekdays[now.getDay()] +
      "）" +
      pad(now.getHours()) +
      ":" +
      pad(now.getMinutes())
    );
  };

  /* 「現在の日付を挿入」ボタン: 本文より小さく灰色の日時テキストをキャレットに入れる */
  Editor.prototype.insertCurrentDate = function () {
    this.execCommand(
      "insertHTML",
      '<p style="font-size: 0.8em; color: #888;">' + this.timestampText() + "</p>"
    );
  };

  function escapeCodeText(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  /* 「赤字」「青字」: 選択範囲の文字色を変える (execCommand が使えない場合は span で囲む) */
  Editor.prototype.applyTextColor = function (color) {
    if (this.mode !== "wysiwyg") {
      this.setMode("wysiwyg");
    }
    this.restoreSelection();
    try {
      document.execCommand("styleWithCSS", false, true);
    } catch (error) { /* 無視 */ }
    var applied = false;
    try {
      if (document.queryCommandSupported && document.queryCommandSupported("foreColor")) {
        applied = document.execCommand("foreColor", false, color);
      }
    } catch (error) {
      applied = false;
    }
    if (!applied) {
      var selection = window.getSelection();
      if (selection && selection.rangeCount > 0) {
        var range = selection.getRangeAt(0);
        try {
          var span = document.createElement("span");
          span.style.color = color;
          span.appendChild(range.extractContents());
          range.insertNode(span);
        } catch (error) { /* 失敗しても編集は続行する */ }
      }
    }
    this._markDirty();
    this.updatePreview();
  };

  /* 「コードブロック」ボタン: 選択範囲を挟む形で pre.site-code-block を挿入する */
  Editor.prototype.insertCodeBlock = function () {
    if (this.mode !== "wysiwyg") {
      this.setMode("wysiwyg");
    }
    this.restoreSelection();
    var selection = window.getSelection();
    var selected = selection && selection.rangeCount > 0 ? selection.toString() : "";
    var before = this.host.querySelectorAll("pre.site-code-block");
    var markup =
      '<pre class="site-code-block">' + escapeCodeText(selected || "コード") + "</pre>";
    this.insertHtmlAtCaret(markup);

    var pool = this.host.querySelectorAll("pre.site-code-block");
    var inserted = null;
    for (var i = pool.length - 1; i >= 0; i--) {
      if (before.length === 0 || Array.prototype.indexOf.call(before, pool[i]) === -1) {
        inserted = pool[i];
        break;
      }
    }
    if (!inserted) {
      return;
    }
    /* 選択なしだった場合はプレースホルダーの末尾にキャレットを置く */
    if (!selected) {
      var range = document.createRange();
      range.selectNodeContents(inserted);
      range.collapse(false);
      var next = window.getSelection();
      if (next) {
        next.removeAllRanges();
        next.addRange(range);
      }
    }
    this.saveSelection();
    this.updateSelectionClasses();
  };

  /* コードブロックのコピーボタン環境 (公開ページは posts.py 側で注入する。内容を合わせること) */
  var CODE_COPY_MARKUP =
    '<style id="site-code-copy-style">\n' +
    "pre.site-code-block { position: relative; box-sizing: border-box; padding: 12px 96px 12px 14px; margin: 12px 0; background: #f6f7f8; border: 1px solid #e3e6ea; border-radius: 8px; overflow-x: auto; white-space: pre; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace; font-size: 0.9em; line-height: 1.55; }\n" +
    ".site-code-copy { position: absolute; top: 6px; right: 6px; padding: 5px 10px; border: 1px solid #d3d8de; border-radius: 6px; background: #ffffff; color: #5a6570; font-size: 12px; line-height: 1; cursor: pointer; }\n" +
    ".site-code-copy:hover { background: #eef1f4; }\n" +
    ".site-code-copy:disabled { opacity: 0.75; cursor: default; }\n" +
    "</style>\n" +
    '<script id="site-code-copy-script">\n' +
    '(function () {\n' +
    '  "use strict";\n' +
    "  function copyText(text) {\n" +
    "    if (navigator.clipboard && navigator.clipboard.writeText) {\n" +
    "      navigator.clipboard.writeText(text).catch(function () { fallbackCopy(text); });\n" +
    "      return;\n" +
    "    }\n" +
    "    fallbackCopy(text);\n" +
    "  }\n" +
    "  function fallbackCopy(text) {\n" +
    '    var area = document.createElement("textarea");\n' +
    "    area.value = text;\n" +
    '    area.style.position = "fixed";\n' +
    '    area.style.opacity = "0";\n' +
    "    document.body.appendChild(area);\n" +
    "    area.select();\n" +
    '    try { document.execCommand("copy"); } catch (error) { /* 無視 */ }\n' +
    "    document.body.removeChild(area);\n" +
    "  }\n" +
    "  function init() {\n" +
    '    var blocks = document.querySelectorAll("pre.site-code-block");\n' +
    "    Array.prototype.forEach.call(blocks, function (pre) {\n" +
    '      if (pre.getAttribute("data-code-copy") === "1") { return; }\n' +
    '      pre.setAttribute("data-code-copy", "1");\n' +
    "      var code = pre.textContent;\n" +
    '      var btn = document.createElement("button");\n' +
    '      btn.type = "button";\n' +
    '      btn.className = "site-code-copy";\n' +
    '      btn.textContent = "コピー";\n' +
    '      btn.addEventListener("click", function () {\n' +
    "        copyText(code);\n" +
    '        btn.textContent = "コピーしました";\n' +
    "        btn.disabled = true;\n" +
    "        window.setTimeout(function () {\n" +
    '          btn.textContent = "コピー";\n' +
    "          btn.disabled = false;\n" +
    "        }, 1600);\n" +
    "      });\n" +
    "      pre.appendChild(btn);\n" +
    "    });\n" +
    "  }\n" +
    '  if (document.readyState === "loading") {\n' +
    '    document.addEventListener("DOMContentLoaded", init);\n' +
    "  } else {\n" +
    "    init();\n" +
    "  }\n" +
    "})();\n" +
    "</script>\n";

  /* 引用 (blockquote) をブロックで囲むスタイル (公開ページは posts.py 側で注入。内容を合わせること) */
  var QUOTE_STYLE_MARKUP =
    '<style id="site-quote-style">\n' +
    "blockquote { margin: 12px 0; padding: 10px 14px; border-left: 4px solid #9aa7b4; background: #f4f6f8; color: #4a5560; border-radius: 0 8px 8px 0; }\n" +
    "</style>\n";

  function ensureInBody(html, marker, markup) {
    if (!html || html.indexOf(marker) >= 0) {
      return html;
    }
    var close = html.search(/<\/body\s*>/i);
    if (close < 0) {
      return html;
    }
    return html.slice(0, close) + markup + html.slice(close);
  }

  Editor.prototype.__ensureCodeCopy = function (html) {
    html = ensureInBody(html, 'id="site-code-copy-script"', CODE_COPY_MARKUP);
    html = ensureInBody(html, 'id="site-quote-style"', QUOTE_STYLE_MARKUP);
    return html;
  };

  /* 「ID を設定」ボタン: キャレット位置のブロック要素に id 属性を設定/解除する */
  Editor.prototype.setElementId = function () {
    if (this.mode !== "wysiwyg") {
      this.setMode("wysiwyg");
    }
    this.restoreSelection();
    var selection = window.getSelection();
    var node = selection && selection.rangeCount > 0 ? selection.getRangeAt(0).startContainer : null;
    var element = node ? (node.nodeType === 1 ? node : node.parentElement) : null;
    element = this._closestBlockElement(element);
    if (!element) {
      this.setStatus("ID を設定する位置にカーソルを置いてください");
      return;
    }
    var current = element.getAttribute("id") || "";
    var value = window.prompt("ID を設定 (リンクのアンカー先)。空欄で削除", current);
    if (value === null) {
      return;
    }
    value = value.trim();
    if (value) {
      element.setAttribute("id", value);
    } else {
      element.removeAttribute("id");
    }
    this._markDirty();
    this.updatePreview();
  };

  var BLOCK_TAGS = ["P", "H1", "H2", "H3", "H4", "H5", "H6", "LI", "BLOCKQUOTE", "PRE", "DIV", "SECTION", "FIGURE", "TD", "TH"];

  Editor.prototype._closestBlockElement = function (element) {
    var node = element;
    var fallback = null;
    while (node && node !== this.host) {
      if (node.nodeType === 1) {
        if (BLOCK_TAGS.indexOf(node.tagName) >= 0) {
          return node;
        }
        if (!fallback) {
          fallback = node;
        }
      }
      node = node.parentNode;
    }
    return fallback;
  };

  Editor.prototype.execCommand = function (command, value) {
    if (this.mode !== "wysiwyg") {
      this.setMode("wysiwyg");
    }
    this.restoreSelection();
    var applied = false;
    try {
      if (document.queryCommandSupported && document.queryCommandSupported(command)) {
        applied = document.execCommand(command, false, value || null);
      }
    } catch (error) {
      applied = false;
    }
    if (!applied) {
      this._manualCommand(command, value);
    }
    this._markDirty();
    this.updatePreview();
  };

  /* execCommand が使えない場合の簡易フォールバック */
  Editor.prototype._manualCommand = function (command, value) {
    var selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      return;
    }
    var range = selection.getRangeAt(0);
    if (command === "bold" || command === "italic" || command === "underline") {
      var tag = command === "bold" ? "strong" : command === "italic" ? "em" : "u";
      try {
        var wrapper = document.createElement(tag);
        wrapper.appendChild(range.extractContents());
        range.insertNode(wrapper);
        selection.removeAllRanges();
        var next = document.createRange();
        next.selectNodeContents(wrapper);
        selection.addRange(next);
      } catch (error) {
        /* 失敗しても編集は続行する */
      }
    } else if (command === "formatBlock" && value) {
      var block = range.startContainer;
      while (block && block !== this.host && block.nodeType !== 1) {
        block = block.parentNode;
      }
      if (block && block !== this.host) {
        var replacement = document.createElement(value);
        replacement.innerHTML = block.innerHTML;
        block.parentNode.replaceChild(replacement, block);
      }
    }
  };

  Editor.prototype.load = function (path, content) {
    this.path = path;
    this.parts = splitDocument(content || "");
    this.original = content || "";
    this.host.innerHTML = this.parts.body;
    this.source.value = this.original;
    this.dirty = false;
    this.selectedImage = null;
    this.selectedLink = null;
    this.onDirtyChange(false);
    this.emitSelection();
    this.updatePreview();
  };

  Editor.prototype.clear = function () {
    this.path = "";
    this.parts = { prefix: "", body: "", suffix: "" };
    this.original = "";
    this.host.innerHTML = "";
    this.source.value = "";
    this.dirty = false;
    this.selectedImage = null;
    this.selectedLink = null;
    this.onDirtyChange(false);
    this.emitSelection();
    this.updatePreview();
  };

  Editor.prototype.currentParts = function () {
    if (this.mode === "source") {
      return splitDocument(this.source.value);
    }
    return { prefix: this.parts.prefix, body: this.host.innerHTML, suffix: this.parts.suffix };
  };

  Editor.prototype.currentText = function () {
    return composeDocument(this.currentParts());
  };

  Editor.prototype.setMode = function (mode) {
    if (mode === this.mode) {
      return;
    }
    if (mode === "source") {
      this.parts = this.currentParts();
      this.source.value = composeDocument(this.parts);
    } else {
      var parts = splitDocument(this.source.value);
      this.parts = { prefix: parts.prefix, body: parts.body, suffix: parts.suffix };
      this.host.innerHTML = parts.body;
    }
    this.mode = mode;
    this.host.hidden = mode !== "wysiwyg";
    this.source.hidden = mode !== "source";
    this.toolbar.style.display = mode === "wysiwyg" ? "" : "none";
    this.updatePreview();
  };

  Editor.prototype.togglePreview = function (visible) {
    this.previewVisible = visible === undefined ? !this.previewVisible : !!visible;
    this.preview.hidden = !this.previewVisible;
    if (this.previewVisible) {
      this.updatePreview();
    }
    return this.previewVisible;
  };

  Editor.prototype.updatePreview = function () {
    if (!this.previewVisible) {
      return;
    }
    this.preview.srcdoc = this.__ensureCodeCopy(this.currentText());
  };

  Editor.prototype._markDirty = function () {
    var dirty = this.currentText() !== this.original;
    if (dirty !== this.dirty) {
      this.dirty = dirty;
      this.onDirtyChange(dirty);
    }
  };

  Editor.prototype.notifyChange = function () {
    this._markDirty();
    this.updatePreview();
  };

  Editor.prototype.markSaved = function () {
    this.parts = this.currentParts();
    this.original = composeDocument(this.parts);
    if (this.mode === "source") {
      this.source.value = this.original;
    } else {
      this.host.innerHTML = this.parts.body;
    }
    this.dirty = false;
    this.selectedImage = null;
    this.selectedLink = null;
    this.onDirtyChange(false);
    this.emitSelection();
  };

  Editor.prototype.setStatus = function (message) {
    if (this.status) {
      this.status.textContent = message;
    }
  };

  window.htmleditEditor = {
    create: function (options) {
      return new Editor(options);
    },
    splitDocument: splitDocument,
    composeDocument: composeDocument
  };
})();
