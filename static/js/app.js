/* global window, document, fetch, setTimeout, clearTimeout */
/**
 * htmledit アプリケーション本体。
 */
(function () {
  "use strict";

  var state = {
    sites: [],
    siteId: null,
    path: null,
    status: null,
    version: null,
    collapsed: {},
    treeEntries: [],
    editingSiteId: null,
    opencodeStarted: false
  };

  var el = {};

  function $(id) {
    return document.getElementById(id);
  }

  /* ------------------------------------------------------------------ */
  /* ユーティリティ                                                      */
  /* ------------------------------------------------------------------ */
  function api(path, options) {
    options = options || {};
    var init = {
      method: options.method || "GET",
      headers: { "X-Requested-With": "htmledit" },
      credentials: "same-origin"
    };
    if (options.body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(options.body);
    }
    return fetch(path, init).then(function (response) {
      return response
        .json()
        .catch(function () {
          return {};
        })
        .then(function (payload) {
          if (!response.ok) {
            var error = new Error(payload.error || response.statusText || "リクエストに失敗しました");
            error.status = response.status;
            error.payload = payload;
            throw error;
          }
          return payload;
        });
    });
  }

  function toast(message, kind) {
    var node = document.createElement("div");
    node.className = "toast" + (kind ? " is-" + kind : "");
    node.textContent = message;
    el.toastContainer.appendChild(node);
    setTimeout(function () {
      node.remove();
    }, kind === "error" ? 9000 : 4500);
  }

  function busy(target, isBusy) {
    if (!target) {
      return;
    }
    target.classList.toggle("is-busy", !!isBusy);
  }

  function formatDate(value) {
    if (!value) {
      return "";
    }
    var date = new Date(value);
    if (isNaN(date.getTime())) {
      return value;
    }
    return date.toLocaleString("ja-JP", { hour12: false });
  }

  function formatBytes(size) {
    if (!size && size !== 0) {
      return "";
    }
    var units = ["B", "KB", "MB", "GB"];
    var index = 0;
    var value = size;
    while (value >= 1024 && index < units.length - 1) {
      value = value / 1024;
      index += 1;
    }
    return (index === 0 ? value : value.toFixed(1)) + " " + units[index];
  }

  /* ------------------------------------------------------------------ */
  /* バージョン / アップデート / 再起動                                    */
  /* ------------------------------------------------------------------ */
  function loadVersion() {
    return api("/api/version")
      .then(function (payload) {
        state.version = payload;
        el.appVersion.textContent = payload.label || "v" + payload.version;
        el.appVersion.title = "バージョン " + (payload.label || payload.version);
        var repo = payload.repository || {};
        var parts = [];
        if (repo.branch) {
          parts.push("branch: " + repo.branch);
        }
        if (repo.lastCommit && repo.lastCommit.shortHash) {
          parts.push("commit: " + repo.lastCommit.shortHash);
        }
        if (repo.dirty) {
          parts.push("未コミットの変更あり");
        }
        el.topbarMeta.textContent = parts.join("  /  ");
        el.topbarMeta.title = repo.remote || "";
      })
      .catch(function (error) {
        el.topbarMeta.textContent = "バージョン情報の取得に失敗しました: " + error.message;
      });
  }

  function runUpdate() {
    if (!confirm("htmledit を最新バージョンにアップデートします。よろしいですか？")) {
      return;
    }
    busy(el.btnUpdate, true);
    el.btnUpdate.disabled = true;
    api("/api/self/update", { method: "POST" })
      .then(function (payload) {
        if (payload.updated) {
          toast(payload.message + "\n再起動すると新しいバージョンが反映されます。", "success");
        } else {
          toast(payload.message || "すでに最新です。", "info");
        }
        return loadVersion();
      })
      .catch(function (error) {
        toast("アップデートに失敗しました: " + error.message, "error");
      })
      .finally(function () {
        busy(el.btnUpdate, false);
        el.btnUpdate.disabled = false;
      });
  }

  function runRestart() {
    if (!confirm("htmledit サービスを再起動します。よろしいですか？")) {
      return;
    }
    busy(el.btnRestart, true);
    el.btnRestart.disabled = true;
    api("/api/self/restart", { method: "POST" })
      .then(function () {
        toast("再起動しています。しばらく待ってください…", "warn");
        waitForRestart();
      })
      .catch(function (error) {
        toast("再起動に失敗しました: " + error.message, "error");
        busy(el.btnRestart, false);
        el.btnRestart.disabled = false;
      });
  }

  function waitForRestart() {
    var attempts = 0;
    var timer = setInterval(function () {
      attempts += 1;
      fetch("/api/version", { cache: "no-store" })
        .then(function (response) {
          if (!response.ok) {
            throw new Error("not ready");
          }
          clearInterval(timer);
          toast("再起動が完了しました。画面を再読み込みします。", "success");
          setTimeout(function () {
            window.location.reload();
          }, 600);
        })
        .catch(function () {
          if (attempts > 60) {
            clearInterval(timer);
            busy(el.btnRestart, false);
            el.btnRestart.disabled = false;
            toast("再起動を確認できませんでした。", "error");
          }
        });
    }, 1000);
  }

  /* ------------------------------------------------------------------ */
  /* サイト管理                                                          */
  /* ------------------------------------------------------------------ */
  function loadSites() {
    return api("/api/sites")
      .then(function (payload) {
        state.sites = payload.sites || [];
        renderSites();
        if (!state.sites.length) {
          state.siteId = null;
          setBaseHref(null);
          el.tree.innerHTML = '<div class="tree-empty">右上の「+ 追加」から GitHub のリポジトリを追加してください。<br />追加すると、ここにフォルダ一覧が表示されます。</div>';
          el.treeTitle.textContent = "ファイル";
          clearGitPane();
          return;
        }
        var current = state.sites.filter(function (site) {
          return site.id === state.siteId;
        })[0];
        selectSite((current || state.sites[0]).id);
      })
      .catch(function (error) {
        toast("サイト一覧の取得に失敗しました: " + error.message, "error");
      });
  }

  function renderSites() {
    el.siteList.innerHTML = "";
    state.sites.forEach(function (site) {
      var item = document.createElement("li");
      item.className = "site-item" + (site.id === state.siteId ? " is-active" : "");

      var name;
      if (site.site_url) {
        /* サイトURL が登録されていれば表示名を別タブで開くリンクにする */
        name = document.createElement("a");
        name.className = "site-item-name site-item-link";
        name.href = site.site_url;
        name.target = "_blank";
        name.rel = "noopener noreferrer";
        name.title = site.site_url + " を別タブで開く";
      } else {
        name = document.createElement("span");
        name.className = "site-item-name";
        name.title = site.url;
      }
      name.textContent = site.name;
      item.appendChild(name);

      if (site.hasToken) {
        var badge = document.createElement("span");
        badge.className = "site-item-badge";
        badge.textContent = "PAT";
        badge.title = "PAT 登録済み (" + (site.username || "認証情報あり") + ")";
        item.appendChild(badge);
      }

      var auth = document.createElement("button");
      auth.type = "button";
      auth.className = "site-item-remove";
      auth.textContent = "🔑";
      auth.title = "認証情報 (ユーザーID / PAT) を編集";
      auth.addEventListener("click", function (event) {
        event.stopPropagation();
        openCredentialDialog(site);
      });
      item.appendChild(auth);

      var remove = document.createElement("button");
      remove.type = "button";
      remove.className = "site-item-remove";
      remove.textContent = "×";
      remove.title = "このサイトを削除";
      remove.addEventListener("click", function (event) {
        event.stopPropagation();
        removeSite(site);
      });
      item.appendChild(remove);

      item.addEventListener("click", function () {
        selectSite(site.id);
      });
      el.siteList.appendChild(item);
    });
  }

  function selectSite(siteId) {
    var changed = siteId !== state.siteId;
    if (changed && editor && editor.dirty) {
      if (!confirm("未保存の変更があります。サイトを変更しますか？")) {
        return;
      }
    }
    state.siteId = siteId;
    if (changed) {
      state.path = null;
      editor.clear();
      el.currentFile.textContent = "ファイルが選択されていません";
      setBaseHref(siteId);
    }
    renderSites();
    refreshTree();
    refreshGit();
    if (terminalPanel && el.terminalPane && !el.terminalPane.classList.contains("is-hidden")) {
      terminalPanel.connect(siteId, "opencode");
    }
  }

  /* エディター内の相対 URL (images/... など) をサイトファイルへ解決させる */
  function setBaseHref(siteId, pagePath) {
    var base = document.getElementById("site-base");
    if (!base) {
      base = document.createElement("base");
      base.id = "site-base";
      document.head.appendChild(base);
    }
    if (!siteId) {
      base.removeAttribute("href");
      return;
    }
    // 開いているページと同じ階層を基準にすると相対パスが正しく解決される
    var dir = "";
    if (pagePath) {
      var index = pagePath.lastIndexOf("/");
      dir = index >= 0 ? pagePath.slice(0, index + 1) : "";
    }
    base.setAttribute("href", "/site/" + encodeURIComponent(siteId) + "/" + dir);
  }

  function removeSite(site) {
    if (!confirm("サイト「" + site.name + "」を削除しますか？\n(ローカルに clone した内容も削除されます)")) {
      return;
    }
    api("/api/sites/" + encodeURIComponent(site.id), { method: "DELETE" })
      .then(function () {
        toast("サイトを削除しました。", "success");
        if (state.siteId === site.id) {
          state.siteId = null;
        }
        loadSites();
      })
      .catch(function (error) {
        toast("サイトの削除に失敗しました: " + error.message, "error");
      });
  }

  function openSiteDialog() {
    state.editingSiteId = null;
    el.siteDialogTitle.textContent = "サイトを追加";
    el.btnSiteSubmit.textContent = "追加する";
    el.siteError.hidden = true;
    el.siteUrl.value = "";
    el.siteUrl.disabled = false;
    el.siteBranch.value = "";
    el.siteBranch.disabled = false;
    el.siteName.value = "";
    el.siteSiteUrl.value = "";
    el.siteUsername.value = "";
    el.siteToken.value = "";
    el.siteToken.placeholder = "ghp_xxxxxxxx";
    el.siteDialog.showModal();
    el.siteUrl.focus();
  }

  function openCredentialDialog(site) {
    state.editingSiteId = site.id;
    el.siteDialogTitle.textContent = "認証情報を編集 - " + site.name;
    el.btnSiteSubmit.textContent = "保存する";
    el.siteError.hidden = true;
    el.siteUrl.value = site.url;
    el.siteUrl.disabled = true;
    el.siteBranch.value = site.branch || "";
    el.siteBranch.disabled = true;
    el.siteName.value = site.name;
    el.siteSiteUrl.value = site.site_url || "";
    el.siteUsername.value = site.username || "";
    el.siteToken.value = "";
    el.siteToken.placeholder = site.hasToken ? "登録済み (空欄で変更なし)" : "ghp_xxxxxxxx";
    el.siteDialog.showModal();
    el.siteUsername.focus();
  }

  /* サイトURL を正規化する (http / https のみ許可) */
  function normalizeSiteUrl(value) {
    var text = (value || "").trim();
    if (!text) {
      return "";
    }
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:(?![0-9])/.test(text)) {
      if (!/^https?:\/\//i.test(text)) {
        throw new Error("サイト URL は http / https で指定してください。");
      }
    } else {
      text = "https://" + text.replace(/^\/+/, "");
    }
    if (!/^https?:\/\/[^/\s?#]+/i.test(text)) {
      throw new Error("サイト URL の形式を解釈できません。");
    }
    return text;
  }

  function submitSiteDialog() {
    var username = el.siteUsername.value.trim();
    var token = el.siteToken.value.trim();
    var siteUrl = "";

    try {
      siteUrl = normalizeSiteUrl(el.siteSiteUrl.value);
    } catch (error) {
      el.siteError.textContent = error.message;
      el.siteError.hidden = false;
      return;
    }

    if (state.editingSiteId) {
      busy(el.btnSiteSubmit, true);
      el.btnSiteSubmit.disabled = true;
      api("/api/sites/" + encodeURIComponent(state.editingSiteId), {
        method: "PATCH",
        body: { name: el.siteName.value.trim(), siteUrl: siteUrl, username: username, token: token }
      })
        .then(function (payload) {
          el.siteDialog.close();
          toast("認証情報を更新しました: " + payload.site.name, "success");
          loadSites();
        })
        .catch(function (error) {
          el.siteError.textContent = error.message;
          el.siteError.hidden = false;
        })
        .finally(function () {
          busy(el.btnSiteSubmit, false);
          el.btnSiteSubmit.disabled = false;
        });
      return;
    }

    var url = el.siteUrl.value.trim();
    if (!url) {
      el.siteError.textContent = "GitHub の URL を入力してください。";
      el.siteError.hidden = false;
      return;
    }
    busy(el.btnSiteSubmit, true);
    el.btnSiteSubmit.disabled = true;
    api("/api/sites", {
      method: "POST",
      body: {
        url: url,
        branch: el.siteBranch.value.trim(),
        name: el.siteName.value.trim(),
        siteUrl: siteUrl,
        username: username,
        token: token
      }
    })
      .then(function (payload) {
        el.siteDialog.close();
        state.siteId = payload.site.id;
        toast("サイト「" + payload.site.name + "」を追加しました。", "success");
        loadSites();
      })
      .catch(function (error) {
        el.siteError.textContent = error.message;
        el.siteError.hidden = false;
      })
      .finally(function () {
        busy(el.btnSiteSubmit, false);
        el.btnSiteSubmit.disabled = false;
      });
  }

  /* ------------------------------------------------------------------ */
  /* ファイルツリー / 編集                                               */
  /* ------------------------------------------------------------------ */
  function refreshTree() {
    if (!state.siteId) {
      return Promise.resolve();
    }
    return api("/api/sites/" + encodeURIComponent(state.siteId) + "/tree")
      .then(function (payload) {
        state.treeEntries = payload.tree || [];
        renderTree(state.treeEntries);
      })
      .catch(function (error) {
        el.tree.innerHTML = '<div class="tree-empty">' + escapeHtml(error.message) + "</div>";
      });
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* 展開中のフォルダをすべて折りたたむ */
  function foldTree() {
    (state.treeEntries || []).forEach(function (entry) {
      if (entry.type === "dir") {
        state.collapsed[entry.path] = true;
      }
    });
    renderTree(state.treeEntries || []);
  }

  function renderTree(entries) {
    el.tree.innerHTML = "";
    if (!entries.length) {
      el.tree.innerHTML = '<div class="tree-empty">このリポジトリにはファイルがありません。</div>';
      return;
    }
    var site = currentSite();
    el.treeTitle.textContent = site ? site.name : "ファイル";

    entries.forEach(function (entry) {
      var depth = entry.path.split("/").length - 1;
      if (isHidden(entry.path)) {
        return;
      }
      var row = document.createElement("div");
      row.className = "tree-row" + (entry.type === "dir" ? " is-dir" : "");
      row.style.paddingLeft = 8 + depth * 14 + "px";
      row.title = entry.path;

      var icon = document.createElement("span");
      icon.className = "tree-icon";
      icon.textContent = entry.type === "dir" ? (state.collapsed[entry.path] ? "▸" : "▾") : "▪";
      row.appendChild(icon);

      var name = document.createElement("span");
      name.className = "tree-name" + (entry.type === "dir" ? " is-dir" : "");
      name.textContent = entry.name;
      row.appendChild(name);

      if (entry.type === "file") {
        var size = document.createElement("span");
        size.className = "tree-icon";
        size.style.marginLeft = "auto";
        size.style.fontSize = "11px";
        size.textContent = formatBytes(entry.size);
        row.appendChild(size);
        row.addEventListener("click", function () {
          openFile(entry.path);
        });
        if (isImagePath(entry.path)) {
          row.draggable = true;
          row.title = entry.path + " (エディターへドラッグして埋め込めます)";
          row.addEventListener("dragstart", function (event) {
            event.dataTransfer.setData("application/x-htmledit-path", entry.path);
            event.dataTransfer.setData("text/plain", entry.path);
            event.dataTransfer.effectAllowed = "copy";
          });
        }
      } else {
        row.addEventListener("click", function () {
          state.collapsed[entry.path] = !state.collapsed[entry.path];
          refreshTree();
        });
      }
      if (entry.path === state.path) {
        row.classList.add("is-active");
      }
      row.addEventListener("contextmenu", function (event) {
        event.preventDefault();
        event.stopPropagation();
        showTreeMenu(event.clientX, event.clientY, {
          type: entry.type,
          path: entry.path,
          dir: entry.type === "file" ? parentDir(entry.path) : entry.path
        });
      });
      el.tree.appendChild(row);
    });
  }

  function parentDir(path) {
    if (!path) {
      return "";
    }
    var index = path.lastIndexOf("/");
    return index < 0 ? "" : path.slice(0, index);
  }

  /* イベントの対象がツリーの行かどうか (行側のメニューと重複させないため) */
  function isTreeRow(node) {
    while (node && node !== el.tree) {
      if (node.classList && node.classList.contains("tree-row")) {
        return true;
      }
      node = node.parentNode;
    }
    return false;
  }

  function isHidden(path) {
    var parts = path.split("/");
    for (var index = 1; index < parts.length; index += 1) {
      var parent = parts.slice(0, index).join("/");
      if (state.collapsed[parent]) {
        return true;
      }
    }
    return false;
  }

  function currentSite() {
    return state.sites.filter(function (site) {
      return site.id === state.siteId;
    })[0];
  }

  function openFile(path) {
    if (!state.siteId) {
      return;
    }
    api("/api/sites/" + encodeURIComponent(state.siteId) + "/file?path=" + encodeURIComponent(path))
      .then(function (payload) {
        state.path = path;
        el.currentFile.textContent = path;
        editor.load(path, payload.content);
        setBaseHref(state.siteId, path);
        setEditorMode(isHtmlFile(path) ? "wysiwyg" : "source");
        editor.setStatus(path + " (" + formatBytes(payload.size) + ") を読み込みました");
        refreshTree();
      })
      .catch(function (error) {
        toast("ファイルを開けませんでした: " + error.message, "error");
      });
  }

  function isHtmlFile(path) {
    return /\.(html?|xhtml)$/i.test(path);
  }

  /* ------------------------------------------------------------------ */
  /* エクスプローラの右クリックメニュー (selfcode と同じ構成)             */
  /* ------------------------------------------------------------------ */
  var contextMenuEl = null;

  function showTreeMenu(x, y, target) {
    if (!state.siteId) {
      return;
    }
    var items = [];
    if (target.type === "file") {
      items.push({ label: "開く", act: function () { openFile(target.path); } });
      items.push({ label: "ここで opencode", act: function () { openOpencodeAt(target.dir); } });
      items.push({ label: "パスをコピー", act: function () { copyTreePath(target.path); } });
      items.push({ sep: true });
      items.push({ label: "アップロード", act: function () { uploadTreeFiles(target.dir); } });
      items.push({ label: "ダウンロード", act: function () { downloadTreeFile(target.path); } });
      items.push({ label: "リネーム", act: function () { renameTreePath(target.path); } });
      items.push({ label: "削除", act: function () { deleteTreePath(target.path); }, danger: true });
    } else {
      items.push({ label: "ファイル作成", act: function () { createTreeFile(target.path); } });
      items.push({ label: "フォルダ作成", act: function () { createTreeFolder(target.path); } });
      items.push({ sep: true });
      items.push({ label: "ここで opencode", act: function () { openOpencodeAt(target.path); } });
      items.push({ label: "パスをコピー", act: function () { copyTreePath(target.path); } });
      items.push({ sep: true });
      items.push({ label: "アップロード", act: function () { uploadTreeFiles(target.path); } });
      items.push({ label: "ダウンロード (ZIP)", act: function () { downloadTreeFile(target.path); } });
      items.push({ label: "リネーム", act: function () { renameTreePath(target.path); } });
      items.push({ label: "削除", act: function () { deleteTreePath(target.path); }, danger: true });
    }
    showContextMenu(x, y, items);
  }

  function showContextMenu(x, y, items) {
    var menu = contextMenu();
    menu.innerHTML = "";
    items.forEach(function (item) {
      if (item.sep) {
        menu.appendChild(document.createElement("hr"));
        return;
      }
      var button = document.createElement("button");
      button.type = "button";
      button.textContent = item.label;
      if (item.danger) {
        button.classList.add("danger");
      }
      button.addEventListener("click", function () {
        closeContextMenu();
        item.act();
      });
      menu.appendChild(button);
    });
    menu.style.display = "block";
    menu.style.visibility = "hidden";
    menu.style.left = "0px";
    menu.style.top = "0px";

    var rect = menu.getBoundingClientRect();
    var pad = 8;
    var posX = x;
    var posY = y;
    if (y + rect.height > window.innerHeight - pad) {
      posY = Math.max(pad, y - rect.height);
    }
    if (posX + rect.width > window.innerWidth - pad) {
      posX = Math.max(pad, window.innerWidth - rect.width - pad);
    }
    menu.style.left = posX + "px";
    menu.style.top = posY + "px";
    menu.style.visibility = "visible";
    menu._close = function () {
      closeContextMenu();
    };
    setTimeout(function () {
      document.addEventListener("click", menu._close, { once: true });
    }, 0);
  }

  function contextMenu() {
    if (contextMenuEl) {
      return contextMenuEl;
    }
    contextMenuEl = document.createElement("div");
    contextMenuEl.id = "context-menu";
    contextMenuEl.className = "context-menu";
    document.body.appendChild(contextMenuEl);
    return contextMenuEl;
  }

  function closeContextMenu() {
    if (!contextMenuEl) {
      return;
    }
    contextMenuEl.style.display = "none";
    if (contextMenuEl._close) {
      document.removeEventListener("click", contextMenuEl._close);
      contextMenuEl._close = null;
    }
  }

  function copyText(text) {
    var fallback = function () {
      return new Promise(function (resolve, reject) {
        var area = document.createElement("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.focus();
        area.select();
        try {
          if (document.execCommand("copy")) {
            resolve();
          } else {
            reject(new Error("copy failed"));
          }
        } catch (error) {
          reject(error);
        } finally {
          area.remove();
        }
      });
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).catch(fallback);
    }
    return fallback();
  }

  /* サイトのルートからの絶対パス */
  function siteAbsolute(path) {
    var site = currentSite();
    var root = site ? site.path : "";
    if (!path) {
      return root;
    }
    return root.replace(/\/+$/, "") + "/" + path;
  }

  function copyTreePath(path) {
    var absolute = siteAbsolute(path);
    copyText(absolute)
      .then(function () {
        toast("パスをコピーしました: " + absolute, "success");
      })
      .catch(function () {
        toast("コピーに失敗しました", "error");
      });
  }

  function siteApi(path) {
    return "/api/sites/" + encodeURIComponent(state.siteId) + path;
  }

  function createTreeFile(directory) {
    var name = window.prompt("ファイル名", "index.html");
    if (!name) {
      return;
    }
    var path = directory ? directory + "/" + name : name;
    api(siteApi("/file"), { method: "POST", body: { path: path, content: "" } })
      .then(function (payload) {
        toast("ファイルを作成しました: " + payload.path, "success");
        refreshTree();
        openFile(payload.path);
      })
      .catch(function (error) {
        toast("ファイルを作成できませんでした: " + error.message, "error");
      });
  }

  function createTreeFolder(directory) {
    var name = window.prompt("フォルダ名", "newfolder");
    if (!name) {
      return;
    }
    var path = directory ? directory + "/" + name : name;
    api(siteApi("/folder"), { method: "POST", body: { path: path } })
      .then(function (payload) {
        toast("フォルダを作成しました: " + payload.path, "success");
        refreshTree();
      })
      .catch(function (error) {
        toast("フォルダを作成できませんでした: " + error.message, "error");
      });
  }

  function renameTreePath(path) {
    var current = path.split("/").pop();
    var name = window.prompt("新しい名前", current);
    if (!name || name === current) {
      return;
    }
    var directory = parentDir(path);
    var to = directory ? directory + "/" + name : name;
    api(siteApi("/rename"), { method: "POST", body: { from: path, to: to } })
      .then(function (payload) {
        toast("名前を変更しました: " + payload.path, "success");
        if (state.path === path) {
          state.path = payload.path;
          el.currentFile.textContent = payload.path;
        }
        refreshTree();
      })
      .catch(function (error) {
        toast("名前を変更できませんでした: " + error.message, "error");
      });
  }

  function deleteTreePath(path) {
    if (!window.confirm("「" + path + "」を削除しますか？")) {
      return;
    }
    api(siteApi("/file"), { method: "DELETE", body: { path: path } })
      .then(function () {
        toast("削除しました: " + path, "success");
        if (state.path === path || state.path.indexOf(path + "/") === 0) {
          state.path = null;
          el.currentFile.textContent = "ファイルが選択されていません";
        }
        refreshTree();
      })
      .catch(function (error) {
        toast("削除できませんでした: " + error.message, "error");
      });
  }

  function downloadTreeFile(path) {
    var link = document.createElement("a");
    link.href = siteApi("/download?path=" + encodeURIComponent(path || ""));
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function uploadTreeFiles(directory) {
    var input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.addEventListener("change", function () {
      var files = Array.prototype.slice.call(input.files || []);
      if (!files.length) {
        return;
      }
      var count = 0;
      files
        .reduce(function (chain, file) {
          return chain.then(function () {
            return fetch(
              siteApi(
                "/upload?dir=" +
                  encodeURIComponent(directory || "") +
                  "&name=" +
                  encodeURIComponent(file.name)
              ),
              {
                method: "POST",
                headers: { "Content-Type": "application/octet-stream", "X-Requested-With": "htmledit" },
                credentials: "same-origin",
                body: file
              }
            )
              .then(function (response) {
                return response
                  .json()
                  .catch(function () {
                    return {};
                  })
                  .then(function (payload) {
                    if (!response.ok) {
                      throw new Error(payload.error || "アップロードに失敗しました");
                    }
                    return payload;
                  });
              })
              .then(function () {
                count += 1;
              })
              .catch(function (error) {
                toast(file.name + " のアップロードに失敗: " + error.message, "error");
              });
          });
        }, Promise.resolve())
        .then(function () {
          if (count) {
            toast(count + " 個のファイルをアップロードしました", "success");
          }
          refreshTree();
        });
    });
    input.click();
  }

  function setEditorMode(mode) {
    Array.prototype.forEach.call(document.querySelectorAll(".seg-btn"), function (button) {
      button.classList.toggle("is-active", button.dataset.mode === mode);
    });
    editor.setMode(mode);
    editor.setStatus(mode === "source" ? "ソースモード (ファイル全体)" : "WYSIWYG モード (本文)");
  }

  function saveFile() {
    if (!state.siteId || !state.path) {
      toast("保存するファイルを選択してください。", "warn");
      return;
    }
    busy(el.btnSave, true);
    el.btnSave.disabled = true;
    api("/api/sites/" + encodeURIComponent(state.siteId) + "/file", {
      method: "PUT",
      body: { path: state.path, content: editor.currentText() }
    })
      .then(function (payload) {
        editor.markSaved();
        toast("保存しました: " + payload.path, "success");
        editor.setStatus(payload.path + " を保存しました (" + formatBytes(payload.size) + ")");
        refreshTree();
        refreshGit();
      })
      .catch(function (error) {
        toast("保存に失敗しました: " + error.message, "error");
      })
      .finally(function () {
        busy(el.btnSave, false);
        el.btnSave.disabled = false;
      });
  }

  /* ------------------------------------------------------------------ */
  /* GitHub ペイン                                                       */
  /* ------------------------------------------------------------------ */
  function clearGitPane() {
    el.repoInfo.innerHTML = "";
    el.changeList.innerHTML = '<li class="empty">サイトを選択してください</li>';
    el.commitList.innerHTML = '<li class="empty">サイトを選択してください</li>';
    el.btnPull.disabled = true;
    el.btnPush.disabled = true;
    el.btnCommit.disabled = true;
  }

  function refreshGit() {
    if (!state.siteId) {
      clearGitPane();
      return Promise.resolve();
    }
    el.btnPull.disabled = false;
    el.btnPush.disabled = false;
    el.btnCommit.disabled = false;

    var base = "/api/sites/" + encodeURIComponent(state.siteId) + "/git";
    return Promise.all([
      api(base + "/status").catch(function (error) {
        toast("Git 状態の取得に失敗しました: " + error.message, "error");
        return null;
      }),
      api(base + "/log?limit=20").catch(function () {
        return { commits: [] };
      })
    ]).then(function (results) {
      var status = results[0];
      if (status) {
        state.status = status;
        renderRepoInfo(status);
        renderChanges(status.changes || []);
      }
      renderCommits((results[1] || {}).commits || []);
    });
  }

  function renderRepoInfo(status) {
    var site = currentSite() || {};
    var rows = [];
    rows.push(["リポジトリ", site.name || status.repo || "-"]);
    rows.push(["ブランチ", status.branch || "-"]);
    if (status.upstream) {
      rows.push(["追跡", status.upstream]);
    }
    var sync = [];
    if (status.ahead) {
      sync.push(" ahead " + status.ahead);
    }
    if (status.behind) {
      sync.push(" behind " + status.behind);
    }
    if (status.dirty) {
      sync.push(" 未コミット " + (status.changes || []).length + " 件");
    }
    var stateHtml = sync.length
      ? '<span class="badge badge-warn">' + escapeHtml(sync.join(" / ").trim()) + "</span>"
      : '<span class="badge badge-ok">クリーン</span>';
    rows.push(["状態", stateHtml]);
    if (status.lastCommit && status.lastCommit.subject) {
      rows.push([
        "最終コミット",
        '<span class="commit-hash">' + escapeHtml(status.lastCommit.shortHash || "") + "</span>" +
          escapeHtml(status.lastCommit.subject)
      ]);
      rows.push(["コミット日時", formatDate(status.lastCommit.date)]);
      rows.push(["作者", status.lastCommit.author || "-"]);
    }
    if (status.remoteUrl) {
      rows.push(["リモート", escapeHtml(status.remoteUrl)]);
    }
    el.repoInfo.innerHTML = rows
      .map(function (row) {
        return "<dt>" + escapeHtml(row[0]) + "</dt><dd>" + row[1] + "</dd>";
      })
      .join("");

    if (site.owner && site.repo) {
      api("/api/github/repo?owner=" + encodeURIComponent(site.owner) + "&repo=" + encodeURIComponent(site.repo))
        .then(function (info) {
          if (info.error) {
            el.githubInfo.innerHTML = '<dt>GitHub</dt><dd class="empty">' + escapeHtml(info.error) + "</dd>";
            return;
          }
          var extra = [];
          if (info.description) {
            extra.push(["説明", escapeHtml(info.description)]);
          }
          extra.push(["スター", String(info.stars)]);
          extra.push(["フォーク", String(info.forks)]);
          extra.push(["Issue", String(info.openIssues)]);
          extra.push(["既定ブランチ", info.defaultBranch || "-"]);
          extra.push(["言語", info.language || "-"]);
          extra.push(["ライセンス", info.license || "-"]);
          extra.push(["最終プッシュ", formatDate(info.pushedAt)]);
          if (info.htmlUrl) {
            extra.push([
              "URL",
              '<a href="' + escapeHtml(info.htmlUrl) + '" target="_blank" rel="noreferrer noopener">' +
                escapeHtml(info.htmlUrl) + "</a>"
            ]);
          }
          el.githubInfo.innerHTML = extra
            .map(function (row) {
              return "<dt>" + escapeHtml(row[0]) + "</dt><dd>" + row[1] + "</dd>";
            })
            .join("");
        })
        .catch(function () {
          /* GitHub API が失敗してもローカルの情報だけで操作は可能 */
        });
    }
  }

  function renderChanges(changes) {
    el.changeList.innerHTML = "";
    if (!changes.length) {
      el.changeList.innerHTML = '<li class="empty">変更はありません</li>';
      return;
    }
    changes.forEach(function (change) {
      var item = document.createElement("li");
      var status = document.createElement("span");
      status.className = "change-status";
      status.textContent = change.status;
      var path = document.createElement("span");
      path.className = "change-path";
      path.textContent = change.path;
      item.appendChild(status);
      item.appendChild(path);
      el.changeList.appendChild(item);
    });
  }

  function renderCommits(commits) {
    el.commitList.innerHTML = "";
    if (!commits.length) {
      el.commitList.innerHTML = '<li class="empty">コミット履歴はありません</li>';
      return;
    }
    commits.forEach(function (commit) {
      var item = document.createElement("li");
      var subject = document.createElement("div");
      subject.className = "commit-subject";
      var hash = document.createElement("span");
      hash.className = "commit-hash";
      hash.textContent = commit.shortHash;
      subject.appendChild(hash);
      subject.appendChild(document.createTextNode(commit.subject || ""));
      var meta = document.createElement("div");
      meta.className = "commit-meta";
      meta.textContent = (commit.author || "") + " ・ " + formatDate(commit.date);
      item.appendChild(subject);
      item.appendChild(meta);
      el.commitList.appendChild(item);
    });
  }

  function runPull() {
    if (!state.siteId) {
      return;
    }
    busy(el.btnPull, true);
    el.btnPull.disabled = true;
    api("/api/sites/" + encodeURIComponent(state.siteId) + "/git/pull", { method: "POST" })
      .then(function (payload) {
        toast("pull 完了\n" + (payload.output || ""), "success");
        refreshTree();
        refreshGit();
      })
      .catch(function (error) {
        toast("pull に失敗しました: " + error.message, "error");
      })
      .finally(function () {
        busy(el.btnPull, false);
        el.btnPull.disabled = false;
      });
  }

  function runCommit() {
    if (!state.siteId) {
      return;
    }
    var message = el.commitMessage.value.trim();
    if (!message) {
      toast("コミットメッセージを入力してください。", "warn");
      el.commitMessage.focus();
      return;
    }
    busy(el.btnCommit, true);
    el.btnCommit.disabled = true;
    api("/api/sites/" + encodeURIComponent(state.siteId) + "/git/commit", {
      method: "POST",
      body: { message: message }
    })
      .then(function (payload) {
        el.commitMessage.value = "";
        var message = "コミットしました\n" + (payload.output || "");
        if (payload.files && payload.files.length) {
          message += "\n" + payload.files.slice(0, 8).join("\n");
          if (payload.files.length > 8) {
            message += "\n他 " + (payload.files.length - 8) + " ファイル";
          }
        }
        toast(message, "success");
        refreshTree();
        refreshGit();
      })
      .catch(function (error) {
        toast("commit に失敗しました: " + error.message, "error");
      })
      .finally(function () {
        busy(el.btnCommit, false);
        el.btnCommit.disabled = false;
      });
  }

  function runPush() {
    if (!state.siteId) {
      return;
    }
    busy(el.btnPush, true);
    el.btnPush.disabled = true;
    api("/api/sites/" + encodeURIComponent(state.siteId) + "/git/push", { method: "POST", body: {} })
      .then(function (payload) {
        toast("push 完了\n" + (payload.output || ""), "success");
        refreshGit();
      })
      .catch(function (error) {
        toast("push に失敗しました: " + error.message, "error");
      })
      .finally(function () {
        busy(el.btnPush, false);
        el.btnPush.disabled = false;
      });
  }

  /* ------------------------------------------------------------------ */
  /* プロパティペイン (リンク / 画像)                                     */
  /* ------------------------------------------------------------------ */
  var IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico"];

  function isImagePath(path) {
    var ext = (path.split(".").pop() || "").toLowerCase();
    return IMAGE_EXTENSIONS.indexOf(ext) >= 0;
  }

  function baseName(path) {
    var parts = (path || "").split("/");
    return parts[parts.length - 1] || path;
  }

  function propRow(label, control) {
    var row = document.createElement("label");
    row.className = "field";
    var caption = document.createElement("span");
    caption.className = "field-label";
    caption.textContent = label;
    row.appendChild(caption);
    row.appendChild(control);
    return row;
  }

  function propInput(value, onChange, type) {
    var input = document.createElement("input");
    input.className = "input";
    input.type = type || "text";
    input.value = value == null ? "" : value;
    input.addEventListener("change", function () {
      onChange(input.value);
    });
    return input;
  }

  function propCheck(checked, label, onChange) {
    var wrapper = document.createElement("label");
    wrapper.className = "check";
    var input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !!checked;
    input.addEventListener("change", function () {
      onChange(input.checked);
    });
    var text = document.createElement("span");
    text.textContent = label;
    wrapper.appendChild(input);
    wrapper.appendChild(text);
    return wrapper;
  }

  function propButton(label, onClick, title) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "btn btn-sm";
    button.textContent = label;
    if (title) {
      button.title = title;
    }
    button.addEventListener("click", onClick);
    return button;
  }

  function propSection(title) {
    var section = document.createElement("section");
    section.className = "prop-section";
    var heading = document.createElement("h3");
    heading.className = "card-title";
    heading.textContent = title;
    section.appendChild(heading);
    return section;
  }

  function renderProperties(info) {
    state.selection = info;
    var body = el.propBody;
    body.innerHTML = "";

    var link = info && info.link;
    var image = info && info.image;
    if (!link && !image) {
      body.innerHTML =
        '<div class="prop-empty">エディター上でリンクや画像をクリックすると、ここにオプションが表示されます。<br /><br />' +
        "画像はファイルツリーやローカルファイルから直接ドロップして埋め込めます。</div>";
      return;
    }

    if (link) {
      body.appendChild(buildLinkSection(link));
    }
    if (image) {
      body.appendChild(buildImageSection(image));
    }
  }

  function buildLinkSection(link) {
    var section = propSection("ハイパーリンク");
    var href = link.getAttribute("href") || "";

    section.appendChild(
      propRow("リンク先 URL", propInput(href, function (value) {
        link.setAttribute("href", value);
        editor.notifyChange();
      }))
    );
    section.appendChild(
      propRow("表示文字列", propInput(link.textContent || "", function (value) {
        link.textContent = value;
        editor.notifyChange();
      }))
    );
    section.appendChild(
      propCheck(link.getAttribute("target") === "_blank", "新しいページで開く (target=_blank)", function (checked) {
        if (checked) {
          link.setAttribute("target", "_blank");
          link.setAttribute("rel", link.getAttribute("rel") || "noopener");
        } else {
          link.removeAttribute("target");
        }
        editor.notifyChange();
      })
    );
    section.appendChild(
      propRow("title 属性", propInput(link.getAttribute("title") || "", function (value) {
        if (value) {
          link.setAttribute("title", value);
        } else {
          link.removeAttribute("title");
        }
        editor.notifyChange();
      }))
    );
    section.appendChild(
      propRow("rel 属性", propInput(link.getAttribute("rel") || "", function (value) {
        if (value) {
          link.setAttribute("rel", value);
        } else {
          link.removeAttribute("rel");
        }
        editor.notifyChange();
      }))
    );

    var actions = document.createElement("div");
    actions.className = "btn-row";
    actions.appendChild(
      propButton("リンクを開く", function () {
        window.open(link.getAttribute("href") || "#", "_blank", "noopener");
      })
    );
    actions.appendChild(
      propButton("URL をコピー", function () {
        var value = link.getAttribute("href") || "";
        if (navigator.clipboard) {
          navigator.clipboard.writeText(value);
        }
        toast("URL をコピーしました: " + value, "success");
      })
    );
    section.appendChild(actions);
    return section;
  }

  function buildImageSection(image) {
    var section = propSection("画像");
    var src = image.getAttribute("src") || "";
    var parentLink = editor.closestElement(image.parentElement, "A");

    var resolved = document.createElement("input");
    resolved.className = "input";
    resolved.type = "text";
    resolved.readOnly = true;
    resolved.value = image.src || "";
    resolved.title = "エディター内で解決される URL";

    var urlInput = propInput(src, function (value) {
      image.setAttribute("src", value);
      editor.notifyChange();
    });
    var altInput = propInput(image.getAttribute("alt") || "", function (value) {
      image.setAttribute("alt", value);
      editor.notifyChange();
    });
    section.appendChild(propRow("画像 URL", urlInput));
    section.appendChild(propRow("代替テキスト (alt)", altInput));
    section.appendChild(
      propRow("幅 (px)", propInput(image.getAttribute("width") || "", function (value) {
        if (value) {
          image.setAttribute("width", value);
        } else {
          image.removeAttribute("width");
        }
        editor.notifyChange();
      }, "text"))
    );
    section.appendChild(
      propRow("高さ (px)", propInput(image.getAttribute("height") || "", function (value) {
        if (value) {
          image.setAttribute("height", value);
        } else {
          image.removeAttribute("height");
        }
        editor.notifyChange();
      }, "text"))
    );
    section.appendChild(
      propRow("title 属性", propInput(image.getAttribute("title") || "", function (value) {
        if (value) {
          image.setAttribute("title", value);
        } else {
          image.removeAttribute("title");
        }
        editor.notifyChange();
      }))
    );
    section.appendChild(propRow("解決後の URL", resolved));
    section.appendChild(
      propCheck(!!parentLink, "画像をクリック時にリンクを開く", function (checked) {
        toggleImageLink(image, checked);
        editor.notifyChange();
        renderProperties(state.selection);
      })
    );
    if (parentLink) {
      section.appendChild(
        propRow("リンク先 URL", propInput(parentLink.getAttribute("href") || "", function (value) {
          parentLink.setAttribute("href", value);
          editor.notifyChange();
        }))
      );
      section.appendChild(
        propCheck(parentLink.getAttribute("target") === "_blank", "新しいページで開く", function (checked) {
          if (checked) {
            parentLink.setAttribute("target", "_blank");
            parentLink.setAttribute("rel", parentLink.getAttribute("rel") || "noopener");
          } else {
            parentLink.removeAttribute("target");
          }
          editor.notifyChange();
        })
      );
    }

    var actions = document.createElement("div");
    actions.className = "btn-row";
    actions.appendChild(
      propButton("元画像を開く", function () {
        window.open(image.getAttribute("src") || "#", "_blank", "noopener");
      })
    );
    actions.appendChild(
      propButton("画像を削除", function () {
        if (image.parentNode) {
          image.parentNode.removeChild(image);
        }
        editor.notifyChange();
        renderProperties(null);
      })
    );
    section.appendChild(actions);
    // サムネイルはカード的最下部 (操作ボタンの下) に置く
    section.appendChild(buildImageGallery(image, { url: urlInput, alt: altInput, resolved: resolved }));
    return section;
  }

  function toggleImageLink(image, wantLink) {
    var existing = editor.closestElement(image.parentElement, "A");
    if (wantLink && !existing) {
      var anchor = document.createElement("a");
      anchor.href = image.getAttribute("src") || "#";
      anchor.target = "_blank";
      anchor.rel = "noopener";
      image.parentNode.insertBefore(anchor, image);
      anchor.appendChild(image);
    } else if (!wantLink && existing) {
      var parent = existing.parentNode;
      while (existing.firstChild) {
        parent.insertBefore(existing.firstChild, existing);
      }
      parent.removeChild(existing);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 保存済みの画像 (public/images) のサムネイル                          */
  /* ------------------------------------------------------------------ */
  var ASSET_PREFIX = "public/images";
  var PLACEHOLDER_ALT = "画像";
  var GALLERY_PAGE_SIZE = 20;
  var assetCache = { key: "", promise: null };

  function assetCacheKey() {
    return (state.siteId || "") + "|" + (state.path || "");
  }

  function invalidateAssetImages() {
    assetCache.key = "";
    assetCache.promise = null;
  }

  function loadAssetImages(force) {
    var siteId = state.siteId;
    if (!siteId) {
      return Promise.resolve([]);
    }
    var key = assetCacheKey();
    if (!force && assetCache.key === key && assetCache.promise) {
      return assetCache.promise;
    }
    var query =
      "?prefix=" + encodeURIComponent(ASSET_PREFIX) + "&page=" + encodeURIComponent(state.path || "");
    assetCache.key = key;
    assetCache.promise = api("/api/sites/" + encodeURIComponent(siteId) + "/assets" + query)
      .then(function (payload) {
        return payload.images || [];
      })
      .catch(function (error) {
        assetCache.promise = null;
        throw error;
      });
    return assetCache.promise;
  }

  /* サイト内のファイルを配信する URL (サムネイル用) */
  function siteFileUrl(path) {
    var parts = String(path || "")
      .split("/")
      .map(function (part) {
        return encodeURIComponent(part);
      });
    return "/site/" + encodeURIComponent(state.siteId || "") + "/" + parts.join("/");
  }

  function buildImageGallery(image, controls) {
    var wrap = document.createElement("div");
    wrap.className = "image-gallery";

    var head = document.createElement("div");
    head.className = "image-gallery-head";
    var title = document.createElement("div");
    title.className = "image-gallery-title";
    title.textContent = "保存済みの画像 (" + ASSET_PREFIX + ")";
    head.appendChild(title);
    var refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "btn btn-sm";
    refresh.textContent = "更新";
    refresh.title = "保存済みの画像の一覧を再読み込み";
    head.appendChild(refresh);
    wrap.appendChild(head);

    var grid = document.createElement("div");
    grid.className = "image-gallery-grid";
    wrap.appendChild(grid);

    var status = document.createElement("div");
    status.className = "image-gallery-status";
    status.textContent = "読み込み中…";
    wrap.appendChild(status);

    var more = document.createElement("button");
    more.type = "button";
    more.className = "btn btn-sm btn-block image-gallery-more";
    more.hidden = true;
    wrap.appendChild(more);

    var images = [];
    var visible = GALLERY_PAGE_SIZE;

    var paint = function () {
      grid.innerHTML = "";
      if (!images.length) {
        status.hidden = false;
        status.textContent = "保存済みの画像はありません (" + ASSET_PREFIX + " を確認してください)";
        more.hidden = true;
        return;
      }
      status.hidden = true;
      title.textContent = "保存済みの画像 (" + ASSET_PREFIX + ") " + images.length + "件";
      images.slice(0, visible).forEach(function (asset) {
        grid.appendChild(buildThumbnail(asset, image, controls));
      });
      // 残りが無くなったらボタンを隠す (残数がマイナスにならないようにする)
      var rest = images.length - visible;
      if (rest > 0) {
        more.hidden = false;
        more.textContent = "続きを読み込む (残り " + rest + " 件)";
      } else {
        more.hidden = true;
      }
    };

    var failed = function (error) {
      grid.innerHTML = "";
      status.hidden = false;
      more.hidden = true;
      status.textContent = "画像の読み込みに失敗しました: " + error.message;
    };

    var reload = function (force) {
      status.hidden = false;
      status.textContent = "読み込み中…";
      loadAssetImages(force)
        .then(function (result) {
          images = result;
          visible = GALLERY_PAGE_SIZE;
          paint();
        })
        .catch(failed);
    };

    more.addEventListener("click", function () {
      visible = Math.min(visible + GALLERY_PAGE_SIZE, images.length);
      paint();
    });

    refresh.addEventListener("click", function () {
      reload(true);
    });

    reload(false);

    return wrap;
  }

  function buildThumbnail(asset, image, controls) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "thumb";
    button.title = asset.path + "\n保存日時: " + formatDate(asset.modified);

    var preview = document.createElement("img");
    preview.className = "thumb-image";
    preview.src = siteFileUrl(asset.path);
    preview.alt = asset.name || "";
    preview.loading = "lazy";
    button.appendChild(preview);

    var caption = document.createElement("span");
    caption.className = "thumb-name";
    caption.textContent = asset.name || "";
    button.appendChild(caption);

    button.addEventListener("click", function () {
      var value = asset.reference || asset.path;
      image.setAttribute("src", value);
      if (controls.url) {
        controls.url.value = value;
      }
      if (controls.resolved) {
        controls.resolved.value = image.src;
      }
      if (controls.alt && image.getAttribute("alt") === PLACEHOLDER_ALT) {
        // 挿入時の仮の alt は不要なので取り除く
        image.removeAttribute("alt");
        controls.alt.value = "";
      }
      editor.notifyChange();
      toast("画像を選択しました: " + value, "success");
    });
    return button;
  }

  /* ツールバーの「画像」ボタン: 画像要素を挿入して保存済みの画像から選ばせる. */
  function insertImageFromLibrary() {
    if (!state.siteId) {
      toast("先にサイトを追加してください。", "warn");
      return;
    }
    // 一覧を最新の状態で取得してから挿入する (直前にアップロードした画像も反映される)
    loadAssetImages(true).catch(function () {
      /* エラーはサムネイル欄の表示に任せる */
    });
    var image = editor.insertImageElement(' alt="' + PLACEHOLDER_ALT + '"');
    if (!image) {
      toast("画像要素を挿入できませんでした。", "error");
      return;
    }
    editor.selectImage(image);
    togglePane("prop", true);
    editor.setStatus("保存済みの画像 (" + ASSET_PREFIX + ") から選んでください");
  }

  /* ------------------------------------------------------------------ */
  /* 画像のドラッグ＆ドロップ                                            */
  /* ------------------------------------------------------------------ */
  function onDropSiteFile(path) {
    if (!state.siteId) {
      return;
    }
    if (!isImagePath(path)) {
      toast("画像ファイルのみドロップできます: " + path, "warn");
      return;
    }
    var name = baseName(path);
    api("/api/sites/" + encodeURIComponent(state.siteId) + "/assets", {
      method: "POST",
      body: { source: path, page: state.path || "" }
    })
      .then(function (payload) {
        editor.insertImage(payload.reference, name);
        toast("画像を挿入しました: " + payload.reference, "success");
        if (payload.ignored) {
          toast("警告: " + payload.path + " は .gitignore によりコミットされません。", "warn");
        }
        invalidateAssetImages();
        refreshTree();
      })
      .catch(function (error) {
        toast("画像の取り込みに失敗しました: " + error.message, "error");
        if (window.console) {
          window.console.error(error);
        }
      });
  }

  function uploadImage(file) {
    if (!state.siteId) {
      toast("先にサイトを追加してください。", "warn");
      return;
    }
    if (!file.type || file.type.indexOf("image/") !== 0) {
      toast("画像ファイルのみドロップできます: " + file.name, "warn");
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      var query =
        "?name=" + encodeURIComponent(file.name) + "&page=" + encodeURIComponent(state.path || "");
      fetch("/api/sites/" + encodeURIComponent(state.siteId) + "/assets/upload" + query, {
        method: "POST",
        headers: { "Content-Type": file.type, "X-Requested-With": "htmledit" },
        credentials: "same-origin",
        body: new Uint8Array(reader.result)
      })
        .then(function (response) {
          return response.json().catch(function () {
            return {};
          }).then(function (payload) {
            if (!response.ok) {
              throw new Error(payload.error || "アップロードに失敗しました");
            }
            return payload;
          });
        })
        .then(function (payload) {
          editor.insertImage(payload.reference, file.name);
          toast("画像を保存しました: " + payload.path, "success");
          if (payload.ignored) {
            toast("警告: " + payload.path + " は .gitignore によりコミットされません。", "warn");
          }
          invalidateAssetImages();
          refreshTree();
        })
        .catch(function (error) {
          toast("画像のアップロードに失敗しました: " + error.message, "error");
        });
    };
    reader.onerror = function () {
      toast("画像を読み込めませんでした: " + file.name, "error");
    };
    reader.readAsArrayBuffer(file);
  }

  /* ------------------------------------------------------------------ */
  /* メモ / ターミナル                                                    */
  /* ------------------------------------------------------------------ */
  var terminalPanel = null;

  function toggleMemo(force) {
    togglePane("memo", force);
  }

  function loadMemo() {
    api("/api/memo")
      .then(function (payload) {
        el.memoText.value = payload.content || "";
        el.memoPath.textContent = payload.path;
        el.memoStatus.textContent = payload.exists ? "読み込みました" : "新規メモです";
      })
      .catch(function (error) {
        el.memoStatus.textContent = "メモの読み込みに失敗しました: " + error.message;
      });
  }

  function saveMemo() {
    busy(el.btnMemoSave, true);
    api("/api/memo", { method: "PUT", body: { content: el.memoText.value } })
      .then(function (payload) {
        el.memoStatus.textContent = "保存しました: " + payload.path;
        toast("メモを保存しました: " + payload.path, "success");
      })
      .catch(function (error) {
        el.memoStatus.textContent = "保存に失敗しました: " + error.message;
        toast("メモの保存に失敗しました: " + error.message, "error");
      })
      .finally(function () {
        busy(el.btnMemoSave, false);
      });
  }

  /* opencode パネルを開く (このパネルでは opencode のみを動かす) */
  function openTerminal() {
    togglePane("terminal", true);
  }

  /* opencode を PTY の子プロセスとして直接起動する (selfcode と同じ方式) */
  function startOpencodeProcess() {
    if (!terminalPanel) {
      return;
    }
    state.opencodeStarted = true;
    el.terminalPane.classList.remove("is-hidden");
    el.btnOpencode.classList.add("is-active");
    terminalPanel.show();
    terminalPanel.connect(state.siteId, "opencode");
  }

  /* ------------------------------------------------------------------ */
  /* opencode (AI)                                                        */
  /* ------------------------------------------------------------------ */
  function openOpencode() {
    openTerminal();
    api("/api/opencode/status")
      .then(function (status) {
        if (status.installed) {
          startOpencodeProcess();
        } else {
          installOpencode();
        }
      })
      .catch(function (error) {
        toast("opencode の確認に失敗しました: " + error.message, "error");
      });
  }

  /* opencode のインストール完了後にターミナルで起動する */
  function startOpencodeAfterInstall() {
    if (!terminalPanel) {
      return;
    }
    startOpencodeProcess();
  }

  /* サイト内のフォルダを作業ディレクトリに opencode を起動する */
  function openOpencodeAt(cwd) {
    state.opencodeStarted = true;
    togglePane("terminal", true, { siteId: state.siteId, command: "opencode", cwd: cwd });
  }

  function installOpencode() {
    toast("opencode が未インストールのため、インストールを開始します", "warn");
    terminalPanel.write(
      "\r\n\x1b[33m[htmledit] opencode をインストールしています (数分かかる場合があります)\x1b[0m\r\n"
    );
    api("/api/opencode/install", { method: "POST" })
      .then(function () {
        pollOpencodeInstall();
      })
      .catch(function (error) {
        toast("opencode のインストールに失敗しました: " + error.message, "error");
      });
  }

  function pollOpencodeInstall() {
    var timer = setInterval(function () {
      api("/api/opencode/status")
        .then(function (status) {
          if (status.installing) {
            var last = (status.log || []).slice(-1)[0];
            if (last) {
              terminalPanel.write("\r\n\x1b[90m" + last + "\x1b[0m\r\n");
            }
            return;
          }
          clearInterval(timer);
          if (status.installed) {
            toast("opencode のインストールが完了しました", "success");
            terminalPanel.write("\r\n\x1b[32m[htmledit] インストールが完了しました\x1b[0m\r\n");
            startOpencodeAfterInstall();
          } else {
            toast("opencode のインストールに失敗しました", "error");
            terminalPanel.write("\r\n\x1b[31m[htmledit] インストールに失敗しました\x1b[0m\r\n");
          }
        })
        .catch(function () {
          clearInterval(timer);
        });
    }, 3000);
  }

  /* ------------------------------------------------------------------ */
  /* パネルの表示 / 非表示の切り替え                                      */
  /* ------------------------------------------------------------------ */
  var PANELS = {
    prop: { pane: "propPane", button: "btnToggleProp", label: "プロパティパネル" },
    git: { pane: "gitPane", button: "btnToggleGit", label: "GitHub パネル" },
    terminal: { pane: "terminalPane", button: "btnOpencode", label: "ターミナルパネル" },
    memo: { pane: "memoPane", button: "btnToggleMemo", label: "メモパネル" }
  };

  function togglePane(name, force, terminalOptions) {
    var config = PANELS[name];
    if (!config) {
      return;
    }
    var pane = el[config.pane];
    var button = el[config.button];
    var hidden = force === undefined ? !pane.classList.contains("is-hidden") : !force;
    pane.classList.toggle("is-hidden", hidden);
    button.classList.toggle("is-active", !hidden);
    button.setAttribute("aria-pressed", hidden ? "false" : "true");
    button.title = (hidden ? "表示する" : "非表示にする") + " - " + config.label;
    if (name === "memo" && !hidden) {
      loadMemo();
    }
    if (name === "terminal" && !hidden && terminalPanel) {
      terminalPanel.show();
      if (terminalOptions) {
        terminalPanel.connect(
          terminalOptions.siteId || "",
          terminalOptions.command || "",
          terminalOptions.cwd === undefined ? null : terminalOptions.cwd
        );
      }
    }
    if (name === "terminal" && hidden && terminalPanel) {
      // パネルを閉じたら opencode も終了する
      state.opencodeStarted = false;
      terminalPanel.kill();
    }
  }

  /* opencode パネルを閉じる (opencode のプロセスも終了する) */
  function closeTerminal() {
    state.opencodeStarted = false;
    togglePane("terminal", false);
  }

  /* ------------------------------------------------------------------ */
  /* 初期化                                                              */
  /* ------------------------------------------------------------------ */
  var editor = null;

  function bindEvents() {
    el.btnAddSite.addEventListener("click", openSiteDialog);
    el.btnSiteSubmit.addEventListener("click", submitSiteDialog);
    el.btnSiteCancel.addEventListener("click", function () {
      el.siteDialog.close();
    });
    el.btnRefreshTree.addEventListener("click", refreshTree);
    el.btnRefreshGit.addEventListener("click", refreshGit);
    el.btnClearSelection.addEventListener("click", function () {
      var selection = window.getSelection();
      if (selection) {
        selection.removeAllRanges();
      }
      editor.selectedImage = null;
      editor.selectedLink = null;
      renderProperties(null);
    });
    el.btnSave.addEventListener("click", saveFile);
    el.btnPull.addEventListener("click", runPull);
    el.btnPush.addEventListener("click", runPush);
    el.btnCommit.addEventListener("click", runCommit);
    el.btnUpdate.addEventListener("click", runUpdate);
    el.btnRestart.addEventListener("click", runRestart);
    el.btnToggleProp.addEventListener("click", function () {
      togglePane("prop");
    });
    el.btnToggleGit.addEventListener("click", function () {
      togglePane("git");
    });
    el.btnToggleMemo.addEventListener("click", function () {
      toggleMemo();
    });
    el.btnOpencode.addEventListener("click", openOpencode);
    el.btnMemoSave.addEventListener("click", saveMemo);
    el.btnFoldTree.addEventListener("click", foldTree);
    el.tree.addEventListener("contextmenu", function (event) {
      // ツリーの余白を右クリックした場合はサイトルート直下を対象にする
      event.preventDefault();
      if (isTreeRow(event.target)) {
        // 行側メニューで処理済み
        return;
      }
      showTreeMenu(event.clientX, event.clientY, { type: "dir", path: "", dir: "" });
    });
    el.btnMemoClose.addEventListener("click", function () {
      toggleMemo(false);
    });
    el.btnTerminalClose.addEventListener("click", function () {
      // 閉じるボタンで opencode も終了させる
      closeTerminal();
    });
    el.memoText.addEventListener("keydown", function (event) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        event.stopPropagation();
        saveMemo();
      }
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        closeContextMenu();
      }
    });
    window.addEventListener("resize", closeContextMenu);
    el.btnPreview.addEventListener("click", function () {
      var visible = editor.togglePreview();
      el.btnPreview.classList.toggle("is-active", visible);
    });

    Array.prototype.forEach.call(document.querySelectorAll(".seg-btn"), function (button) {
      button.addEventListener("click", function () {
        setEditorMode(button.dataset.mode);
      });
    });

    document.addEventListener("keydown", function (event) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveFile();
      }
    });

    el.siteForm.addEventListener("submit", function (event) {
      event.preventDefault();
      submitSiteDialog();
    });
  }

  function init() {
    el.appVersion = $("app-version");
    el.topbarMeta = $("topbar-meta");
    el.btnUpdate = $("btn-update");
    el.btnRestart = $("btn-restart");
    el.siteList = $("site-list");
    el.btnAddSite = $("btn-add-site");
    el.tree = $("file-tree");
    el.treeTitle = $("tree-title");
    el.currentFile = $("current-file");
    el.dirtyFlag = $("dirty-flag");
    el.btnSave = $("btn-save");
    el.btnPreview = $("btn-preview");
    el.btnPull = $("btn-pull");
    el.btnPush = $("btn-push");
    el.btnCommit = $("btn-commit");
    el.commitMessage = $("commit-message");
    el.changeList = $("change-list");
    el.commitList = $("commit-list");
    el.repoInfo = $("repo-info");
    el.githubInfo = $("github-info");
    el.propBody = $("prop-body");
    el.toastContainer = $("toast-container");
    el.siteDialog = $("site-dialog");
    el.siteForm = $("site-form");
    el.siteUrl = $("site-url");
    el.siteBranch = $("site-branch");
    el.siteName = $("site-name");
    el.siteSiteUrl = $("site-site-url");
    el.siteUsername = $("site-username");
    el.siteToken = $("site-token");
    el.siteDialogTitle = $("site-dialog-title");
    el.siteError = $("site-error");
    el.btnSiteSubmit = $("btn-site-submit");
    el.btnSiteCancel = $("btn-site-cancel");
    el.btnRefreshTree = $("btn-refresh-tree");
    el.btnRefreshGit = $("btn-refresh-git");
    el.btnClearSelection = $("btn-clear-selection");
    el.btnToggleProp = $("btn-toggle-prop");
    el.btnToggleGit = $("btn-toggle-git");
    el.btnToggleMemo = $("btn-toggle-memo");
    el.btnOpencode = $("btn-opencode");
    el.workspace = $("workspace");
    el.propPane = $("prop-pane");
    el.gitPane = $("git-pane");
    el.memoPane = $("memo-pane");
    el.terminalPane = $("terminal-pane");
    el.memoText = $("memo-text");
    el.memoPath = $("memo-path");
    el.memoStatus = $("memo-status");
    el.btnMemoSave = $("btn-memo-save");
    el.btnMemoClose = $("btn-memo-close");
    el.btnFoldTree = $("btn-fold-tree");
    el.btnTerminalClose = $("btn-terminal-close");

    editor = window.htmleditEditor.create({
      host: $("wysiwyg-host"),
      source: $("source-host"),
      toolbar: $("toolbar"),
      preview: $("preview-frame"),
      status: $("editor-status"),
      onDirtyChange: function (dirty) {
        el.dirtyFlag.hidden = !dirty;
      },
      onSelection: function (info) {
        renderProperties(info);
      },
      onDropSiteFile: function (path) {
        onDropSiteFile(path);
      },
      onDropUnsupported: function (message) {
        toast(message, "warn");
      },
      onUploadImage: function (file) {
        uploadImage(file);
      },
      onInsertImage: function () {
        insertImageFromLibrary();
      }
    });

    try {
      terminalPanel = window.htmleditTerminal.create({
        host: $("terminal"),
        onStatus: function (message, kind) {
          // 状態表示はしない (エラーだけをトーストで知らせる)
          if (kind === "error") {
            toast(message, "error");
          }
        }
      });
    } catch (error) {
      terminalPanel = null;
      toast("ターミナルを初期化できませんでした: " + error.message, "error");
    }

    bindEvents();
    loadVersion();
    loadSites();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
