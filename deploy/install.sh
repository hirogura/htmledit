#!/usr/bin/env bash
# htmledit を systemd サービスとしてインストールする。
#
#   sudo ./deploy/install.sh
#
# 環境変数で上書きできる:
#   HTMLEDIT_INSTALL_DIR  インストール先 (既定: /opt/htmledit)
#   HTMLEDIT_PORT         待ち受けポート (既定: 3372)
#   HTMLEDIT_RUN_USER     服务的実行ユーザー (既定: root)
set -euo pipefail

INSTALL_DIR="${HTMLEDIT_INSTALL_DIR:-/opt/htmledit}"
PORT="${HTMLEDIT_PORT:-3372}"
RUN_USER="${HTMLEDIT_RUN_USER:-root}"
MEMO_DIR="${HTMLEDIT_MEMO_DIR:-/opt/lxd-data/htmledit-memo}"
DATA_DIR="${HTMLEDIT_DATA_DIR:-/opt/lxd-data/htmledit-data}"
ENV_DIR="/etc/htmledit"
ENV_FILE="${ENV_DIR}/htmledit.env"
UNIT_FILE="/etc/systemd/system/htmledit.service"

if [ ! -f "${INSTALL_DIR}/htmledit/__main__.py" ]; then
  echo "htmledit のソースが見つかりません: ${INSTALL_DIR}" >&2
  exit 1
fi

echo "==> systemd ユニット(${UNIT_FILE})を作成"
mkdir -p "${ENV_DIR}"
sed \
  -e "s|^User=.*|User=${RUN_USER}|" \
  -e "s|^Group=.*|Group=${RUN_USER}|" \
  -e "s|^WorkingDirectory=.*|WorkingDirectory=${INSTALL_DIR}|" \
  -e "s|^Environment=PYTHONPATH=.*|Environment=PYTHONPATH=${INSTALL_DIR}|" \
  -e "s|^ExecStart=.*|ExecStart=$(command -v python3) -m htmledit|" \
  -e "s|ReadWritePaths=.*|ReadWritePaths=${DATA_DIR} ${MEMO_DIR} ${INSTALL_DIR}/.git ${INSTALL_DIR}/static|" \
  "${INSTALL_DIR}/deploy/htmledit.service" > "${UNIT_FILE}"

if [ ! -f "${ENV_FILE}" ]; then
  echo "==> 環境設定ファイル(${ENV_FILE})を作成"
  sed -e "s|^HTMLEDIT_PORT=.*|HTMLEDIT_PORT=${PORT}|" \
      -e "s|^HTMLEDIT_DATA_DIR=.*|HTMLEDIT_DATA_DIR=${DATA_DIR}|" \
      -e "s|^HTMLEDIT_MEMO_DIR=.*|HTMLEDIT_MEMO_DIR=${MEMO_DIR}|" \
      "${INSTALL_DIR}/deploy/htmledit.env.example" > "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
  echo "    GITHUB_TOKEN / HTMLEDIT_AUTH_* 必要に応じて編集してください"
fi

mkdir -p "${DATA_DIR}"
mkdir -p "${MEMO_DIR}"
chown -R "${RUN_USER}:${RUN_USER}" "${DATA_DIR}"
chown -R "${RUN_USER}:${RUN_USER}" "${MEMO_DIR}"

echo "==> systemd を再読み込みして起動"
systemctl daemon-reload
systemctl enable htmledit.service
systemctl restart htmledit.service
sleep 1
systemctl --no-pager --lines=5 status htmledit.service || true

echo ""
echo "==> 完了: http://<このサーバーの IP>:${PORT}/ でアクセスできます。"
