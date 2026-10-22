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
    collapsed: {}
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
        if (payload.publicUrl) {
          el.publicLink.href = payload.publicUrl;
          el.publicLink.hidden = false;
        }
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

      var name = document.createElement("span");
      name.className = "site-item-name";
      name.textContent = site.name;
      name.title = site.url;
      item.appendChild(name);

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
    state.siteId = siteId;
    state.path = null;
    editor.clear();
    el.currentFile.textContent = "ファイルが選択されていません";
    renderSites();
    refreshTree();
    refreshGit();
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
    el.siteError.hidden = true;
    el.siteUrl.value = "";
    el.siteBranch.value = "";
    el.siteName.value = "";
    el.siteDialog.showModal();
    el.siteUrl.focus();
  }

  function submitSiteDialog() {
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
        name: el.siteName.value.trim()
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
        renderTree(payload.tree || []);
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
      } else {
        row.addEventListener("click", function () {
          state.collapsed[entry.path] = !state.collapsed[entry.path];
          refreshTree();
        });
      }
      if (entry.path === state.path) {
        row.classList.add("is-active");
      }
      el.tree.appendChild(row);
    });
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
        toast("コミットしました\n" + (payload.output || ""), "success");
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
    el.btnSave.addEventListener("click", saveFile);
    el.btnPull.addEventListener("click", runPull);
    el.btnPush.addEventListener("click", runPush);
    el.btnCommit.addEventListener("click", runCommit);
    el.btnUpdate.addEventListener("click", runUpdate);
    el.btnRestart.addEventListener("click", runRestart);
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
    el.publicLink = $("public-link");
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
    el.toastContainer = $("toast-container");
    el.siteDialog = $("site-dialog");
    el.siteForm = $("site-form");
    el.siteUrl = $("site-url");
    el.siteBranch = $("site-branch");
    el.siteName = $("site-name");
    el.siteError = $("site-error");
    el.btnSiteSubmit = $("btn-site-submit");
    el.btnSiteCancel = $("btn-site-cancel");
    el.btnRefreshTree = $("btn-refresh-tree");
    el.btnRefreshGit = $("btn-refresh-git");

    editor = window.htmleditEditor.create({
      host: $("wysiwyg-host"),
      source: $("source-host"),
      toolbar: $("toolbar"),
      preview: $("preview-frame"),
      status: $("editor-status"),
      onDirtyChange: function (dirty) {
        el.dirtyFlag.hidden = !dirty;
      }
    });

    bindEvents();
    loadVersion();
    loadSites();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
