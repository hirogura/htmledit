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
python3 -m htmledit                    # http://0.0.0.0:3372 で待ち受け
python3 -m htmledit --port 8080        # ポート変更
```

## ポート

既定で **3372** 番ポートで待ち受けます (`HTMLEDIT_PORT` で変更可能)。

```
http://<サーバー IP>:3372/
```

## 使い方

1. 左ペインの「+ 追加」を押し、GitHub のリポジトリ URL (`https://github.com/owner/repo`) を入力する
   - `https://github.com/owner/repo/tree/branch` のようなブランチ指定 URL にも対応
   - `git@github.com:owner/repo.git` のような SSH URL にも対応
2. 追加すると、左ペインにはこのリポジトリのルートを基準としたフォルダ一覧が表示される
3. ファイル (.html / .htm) をクリックすると中央ペインで WYSIWYG 編集ができる
   - 「ソース」タブでファイル全体 (head を含む) を直接編集することも可能
   - 「プレビュー」ボタンで実際のページ表示を確認できる
   - `Ctrl+S` で保存
4. 右ペインでコミットメッセージを入力して「コミット」→「プッシュ」
   - 「プル」でリモートの変更を取得してから編集する運用も可能

## タイトルバーのバージョン表示 / アップデート / 再起動

画面上部のタイトル表示の右隣に:

| 表示 | 動作 |
| --- | --- |
| `v.0.1.0` | 実行中のバージョン |
| アップデート | `https://github.com/hirogura/htmledit.git` から `git fetch` + `git merge --ff-only` で自身を更新する |
| 再起動 | `systemctl restart htmledit` でサービスを再起動する (systemd がない環境ではプロセスを再実行) |

アップデートの反映には再起動が必要です。アップデート完了後は「再起動」ボタンを押してください。

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
| `HTMLEDIT_HOST` | `0.0.0.0` | 待ち受けアドレス |
| `HTMLEDIT_PORT` | `3372` | 待ち受けポート |
| `HTMLEDIT_DATA_DIR` | `/opt/htmledit/data` | サイト登録情報と clone 先 |
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
│   ├── gitcmd.py        git CLI ラッパー
│   ├── github.py        GitHub API
│   ├── selfservice.py   アップデート / 再起動
│   └── config.py        設定
├── static/              フロントエンド (依存ライブラリなし)
│   ├── index.html
│   ├── css/app.css
│   └── js/{app,editor}.js
├── deploy/              systemd / Cloudflare 関連の設定
├── tests/               結合テスト
└── data/                実行時データ (gitignore 対象)
    ├── sites.json       登録済みサイト
    └── repos/           clone したリポジトリ
```

## API

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/version` | バージョンと自身のリポジトリ状態 |
| GET | `/api/sites` | 登録済みサイト一覧 |
| POST | `/api/sites` | サイトの追加 (GitHub URL) |
| PATCH | `/api/sites/{id}` | サイト名の変更 |
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
