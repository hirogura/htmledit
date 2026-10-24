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
    opencodeStarted: false,
    postPhotos: [],
    settingsMenuRows: []
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
      auth.textContent = "⚙";
      auth.title = "設定を編集 (表示名 / サイトURL / 認証情報)";
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
    refreshTree().then(function () {
      openFile("public/index.html");
    });
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
  /* 記事投稿 (public/index.html への挿入)                                */
  /* ------------------------------------------------------------------ */
  var POST_PAGE = "public/index.html";
  var POST_DEFAULT_MAX_SIDE = 1024;
  var RESIZABLE_TYPES = ["image/png", "image/jpeg", "image/webp"];

  function openPostPane() {
    if (state.siteId) {
      el.postError.hidden = true;
    } else {
      el.postError.textContent = "先にサイトを追加してください。";
      el.postError.hidden = false;
    }
    togglePane("post", true);
    el.postTitle.focus();
  }

  function renderPostPhotoList() {
    var list = el.postPhotoList;
    list.innerHTML = "";
    (state.postPhotos || []).forEach(function (file, index) {
      var item = document.createElement("span");
      item.className = "post-photo-item";
      var name = document.createElement("span");
      name.className = "post-photo-name";
      name.textContent = file.name + " (" + formatBytes(file.size) + ")";
      item.appendChild(name);
      var remove = document.createElement("button");
      remove.type = "button";
      remove.className = "post-photo-remove";
      remove.textContent = "×";
      remove.title = "この写真を外す";
      remove.addEventListener("click", function () {
        state.postPhotos.splice(index, 1);
        renderPostPhotoList();
      });
      item.appendChild(remove);
      list.appendChild(item);
    });
  }

  /* 長辺が maxSide を超える画像を canvas で縮小する (超えなければ元のまま) */
  function postResizeImage(file, maxSide) {
    if (!maxSide || RESIZABLE_TYPES.indexOf(file.type) < 0) {
      return Promise.resolve(file);
    }
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file);
      var image = new Image();
      image.onload = function () {
        URL.revokeObjectURL(url);
        var long = Math.max(image.naturalWidth, image.naturalHeight);
        if (!long || long <= maxSide) {
          resolve(file);
          return;
        }
        var scale = maxSide / long;
        var canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        var context = canvas.getContext("2d");
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(function (blob) {
          if (!blob) {
            resolve(file);
            return;
          }
          var resized = new File([blob], file.name, { type: blob.type || file.type });
          if (window.console) {
            window.console.info(
              "post: resize " + file.name + " " + long + "px -> " + Math.max(canvas.width, canvas.height) + "px"
            );
          }
          resolve(resized);
        }, file.type);
      };
      image.onerror = function () {
        URL.revokeObjectURL(url);
        resolve(file);
      };
      image.src = url;
    });
  }

  function postUploadImage(siteId, file, page) {
    return fetch(
      "/api/sites/" +
        encodeURIComponent(siteId) +
        "/assets/upload?name=" +
        encodeURIComponent(file.name) +
        "&page=" +
        encodeURIComponent(page),
      {
        method: "POST",
        headers: { "Content-Type": file.type || "application/octet-stream", "X-Requested-With": "htmledit" },
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
      .then(function (payload) {
        invalidateAssetImages();
        return payload.reference || payload.path;
      });
  }

  /*
   * 投稿は「1記事=1ページ」で生成する:
   * - 個別ページ: public/posts/YYYY/MM/DD/ID.html (日付階層 / タイトル / 本文全文 / 写真) をサーバー側で作成
   * - 一覧ページ: index.html / page/*.html には「最初の 3 行 (100 文字程度) + 続きを読む」の
   *   スニペット article (data-post-id="ID") を最大 20 件ずつ配置 (サーバー側で再構築)
   */

  /* コミットメッセージの付日 (投稿 YYYY-MM-DD) */
  function postCommitStamp() {
    var now = new Date();
    var pad = function (value) {
      return String(value).padStart(2, "0");
    };
    return now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate());
  }

  /* 記事 ID (YYYYMMDD-HHMMSS) - 個別ページのファイル名・スニペットの識別子 */
  function postIdFromNow() {
    var now = new Date();
    var pad = function (value) {
      return String(value).padStart(2, "0");
    };
    return (
      now.getFullYear() +
      pad(now.getMonth() + 1) +
      pad(now.getDate()) +
      "-" +
      pad(now.getHours()) +
      pad(now.getMinutes()) +
      pad(now.getSeconds())
    );
  }

  /* 個別ページの本文部分 (段落 + 写真) を組み立てる */
  function buildPostBodyHtml(body, references) {
    var lines = [];
    var bodyText = (body || "").replace(/\r\n?/g, "\n").trim();
    if (bodyText) {
      lines.push("<p>" + bodyText.split("\n").map(escapeHtml).join("<br />\n") + "</p>");
    }
    references.forEach(function (reference) {
      lines.push('<img src="' + escapeHtml(reference) + '" alt="">');
      lines.push("<br />");
    });
    return lines.join("\n");
  }

  function submitPostDialog(withPush) {
    if (!state.siteId) {
      el.postError.textContent = "先にサイトを追加してください。";
      el.postError.hidden = false;
      return;
    }
    var title = el.postTitle.value.trim();
    var body = el.postBody.value;
    var maxSide = parseInt(el.postMaxSide.value, 10);
    if (!title) {
      el.postError.textContent = "タイトルを入力してください。";
      el.postError.hidden = false;
      return;
    }
    if (!body.trim() && !(state.postPhotos || []).length) {
      el.postError.textContent = "本文を入力するか、写真を添付してください。";
      el.postError.hidden = false;
      return;
    }
    if (isNaN(maxSide) || maxSide <= 0) {
      maxSide = POST_DEFAULT_MAX_SIDE;
    }
    var siteId = state.siteId;
    var photos = (state.postPhotos || []).slice();
    var postId = postIdFromNow();
    /* 個別ページは日付で階層分けする: public/posts/YYYY/MM/DD/HHMMSS.html */
    var postPath =
      "public/posts/" + postId.slice(0, 4) + "/" + postId.slice(4, 6) + "/" + postId.slice(6, 8) + "/" + postId + ".html";

    if (state.path === POST_PAGE && editor && editor.dirty) {
      if (!confirm("未保存の変更があります。投稿した内容で public/index.html を上書きしますか？")) {
        return;
      }
    }

    busy(el.btnPostSubmit, true);
    el.btnPostSubmit.disabled = true;
    busy(el.btnPostPush, true);
    el.btnPostPush.disabled = true;

    var uploadChain = Promise.resolve();
    var references = [];
    photos.forEach(function (file, index) {
      uploadChain = uploadChain.then(function () {
        return postResizeImage(file, maxSide)
          .then(function (image) {
            toast((index + 1) + " / " + photos.length + " 枚目をアップロード中…", "info");
            /* 個別ページ (public/posts/YYYY/MM/DD/ID.html) からの相対パスで参照する */
            return postUploadImage(siteId, image, postPath);
          })
          .then(function (reference) {
            references.push(reference);
          });
      });
    });

    uploadChain
      .then(function () {
        return api(
          "/api/sites/" + encodeURIComponent(siteId) + "/posts",
          {
            method: "POST",
            body: {
              id: postId,
              title: title,
              bodyHtml: buildPostBodyHtml(body, references),
              timestamp: el.postTimestamp.checked,
              divider: el.postDivider.checked,
              tags: el.postTags.value
            }
          }
        );
      })
      .then(function (payload) {
        /* 入力内容をクリアする */
        el.postTitle.value = "";
        el.postBody.value = "";
        el.postTags.value = "";
        state.postPhotos = [];
        renderPostPhotoList();
        el.postError.hidden = true;
        el.postMaxSide.value = String(POST_DEFAULT_MAX_SIDE);
        /* オプションは既定の状態 (すべて On) に戻す */
        el.postTimestamp.checked = true;
        el.postDivider.checked = true;
        toast(
          "投稿しました: " + (payload.post || postPath) +
            (payload.pages > 0 ? "\n一覧: " + (payload.paths || []).join(", ") : ""),
          "success"
        );
        refreshTree();
        refreshGit();
        if (state.path === POST_PAGE) {
          openFile(POST_PAGE);
        }
        if (!withPush) {
          /* 「投稿」ボタン: 保存が済んだら投稿パネルを閉じる */
          togglePane("post", false);
          return null;
        }
        /* 「投稿・保存・Push」ボタン: 「投稿+日付」でコミットして push まで行う */
        var message = "投稿 " + postCommitStamp();
        return api(
          "/api/sites/" + encodeURIComponent(siteId) + "/git/commit",
          { method: "POST", body: { message: message } }
        )
          .then(function (payload) {
            toast("コミットしました: " + message + "\n" + (payload.output || "").trim(), "success");
            refreshGit();
            return api(
              "/api/sites/" + encodeURIComponent(siteId) + "/git/push",
              { method: "POST", body: {} }
            );
          })
          .then(function (payload) {
            toast("push 完了\n" + (payload.output || "").trim(), "success");
            refreshGit();
            togglePane("post", false);
          });
      })
      .catch(function (error) {
        var message =
          error.status === 404
            ? POST_PAGE + " が見つかりません。先にページを作成してください。"
            : error.message;
        el.postError.textContent = message;
        el.postError.hidden = false;
        /* エディター側ボタンから実行して投稿パネルが閉じている場合はトーストでも知らせる */
        if (el.postPane.classList.contains("is-hidden")) {
          toast(message, "error");
        }
      })
      .finally(function () {
        busy(el.btnPostSubmit, false);
        el.btnPostSubmit.disabled = false;
        busy(el.btnPostPush, false);
        el.btnPostPush.disabled = false;
      });
  }

  /* エディターの「保存・Push」ボタン: 現在のファイルを保存して commit + push まで行う */
  function runEditorSavePush() {
    if (!state.siteId || !state.path) {
      toast("保存するファイルを選択してください。", "warn");
      return;
    }
    var siteId = state.siteId;
    var path = state.path;
    busy(el.btnEditorSavePush, true);
    el.btnEditorSavePush.disabled = true;
    var saved = api("/api/sites/" + encodeURIComponent(siteId) + "/file", {
      method: "PUT",
      body: { path: path, content: editor.currentText() }
    })
      .then(function (payload) {
        editor.markSaved();
        toast("保存しました: " + payload.path, "success");
        refreshTree();
        refreshGit();
        var message = "投稿 " + postCommitStamp();
        return api("/api/sites/" + encodeURIComponent(siteId) + "/git/commit", {
          method: "POST",
          body: { message: message }
        }).then(function (committed) {
          toast("コミットしました: " + message + "\n" + (committed.output || "").trim(), "success");
          return api("/api/sites/" + encodeURIComponent(siteId) + "/git/push", { method: "POST", body: {} });
        });
      })
      .then(function (payload) {
        toast("push 完了\n" + (payload.output || "").trim(), "success");
        refreshGit();
      });
    saved
      .catch(function (error) {
        toast(error.message || String(error), "error");
      })
      .finally(function () {
        busy(el.btnEditorSavePush, false);
        el.btnEditorSavePush.disabled = false;
      });
  }

  /* ------------------------------------------------------------------ */
  /* サイト設定 (index.html の head と上部メニューの初期設定)              */
  /* ------------------------------------------------------------------ */
  var TOPBAR_CLASS = "site-topbar";

  function topbarHeaderPattern() {
    return new RegExp(
      '<header\\b[^>]*class=["\'][^"\']*' + TOPBAR_CLASS + '[^"\']*["\'][^>]*>[\\s\\S]*?</header\\s*>',
      "i"
    );
  }

  /* 上部メニュー内の検索ボックス (site-search フォーム) のパターン */
  function searchFormPattern() {
    return /<form\b[^>]*class=["'][^"']*site-search[^"']*["'][^>]*>/i;
  }

  /* メニュー行入力欄 (「項目名」「リンク先」の入力欄ペア) を描画する */
  function renderMenuRows(rows) {
    var wrap = el.settingsMenuRows;
    wrap.innerHTML = "";
    rows.forEach(function (row, index) {
      var line = document.createElement("div");
      line.className = "menu-row";

      var label = document.createElement("input");
      label.className = "input";
      label.type = "text";
      label.placeholder = "項目名";
      label.value = row.label || "";
      label.addEventListener("change", function () {
        rows[index].label = label.value;
      });

      var href = document.createElement("input");
      href.className = "input";
      href.type = "text";
      href.placeholder = "リンク先";
      href.value = row.href || "";
      href.addEventListener("change", function () {
        rows[index].href = href.value;
      });

      var remove = document.createElement("button");
      remove.type = "button";
      remove.className = "post-photo-remove";
      remove.textContent = "×";
      remove.title = "この項目を削除";
      remove.addEventListener("click", function () {
        rows.splice(index, 1);
        renderMenuRows(rows);
      });

      line.appendChild(label);
      line.appendChild(href);
      line.appendChild(remove);
      wrap.appendChild(line);
    });
  }

  function addMenuRow() {
    state.settingsMenuRows.push({ label: "", href: "" });
    renderMenuRows(state.settingsMenuRows);
    var rows = el.settingsMenuRows.querySelectorAll(".menu-row input");
    if (rows.length) {
      rows[rows.length - 2].focus();
    }
  }

  /* 入力欄からメニュー項目を回収する (項目名が空の行は無視) */
  function readMenuRows() {
    var items = [];
    Array.prototype.forEach.call(el.settingsMenuRows.children, function (line) {
      var inputs = line.querySelectorAll("input");
      if (!inputs.length) {
        return;
      }
      var label = inputs[0].value.trim();
      var href = inputs[1].value.trim();
      if (!label) {
        return;
      }
      items.push({ label: label, href: href || "#" });
    });
    return items;
  }

  function buildTopbarHtml(items, brand, addSearch) {
    var hasBrand = !!(brand && (brand.title || brand.logo));
    if (!items.length && !hasBrand && !addSearch) {
      return "";
    }
    var parts = ['<header class="' + TOPBAR_CLASS + '">'];
    if (hasBrand) {
      parts.push('    <div class="site-brand">');
      if (brand.logo) {
        parts.push(
          '      <img class="site-logo" src="' +
            escapeHtml(brand.logo) +
            '" alt="' +
            escapeHtml(brand.title || "サイトロゴ") +
            '" />'
        );
      } else {
        parts.push(
          '      <span class="site-brand-title">' + escapeHtml(brand.title) + "</span>"
        );
      }
      if (brand.desc) {
        parts.push('      <span class="site-brand-desc">' + escapeHtml(brand.desc) + "</span>");
      }
      parts.push("    </div>");
    }
    if (items.length) {
      parts.push('    <nav aria-label="メインメニュー">');
      items.forEach(function (item) {
        parts.push(
          '      <a href="' + escapeHtml(item.href) + '">' + escapeHtml(item.label) + "</a>"
        );
      });
      parts.push("    </nav>");
    }
    if (addSearch) {
      parts.push('    <form class="site-search" id="site-search-form" role="search">');
      parts.push(
        '      <input type="search" id="site-search-query" name="q" placeholder="記事を検索" aria-label="サイト内検索" />'
      );
      parts.push('      <button type="submit">検索</button>');
      parts.push("    </form>");
    }
    parts.push("  </header>");
    return parts.join("\n");
  }

  /* サンプル HTML を生成する (投稿用の container / hero 構成を含む) */
  function buildSampleHtml(settings) {
    var title = settings.title || "サイト";
    var brand = {
      title: title,
      desc: (settings.desc || "").trim(),
      logo: (settings.logo || "").trim()
    };
    var menuHtml = buildTopbarHtml(settings.items, brand, settings.addSearch);
    var headerWidth = normalizeCssMeasure(settings.headerWidth, "800px");
    var bodyWidth = normalizeCssMeasure(settings.bodyWidth, "800px");
    var headerHeight = normalizeCssHeight(settings.headerHeight, "");
    var headerColor = normalizeCssColor(settings.headerColor, "");
    var iconLink = settings.icon
      ? '\n    <link rel="icon" href="' + escapeHtml(settings.icon) + '" />'
      : "";
    var topbarCss = [
      "    .site-topbar {",
      "      position: sticky;",
      "      top: 0;",
      "      z-index: 10;",
      "      display: flex;",
      "      flex-wrap: wrap;",
      "      align-items: center;",
      "      gap: 4px 16px;",
      "      max-width: " + headerWidth + ";",
      "      margin: 0 auto;",
      "      padding: 10px 20px;",
      "      background: " + (headerColor || "#fff") + ";",
      "      border-bottom: 1px solid #e2e6ea;"
    ];
    if (headerHeight) {
      topbarCss.splice(6, 0, "      height: " + headerHeight + ";");
    }
    topbarCss.push("    }");
    var css = [
      "    * { box-sizing: border-box; }",
      "    body { margin: 0; font-family: system-ui, -apple-system, sans-serif; color: #2b3138; background: #fff; line-height: 1.7; }",
      "",
      topbarCss.join("\n"),
      "    .site-brand { display: flex; align-items: baseline; gap: 10px; min-width: 0; }",
      "    .site-brand-title { font-weight: 700; font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }",
      "    .site-brand-desc { color: #8a929c; font-size: 12px; }",
      "    .site-topbar .site-logo { display: block; width: auto; max-width: 100%; }",
      '    .site-topbar nav { display: flex; flex-wrap: wrap; gap: 18px; margin-left: auto; }',
      '    .site-topbar a { color: #37414c; text-decoration: none; font-size: 14px; }',
      '    .site-topbar a:hover { color: #2563eb; }'
    ];
    if (settings.addSearch) {
      css.push(
        "    .site-topbar .site-search { display: flex; gap: 6px; margin-left: 8px; }",
        '    .site-topbar .site-search input[type="search"] { width: 160px; padding: 4px 8px; border: 1px solid #e2e6ea; border-radius: 6px; font-size: 13px; }',
        '    .site-topbar .site-search button { padding: 4px 10px; border: 1px solid #e2e6ea; background: #fff; border-radius: 6px; font-size: 13px; cursor: pointer; }',
        '    .site-topbar .site-search button:hover { border-color: #2563eb; color: #2563eb; }',
        "    .site-search-status { color: #69737e; font-size: 14px; padding: 8px 0; }",
        "    .site-search-status a { color: #2563eb; }",
        "    .site-tag { display: inline-block; margin-right: 6px; padding: 1px 8px; border: 1px solid #e2e6ea; border-radius: 10px; font-size: 12px; color: #37414c; text-decoration: none; }",
        "    .site-tag:hover { border-color: #2563eb; color: #2563eb; }"
      );
    }
    css.push(
      "",
      "    .container { max-width: " + bodyWidth + "; margin: 0 auto; padding: 8px 20px 48px; }",
      "    .hero { padding: 40px 0 8px; border-bottom: 1px solid #eef1f4; margin-bottom: 24px; }",
      "    .hero h1 { margin: 0 0 8px; font-size: 28px; font-weight: 700; }",
      "    .hero p { margin: 0; color: #69737e; font-size: 14px; }",
      "    h2 { margin: 24px 0 8px; font-size: 20px; }",
      "    img { max-width: 100%; height: auto; border-radius: 8px; }",
      "    hr { border: none; border-top: 1px solid #e2e6ea; margin: 24px 0; }",
      "",
      '    .site-footer { border-top: 1px solid #e2e6ea; color: #8a929c; font-size: 12.5px; text-align: center; padding: 16px 0 28px; }'
    );
    css = css.join("\n");

    var lines = [
      "<!doctype html>",
      '<html lang="ja">',
      "<head>",
      '    <meta charset="utf-8" />',
      '    <meta name="viewport" content="width=device-width, initial-scale=1" />',
      "    <title>" + escapeHtml(title) + "</title>" + iconLink,
      "    <style>",
      css,
      "    </style>",
      "</head>",
      "<body>"
    ];
    if (menuHtml) {
      lines.push("  " + menuHtml);
    }
    lines.push(
      "",
      '  <main class="container">',
      "",
      '    <article class="posts">',
      "      <!-- 投稿パネルの記事はこの直下に追加される (新しい記事が上に積まれる) -->",
      "    </article>",
      "  </main>",
      "",
      '  <footer class="site-footer">&copy; ' + new Date().getFullYear() + ' ' + escapeHtml(title) + "</footer>"
    );
    if (settings.addSearch) {
      lines.push("", "  " + buildSiteSearchScriptHtml());
    }
    lines.push(
      "</body>",
      "</html>",
      ""
    );
    return lines.join("\n");
  }

  /* 検索ボックス用スクリプト (index.html / page/*.html と記事個別ページを検索する) */
  function buildSiteSearchScriptHtml() {
    var js = [
      "(function () {",
      '  "use strict";',
      '  var form = document.getElementById("site-search-form");',
      '  var input = document.getElementById("site-search-query");',
      "  if (!form || !input) {",
      "    return;",
      "  }",
      '  var listHost = document.querySelector("article.posts");',
      '  var baseDir = location.pathname.replace(/[^/]*$/, "");',
      '  if (/page\\/$/.test(baseDir)) { baseDir = baseDir.replace(/page\\/$/, ""); }',
      '  var listUrl = baseDir + "index.html";',
      '  var indexDirRel = "";',
      "  if (baseDir !== \"/\" ) {",
      '    var pageDir = location.pathname.replace(/[^/]*$/, "");',
      "    if (pageDir.indexOf(baseDir) === 0 && pageDir.length > baseDir.length) {",
      '      indexDirRel = pageDir.slice(baseDir.length).replace(/[^/]+\\/?/g, "../");',
      "    }",
      "  }",
      "  var defaultList = listHost ? listHost.innerHTML : \"\";",
      "",
      "  /* 本文の「タグ: 旅行, カメラ」行からタグを抽出する (無ければ空配列) */",
      "  function tagsFromRaw(raw) {",
      '    var match = /(?:タグ|tags?)\\s*[:：]\\s*([^\\n<]{1,200})/i.exec(raw || "");',
      "    if (!match) {",
      "      return [];",
      "    }",
      "    var tags = [];",
      "    match[1].split(/[,、\\s]+/).forEach(function (raw) {",
      '      var tag = (raw || "").replace(/^(?:tags?|タグ)\\s*[:：]/i, "").trim();',
      "      if (tag) {",
      "        tags.push(tag);",
      "      }",
      "    });",
      "    return tags;",
      "  }",
      "",
      "  /* タグ指定 (カンマ・読点・空白区切りで複数指定 = AND) でタグ群にヒットするか */",
      "  function tagMatchList(groups, keywords) {",
      "    return keywords.every(function (raw) {",
      "      var needle = plainText(raw);",
      "      return groups.some(function (tag) {",
      "        return plainText(tag).indexOf(needle) >= 0;",
      "      });",
      "    });",
      "  }",
      "",
  "  function plainText(value) {",
  '    return (value || "").replace(/\\s+/g, " ").toLowerCase();',
  "  }",
  "",
  "  /* 本文検索: 「tag: メモ」と「tag:メモ」のように空白の有無が違ってもヒットさせる */",
  "  function matchesText(hay, needle) {",
  "    if (!hay || !needle) {",
  "      return false;",
  "    }",
  '    var compact = hay.replace(/\\s+/g, "");',
  '    return needle.split(" ").every(function (token) {',
  '      var word = token.replace(/\\s+/g, "");',
  "      if (!word) {",
  "        return true;",
  "      }",
  "      return hay.indexOf(word) >= 0 || compact.indexOf(word) >= 0;",
  "    });",
  "  }",
  "",
      "  function escapeText(text) {",
      '    var table = { "&": "&amp;", "<": "&lt;", ">": "&gt;", \'"\': "&quot;", "\'": "&#39;" };',
      '    return (text || "").replace(/[&<>"\']/g, function (c) { return table[c]; });',
      "  }",
      "",
      "  function resolveUrl(href, base) {",
      "    try {",
      "      return new URL(href, base).href;",
      "    } catch (e) {",
      '      return "";',
      "    }",
      "  }",
      "",
      "  function toRelative(url) {",
      "    try {",
      "      var abs = new URL(url, location.href);",
      "      var path = abs.pathname;",
      '      if (baseDir === "/") {',
      '        if (path.charAt(0) === "/") { path = path.slice(1); }',
      "      } else if (path.indexOf(baseDir) === 0) {",
      "        path = path.slice(baseDir.length);",
      "      } else {",
      "        return abs.href;",
      "      }",
      "      return path + abs.search + abs.hash;",
      "    } catch (e) {",
      "      return url;",
      "    }",
      "  }",
      "",
      "  function rewriteAssets(node, baseUrl) {",
      "    if (!node || !node.querySelectorAll) {",
      "      return;",
      "    }",
      '    Array.prototype.forEach.call(node.querySelectorAll("[src], [href]"), function (tag) {',
      '      ["src", "href"].forEach(function (attr) {',
      '        var raw = tag.getAttribute(attr) || "";',
      '        if (!raw || raw.charAt(0) === "#" || /^(mailto|javascript|data)[:]/i.test(raw)) {',
      "          return;",
      "        }",
      "        var abs = resolveUrl(raw, baseUrl);",
      "        if (!abs) {",
      "          return;",
      "        }",
      "        var rel = toRelative(abs);",
      '        if (rel && rel.indexOf("://") < 0) {',
      "          rel = indexDirRel + rel;",
      "        }",
      "        tag.setAttribute(attr, rel);",
      "      });",
      "    });",
      "  }",
      "",
      "  function fetchDoc(url) {",
      '    return fetch(url, { credentials: "same-origin" }).then(function (response) {',
      "      if (!response.ok) {",
      "        throw new Error(String(response.status));",
      "      }",
      "      return response.text();",
      "    }).then(function (text) {",
      '      return { doc: new DOMParser().parseFromString(text, "text/html"), url: url };',
      "    });",
      "  }",
      "",
      "  function collectSnippets() {",
      "    return fetchDoc(resolveUrl(listUrl, location.href)).then(function (first) {",
      "      var hrefs = [];",
      '      Array.prototype.forEach.call(first.doc.querySelectorAll("a[href]"), function (anchor) {',
      '        var href = anchor.getAttribute("href") || "";',
      '        if (/^page\\/\\d+\\.html$/i.test(href) && hrefs.indexOf(href) < 0) {',
      "          hrefs.push(href);",
      "        }",
      "      });",
      "      var requests = hrefs.map(function (href) {",
      '        return fetchDoc(resolveUrl(href, first.url)).catch(function () { return null; });',
      "      });",
      "      return Promise.all(requests).then(function (pages) {",
      '        return [first].concat(pages.filter(function (page) { return page; }));',
      "      });",
      "    });",
      "  }",
      "",
      "  function extractSnippets(page) {",
      "    var items = [];",
      '    Array.prototype.forEach.call(page.doc.querySelectorAll("article[data-post-id]"), function (block) {',
      '      var id = block.getAttribute("data-post-id") || "";',
      "      if (!id) {",
      "        return;",
      "      }",
      '      var link = "";',
      '      var anchors = block.querySelectorAll("a[href]");',
      "      if (anchors.length) {",
      '        var href = anchors[0].getAttribute("href") || "";',
      '        if (href && href.charAt(0) !== "#") {',
      "          link = resolveUrl(href, page.url);",
      "        }",
      "      }",
      "      rewriteAssets(block, page.url);",
      "      var raw = block.outerHTML;",
      '      items.push({ id: id, html: raw, text: plainText(block.textContent), link: link, tags: tagsFromRaw(raw) });',
      "    });",
      "    return items;",
      "  }",
      "",
      "  function setStatus(message) {",
      '    listHost.innerHTML = \'<p class="site-search-status">\' + message + "</p>";',
      "  }",
      "",
      "  function runSearch(rawQuery) {",
      '    var query = (rawQuery || "").trim();',
      "    var tagSpec = /^(?:タグ|tags?)\\s*[:：]\\s*(.*)$/i.exec(query);",
      '    var keyword = tagSpec ? tagSpec[1].trim() : "";',
      "    var keywords = keyword.split(/[,、\\s]+/).filter(function (part) {",
      "      return part;",
      "    });",
      '    var textQuery = query;',
      "    if (tagSpec) {",
      '      textQuery = (query.slice(0, tagSpec.index) + " " + query.slice(tagSpec.index + tagSpec[0].length)).trim();',
      "    }",
      '    var needle = plainText(textQuery);',
      '    setStatus(tagSpec ? "タグを検索中…" : "検索中…");',
      "    collectSnippets().then(function (pages) {",
      "      var snippets = [];",
      "      var seenIds = {};",
      "      pages.forEach(function (page) {",
      "        extractSnippets(page).forEach(function (item) {",
      "          if (!seenIds[item.id]) {",
      "            seenIds[item.id] = true;",
      "            snippets.push(item);",
      "          }",
      "        });",
      "      });",
      "      var bodies = {};",
      "      var urls = [];",
      "      snippets.forEach(function (item) {",
      "        if (item.link && !bodies.hasOwnProperty(item.link)) {",
      '          bodies[item.link] = { text: "", tags: [] };',
      "          urls.push(item.link);",
      "        }",
      "      });",
      "      return Promise.all(urls.map(function (url) {",
      "        return fetchDoc(url).then(function (page) {",
      '          var target = page.doc.querySelector("article[data-post-id]") || page.doc.body;',
      "          bodies[url] = { text: plainText(target.textContent), tags: tagsFromRaw(target.outerHTML) };",
      "        }).catch(function () {",
      '          bodies[url] = { text: "", tags: [] };',
      "        });",
      "      })).then(function () {",
      "        var matches = snippets.filter(function (item) {",
      "          var fullTags = item.tags.concat(item.link && bodies[item.link] ? bodies[item.link].tags : []);",
      "          if (tagSpec && !tagMatchList(fullTags, keywords)) {",
      "            return false;",
      "          }",
      "          if (!needle) {",
      "            return true;",
      "          }",
      "          return matchesText(item.text, needle) || (item.link && matchesText(bodies[item.link].text, needle));",
      "        });",
      '        renderMatches(matches, query, tagSpec ? keyword : "");',
      "      });",
      "    }).catch(function () {",
      '      setStatus("検索に失敗しました。");',
      "    });",
      "  }",
      "",
      "  function renderMatches(matches, query, tagLabel) {",
      '    var back = \' <a href="\' + listUrl + \'">一覧に戻る</a>\';',
      "    var label;",
      "    if (!matches.length) {",
      '      label = tagLabel',
      '        ? \'タグ「\' + escapeText(tagLabel) + \'」に一致する記事は見つかりませんでした。\'',
      '        : \'「\' + escapeText(query) + \'」に一致する記事は見つかりませんでした。\';',
      '      listHost.innerHTML = \'<p class="site-search-status">\' + label + back + "</p>";',
      "      return;",
      "    }",
      '    label = tagLabel',
      '      ? \'<strong>\' + matches.length + \' 件</strong> (タグ「\' + escapeText(tagLabel) + \'」)\'',
      '      : \'<strong>\' + matches.length + \' 件</strong>ヒット (「\' + escapeText(query) + \'」)\';',
      '    listHost.innerHTML = \'<p class="site-search-status">\' + label + back + \'</p>\'',
      '      + matches.map(function (item) { return item.html; }).join("\\n");',
      "    linkifyTags();",
      "  }",
      "",
      "  /* 記事内の「タグ: …」行をタグリンク化する (クリックでタグ検索) */",
      "  function linkifyTags() {",
      '    Array.prototype.forEach.call(document.querySelectorAll("article[data-post-id] p"), function (p) {',
      '      var text = (p.textContent || "").trim();',
      '      var markerMatch = /^(?:タグ|tags?)\\s*[:：]/i.exec(text);',
      '      if (!markerMatch || p.querySelector("a.site-tag")) {',
      "        return;",
      "      }",
      "      var tags = [];",
      "      text.slice(markerMatch[0].length).split(/[,、\\s]+/).forEach(function (tag) {",
      '        tag = (tag || "").trim();',
      "        if (tag) {",
      "          tags.push(tag);",
      "        }",
      "      });",
      "      if (!tags.length) {",
      "        return;",
      "      }",
      "      while (p.firstChild) {",
      "        p.removeChild(p.firstChild);",
      "      }",
      '      var labelSpan = document.createElement("span");',
      "      labelSpan.textContent = markerMatch[0];",
      "      p.appendChild(labelSpan);",
      "      tags.forEach(function (tag, index) {",
      "        if (index) {",
      '          p.appendChild(document.createTextNode(" "));',
      "        }",
      '        var link = document.createElement("a");',
      '        link.className = "site-tag";',
      "        link.textContent = tag;",
      '        link.href = listUrl + "?q=" + encodeURIComponent("tag:" + tag);',
      "        p.appendChild(link);",
      "      });",
      "    });",
      "  }",
      "",
      "  /* 上部メニューの「Tag:メモ」形式リンクをタグ検索へのリンクに差し替える */",
      "  function relinkMenuTags() {",
      '    var topbar = document.querySelector(".site-topbar");',
      "    if (!topbar || !topbar.querySelectorAll) {",
      "      return;",
      "    }",
      '    Array.prototype.forEach.call(topbar.querySelectorAll("a[href]"), function (anchor) {',
      '      var href = (anchor.getAttribute("href") || "").trim();',
      '      var match = /^(?:tags?|タグ)\\s*[:：]\\s*(.+)$/i.exec(href);',
      "      if (!match) {",
      "        return;",
      "      }",
      "      var hrefValue = match[1].trim();",
      "      if (!hrefValue) {",
      "        return;",
      "      }",
      '      anchor.href = listUrl + "?q=" + encodeURIComponent("tag:" + hrefValue);',
      "    });",
      "  }",
      "",
      "  function renderMatches(matches, query) {",
      '    var back = \' <a href="\' + listUrl + \'">一覧に戻る</a>\';',
      "    if (!matches.length) {",
      '      listHost.innerHTML = \'<p class="site-search-status">「\' + escapeText(query) + \'」に一致する記事は見つかりませんでした。\' + back + "</p>";',
      "      return;",
      "    }",
      '    listHost.innerHTML = \'<p class="site-search-status"><strong>\' + matches.length + \' 件</strong>ヒット (「\' + escapeText(query) + \'」)\' + back + \'</p>\'',
      "      + matches.map(function (item) { return item.html; }).join(\"\\n\");",
      "  }",
      "",
      '  form.addEventListener("submit", function (event) {',
      "    event.preventDefault();",
      '    var query = (input.value || "").trim();',
      "    if (!query) {",
      "      if (listHost) {",
      "        listHost.innerHTML = defaultList;",
      "      } else {",
      '        location.href = listUrl;',
      "      }",
      "      return;",
      "    }",
      "    if (!listHost) {",
      '      location.href = listUrl + "?q=" + encodeURIComponent(query);',
      "      return;",
      "    }",
      "    runSearch(query);",
      "  });",
      "",
      "  linkifyTags();",
      "  relinkMenuTags();",
      "  try {",
      '    var queryParam = new URLSearchParams(location.search).get("q");',
      "    if (queryParam && listHost) {",
      "      input.value = queryParam;",
      "      runSearch(queryParam);",
      "    }",
      "  } catch (e) {",
      "  }",
      "})();"
    ].join("\n");
    return '<script id="site-search-script">\n' + js + "\n  </script>";
  }

  /* 検索ボックススクリプト (id="site-search-script" の <script>) のパターン */
  function siteSearchScriptPattern() {
    return /<script\b[^>]*\bid=["']site-search-script["'][^>]*>[\s\S]*?<\/script\s*>/i;
  }

  /* style ブロック内のルールに property を設定する (既存値があれば置換) */
  function applyCssRuleProperty(css, ruleName, property, value) {
    var valueRe = new RegExp(
      "(" + ruleName + "\\s*\\{[^}]*)(?<![\\w-])" + property + "\\s*:\\s*[^;}]+",
      "i"
    );
    if (valueRe.test(css)) {
      return css.replace(valueRe, "$1" + property + ": " + value);
    }
    var openRe = new RegExp("(" + ruleName + "\\s*\\{)", "i");
    if (openRe.test(css)) {
      return css.replace(openRe, "$1 " + property + ": " + value + ";");
    }
    return css;
  }

  /* style ブロック内のルールを水平方向に中央揃えにする (auto マージンを末尾に追加) */
  function applyCssRuleCentering(css, ruleName) {
    var ruleRe = new RegExp("(" + ruleName + "\\s*\\{)([^}]*?)(\\})", "i");
    var matched = ruleRe.exec(css);
    if (!matched) {
      return css;
    }
    if (/margin[^;}]*auto/i.test(matched[2])) {
      return css;
    }
    return css.replace(ruleRe, function () {
      return matched[1] + matched[2] + " margin-left: auto; margin-right: auto; " + matched[3];
    });
  }

  /* 幅・高さ・色の指定を <style> ブロックに反映する (ヘッダー = .site-topbar, 本文 = .container) */
  function applyLayoutWidths(output, settings) {
    if (!/<style\b[^>]*>/i.test(output)) {
      return output;
    }
    var headerWidth = normalizeCssMeasure(settings.headerWidth, "");
    var headerHeight = normalizeCssHeight(settings.headerHeight, "");
    var headerColor = normalizeCssColor(settings.headerColor, "");
    var bodyWidth = normalizeCssMeasure(settings.bodyWidth, "");
    if (!headerWidth && !bodyWidth && !headerHeight && !headerColor) {
      return output;
    }
    return output.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/i, function (
      whole,
      open,
      css,
      close
    ) {
      var updated = css;
      if (headerWidth) {
        updated = applyCssRuleProperty(updated, "\\.site-topbar", "max-width", headerWidth);
        updated = applyCssRuleCentering(updated, "\\.site-topbar");
      }
      if (headerHeight) {
        updated = applyCssRuleProperty(updated, "\\.site-topbar", "height", headerHeight);
      }
      if (headerColor) {
        updated = applyCssRuleProperty(updated, "\\.site-topbar", "background", headerColor);
      }
      if (bodyWidth) {
        updated = applyCssRuleProperty(updated, "\\.container", "max-width", bodyWidth);
      }
      if (updated === css) {
        return whole;
      }
      return open + updated + close;
    });
  }

  /* 既存 html にタイトル / 説明 / アイコン / 上部メニューを反映して返す */
  function applyHeadSettings(html, settings) {
    var output = html;
    var brand = {
      title: (settings.title || "").trim(),
      desc: (settings.desc || "").trim(),
      logo: (settings.logo || "").trim()
    };

    if (settings.title) {
      var safeTitle = escapeHtml(settings.title);
      var titleRe = /<title[^>]*>[\s\S]*?<\/title\s*>/i;
      if (titleRe.test(output)) {
        output = output.replace(titleRe, "<title>" + safeTitle + "</title>");
      } else if (/<head\b[^>]*>/i.test(output)) {
        output = output.replace(/<head\b[^>]*>/i, "$&\n    <title>" + safeTitle + "</title>");
      }
      /* ヒーロー部の大見出し <h1> もタイトルに揃える */
      var heroH1Re = /(<section\b[^>]*class=["'][^"']*\bhero\b[^"']*["'][^>]*>[\s\S]*?<h1[^>]*>)([\s\S]*?)(<\/h1\s*>)/i;
      if (heroH1Re.test(output)) {
        output = output.replace(heroH1Re, "$1" + safeTitle + "$3");
      }
    }

    if (settings.icon) {
      var iconLink = '<link rel="icon" href="' + escapeHtml(settings.icon) + '" />';
      var iconRe = iconLinkPattern();
      if (iconRe.test(output)) {
        output = output.replace(iconRe, iconLink);
      } else if (/<\/title\s*>/i.test(output)) {
        output = output.replace(/<\/title\s*>/i, "$&\n    " + iconLink);
      } else if (/<head\b[^>]*>/i.test(output)) {
        output = output.replace(/<head\b[^>]*>/i, "$&\n    " + iconLink);
      }
    }

    /* 既存の上部メニューを置き換える (タイトル・説明も出力する。両方空なら削除) */
    output = output.replace(topbarHeaderPattern(), "");
    var menuHtml = buildTopbarHtml(settings.items, brand, settings.addSearch);
    if (menuHtml) {
      output = output.replace(/<body\b[^>]*>/i, function (bodyTag) {
        return bodyTag + "\n  " + menuHtml;
      });
    }
    output = applyLayoutWidths(output, settings);
    /* 検索ボックススクリプトを張り替える (チェックが外れたら除去) */
    output = output.replace(siteSearchScriptPattern(), "");
    if (settings.addSearch) {
      output = output.replace(/<\/body\s*>/i, function (bodyClose) {
        return "\n  " + buildSiteSearchScriptHtml() + "\n" + bodyClose;
      });
    } else {
      output = stripSearchStyles(output);
    }
    return output;
  }

  /* 検索ボックス用の CSS ルール (.site-search を含むセレクター) を取り除く */
  function stripSearchStyles(html) {
    return html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/i, function (
      whole,
      open,
      css,
      close
    ) {
      var ruleRe = /^[ \t]*\.[^{]*\{[^}]*\}[ \t]*\r?\n?/gm;
      var updated = css.replace(ruleRe, function (rule) {
        var selector = rule.slice(0, rule.indexOf("{"));
        return selector.indexOf("site-search") >= 0 || selector.indexOf("site-tag") >= 0
          ? ""
          : rule;
      });
      if (updated === css) {
        return whole;
      }
      return open + updated + close;
    });
  }

  /* 上部メニューのリンクをメニュー行のデータ (rows) に戻す */
  function rowsFromTopbar(html) {
    var match = topbarHeaderPattern().exec(html);
    if (!match) {
      return [];
    }
    var rows = [];
    var anchorRe = /<a\b[^>]*href=["']?([^"'>\s]+)["']?[^>]*>([\s\S]*?)<\/a\s*>/gi;
    var anchor;
    while ((anchor = anchorRe.exec(match[0]))) {
      rows.push({ label: anchor[2].trim(), href: anchor[1] });
    }
    return rows;
  }

  /* 幅・高さ・色の指定を既存 html の style ブロックから読み取る */
  function readDeclaration(ruleBody, property) {
    var re = new RegExp("(?:^|;)\\s*" + property + "\\s*:\\s*([^;}]+)", "i");
    var m = re.exec(ruleBody);
    return m ? m[1].trim() : "";
  }

  function readLayoutWidthsFromHtml(html) {
    var match = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/i.exec(html);
    var result = {};
    if (!match) {
      return result;
    }
    var topbarRule = /\.site-topbar\s*\{([^}]*)\}/i.exec(match[1]);
    if (topbarRule) {
      var width = readDeclaration(topbarRule[1], "max-width");
      if (width) {
        result.headerWidth = width;
      }
      var height = readDeclaration(topbarRule[1], "height");
      if (height) {
        result.headerHeight = height;
      }
      var background = readDeclaration(topbarRule[1], "background");
      if (background) {
        result.headerColor = background;
      }
    }
    var containerRule = /\.container\s*\{([^}]*)\}/i.exec(match[1]);
    if (containerRule) {
      var bodyWidth = readDeclaration(containerRule[1], "max-width");
      if (bodyWidth) {
        result.bodyWidth = bodyWidth;
      }
    }
    return result;
  }

  /* サイトの説明を既存 html (上部メニューの説明 or ヒーロー部の最初の段落) から読み取る */
  function readSiteDescriptionFromHtml(html) {
    var topbar = topbarHeaderPattern().exec(html);
    if (topbar) {
      var brandDesc = /<span\b[^>]*class=["'][^"']*site-brand-desc[^"']*["'][^>]*>([\s\S]*?)<\/span\s*>/i.exec(
        topbar[0]
      );
      if (brandDesc) {
        return brandDesc[1].trim();
      }
    }
    var hero = /<section\b[^>]*class=["'][^"']*\bhero\b[^"']*["'][^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p\s*>/i.exec(
      html
    );
    return hero ? hero[1].trim() : "";
  }

  /* icon タグ (rel に icon を含む <link>) を探すパターン */
  function iconLinkPattern() {
    return /<link\b(?=[^>]*\brel\b)(?=[^>]*\bicon\b)[^>]*>/i;
  }

  /*
   * アイコンの指定を index.html からの相対パス / URL に正規化する。
   * 「public/favicon.svg」のようなリポジトリルート基準のパスは、
   * ページ (public/index.html) から見ると「favicon.svg」になる。
   */
  function normalizeIconReference(value) {
    var text = (value || "").trim();
    if (!text) {
      return text;
    }
    if (/^(https?:)?\/\//i.test(text) || /^data:/i.test(text)) {
      return text;
    }
    var pageDir = parentDir(POST_PAGE);
    if (pageDir && text.indexOf(pageDir + "/") === 0) {
      return text.slice(pageDir.length + 1);
    }
    return text;
  }

  /* タイトルの頭文字でシンプルな SVG ファビコンを作る */
  function buildFaviconSvg(title) {
    var initial = ((title || "").trim().charAt(0) || "S").toUpperCase();
    return [
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">',
      '  <rect width="64" height="64" rx="12" fill="#2563eb" />',
      '  <text x="32" y="43" font-family="system-ui, sans-serif" font-size="32" font-weight="700" fill="#ffffff" text-anchor="middle">' +
        escapeHtml(initial) +
        "</text>",
      "</svg>",
      ""
    ].join("\n");
  }

  /*
   * ファビコンファイルがまだ無ければ自動生成する。
   * <link rel="icon"> があってもファイルが存在しないと反映されないので、
   * 相対パス指定の時はタイトルの頭文字で SVG を作る (既存ファイルは触らない)。
   */
  function ensureFaviconFile(siteId, settings) {
    var icon = (settings.icon || "").trim();
    if (!icon || /^(https?:)?\/\//i.test(icon) || /^data:/i.test(icon)) {
      return Promise.resolve(null);
    }
    var pageDir = parentDir(POST_PAGE);
    var name = pageDir ? pageDir + "/" + icon : icon;
    return api(
      "/api/sites/" + encodeURIComponent(siteId) + "/file?path=" + encodeURIComponent(name)
    )
      .then(function () {
        /* 既存のファイルがある場合はそのまま使う */
        return null;
      })
      .catch(function (error) {
        if (error.status !== 404) {
          throw error;
        }
        return api("/api/sites/" + encodeURIComponent(siteId) + "/file", {
          method: "PUT",
          body: { path: name, content: buildFaviconSvg(settings.title) }
        }).then(function () {
          return name;
        });
      });
  }

  /* 幅の指定を CSS に安全に使える形 (auto / 数値 + 単位) に整える */
  function normalizeCssMeasure(value, fallback) {
    var text = (value || "").trim();
    if (!text) {
      return fallback;
    }
    if (/^(auto|\d+(\.\d+)?(px|%|em|rem|vw|vh)?)$/i.test(text)) {
      return text;
    }
    return fallback;
  }

  /* 高さの指定を CSS に安全に使える形 (auto / ピクセル) に整える (数値は px 扱い) */
  function normalizeCssHeight(value, fallback) {
    var text = (value || "").trim();
    if (!text) {
      return fallback;
    }
    if (/^auto$/i.test(text)) {
      return "auto";
    }
    if (/^\d+(\.\d+)?$/i.test(text)) {
      return text + "px";
    }
    if (/^\d+(\.\d+)?px$/i.test(text)) {
      return text.toLowerCase();
    }
    return fallback;
  }

  /* 背景色を CSS に安全に使える形 (#rgb / #rrggbb) に整える (白は既定として扱い空を返す) */
  function normalizeCssColor(value, fallback) {
    var text = (value || "").trim();
    if (!text) {
      return fallback;
    }
    if (/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(text)) {
      text = text.toLowerCase();
      if (text === "#fff" || text === "#ffffff") {
        return fallback;
      }
      return text;
    }
    return fallback;
  }

  /* 既存 html の上部メニューからロゴ画像の参照を読み取る */
  function readLogoFromHtml(html) {
    var topbar = topbarHeaderPattern().exec(html);
    if (!topbar) {
      return "";
    }
    var img = /<img\b[^>]*class=["'][^"']*site-logo[^"']*["'][^>]*>/i.exec(topbar[0]);
    if (!img) {
      return "";
    }
    var src = /src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(img[0]);
    return src ? (src[1] || src[2] || src[3] || "").trim() : "";
  }

  function openSiteSettings() {
    if (!state.siteId) {
      toast("先にサイトを追加してください。", "warn");
      return;
    }
    var site = currentSite();
    el.settingsDialogTitle.textContent = "サイト設定 - " + (site ? site.name : "");
    el.settingsTitle.value = "";
    el.settingsDesc.value = "";
    /* favicon は最初から「favicon.svg」を記入しておく (ファイルが無ければ自動生成される) */
    el.settingsIcon.value = "favicon.svg";
    el.settingsHeaderWidth.value = "";
    el.settingsBodyWidth.value = "";
    el.settingsHeaderHeight.value = "";
    el.settingsHeaderColor.value = "#ffffff";
    el.settingsLogo.value = "";
    state.settingsMenuRows = [];
    renderMenuRows(state.settingsMenuRows);
    el.settingsAddSearch.checked = false;
    el.settingsError.hidden = true;
    el.settingsDialog.showModal();
    /* 既存の index.html から現在の設定値を取り込む */
    api("/api/sites/" + encodeURIComponent(state.siteId) + "/file?path=" + encodeURIComponent(POST_PAGE))
      .then(function (payload) {
        if (el.settingsDialog.open !== true) {
          return;
        }
        var html = payload.content || "";
        var titleMatch = /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
        if (titleMatch) {
          el.settingsTitle.value = titleMatch[1].trim();
        }
        var iconTag = iconLinkPattern().exec(html);
        if (iconTag) {
          var hrefMatch = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(iconTag[0]);
          var iconHref = hrefMatch ? hrefMatch[1] || hrefMatch[2] || hrefMatch[3] || "" : "";
          if (iconHref) {
            el.settingsIcon.value = iconHref;
          }
        }
        var rows = rowsFromTopbar(html);
        if (rows.length) {
          state.settingsMenuRows = rows;
          renderMenuRows(state.settingsMenuRows);
        }
        var desc = readSiteDescriptionFromHtml(html);
        if (desc) {
          el.settingsDesc.value = desc;
        }
        var widths = readLayoutWidthsFromHtml(html);
        if (widths.headerWidth) {
          el.settingsHeaderWidth.value = widths.headerWidth;
        }
        if (widths.bodyWidth) {
          el.settingsBodyWidth.value = widths.bodyWidth;
        }
        if (widths.headerHeight) {
          el.settingsHeaderHeight.value = widths.headerHeight;
        }
        if (widths.headerColor) {
          el.settingsHeaderColor.value = normalizeCssColor(widths.headerColor, "#ffffff");
        }
        var logo = readLogoFromHtml(html);
        if (logo) {
          el.settingsLogo.value = logo;
        }
        var topbar = topbarHeaderPattern().exec(html);
        if (topbar && searchFormPattern().test(topbar[0])) {
          el.settingsAddSearch.checked = true;
        }
      })
      .catch(function () {
        /* index.html が無い場合は空欄のまま */
      });
  }

  function flushEditorForPostPage() {
    if (state.path !== POST_PAGE) {
      return false;
    }
    openFile(POST_PAGE);
    return true;
  }

  function submitSiteSettings(action) {
    var siteId = state.siteId;
    if (!siteId) {
      el.settingsError.textContent = "先にサイトを追加してください。";
      el.settingsError.hidden = false;
      return;
    }
    var settings = {
      title: el.settingsTitle.value.trim(),
      desc: el.settingsDesc.value.trim(),
      icon: normalizeIconReference(el.settingsIcon.value),
      headerWidth: el.settingsHeaderWidth.value.trim(),
      bodyWidth: el.settingsBodyWidth.value.trim(),
      headerHeight: el.settingsHeaderHeight.value.trim(),
      headerColor: el.settingsHeaderColor.value.trim(),
      logo: normalizeIconReference(el.settingsLogo.value),
      addSearch: el.settingsAddSearch.checked,
      items: readMenuRows()
    };

    var buttons = [el.btnSettingsCreate, el.btnSettingsApply];
    buttons.forEach(function (button) {
      busy(button, true);
      button.disabled = true;
    });

    var chain;
    if (action === "create") {
      /* 既存の index.html を index-bk.html (重複時は連番) へ退避してから作成 */
      var backup = null;
      chain = api(
        "/api/sites/" + encodeURIComponent(siteId) + "/file?path=" + encodeURIComponent(POST_PAGE)
      )
        .then(function () {
          var attempt = function (index) {
            var name =
              (parentDir(POST_PAGE) ? parentDir(POST_PAGE) + "/" : "") +
              (index === 0 ? "index-bk.html" : "index-bk-" + index + ".html");
            return api("/api/sites/" + encodeURIComponent(siteId) + "/rename", {
              method: "POST",
              body: { from: POST_PAGE, to: name }
            })
              .then(function () {
                backup = name;
              })
              .catch(function (error) {
                if (index >= 50) {
                  throw error;
                }
                return attempt(index + 1);
              });
          };
          return attempt(0);
        })
        .catch(function (error) {
          /* index.html が無い場合のみ退避を省略する */
          if (error.status === 404) {
            return null;
          }
          throw error;
        })
        .then(function () {
          return api("/api/sites/" + encodeURIComponent(siteId) + "/file", {
            method: "PUT",
            body: { path: POST_PAGE, content: buildSampleHtml(settings) }
          }).then(function () {
            return backup;
          });
        })
        .then(function (backupName) {
          return ensureFaviconFile(siteId, settings).then(function (faviconName) {
            return { backup: backupName, favicon: faviconName };
          });
        })
        .then(function (result) {
          el.settingsDialog.close();
          toast(
            "index.html を作成しました: " + POST_PAGE +
              (result.backup ? "\n元のファイルは " + result.backup + " に退避しました。" : "") +
              (result.favicon ? "\nファビコンファイルを作成しました: " + result.favicon : ""),
            "success"
          );
          flushEditorForPostPage();
          refreshTree();
          refreshGit();
        });
    } else {
      chain = api(
        "/api/sites/" + encodeURIComponent(siteId) + "/file?path=" + encodeURIComponent(POST_PAGE)
      )
        .then(function (payload) {
          if (!payload.content) {
            throw new Error(POST_PAGE + " が空です。");
          }
          return ensureFaviconFile(siteId, settings).then(function (faviconName) {
            return api("/api/sites/" + encodeURIComponent(siteId) + "/file", {
              method: "PUT",
              body: {
                path: POST_PAGE,
                content: applyHeadSettings(payload.content, settings)
              }
            }).then(function () {
              return faviconName;
            });
          });
        })
        .then(function (faviconName) {
          el.settingsDialog.close();
          toast(
            "設定を適用しました: " + POST_PAGE +
              (faviconName ? "\nファビコンファイルを作成しました: " + faviconName : ""),
            "success"
          );
          flushEditorForPostPage();
          refreshGit();
        });
    }

    chain
      .catch(function (error) {
        var message =
          error.status === 404
            ? POST_PAGE + " が見つかりません。先に「index.html を作成」してください。"
            : error.message;
        el.settingsError.textContent = message;
        el.settingsError.hidden = false;
      })
      .finally(function () {
        buttons.forEach(function (button) {
          busy(button, false);
          button.disabled = false;
        });
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

  function unwrapLink(link) {
    var parent = link.parentNode;
    if (!parent) {
      return;
    }
    while (link.firstChild) {
      parent.insertBefore(link.firstChild, link);
    }
    parent.removeChild(link);
  }

  function buildLinkSection(link) {
    var section = propSection("ハイパーリンク");
    var href = link.getAttribute("href") || "";

    section.appendChild(
      propRow("リンク先 URL", propInput(href, function (value) {
        if (!value) {
          unwrapLink(link);
          editor.notifyChange();
          toast("ハイパーリンクを削除しました", "success");
          renderProperties(null);
          return;
        }
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
           editor.insertHtmlAtCaret("<br>");
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
        markMemoClean();
      })
      .catch(function (error) {
        el.memoStatus.textContent = "メモの読み込みに失敗しました: " + error.message;
      });
  }

  var memoSaveTimer = null;
  function markMemoDirty() {
    el.btnMemoSave.classList.add("is-dirty");
    if (memoSaveTimer) clearTimeout(memoSaveTimer);
    memoSaveTimer = setTimeout(function () {
      saveMemo(true);
    }, 5000);
  }
  function markMemoClean() {
    el.btnMemoSave.classList.remove("is-dirty");
    if (memoSaveTimer) {
      clearTimeout(memoSaveTimer);
      memoSaveTimer = null;
    }
  }

  function saveMemo(auto) {
    if (memoSaveTimer && !auto) {
      clearTimeout(memoSaveTimer);
      memoSaveTimer = null;
    }
    busy(el.btnMemoSave, true);
    api("/api/memo", { method: "PUT", body: { content: el.memoText.value } })
      .then(function (payload) {
        el.memoStatus.textContent = "保存しました: " + payload.path;
        if (!auto) toast("メモを保存しました: " + payload.path, "success");
        markMemoClean();
      })
      .catch(function (error) {
        el.memoStatus.textContent = "保存に失敗しました: " + error.message;
        if (!auto) toast("メモの保存に失敗しました: " + error.message, "error");
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
    post: { pane: "postPane", button: "btnPost", label: "投稿パネル" },
    site: { pane: "sidebarPane", button: "btnToggleSite", label: "サイトパネル" },
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

  function setupResizers() {
    var workspace = el.workspace;
    if (!workspace) return;
    var panes = Array.prototype.slice.call(workspace.querySelectorAll(":scope > .pane"));
    panes.forEach(function (pane, index) {
      if (index === panes.length - 1) return;
      var resizer = document.createElement("div");
      resizer.className = "resizer";
      pane.parentNode.insertBefore(resizer, pane.nextSibling);
      var dragging = false;
      var startX = 0;
      var startW = 0;
      resizer.addEventListener("mousedown", function (e) {
        dragging = true;
        startX = e.clientX;
        startW = pane.getBoundingClientRect().width;
        e.preventDefault();
      });
      document.addEventListener("mousemove", function (e) {
        if (!dragging) return;
        var newW = Math.max(120, startW + (e.clientX - startX));
        pane.style.width = newW + "px";
      });
      document.addEventListener("mouseup", function () {
        dragging = false;
      });
    });
  }
  function bindEvents() {
    el.btnAddSite.addEventListener("click", openSiteDialog);
    el.btnSiteSubmit.addEventListener("click", submitSiteDialog);
    el.btnSiteCancel.addEventListener("click", function () {
      el.siteDialog.close();
    });
    el.btnRefreshTree.addEventListener("click", refreshTree);
    el.btnSiteSettings.addEventListener("click", openSiteSettings);
    el.btnSettingsMenuAdd.addEventListener("click", addMenuRow);
    el.btnSettingsHeaderColorClear.addEventListener("click", function () {
      el.settingsHeaderColor.value = "#ffffff";
    });
    el.btnSettingsLogoUpload.addEventListener("click", function () {
      el.settingsLogoFile.click();
    });
    el.settingsLogoFile.addEventListener("change", function () {
      var file = el.settingsLogoFile.files && el.settingsLogoFile.files[0];
      el.settingsLogoFile.value = "";
      if (!file) {
        return;
      }
      if (!state.siteId) {
        toast("先にサイトを追加してください。", "warn");
        return;
      }
      el.btnSettingsLogoUpload.disabled = true;
      postUploadImage(state.siteId, file, POST_PAGE)
        .then(function (reference) {
          el.settingsLogo.value = reference;
          toast("ロゴをアップロードしました: " + reference, "success");
        })
        .catch(function (error) {
          toast(error.message || String(error), "error");
        })
        .finally(function () {
          el.btnSettingsLogoUpload.disabled = false;
        });
    });
    el.btnSettingsLogoClear.addEventListener("click", function () {
      el.settingsLogo.value = "";
    });
    el.btnSettingsApply.addEventListener("click", function () {
      submitSiteSettings("apply");
    });
    el.btnSettingsCreate.addEventListener("click", function () {
      submitSiteSettings("create");
    });
    el.btnSettingsClose.addEventListener("click", function () {
      el.settingsDialog.close();
    });
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
    el.btnToggleSite.addEventListener("click", function () {
      togglePane("site");
    });
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
    el.btnPost.addEventListener("click", function () {
      if (el.postPane.classList.contains("is-hidden")) {
        openPostPane();
      } else {
        togglePane("post", false);
      }
    });
    el.btnPostSubmit.addEventListener("click", function () {
      submitPostDialog(false);
    });
    el.btnPostPush.addEventListener("click", function () {
      submitPostDialog(true);
    });
    el.btnEditorSavePush.addEventListener("click", runEditorSavePush);
    el.btnPostClose.addEventListener("click", function () {
      togglePane("post", false);
    });
    el.postPhotos.addEventListener("change", function () {
      var files = Array.prototype.slice.call(el.postPhotos.files || []);
      state.postPhotos = (state.postPhotos || []).concat(files);
      renderPostPhotoList();
      el.postPhotos.value = "";
    });
    // 手書きパネル
    (function () {
      var canvas = el.handwritingCanvas;
      var ctx = canvas.getContext("2d");
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.strokeStyle = "#000";
      Array.prototype.forEach.call(document.querySelectorAll("#handwriting-pane [data-color]"), function (btn) {
        btn.addEventListener("click", function () {
          ctx.strokeStyle = btn.getAttribute("data-color");
        });
      });
      var drawing = false;
      function pos(e) {
        var r = canvas.getBoundingClientRect();
        var src = e.touches ? e.touches[0] : e;
        return { x: (src.clientX - r.left) * (canvas.width / r.width), y: (src.clientY - r.top) * (canvas.height / r.height) };
      }
      function start(e) { drawing = true; var p = pos(e); ctx.beginPath(); ctx.moveTo(p.x, p.y); e.preventDefault(); }
      function move(e) { if (!drawing) return; var p = pos(e); ctx.lineTo(p.x, p.y); ctx.stroke(); e.preventDefault(); }
      function end() { drawing = false; }
      canvas.addEventListener("mousedown", start);
      canvas.addEventListener("mousemove", move);
      canvas.addEventListener("mouseup", end);
      canvas.addEventListener("mouseleave", end);
      canvas.addEventListener("touchstart", start, { passive: false });
      canvas.addEventListener("touchmove", move, { passive: false });
      canvas.addEventListener("touchend", end);
      el.btnHandwritingOpen.addEventListener("click", function () {
        state.handwritingTarget = "post";
        el.handwritingPane.classList.remove("is-hidden");
      });
      el.btnHandwritingClose.addEventListener("click", function () {
        el.handwritingPane.classList.add("is-hidden");
      });
      el.btnHandwritingClear.addEventListener("click", function () {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      });
      el.btnHandwritingSave.addEventListener("click", function () {
        canvas.toBlob(function (blob) {
          if (!blob) { toast("保存に失敗しました", "error"); return; }
          if (state.handwritingTarget === "editor") {
            var reader = new FileReader();
            reader.onload = function () {
              editor.insertImage(reader.result, "handwriting.png");
              el.handwritingPane.classList.add("is-hidden");
              toast("手書き画像を挿入しました", "success");
            };
            reader.readAsDataURL(blob);
            return;
          }
          var file = new File([blob], "handwriting.png", { type: "image/png" });
          state.postPhotos = (state.postPhotos || []).concat([file]);
          renderPostPhotoList();
          el.handwritingPane.classList.add("is-hidden");
          toast("手書き画像を添付しました", "success");
        }, "image/png");
      });
    })();
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
    el.memoText.addEventListener("input", markMemoDirty);
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
    el.settingsForm.addEventListener("submit", function (event) {
      event.preventDefault();
    });    el.postForm.addEventListener("submit", function (event) {
      event.preventDefault();
      submitPostDialog();
    });
  }

  function init() {
    el.appVersion = $("app-version");
    el.topbarMeta = $("topbar-meta");
    el.btnUpdate = $("btn-update");
    el.btnRestart = $("btn-restart");
    el.siteList = $("site-list");
    el.sidebarPane = $("sidebar-pane");
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
    el.btnToggleSite = $("btn-toggle-site");
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
    el.btnSiteSettings = $("btn-site-settings");
    el.settingsDialog = $("settings-dialog");
    el.settingsForm = $("settings-form");
    el.settingsDialogTitle = $("settings-dialog-title");
    el.settingsTitle = $("settings-title");
    el.settingsDesc = $("settings-desc");
    el.settingsIcon = $("settings-icon");
    el.settingsHeaderWidth = $("settings-header-width");
    el.settingsBodyWidth = $("settings-body-width");
    el.settingsMenuRows = $("settings-menu-rows");
    el.settingsAddSearch = $("settings-add-search");
    el.btnSettingsMenuAdd = $("btn-settings-menu-add");
    el.settingsHeaderHeight = $("settings-header-height");
    el.settingsHeaderColor = $("settings-header-color");
    el.btnSettingsHeaderColorClear = $("btn-settings-header-color-clear");
    el.settingsLogo = $("settings-logo");
    el.btnSettingsLogoUpload = $("btn-settings-logo-upload");
    el.btnSettingsLogoClear = $("btn-settings-logo-clear");
    el.settingsLogoFile = $("settings-logo-file");
    el.settingsError = $("settings-error");
    el.btnSettingsCreate = $("btn-settings-create");
    el.btnSettingsApply = $("btn-settings-apply");
    el.btnSettingsClose = $("btn-settings-close");
    el.btnPost = $("btn-post");
    el.postPane = $("post-pane");
    el.btnPostClose = $("btn-post-close");
    el.postForm = $("post-form");
    el.postTitle = $("post-title");
    el.postBody = $("post-body");
    el.postPhotos = $("post-photos");
    el.postPhotoList = $("post-photo-list");
    el.postTags = $("post-tags");
    el.handwritingPane = $("handwriting-pane");
    el.handwritingCanvas = $("handwriting-canvas");
    el.btnHandwritingOpen = $("btn-handwriting-open");
    el.btnHandwritingClose = $("btn-handwriting-close");
    el.btnHandwritingClear = $("btn-handwriting-clear");
    el.btnHandwritingSave = $("btn-handwriting-save");
    el.postMaxSide = $("post-max-side");
    el.postTimestamp = $("post-timestamp");
    el.postDivider = $("post-divider");
    el.postError = $("post-error");
    el.btnPostSubmit = $("btn-post-submit");
    el.btnPostPush = $("btn-post-push");
    el.btnEditorSavePush = $("btn-editor-save-push");

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
      },
      onHandwriting: function () {
        state.handwritingTarget = "editor";
        el.handwritingPane.classList.remove("is-hidden");
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

    setupResizers();
    bindEvents();
    loadVersion();
    loadSites();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
