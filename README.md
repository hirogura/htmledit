# htmledit

GitHub 上の静的サイト (HTML) をブラウザ上で WYSIWYG 編集し、そのままコミット・プッシュするためのセルフホスト型 Web エディターです。

- 左ペイン: 追加したサイトの一覧と、ファイルツリー
- 中央ペイン: WYSIWYG 編集 (CLASS / ID / head 内の CSS はそのまま保持)
- プロパティペイン: 選択中のリンク / 画像のオプション編集 (保存済み画像のサムネイルから選択可能)
- opencode ペイン: opencode (AI) によるサイト編集
- 右ペイン: GitHub リポジトリ情報と pull / commit / push
- 最右ペイン: メモ (Markdown)

外部依存ゼロ (Python 標準ライブラリ + git コマンドのみ) で動きます。

---

## 必要要件

| 項目 | バージョン |
| --- | --- |
| Python | 3.11 以上 (3.14 で動作確認済み) |
| git | 2.30 以上 |
| OS | Linux (systemd 環境推奨) |

Python パッケージのインストールは不要です。

## インストール

```bash
git clone https://github.com/hirogura/htmledit.git /opt/htmledit
cd /opt/htmledit
sudo ./deploy/install.sh
```

`install.sh` は次のことを行います。

1. root / systemd / Python 3.11+ / git の有無と、モジュールの読み込みを事前チェック
2. `/etc/systemd/system/htmledit.service` を作成
3. `/etc/htmledit/htmledit.env` を作成 (`GITHUB_TOKEN` や basic 認証はここで設定)
4. `systemctl enable` + `systemctl restart` で起動し、起動できなければログを表示して異常終了
5. `tailscale serve` に登録して、tailnet 内へ HTTPS で公開
   (tailnet を使わない環境では自動スキップされます)

`install.sh` は環境変数で上書きできます。LXD 以外 (VPS / 物理マシン) でも
保存先やポートを変更すればインストールできます。

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `HTMLEDIT_INSTALL_DIR` | `/opt/htmledit` | インストール先 |
| `HTMLEDIT_PORT` | `3372` | 待ち受けポート |
| `HTMLEDIT_HOST` | `127.0.0.1` | 待ち受けアドレス (LAN から直接アクセスする場合は `0.0.0.0`) |
| `HTMLEDIT_RUN_USER` | `root` | サービスの実行ユーザー |
| `HTMLEDIT_SERVICE_NAME` | `htmledit` | systemd ユニット名 |
| `HTMLEDIT_DATA_DIR` | `/opt/lxd-data/htmledit-data` | サイト登録情報と認証情報の保存先 |
| `HTMLEDIT_MEMO_DIR` | `/opt/lxd-data/htmledit-memo` | メモの保存先 |
| `HTMLEDIT_ENV_DIR` | `/etc/htmledit` | 環境設定ファイルの配置先 |
| `HTMLEDIT_TAILSCALE_SERVE` | `auto` | `tailscale serve` への登録 (1 / 0 / auto) |

例: ポートと保存先を変更してインストールする。

```bash
sudo HTMLEDIT_PORT=8080 \
     HTMLEDIT_DATA_DIR=/var/lib/htmledit/data \
     HTMLEDIT_MEMO_DIR=/var/lib/htmledit/memo \
     ./deploy/install.sh
```

注意:

- `/etc/htmledit/htmledit.env` は既に存在すると変更しません (設定は手動で編集してください)
- 保存先を `/tmp` 配下にした場合、systemd の `PrivateTmp` を自動で無効にします
- systemd 以外の環境 (openrc や PID 1 が systemd でないコンテナ) では
  `python3 -m htmledit` を直接起動してください

手動で起動する場合:

```bash
cd /opt/htmledit
python3 -m htmledit                    # http://127.0.0.1:3372 で待ち受け
python3 -m htmledit --port 8080        # ポート変更
python3 -m htmledit --host 0.0.0.0     # LAN からも直接受け付けたい場合
```

## ポートと公開先

既定で **3372** 番ポートに待ち受けます (`HTMLEDIT_PORT` で変更可能)。
待ち受けアドレスは既定で `127.0.0.1` なので、外部からの直接アクセスはできません。
公開は [Tailscale](#tailscale-による-https-公開) または [Cloudflare](#cloudflare-連携) 経由で行います。

```
https://<tailnet のホスト名>:3372/    # tailscale serve 経由 (HTTPS)
```

## 使い方

1. 左ペインの「+ 追加」を押し、GitHub のリポジトリ URL (`https://github.com/owner/repo`) を入力する
   - `https://github.com/owner/repo/tree/branch` のようなブランチ指定 URL にも対応
   - `git@github.com:owner/repo.git` のような SSH URL にも対応
   - プライベートリポジトリや push 用に「ユーザーID」「PAT」を入力できる (後述)
   - 公開サイトの URL を「サイトURL」に入力すると、サイドバーの表示名がその URL へのリンクになる (後述)
2. 追加すると、左ペインにはこのリポジトリのルートを基準としたフォルダ一覧が表示される
3. ファイル (.html / .htm) をクリックすると中央ペインで WYSIWYG 編集ができる
   - 「ソース」タブでファイル全体 (head を含む) を直接編集することも可能
   - 「プレビュー」ボタンで実際のページ表示を確認できる
   - `Ctrl+S` で保存
4. 右ペインでコミットメッセージを入力して「コミット」→「プッシュ」
   - 「プル」でリモートの変更を取得してから編集する運用も可能

## サイトURL (公開サイトのリンク)

「認証情報を編集」ウィンドウ (サイト横の 🔑 ボタン) には **サイトURL** の項目があります。

- 公開中のサイトの URL (例: `https://example.com`) を登録します
- 登録すると、サイドバーの表示名がリンクになり、**クリックで新しいタブ**に開きます
- URL は `http` / `https` のみ指定できます (スキームが無ければ `https://` を補います)
- 空欄にすると未設定に戻ります
- サイトURL は `data/sites.json` に保存されます

## リンクと画像の編集 (プロパティペイン)

中央ペインと GitHub ペインの間にある「プロパティ」ペインは、
エディター上で選択した要素のオプションを編集します。

### ハイパーリンク

リンクをクリック (またはカーソルをリンク内へ移動) すると、

| 項目 | 説明 |
| --- | --- |
| リンク先 URL | `href` を直接書き換える |
| 表示文字列 | リンクの表示テキストを書き換える |
| 新しいページで開く | `target="_blank"` を付ける / 外す (付ける場合は `rel="noopener"` も付与) |
| title 属性 | `title` 属性を設定する |
| rel 属性 | `rel` 属性を設定する (例: `nofollow`) |
| リンクを開く / URL をコピー | 別ウィンドウで開く、URL のコピー |

### 画像

画像をクリックすると、

| 項目 | 説明 |
| --- | --- |
| 画像 URL | `src` を書き換える |
| 代替テキスト (alt) | `alt` を設定する |
| 幅 / 高さ (px) | `width` / `height` を設定する (空欄で自動) |
| title 属性 | `title` 属性を設定する |
| 画像をクリック時にリンクを開く | 画像を `<a>` で囲む / 囲みを外す |
| 元画像を開く / 画像を削除 | 元画像の表示、画像の削除 |

### 保存済み画像のサムネイル

ツールバーの「画像」ボタン (🖼) を押すと、編集位置に画像要素が挿入され、
プロパティペインの「画像」カードの最下部 (「元画像を開く」「画像を削除」の下) に
**保存済み画像のサムネイル一覧**が表示されます。

| 項目 | 説明 |
| --- | --- |
| 保存済みの画像 | 選択中のサイトの `public/images` 以下に保存されている画像をサムネイルで表示 |
| 並び順 | 保存日 (更新日時) の新しい順 |
| サムネイルをクリック | その上の「画像 URL」に **そのページからの相対パス**が入力され、画像の `src` になる |
| 続きを読み込む | 20枚ずつ、次の 20枚を表示する (20枚を超える場合のみ表示) |
| 更新 | 一覧を最新の状態で読み込み直す |

- 画像が無い場合は「保存済みの画像はありません」と表示される
- 画像の追加 (ドラッグ＆ドロップ) を行った場合は「更新」ボタンで再読み込みできる

### 画像のドラッグ＆ドロップ

以下の 3 通りで画像を WYSIWYG に埋め込めます。画像は Base64 (data URL) ではなく
**リポジトリ内の日付付きフォルダ**に保存され、HTML からは相対パスで参照します。

```
public/images/2026/10/22/photo.png
└── index.html からは <img src="public/images/2026/10/22/photo.png">
```

| 手順 | 動作 |
| --- | --- |
| ファイルツリーからドラッグ | サーバー側で `public/images/YYYY/MM/DD/` へコピーし、相対パスを挿入する |
| ローカルファイルからドラッグ | ファイルをアップロードして `public/images/YYYY/MM/DD/` に保存し、相対パスを挿入する |
| 画像 URL をドラッグ | `<img src="https://...">` として挿入する (外部画像は保存しない) |

- フォルダは画像を取り込んだ日付 (サーバー時刻) で自動的に作成される
- 同名ファイルがある場合は `photo-1.png` のように連番になる
- アップロードされたファイル名は安全な名前に変換される (パスや記号を含む場合は置換)

画像を表示する仕組み:

- 作成した画像はリポジトリ内の `public/images/YYYY/MM/DD/` に保存され、HTML からは
  **そのページからの相対パス**で参照される (ルート直下の `index.html` なら
  `public/images/2026/10/22/photo.png`、サブディレクトリのページなら `../public/images/...`)
- エディター (WYSIWYG / プレビュー) 内では相対 URL がそのままでは解決できないため、
  アプリがサイトのリポジトリを `/site/{サイトID}/` で配信し、エディター側の
  `<base>` をそこに向けることで画像を正しく表示する
- `.gitignore` で無視されるファイルに画像を保存した場合は、警告を表示する
  (警告された画像はコミットされないため、`src` を確認すること)

## 記事投稿

トップバーの「投稿」ボタン (「サイト」ボタンの左) を押すと、
**サイトパネルの左側**に投稿パネルが開きます。
パネル内の「投稿」ボタンを押すと、挿入が完了した後でパネルは自動的に閉じます。

| 項目 | 説明 |
| --- | --- |
| タイトル | `<h2>` として挿入される |
| 本文 | 1 行ずつ `<br>` で区切った `<p>` として挿入される |
| 写真添付 | 複数枚選択可能。1 枚ずつ `public/images/YYYY/MM/DD/` に保存され、`<img><br>` の形で 1 枚ごとに改行して挿入される |
| 画像の長辺最大幅 | 既定 1024px。長辺がこの幅を超える写真はブラウザ側で自動的にリサイズしてから保存する |

「投稿」ボタンを押すと、選択中のサイトの `public/index.html` 内にある
`<main class="container">` の `<section class="hero">` (閉じタグ) の直後に
タイトル・本文・写真を挿入してファイルを保存します。

- `public/index.html` が存在しない場合はエラーになる (先にページを作成すること)
- hero セクションが無い場合は `</main>` の直前、
  `main.container` 自体が無い場合は `</body>` の直前に挿入される
- 編集中のページが `public/index.html` の場合は、投稿後に内容を再読み込みする
  (未保存の変更がある場合は上書き確認のダイアログを表示する)
- 画像のアップロードは 1 枚ずつ進捗トーストとともに行う

## opencode (AI) によるサイト編集

トップバーの「opencode」ボタンを押すと、**プロパティペインの左側**に opencode パネルが開きます。

- opencode は PTY 上の子プロセス (xterm.js + WebSocket) として起動し、
  選択中のサイトの作業ディレクトリをカレントディレクトリにして実行します
  (AI がそのままサイトのファイルを編集できます)
- ファイルツリーの「ここで opencode」からは、選択中のフォルダを
  作業ディレクトリにして起動できます
- パネルの「×」閉じるボタンでパネルを閉じると、**起動中の opencode も終了**します
- opencode が未インストールの場合、自動で `curl -fsSL https://opencode.ai/install | bash`
  を実行してインストールします (進捗はパネルに表示)
- 出力はすべて JSON のテキストフレームで配信するため、xterm.js 側で確実に描画されます
- opencode には AI プロバイダーの認証情報が必要です
  (`~/.local/share/opencode/auth.json` などの opencode 側の設定を使用します)

## メモ

トップバーの「メモ」ボタンを押すと、**画面右端（一番右）** にメモパネルが開きます。

- 入力内容は `/opt/lxd-data/htmledit-memo/memo.md` に保存されます
- 「保存」ボタンまたは `Ctrl+S` で保存します
- 保存先パスを変更する場合は `HTMLEDIT_MEMO_FILE`、保存先ディレクトリを変更する場合は `HTMLEDIT_MEMO_DIR` 環境変数を設定してください
- メモはリポジトリの外にあるため、コミットしても GitHub には公開されません

## エクスプローラ (ファイルツリー)

左ペインの「ファイル」ツリーは selfcode のサイドバーと同じく、フォルダの展開 / 折りたたみと
右クリックメニューに対応しています。

- 「折畳」ボタンで展開中のフォルダをすべて折りたたみます
- ツリーを右クリックすると、selfcode と同じメニューが表示されます

| メニュー | 動作 |
| --- | --- |
| 開く | ファイルを開いて編集する |
| ファイル作成 | 選択中のフォルダに空ファイルを作る |
| フォルダ作成 | 選択中のフォルダにフォルダを作る |
| ここで opencode | 選択中のフォルダを作業ディレクトリに opencode ターミナルを起動する |
| パスをコピー | 絶対パスをクリップボードにコピーする |
| アップロード | ローカルからファイルをアップロードする |
| ダウンロード | ファイルをダウンロードする (フォルダは ZIP) |
| リネーム | 同じフォルダ内で名前を変更する |
| 削除 | ファイル / フォルダを削除する |

- ツリーの余白を右クリックすると、サイトルート直下を対象にしたメニューが表示されます

## 認証情報 (ユーザーID / PAT)

「サイトを追加」ウィンドウには **ユーザーID** と **PAT (Personal Access Token)** の項目があります。

- プライベートリポジトリの clone / pull と、push 時に GitHub へ渡される認証情報です
- PAT は `repo` スコープで発行してください
- 認証情報がセットされたサイトはサイドバーに `PAT` バッジが表示されます
- サイト横の 🔑 ボタンから、PAT の再登録・更新ができます (PAT を空欄にすると既存の値を維持)
- PAT はサーバー側の `data/credentials.json` (権限 0600) に保存され、API の応答には含まれません
- git の credential helper 経由で渡されるため、`.git/config` にも平文で残りません

サイトごとに異なるアカウントを使いたい場合は、サイトごとに PAT を登録してください。
すべてのサイトで共通の PAT を使いたい場合は、環境変数 `GITHUB_TOKEN` (サイト個別の PAT がない場合の既定値) を利用できます。
PAT を使うのは HTTPS リモート (`https://github.com/...`) の場合です。
SSH リモート (`git@github.com:...`) では SSH 鍵が使われます。

## タイトルバーのボタン

画面上部のタイトル表示の右隣に:

| 表示 | 動作 |
| --- | --- |
| `v.1.1.0` | 実行中のバージョン |
| サイト | 左ペイン (サイト一覧 / ファイルツリー) の表示 / 非表示を切り替える |
| opencode | opencode パネルを開き、opencode (AI) を起動する (未インストールなら自動インストール) |
| プロパティ | プロパティペイン (リンク / 画像の設定) の表示 / 非表示を切り替える |
| GitHub | GitHub ペイン (リポジトリ情報と pull / commit / push) の表示 / 非表示を切り替える |
| メモ | メモパネルの表示 / 非表示を切り替える |
| アップデート | `https://github.com/hirogura/htmledit.git` から `git fetch` + `git merge --ff-only` で自身を更新する |
| 再起動 | `systemctl restart htmledit` でサービスを再起動する (systemd がない環境ではプロセスを再実行) |

「サイト」「プロパティ」「GitHub」「メモ」ボタンは、表示中のパネルはアクセント色で示され、
非表示にするとペインが閉じてエディターが広がる。ボタンの高さはすべて同じ (30px) に揃えている。

アップデートの反映には再起動が必要です。アップデート完了後は「再起動」ボタンを押してください。

## Tailscale による HTTPS 公開

`tailscale serve` を使うと、ポートを外部に開かずに tailnet 内へ HTTPS で公開できます。

`install.sh` は既定で `tailscale serve` への登録まで行います
(`tailscaled` が動いていて、待ち受けが `127.0.0.1` の場合)。
設定し直すときは次のスクリプトを実行します。

```bash
sudo ./deploy/tailscale-serve.sh
```

このスクリプトは次のことを行います。

1. `/etc/htmledit/htmledit.env` の `HTMLEDIT_HOST` を `127.0.0.1` にしてサービスを再起動
2. `tailscale serve` で 3372 番ポートのみを HTTPS で公開 (443 には公開しない)
   - `tailscale serve --bg --https=3372 http://127.0.0.1:3372`
   - `tailscale serve --https=443 off` (443 で公開されていた場合)
3. 公開 URL (`https://<tailnet のホスト名>:3372/`) を表示

証明書は Tailscale が自動で Let's Encrypt の証明書を発行します。
`tailscale serve status` で公開先を確認、`tailscale serve --https=443 off` で公開を停止します。

`install.sh` での公開は `HTMLEDIT_TAILSCALE_SERVE` で切り替えられます。

| 値 | 動作 |
| --- | --- |
| `auto` (既定) | `tailscaled` が動いていて待ち受けが `127.0.0.1` のときだけ登録する |
| `1` | 必ず登録する (待ち受けが `0.0.0.0` なら `127.0.0.1` に変更する) |
| `0` | 登録しない (手動で `tailscale-serve.sh` を実行する) |

## Cloudflare 連携

htmledit はローカルで 3372 番ポートで待ち受け、Cloudflare 経由での公開を想定しています。

### 方法 1: Cloudflare Tunnel (推奨)

外部にポートを開けずに公開できます。

```bash
# 1. cloudflared をインストール
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install -y cloudflared

# 2. ダッシュボードで tunnel を作成し、credentials JSON を配置
sudo install -d /etc/cloudflared
sudo cp <TUNNEL_ID>.json /etc/cloudflared/<TUNNEL_ID>.json
sudo cp deploy/cloudflared/config.yml.example /etc/cloudflared/config.yml
sudo vi /etc/cloudflared/config.yml   # tunnel / hostname / credentials-file を書き換える

# 3. サービスとして起動
sudo cp deploy/cloudflared/cloudflared.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cloudflared
```

### 方法 2: Cloudflare の DNS プロキシ + リバースプロキシ

`deploy/Caddyfile.example` / `deploy/nginx.conf.example` を設定し、Cloudflare の
origin certificate を設置します。公開アドレスは `tailscale serve status` や
Cloudflare のダッシュボードで確認してください。

### 公開時の注意

- 公開する場合は `HTMLEDIT_AUTH_USER` / `HTMLEDIT_AUTH_PASSWORD` で basic 認証を設定してください
  ( サイト登録情報や GitHub のトークンを扱うため、認証なしの公開は避けてください )
- `GITHUB_TOKEN` は `/etc/htmledit/htmledit.env` に `chmod 600` で保管されます

## 設定 (環境変数)

`/etc/htmledit/htmledit.env` または起動時の環境変数で指定します。

| 変数 | 既定値 | 説明 |
| --- | --- | --- |
| `HTMLEDIT_HOST` | `127.0.0.1` | 待ち受けアドレス (0.0.0.0 にすると LAN からも到達可能) |
| `HTMLEDIT_PORT` | `3372` | 待ち受けポート |
| `HTMLEDIT_DATA_DIR` | `/opt/lxd-data/htmledit-data` | サイト登録情報・認証情報と clone 先 (ワークスペースの外) |
| `HTMLEDIT_REPO_URL` | `https://github.com/hirogura/htmledit.git` | アップデート時に取得するリポジトリ |
| `GITHUB_TOKEN` | (空) | push / pull / GitHub API 用の Personal Access Token |
| `HTMLEDIT_AUTH_USER` / `HTMLEDIT_AUTH_PASSWORD` | (空) | basic 認証 |
| `HTMLEDIT_COMMIT_USER_NAME` / `HTMLEDIT_COMMIT_USER_EMAIL` | `htmledit` / `htmledit@localhost` | コミットの作者情報 |
| `HTMLEDIT_SERVICE_NAME` | `htmledit` | 再起動時に操作する systemd ユニット名 |
| `HTMLEDIT_MEMO_DIR` | `/opt/lxd-data/htmledit-memo` | メモ (ファイルエクスプローラー) の保存先ディレクトリ |
| `HTMLEDIT_MEMO_FILE` | `$HTMLEDIT_MEMO_DIR/memo.md` | 既定のメモファイル |
| `HTMLEDIT_ALLOW_LOCAL_PATHS` | `1` | ローカルパスのリポジトリ登録を許可するか |

## ディレクトリ構成

```
htmledit/
├── htmledit/            Python パッケージ (バックエンド)
│   ├── __main__.py      起動エントリーポイント
│   ├── server.py        HTTP サーバー / 静的ファイル配信
│   ├── api.py           REST API
│   ├── sites.py         サイト管理・ファイル操作
│   ├── gitcmd.py        git CLI ラッパー (認証対応)
│   ├── credentials.py   サイトごとのユーザーID / PAT の保管
│   ├── github.py        GitHub API
│   ├── selfservice.py   アップデート / 再起動
│   └── config.py        設定
├── static/              フロントエンド (依存ライブラリなし)
│   ├── index.html
│   ├── css/app.css
│   ├── js/{app,editor,terminal}.js
│   └── vendor/xterm/    xterm.js (MIT) — ターミナル表示用
├── deploy/              systemd / Tailscale / Cloudflare 関連の設定
└── tests/               結合テスト
```

実行時データはリポジトリの外に置きます (誤って push されないようにするため)。

```
/opt/lxd-data/
├── htmledit-data/       サイト登録情報・認証情報と clone したリポジトリ
│   ├── sites.json       登録済みサイト (表示名 / サイトURL など)
│   ├── credentials.json サイトごとのユーザーID / PAT (0600)
│   └── repos/           clone したリポジトリ
└── htmledit-memo/       メモの保存先 (memo.md)
```

## API

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/version` | バージョンと自身のリポジトリ状態 |
| GET | `/api/sites` | 登録済みサイト一覧 |
| POST | `/api/sites` | サイトの追加 (GitHub URL / サイトURL) |
| PATCH | `/api/sites/{id}` | サイト名・サイトURL・ユーザーID・PAT の更新 |
| DELETE | `/api/sites/{id}` | サイトの削除 |
| GET | `/api/sites/{id}/tree` | ファイルツリー |
| GET | `/api/sites/{id}/file?path=` | ファイル読み取り |
| GET | `/api/sites/{id}/assets?prefix=&page=` | 保存済み画像の一覧 (保存日の新しい順) |
| POST | `/api/sites/{id}/assets` | 画像などの取り込み (日付付きフォルダへコピー) |
| POST | `/api/sites/{id}/assets/upload` | 画像のアップロード (日付付きフォルダへ保存) |
| PUT | `/api/sites/{id}/file` | ファイル保存 |
| POST | `/api/sites/{id}/file` | ファイル作成 |
| DELETE | `/api/sites/{id}/file` | ファイル / フォルダ削除 |
| POST | `/api/sites/{id}/folder` | フォルダ作成 |
| POST | `/api/sites/{id}/rename` | ファイル / フォルダ名変更 |
| POST | `/api/sites/{id}/upload?dir=&name=` | ファイルアップロード |
| GET | `/api/sites/{id}/download?path=` | ファイル / フォルダ (ZIP) のダウンロード |
| GET | `/api/sites/{id}/git/status` | ブランチ / 変更内容 / ahead-behind |
| GET | `/api/sites/{id}/git/log` | コミット履歴 |
| POST | `/api/sites/{id}/git/pull` | pull |
| POST | `/api/sites/{id}/git/commit` | commit |
| POST | `/api/sites/{id}/git/push` | push |
| GET | `/api/github/repo?owner=&repo=` | GitHub リポジトリ情報 |
| GET | `/site/{id}/{path}` | サイトのリポジトリ内のファイル配信 (エディター内の相対 URL 解決用) |
| GET | `/api/memo` | 既定のメモの読み取り |
| PUT | `/api/memo` | 既定のメモの保存 |
| GET | `/api/opencode/status` | opencode のインストール状況 |
| POST | `/api/opencode/install` | opencode のインストール |
| WS | `/ws/terminal` | ターミナル (PTY) の WebSocket |
| POST | `/api/self/update` | htmledit 自身のアップデート |
| POST | `/api/self/restart` | htmledit サービスの再起動 |

## 開発

```bash
# テスト (外部サービス不要)
python3 -m unittest discover -s tests -v

# 開発用の起動
python3 -m htmledit --port 3372
```

## ライセンス

MIT
