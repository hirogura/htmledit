# htmledit

GitHub 上の静的サイト (HTML) をブラウザ上で WYSIWYG 編集し、そのままコミット・プッシュするためのセルフホスト型 Web エディターです。

- 左ペイン: 追加したサイトの一覧と、ファイルツリー
- 中央ペイン: WYSIWYG 編集 (CLASS / ID / head 内の CSS はそのまま保持)
- 右ペイン: GitHub リポジトリ情報と pull / commit / push

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
sudo ./deploy/install.sh
```

`install.sh` は次のことを行います。

1. `/etc/systemd/system/htmledit.service` を作成
2. `/etc/htmledit/htmledit.env` を作成 (`GITHUB_TOKEN` や basic 認証はここで設定)
3. `systemctl enable --now htmledit` で起動

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
2. 追加すると、左ペインにはこのリポジトリのルートを基準としたフォルダ一覧が表示される
3. ファイル (.html / .htm) をクリックすると中央ペインで WYSIWYG 編集ができる
   - 「ソース」タブでファイル全体 (head を含む) を直接編集することも可能
   - 「プレビュー」ボタンで実際のページ表示を確認できる
   - `Ctrl+S` で保存
4. 右ペインでコミットメッセージを入力して「コミット」→「プッシュ」
   - 「プル」でリモートの変更を取得してから編集する運用も可能

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

## タイトルバーのバージョン表示 / アップデート / 再起動

画面上部のタイトル表示の右隣に:

| 表示 | 動作 |
| --- | --- |
| `v.0.2.0` | 実行中のバージョン |
| アップデート | `https://github.com/hirogura/htmledit.git` から `git fetch` + `git merge --ff-only` で自身を更新する |
| 再起動 | `systemctl restart htmledit` でサービスを再起動する (systemd がない環境ではプロセスを再実行) |

アップデートの反映には再起動が必要です。アップデート完了後は「再起動」ボタンを押してください。

## Tailscale による HTTPS 公開

`tailscale serve` を使うと、ポートを外部に開かずに tailnet 内へ HTTPS で公開できます。

```bash
sudo ./deploy/tailscale-serve.sh
```

このスクリプトは次のことを行います。

1. `/etc/htmledit/htmledit.env` の `HTMLEDIT_HOST` を `127.0.0.1` にしてサービスを再起動
2. `tailscale serve` で 3372 番ポートのみを HTTPS で公開 (443 には公開しない)
   - `tailscale serve --bg --https=3372 http://127.0.0.1:3372`
   - `tailscale serve --https=443 off` (443 で公開されていた場合)
3. 公開 URL (`https://<tailnet のホスト名>:3372/`) を `HTMLEDIT_PUBLIC_URL` に設定
   (トップバーの「公開URL」リンクに表示)

証明書は Tailscale が自動で Let's Encrypt の証明書を発行します。
`tailscale serve status` で公開先を確認、`tailscale serve --https=443 off` で公開を停止します。

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

`deploy/Caddyfile.example` / `deploy/nginx.conf.example` をconfigureし、Cloudflare の
origin certificate を設置します。どちらの構成でも、タイトルバーの「公開URL」リンクに
公開アドレスを表示させる場合は `HTMLEDIT_PUBLIC_URL` を設定してください。

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
| `HTMLEDIT_DATA_DIR` | `/opt/htmledit/data` | サイト登録情報・認証情報と clone 先 |
| `HTMLEDIT_REPO_URL` | `https://github.com/hirogura/htmledit.git` | アップデート時に取得するリポジトリ |
| `GITHUB_TOKEN` | (空) | push / pull / GitHub API 用の Personal Access Token |
| `HTMLEDIT_PUBLIC_URL` | (空) | トップバーに表示する公開 URL |
| `HTMLEDIT_AUTH_USER` / `HTMLEDIT_AUTH_PASSWORD` | (空) | basic 認証 |
| `HTMLEDIT_COMMIT_USER_NAME` / `HTMLEDIT_COMMIT_USER_EMAIL` | `htmledit` / `htmledit@localhost` | コミットの作者情報 |
| `HTMLEDIT_SERVICE_NAME` | `htmledit` | 再起動時に操作する systemd ユニット名 |
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
│   └── js/{app,editor}.js
├── deploy/              systemd / Tailscale / Cloudflare 関連の設定
├── tests/               結合テスト
└── data/                実行時データ (gitignore 対象)
    ├── sites.json       登録済みサイト
    ├── credentials.json サイトごとのユーザーID / PAT (0600)
    └── repos/           clone したリポジトリ
```

## API

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/version` | バージョンと自身のリポジトリ状態 |
| GET | `/api/sites` | 登録済みサイト一覧 |
| POST | `/api/sites` | サイトの追加 (GitHub URL) |
| PATCH | `/api/sites/{id}` | サイト名・ユーザーID・PAT の更新 |
| DELETE | `/api/sites/{id}` | サイトの削除 |
| GET | `/api/sites/{id}/tree` | ファイルツリー |
| GET | `/api/sites/{id}/file?path=` | ファイル読み取り |
| PUT | `/api/sites/{id}/file` | ファイル保存 |
| GET | `/api/sites/{id}/git/status` | ブランチ / 変更内容 / ahead-behind |
| GET | `/api/sites/{id}/git/log` | コミット履歴 |
| POST | `/api/sites/{id}/git/pull` | pull |
| POST | `/api/sites/{id}/git/commit` | commit |
| POST | `/api/sites/{id}/git/push` | push |
| GET | `/api/github/repo?owner=&repo=` | GitHub リポジトリ情報 |
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
