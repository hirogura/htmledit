#!/usr/bin/env bash
# htmledit を systemd サービスとしてインストールする。
#
#   sudo ./deploy/install.sh
#
# 環境変数で上書きできる:
#   HTMLEDIT_INSTALL_DIR  インストール先 (既定: /opt/htmledit)
#   HTMLEDIT_PORT         待ち受けポート (既定: 3372)
#   HTMLEDIT_HOST         待ち受けアドレス (既定: 127.0.0.1)
#   HTMLEDIT_RUN_USER     サービスの実行ユーザー (既定: root)
set -euo pipefail

INSTALL_DIR="${HTMLEDIT_INSTALL_DIR:-/opt/htmledit}"
PORT="${HTMLEDIT_PORT:-3372}"
HOST="${HTMLEDIT_HOST:-127.0.0.1}"
RUN_USER="${HTMLEDIT_RUN_USER:-root}"
MEMO_DIR="${HTMLEDIT_MEMO_DIR:-/opt/lxd-data/htmledit-memo}"
DATA_DIR="${HTMLEDIT_DATA_DIR:-/opt/lxd-data/htmledit-data}"
ENV_DIR="/etc/htmledit"
ENV_FILE="${ENV_DIR}/htmledit.env"
UNIT_FILE="/etc/systemd/system/htmledit.service"

fail() {
  echo "!! $*" >&2
  exit 1
}

PYTHON_BIN="$(command -v python3 || true)"

# --- 事前チェック -----------------------------------------------------------
if [ ! -f "${INSTALL_DIR}/htmledit/__main__.py" ]; then
  fail "htmledit のソースが見つかりません: ${INSTALL_DIR}"
fi

if [ -z "${PYTHON_BIN}" ]; then
  fail "python3 が見つかりません。Python 3.11 以上を導入してください。"
fi

if ! "${PYTHON_BIN}" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)'; then
  fail "Python 3.11 以上が必要です: $("${PYTHON_BIN}" -V 2>&1)"
fi

# モジュールが読み込めないまま起動しても原因が分からないため、起動前に確認する
echo "==> モジュールの読み込みを確認"
if ! (cd "${INSTALL_DIR}" && PYTHONPATH="${INSTALL_DIR}" "${PYTHON_BIN}" -c 'import htmledit.server'); then
  fail "htmledit のモジュールを読み込めませんでした (上のエラーを確認してください)。"
fi

# --- systemd ユニットの作成 --------------------------------------------------
# ReadWritePaths に存在しないパスを書くと systemd が名前空間設定に失敗するため、
# 存在するものだけを含める。
rw_paths=("${DATA_DIR}" "${MEMO_DIR}")
for extra in "${INSTALL_DIR}/.git" "${INSTALL_DIR}/static"; do
  if [ -e "${extra}" ]; then
    rw_paths+=("${extra}")
  fi
done

echo "==> systemd ユニット(${UNIT_FILE})を作成"
mkdir -p "${ENV_DIR}"
sed \
  -e "s|^User=.*|User=${RUN_USER}|" \
  -e "s|^Group=.*|Group=${RUN_USER}|" \
  -e "s|^WorkingDirectory=.*|WorkingDirectory=${INSTALL_DIR}|" \
  -e "s|^Environment=PYTHONPATH=.*|Environment=PYTHONPATH=${INSTALL_DIR}|" \
  -e "s|^ExecStart=.*|ExecStart=${PYTHON_BIN} -m htmledit|" \
  -e "s|^ReadWritePaths=.*|ReadWritePaths=${rw_paths[*]} |" \
  "${INSTALL_DIR}/deploy/htmledit.service" > "${UNIT_FILE}"

# --- 環境設定ファイル --------------------------------------------------------
if [ ! -f "${ENV_FILE}" ]; then
  echo "==> 環境設定ファイル(${ENV_FILE})を作成"
  sed -e "s|^HTMLEDIT_HOST=.*|HTMLEDIT_HOST=${HOST}|" \
      -e "s|^HTMLEDIT_PORT=.*|HTMLEDIT_PORT=${PORT}|" \
      -e "s|^HTMLEDIT_DATA_DIR=.*|HTMLEDIT_DATA_DIR=${DATA_DIR}|" \
      -e "s|^HTMLEDIT_MEMO_DIR=.*|HTMLEDIT_MEMO_DIR=${MEMO_DIR}|" \
      "${INSTALL_DIR}/deploy/htmledit.env.example" > "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
  echo "    GITHUB_TOKEN / HTMLEDIT_AUTH_* 必要に応じて編集してください"
else
  echo "==> 環境設定ファイル(${ENV_FILE})は既に存在するため変更しません"
fi

mkdir -p "${DATA_DIR}"
mkdir -p "${MEMO_DIR}"
chown -R "${RUN_USER}:${RUN_USER}" "${DATA_DIR}"
chown -R "${RUN_USER}:${RUN_USER}" "${MEMO_DIR}"

# --- 起動 -------------------------------------------------------------------
echo "==> systemd を再読み込みして起動"
systemctl daemon-reload
systemctl enable htmledit.service
systemctl restart htmledit.service

for _ in $(seq 1 20); do
  if systemctl is-active --quiet htmledit.service; then
    break
  fi
  sleep 0.5
done

if ! systemctl is-active --quiet htmledit.service; then
  echo "!! サービスが起動しませんでした。journal のログを確認してください。" >&2
  journalctl -u htmledit.service --no-pager --lines=30 >&2 || true
  exit 1
fi

systemctl --no-pager --lines=5 status htmledit.service || true

echo ""
if [ "${HOST}" = "127.0.0.1" ] || [ "${HOST}" = "localhost" ]; then
  echo "==> 完了: http://127.0.0.1:${PORT}/ でアクセスできます (このコンテナからのみ)。"
  echo "    LAN などから直接アクセスする場合は HTMLEDIT_HOST=0.0.0.0 で再実行するか、"
  echo "    ${ENV_FILE} の HTMLEDIT_HOST を 0.0.0.0 に変更して再起動してください。"
else
  echo "==> 完了: http://<このサーバーの IP>:${PORT}/ でアクセスできます。"
fi
