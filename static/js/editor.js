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

  var TOOLBAR_GROUPS = [
    [
      { label: "B", title: "太字", command: "bold" },
      { label: "I", title: "斜体", command: "italic" },
      { label: "U", title: "下線", command: "underline" },
      { label: "S", title: "取り消し線", command: "strikeThrough" }
    ],
    [
      { type: "select", title: "段落スタイル", options: [
        { value: "p", label: "本文" },
        { value: "h1", label: "見出し 1" },
        { value: "h2", label: "見出し 2" },
        { value: "h3", label: "見出し 3" },
        { value: "blockquote", label: "引用" },
        { value: "pre", label: "等幅" }
      ] }
    ],
    [
      { label: "•", title: "箇条書き", command: "insertUnorderedList" },
      { label: "1.", title: "番号付きリスト", command: "insertOrderedList" }
    ],
    [
      { label: "≡", title: "左寄せ", command: "justifyLeft" },
      { label: "≡", title: "中央寄せ", command: "justifyCenter" },
      { label: "≡", title: "右寄せ", command: "justifyRight" }
    ],
    [
      { label: "🔗", title: "リンク", command: "createLink" },
      { label: "🖼", title: "画像", command: "insertImage" },
      { label: "⌫", title: "書式を消去", command: "removeFormat" }
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

  function Editor(options) {
    this.host = options.host;
    this.source = options.source;
    this.toolbar = options.toolbar;
    this.preview = options.preview;
    this.status = options.status;
    this.onChange = options.onChange || function () {};
    this.onDirtyChange = options.onDirtyChange || function () {};

    this.mode = "wysiwyg";
    this.path = "";
    this.parts = { prefix: "", body: "", suffix: "" };
    this.original = "";
    this.dirty = false;
    this.savedRange = null;
    this.previewVisible = false;

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
            self.execCommand("formatBlock", select.value);
          });
          fragment.appendChild(select);
          return;
        }
        var button = document.createElement("button");
        button.type = "button";
        button.textContent = item.label;
        button.title = item.title;
        button.dataset.command = item.command;
        button.addEventListener("mousedown", function (event) {
          event.preventDefault();
          self.saveSelection();
        });
        button.addEventListener("click", function () {
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
    });
    this.host.addEventListener("mouseup", function () {
      self.saveSelection();
    });
    document.addEventListener("selectionchange", function () {
      if (document.activeElement === self.host) {
        self.saveSelection();
      }
    });
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
    this.onDirtyChange(false);
    this.updatePreview();
  };

  Editor.prototype.clear = function () {
    this.path = "";
    this.parts = { prefix: "", body: "", suffix: "" };
    this.original = "";
    this.host.innerHTML = "";
    this.source.value = "";
    this.dirty = false;
    this.onDirtyChange(false);
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
    this.preview.srcdoc = this.currentText();
  };

  Editor.prototype._markDirty = function () {
    var dirty = this.currentText() !== this.original;
    if (dirty !== this.dirty) {
      this.dirty = dirty;
      this.onDirtyChange(dirty);
    }
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
    this.onDirtyChange(false);
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
