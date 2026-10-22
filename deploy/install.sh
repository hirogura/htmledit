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
#   HTMLEDIT_SERVICE_NAME systemd ユニット名 (既定: htmledit)
#   HTMLEDIT_DATA_DIR     データ保存先 (既定: /opt/lxd-data/htmledit-data)
#   HTMLEDIT_MEMO_DIR     メモ保存先 (既定: /opt/lxd-data/htmledit-memo)
#   HTMLEDIT_ENV_DIR      環境設定ファイルの配置先 (既定: /etc/htmledit)
#   HTMLEDIT_TAILSCALE_SERVE
#                         tailscale serve の登録 (既定: auto)
#                         1 で有効化 / 0 で無効化 / auto は tailscaled が
#                         動いていて待ち受けが 127.0.0.1 のときだけ有効
set -euo pipefail

INSTALL_DIR="${HTMLEDIT_INSTALL_DIR:-/opt/htmledit}"
PORT="${HTMLEDIT_PORT:-3372}"
HOST="${HTMLEDIT_HOST:-127.0.0.1}"
RUN_USER="${HTMLEDIT_RUN_USER:-root}"
SERVICE_NAME="${HTMLEDIT_SERVICE_NAME:-htmledit}"
MEMO_DIR="${HTMLEDIT_MEMO_DIR:-/opt/lxd-data/htmledit-memo}"
DATA_DIR="${HTMLEDIT_DATA_DIR:-/opt/lxd-data/htmledit-data}"
ENV_DIR="${HTMLEDIT_ENV_DIR:-/etc/htmledit}"
ENV_FILE="${ENV_DIR}/htmledit.env"
UNIT_FILE="${HTMLEDIT_UNIT_FILE:-/etc/systemd/system/${SERVICE_NAME}.service}"
SERVE_MODE="${HTMLEDIT_TAILSCALE_SERVE:-auto}"

fail() {
  echo "!! $*" >&2
  exit 1
}

PYTHON_BIN="$(command -v python3 || true)"

# --- 事前チェック -----------------------------------------------------------
if [ "$(id -u)" -ne 0 ]; then
  fail "root で実行してください (sudo ./deploy/install.sh)。"
fi

if [ ! -f "${INSTALL_DIR}/htmledit/__main__.py" ]; then
  fail "htmledit のソースが見つかりません: ${INSTALL_DIR}"
fi

if [ -z "${PYTHON_BIN}" ]; then
  fail "python3 が見つかりません。Python 3.11 以上を導入してください。"
fi

if ! "${PYTHON_BIN}" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)'; then
  fail "Python 3.11 以上が必要です: $("${PYTHON_BIN}" -V 2>&1)"
fi

if ! command -v git >/dev/null 2>&1; then
  fail "git が見つかりません。clone / push に必要なので導入してください。"
fi

if ! command -v systemctl >/dev/null 2>&1; then
  fail "systemctl が見つかりません。systemd 環境 (PID 1 が systemd) で実行してください。"
fi

if [ ! -d /run/systemd/system ]; then
  fail "systemd が起動していません。コンテナの場合は systemd を PID 1 にして起動してください。"
fi

if ! id -u "${RUN_USER}" >/dev/null 2>&1; then
  fail "実行ユーザーが存在しません: ${RUN_USER}"
fi

# 主グループの名前がユーザー名と異なるユーザー (nobody/nogroup など) があるため
# id で解決する
RUN_GROUP="$(id -gn "${RUN_USER}")"

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

# PrivateTmp=true では /tmp が専用マウントに置き換えられるため、
# 保存先に /tmp を指定している場合は無効にする
private_tmp="true"
for dir in "${DATA_DIR}" "${MEMO_DIR}" "${INSTALL_DIR}"; do
  case "${dir}" in
    /tmp|/tmp/*)
      private_tmp="false"
      echo "    注意: ${dir} が /tmp 配下のため PrivateTmp を無効にします"
      ;;
  esac
done

echo "==> systemd ユニット(${UNIT_FILE})を作成"
mkdir -p "${ENV_DIR}"
sed \
  -e "s|^User=.*|User=${RUN_USER}|" \
  -e "s|^Group=.*|Group=${RUN_GROUP}|" \
  -e "s|^WorkingDirectory=.*|WorkingDirectory=${INSTALL_DIR}|" \
  -e "s|^EnvironmentFile=.*|EnvironmentFile=-${ENV_FILE}|" \
  -e "s|^Environment=PYTHONPATH=.*|Environment=PYTHONPATH=${INSTALL_DIR}|" \
  -e "s|^ExecStart=.*|ExecStart=${PYTHON_BIN} -m htmledit|" \
  -e "s|^PrivateTmp=.*|PrivateTmp=${private_tmp}|" \
  -e "s|^ReadWritePaths=.*|ReadWritePaths=${rw_paths[*]} |" \
  "${INSTALL_DIR}/deploy/htmledit.service" > "${UNIT_FILE}"

# --- 環境設定ファイル --------------------------------------------------------
if [ ! -f "${ENV_FILE}" ]; then
  echo "==> 環境設定ファイル(${ENV_FILE})を作成"
  sed -e "s|^HTMLEDIT_HOST=.*|HTMLEDIT_HOST=${HOST}|" \
      -e "s|^HTMLEDIT_PORT=.*|HTMLEDIT_PORT=${PORT}|" \
      -e "s|^HTMLEDIT_DATA_DIR=.*|HTMLEDIT_DATA_DIR=${DATA_DIR}|" \
      -e "s|^HTMLEDIT_MEMO_DIR=.*|HTMLEDIT_MEMO_DIR=${MEMO_DIR}|" \
      -e "s|^HTMLEDIT_SERVICE_NAME=.*|HTMLEDIT_SERVICE_NAME=${SERVICE_NAME}|" \
      "${INSTALL_DIR}/deploy/htmledit.env.example" > "${ENV_FILE}"
  chmod 600 "${ENV_FILE}"
  echo "    GITHUB_TOKEN / HTMLEDIT_AUTH_* 必要に応じて編集してください"
else
  echo "==> 環境設定ファイル(${ENV_FILE})は既に存在するため変更しません"
  # 引数と既存設定が食い違うと、期待しない場所へ書き込むことになるため警告する
  for key in HTMLEDIT_HOST HTMLEDIT_PORT HTMLEDIT_DATA_DIR HTMLEDIT_MEMO_DIR HTMLEDIT_SERVICE_NAME; do
    current="$(sed -n "s|^${key}=||p" "${ENV_FILE}" | tail -n 1)"
    case "${key}" in
      HTMLEDIT_HOST) expected="${HOST}" ;;
      HTMLEDIT_PORT) expected="${PORT}" ;;
      HTMLEDIT_DATA_DIR) expected="${DATA_DIR}" ;;
      HTMLEDIT_MEMO_DIR) expected="${MEMO_DIR}" ;;
      HTMLEDIT_SERVICE_NAME) expected="${SERVICE_NAME}" ;;
    esac
    if [ -n "${current}" ] && [ "${current}" != "${expected}" ]; then
      echo "    !! ${ENV_FILE} の ${key} は '${current}' です (指定値 '${expected}' とは異なります)"
    fi
  done
fi

mkdir -p "${DATA_DIR}"
mkdir -p "${MEMO_DIR}"
chown -R "${RUN_USER}:${RUN_GROUP}" "${DATA_DIR}"
chown -R "${RUN_USER}:${RUN_GROUP}" "${MEMO_DIR}"

# --- 起動 -------------------------------------------------------------------
start_service() {
  systemctl daemon-reload
  systemctl enable "${SERVICE_NAME}.service"
  systemctl restart "${SERVICE_NAME}.service"

  # 起動直後にプロセス Died して再起動を繰り返す場合があるため、
  # 自動再起動の回数が増えるかを見て判断する
  local restarts_before restarts_after state
  restarts_before="$(systemctl show -p NRestarts --value "${SERVICE_NAME}.service" 2>/dev/null || echo 0)"

  for _ in $(seq 1 20); do
    if [ "$(systemctl show -p ActiveState --value "${SERVICE_NAME}.service" 2>/dev/null)" = "active" ]; then
      break
    fi
    sleep 0.5
  done

  sleep 3

  state="$(systemctl show -p ActiveState --value "${SERVICE_NAME}.service" 2>/dev/null)"
  restarts_after="$(systemctl show -p NRestarts --value "${SERVICE_NAME}.service" 2>/dev/null || echo 0)"

  if [ "${state}" != "active" ] || [ "${restarts_after}" != "${restarts_before}" ]; then
    journalctl -u "${SERVICE_NAME}.service" --no-pager --lines=30 >&2 || true
    fail "サービスが起動しませんでした (ActiveState=${state})。"
  fi
}

echo "==> systemd を再読み込みして起動"
start_service

# --- tailscale serve --------------------------------------------------------
# 実際に適用される設定 (環境設定ファイルの値を優先する)
EFFECTIVE_HOST="$(sed -n 's|^HTMLEDIT_HOST=||p' "${ENV_FILE}" | tail -n 1)"
EFFECTIVE_PORT="$(sed -n 's|^HTMLEDIT_PORT=||p' "${ENV_FILE}" | tail -n 1)"
EFFECTIVE_HOST="${EFFECTIVE_HOST:-${HOST}}"
EFFECTIVE_PORT="${EFFECTIVE_PORT:-${PORT}}"

serve_enabled="no"
case "${SERVE_MODE}" in
  1|yes|true)
    serve_enabled="yes"
    ;;
  0|no|false)
    serve_enabled="no"
    ;;
  *)
    serve_enabled="auto"
    ;;
esac

if [ "${serve_enabled}" = "auto" ]; then
  if ! command -v tailscale >/dev/null 2>&1; then
    serve_enabled="no"
  elif ! systemctl is-active --quiet tailscaled; then
    serve_enabled="no"
  elif [ "${EFFECTIVE_HOST}" != "127.0.0.1" ] && [ "${EFFECTIVE_HOST}" != "localhost" ]; then
    serve_enabled="no"
    echo "==> tailscale serve はスキップします (待ち受けが ${EFFECTIVE_HOST} のため直接アクセス用)"
  else
    serve_enabled="yes"
  fi
fi

public_url=""
if [ "${serve_enabled}" = "yes" ]; then
  # serve は 127.0.0.1 宛てにプロキシするため、待ち受けを絞る必要がある
  if [ "${EFFECTIVE_HOST}" != "127.0.0.1" ]; then
    echo "==> tailscale serve のため ${ENV_FILE} の HTMLEDIT_HOST を 127.0.0.1 に変更します"
    sed -i "s|^HTMLEDIT_HOST=.*|HTMLEDIT_HOST=127.0.0.1|" "${ENV_FILE}"
    EFFECTIVE_HOST="127.0.0.1"
    start_service
  fi

  echo "==> tailscale serve を設定します (http://127.0.0.1:${EFFECTIVE_PORT})"
  if ! tailscale serve --bg --https="${EFFECTIVE_PORT}" "http://127.0.0.1:${EFFECTIVE_PORT}"; then
    fail "tailscale serve の設定に失敗しました。tailnet の ACL で serve が有効か確認してください。"
  fi

  public_url="$(tailscale status --json 2>/dev/null | "${PYTHON_BIN}" -c 'import json,sys; print((json.load(sys.stdin).get("Self") or {}).get("DNSName","").rstrip("."))' 2>/dev/null || true)"
fi

systemctl --no-pager --lines=5 status "${SERVICE_NAME}.service" || true

echo ""
echo "==> 設定の確認"
echo "    インストール先: ${INSTALL_DIR}"
echo "    データ保存先:   ${DATA_DIR}"
echo "    メモ保存先:     ${MEMO_DIR}"
echo "    環境設定ファイル: ${ENV_FILE}"
echo "    ユニット名:     ${SERVICE_NAME}.service"
echo "    待ち受け:       ${EFFECTIVE_HOST}:${EFFECTIVE_PORT}"
echo ""
if [ -n "${public_url}" ]; then
  echo "==> 完了: https://${public_url}:${EFFECTIVE_PORT}/ でアクセスできます (tailnet のみ)。"
  echo "    serve の設定: tailscale serve status"
else
  echo "==> 完了: http://${EFFECTIVE_HOST}:${EFFECTIVE_PORT}/ でアクセスできます。"
  if [ "${EFFECTIVE_HOST}" = "127.0.0.1" ] || [ "${EFFECTIVE_HOST}" = "localhost" ]; then
    echo "    このホストからのみアクセスできます。外部から使う場合は tailscale serve を設定してください。"
    echo "    (sudo ${INSTALL_DIR}/deploy/tailscale-serve.sh)"
  fi
fi
