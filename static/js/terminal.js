/* global window, document, WebSocket */
/**
 * ターミナルパネル (xterm.js + WebSocket で PTY の bash を操作する).
 */
(function () {
  "use strict";

  function TerminalPanel(options) {
    this.host = options.host;
    this.cwdLabel = options.cwdLabel;
    this.onStatus = options.onStatus || function () {};
    this.onOpenChange = options.onOpenChange || function () {};
    this.socket = null;
    this.term = null;
    this.fitAddon = null;
    this.siteId = "";
    this.sessionId = "htmledit-" + Math.random().toString(36).slice(2, 10);
    this._initTerm();
  }

  TerminalPanel.prototype._initTerm = function () {
    if (!window.Terminal) {
      this.host.textContent = "xterm.js を読み込めませんでした。";
      return;
    }
    var self = this;
    this.term = new window.Terminal({
      convertEol: true,
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "DejaVu Sans Mono", monospace',
      scrollback: 8000,
      theme: {
        background: "#12161c",
        foreground: "#e6edf3",
        cursor: "#6ea8ff",
        selectionBackground: "#2f6feb"
      }
    });
    if (window.FitAddon && window.FitAddon.FitAddon) {
      this.fitAddon = new window.FitAddon.FitAddon();
      this.term.loadAddon(this.fitAddon);
    }
    this.term.open(this.host);
    this.term.onData(function (data) {
      self.send({ type: "input", data: data });
    });
    window.addEventListener("resize", function () {
      self.fit();
    });
  };

  TerminalPanel.prototype.fit = function () {
    if (!this.term || !this.fitAddon) {
      return;
    }
    try {
      this.fitAddon.fit();
      this.send({ type: "resize", cols: this.term.cols, rows: this.term.rows });
    } catch (error) {
      /* パネルが隠れている場合は無視 */
    }
  };

  TerminalPanel.prototype.connect = function (siteId) {
    var next = siteId || "";
    if (this.socket && next === this.siteId && this.socket.readyState <= 1) {
      this.fit();
      return;
    }
    this.siteId = next;
    this.disconnect();
    var protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    var url =
      protocol +
      "//" +
      window.location.host +
      "/ws/terminal?id=" +
      encodeURIComponent(this.sessionId) +
      (next ? "&site=" + encodeURIComponent(next) : "");
    var self = this;
    try {
      this.socket = new WebSocket(url);
    } catch (error) {
      this.onStatus("接続に失敗しました: " + error.message, "error");
      return;
    }
    this.socket.onopen = function () {
      self.onStatus("接続しました", "ok");
      self.fit();
    };
    this.socket.onmessage = function (event) {
      var message;
      try {
        message = JSON.parse(event.data);
      } catch (error) {
        return;
      }
      if (message.type === "data" && self.term) {
        self.term.write(message.data);
      }
    };
    this.socket.onclose = function () {
      self.onStatus("切断されました", "warn");
    };
    this.socket.onerror = function () {
      self.onStatus("接続エラーが発生しました", "error");
    };
  };

  TerminalPanel.prototype.disconnect = function () {
    if (this.socket) {
      try {
        this.socket.close();
      } catch (error) {
        /* noop */
      }
      this.socket = null;
    }
  };

  TerminalPanel.prototype.send = function (message) {
    if (!this.socket || this.socket.readyState !== 1) {
      return false;
    }
    try {
      this.socket.send(JSON.stringify(message));
      return true;
    } catch (error) {
      return false;
    }
  };

  TerminalPanel.prototype.run = function (command) {
    return this.send({ type: "command", data: command });
  };

  TerminalPanel.prototype.write = function (text) {
    if (this.term) {
      this.term.write(text);
    }
  };

  window.htmleditTerminal = {
    create: function (options) {
      return new TerminalPanel(options);
    }
  };
})();
