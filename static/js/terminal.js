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
    this.command = "";
    this.cwd = null;
    this.sessionId = "htmledit-" + Math.random().toString(36).slice(2, 10);
  }

  TerminalPanel.prototype._initTerm = function () {
    if (this.term) {
      return;
    }
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

  /* パネルが表示されている状態で初期化する (寸法が分かる状態で開く必要がある) */
  TerminalPanel.prototype.show = function () {
    this._initTerm();
    var self = this;
    setTimeout(function () {
      self.fit();
      self.focus();
    }, 30);
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

  TerminalPanel.prototype.connect = function (siteId, command, cwd) {
    var next = siteId || "";
    var cmd = command || "";
    // cwd が未指定 (null) のときはサイトのディレクトリ、
    // 空文字のときはメモのルートを使う
    var dir = cwd === undefined || cwd === null ? null : String(cwd);
    if (
      this.socket &&
      next === this.siteId &&
      cmd === this.command &&
      dir === this.cwd &&
      this.socket.readyState <= 1
    ) {
      this.fit();
      return;
    }
    this.siteId = next;
    this.command = cmd;
    this.cwd = dir;
    this.disconnect();
    var protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    var url =
      protocol +
      "//" +
      window.location.host +
      "/ws/terminal?id=" +
      encodeURIComponent(this.sessionId + (cmd ? "-" + cmd.replace(/[^A-Za-z0-9_-]/g, "") : "")) +
      (next ? "&site=" + encodeURIComponent(next) : "") +
      (dir !== null ? "&cwd=" + encodeURIComponent(dir) : "") +
      (cmd ? "&cmd=" + encodeURIComponent(cmd) : "");
    var self = this;
    try {
      this.socket = new WebSocket(url);
    } catch (error) {
      this.onStatus("接続に失敗しました: " + error.message, "error");
      return;
    }
    this.socket.onopen = function () {
      self.onStatus(cmd ? "接続しました (" + cmd + ")" : "接続しました", "ok");
      self.fit();
      // 寸法が求まらない場合でも大きめの既定サイズで告知する
      self.send({
        type: "resize",
        cols: self.term ? self.term.cols : 120,
        rows: self.term ? self.term.rows : 35
      });
      self._flush();
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

  /* 接続完了前の送信分を保持して、接続後にまとめて送る */
  TerminalPanel.prototype._flush = function () {
    var pending = this.queue || [];
    this.queue = [];
    for (var index = 0; index < pending.length; index += 1) {
      pending[index]();
    }
  };

  TerminalPanel.prototype.kill = function () {
    if (this.socket && this.socket.readyState === 1) {
      try {
        this.socket.send(JSON.stringify({ type: "kill" }));
      } catch (error) {
        /* noop */
      }
    }
    this.disconnect();
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
    if (this.socket && this.socket.readyState === 1) {
      try {
        this.socket.send(JSON.stringify(message));
        return true;
      } catch (error) {
        return false;
      }
    }
    // 未接続 (接続中) の場合はキューに積んでから送る
    if (!this.queue) {
      this.queue = [];
    }
    var self = this;
    this.queue.push(function () {
      self.send(message);
    });
    return false;
  };

  TerminalPanel.prototype.run = function (command) {
    return this.send({ type: "command", data: command });
  };

  TerminalPanel.prototype.focus = function () {
    if (this.term) {
      try {
        this.term.focus();
      } catch (error) {
        /* noop */
      }
    }
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
