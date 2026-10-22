#!/usr/bin/env bash
# htmledit を tailscale serve 経由で HTTPS 公開する。
#
#   sudo ./deploy/tailscale-serve.sh
#
# - htmledit は 127.0.0.1:3372 でのみ待ち受ける
# - tailscale serve が tailnet 内に HTTPS (443) で公開する
# - 公開 URL は HTMLEDIT_PUBLIC_URL に設定される
set -euo pipefail

ENV_FILE="${HTMLEDIT_ENV_FILE:-/etc/htmledit/htmledit.env}"
PORT="${HTMLEDIT_PORT:-3372}"
HOST="${HTMLEDIT_HOST:-127.0.0.1}"
SERVICE="${HTMLEDIT_SERVICE_NAME:-htmledit}"

if ! command -v tailscale >/dev/null 2>&1; then
  echo "tailscale (tailscaled) が見つかりません。" >&2
  echo "https://tailscale.com/kb/1031/install-linux を参照してインストールしてください。" >&2
  exit 1
fi

if ! systemctl is-active --quiet tailscaled; then
  echo "==> tailscaled を起動します"
  systemctl enable --now tailscaled
  sleep 2
fi

# 1) 待ち受けを 127.0.0.1 に絞る
if [ -f "${ENV_FILE}" ]; then
  if grep -q "^HTMLEDIT_HOST=" "${ENV_FILE}"; then
    sed -i "s|^HTMLEDIT_HOST=.*|HTMLEDIT_HOST=${HOST}|" "${ENV_FILE}"
  else
    printf 'HTMLEDIT_HOST=%s\n' "${HOST}" >> "${ENV_FILE}"
  fi
  echo "==> ${ENV_FILE} の HTMLEDIT_HOST を ${HOST} に設定しました"
fi

systemctl restart "${SERVICE}.service"
sleep 1

# 2) tailnet 内に 3372 番ポートで HTTPS 公開する (443 には公開しない)
echo "==> tailscale serve を設定します (http://${HOST}:${PORT})"
tailscale serve --bg --https="${PORT}" "http://${HOST}:${PORT}"
# 443 で公開されていた場合は閉じる
tailscale serve --https=443 off >/dev/null 2>&1 || true

# 3) 公開 URL を環境変数に設定する (トップバーの「公開URL」リンク用)
PUBLIC_URL="$(tailscale status --json 2>/dev/null | python3 -c 'import json,sys; print((json.load(sys.stdin).get("Self") or {}).get("DNSName","").rstrip("."))' 2>/dev/null || true)"
if [ -n "${PUBLIC_URL}" ]; then
  URL="https://${PUBLIC_URL}:${PORT}/"
  if [ -f "${ENV_FILE}" ]; then
    if grep -q "^HTMLEDIT_PUBLIC_URL=" "${ENV_FILE}"; then
      sed -i "s|^HTMLEDIT_PUBLIC_URL=.*|HTMLEDIT_PUBLIC_URL=${URL}|" "${ENV_FILE}"
    else
      printf 'HTMLEDIT_PUBLIC_URL=%s\n' "${URL}" >> "${ENV_FILE}"
    fi
    systemctl restart "${SERVICE}.service"
    echo "==> HTMLEDIT_PUBLIC_URL を ${URL} に設定しました"
  fi
  echo ""
  echo "公開 URL: ${URL}"
else
  echo ""
  echo "公開 URL: tailscale serve status で確認してください"
fi

echo ""
tailscale serve status
