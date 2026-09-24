#!/usr/bin/env bash
# BuzzAssist の1行導入（macOS / Linux）
#
#   curl -fsSL https://raw.githubusercontent.com/sam-mountainman/BuzzAssist/main/install.sh | bash
#
# やること（何度実行しても同じ結果になる。管理者権限は使わない）:
#   1. Node.js 22 以上が無ければ、nodejs.org の公式配布物を SHASUMS256.txt で照合して
#      ~/.buzzassist/tools/node/ に展開する（システムの Node には触らない）
#   2. 最新の stable Release の tgz を .sha256 で照合して ~/.buzzassist/app/ に展開する
#   3. 入っているホスト（Claude Code / Codex）を見つけて、見つけた全部へ
#      node scripts/setup-agents.mjs --agents <ホスト> を実行する
#
# 環境変数（引数でも指定できる）:
#   BUZZASSIST_PROJECT_DIR  作業フォルダ（既定 ~/BuzzAssist）。--project-dir DIR
#   BUZZASSIST_VERSION      入れる版（既定は最新の stable Release）。--version X.Y.Z
# それ以外の引数（--no-launch、--tunnel、--no-install-prerequisites など）は setup-agents にそのまま渡す。
#
# このファイルは全体を関数の中に置き、最後の1行で呼ぶ。`curl | bash` のとき、途中で起動した
# プログラムが標準入力から残りのスクリプトを読んでしまうのを防ぐため。

set -euo pipefail

BUZZASSIST_REPO="${BUZZASSIST_REPO:-sam-mountainman/BuzzAssist}"
NODE_MIN_MAJOR=22

say() { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
fail() {
  printf '\n[BuzzAssist の導入を止めました] %s\n' "$1" >&2
  shift || true
  for line in "$@"; do printf '  %s\n' "$line" >&2; done
  exit 1
}

have() { command -v "$1" >/dev/null 2>&1; }

fetch() {
  # fetch URL [出力先]。出力先が無ければ標準出力へ。
  local url="$1" out="${2:-}"
  if have curl; then
    if [ -n "$out" ]; then curl -fsSL --retry 3 --connect-timeout 20 -o "$out" "$url"; else curl -fsSL --retry 3 --connect-timeout 20 "$url"; fi
  elif have wget; then
    if [ -n "$out" ]; then wget -q -O "$out" "$url"; else wget -q -O - "$url"; fi
  else
    fail "curl も wget も見つかりません。" "どちらかを入れてから、同じ1行をもう一度実行してください。"
  fi
}

sha256_of() {
  if have sha256sum; then sha256sum "$1" | awk '{print $1}'
  elif have shasum; then shasum -a 256 "$1" | awk '{print $1}'
  else fail "SHA-256 を計算する道具（sha256sum / shasum）が見つかりません。"
  fi
}

detect_platform() {
  case "$(uname -s)" in
    Darwin) OS=darwin ;;
    Linux) OS=linux ;;
    *) fail "この OS（$(uname -s)）には対応していません。" "Windows では install.ps1 を使ってください。" ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) ARCH=x64 ;;
    arm64|aarch64) ARCH=arm64 ;;
    *) fail "この CPU（$(uname -m)）向けの Node.js を自動で入れられません。" "Node.js 22 以上を自分で入れてから、同じ1行をもう一度実行してください。" ;;
  esac
}

node_major() {
  "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0
}

ensure_node() {
  step "Node.js ${NODE_MIN_MAJOR} 以上を確認"
  if have node && [ "$(node_major node)" -ge "$NODE_MIN_MAJOR" ]; then
    NODE_BIN="$(command -v node)"
    say "システムの Node を使います: ${NODE_BIN}（$(node --version)）"
    return
  fi
  local node_root="${TOOLS_DIR}/node"
  local sums_url="https://nodejs.org/dist/latest-v${NODE_MIN_MAJOR}.x/SHASUMS256.txt"
  local sums file expected dir
  sums="$(fetch "$sums_url")" || fail "Node.js の配布一覧（${sums_url}）を取得できませんでした。" "ネットワークを確認して、同じ1行をもう一度実行してください。"
  file="$(printf '%s\n' "$sums" | awk -v want="-${OS}-${ARCH}.tar.gz" '{ if (index($2, want) > 0 && $2 ~ /^node-v[0-9.]+-/) { print $2; exit } }')"
  expected="$(printf '%s\n' "$sums" | awk -v f="$file" '$2 == f { print $1; exit }')"
  [ -n "$file" ] && [ -n "$expected" ] || fail "Node.js ${NODE_MIN_MAJOR} の ${OS}-${ARCH} 向け配布物が見つかりませんでした。"
  dir="${node_root}/${file%.tar.gz}"
  if [ -x "${dir}/bin/node" ] && [ "$(node_major "${dir}/bin/node")" -ge "$NODE_MIN_MAJOR" ]; then
    NODE_BIN="${dir}/bin/node"
    say "入れてある Node を使います: ${NODE_BIN}"
  else
    say "Node.js（${file}）を nodejs.org から取得して照合します。"
    mkdir -p "$node_root"
    local tmp
    tmp="$(mktemp -d "${node_root}/.download.XXXXXX")"
    fetch "https://nodejs.org/dist/latest-v${NODE_MIN_MAJOR}.x/${file}" "${tmp}/${file}" || { rm -rf "$tmp"; fail "Node.js（${file}）を取得できませんでした。"; }
    local actual
    actual="$(sha256_of "${tmp}/${file}")"
    if [ "$actual" != "$expected" ]; then
      rm -rf "$tmp"
      fail "取得した Node.js の SHA-256 が SHASUMS256.txt と一致しません。" "期待: ${expected}" "実際: ${actual}" "壊れた、または差し替えられた可能性があるので使いません。"
    fi
    tar -xzf "${tmp}/${file}" -C "$tmp" || { rm -rf "$tmp"; fail "Node.js の展開に失敗しました。"; }
    rm -rf "$dir"
    mv "${tmp}/${file%.tar.gz}" "$dir"
    rm -rf "$tmp"
    NODE_BIN="${dir}/bin/node"
    say "Node.js を入れました: ${NODE_BIN}"
  fi
  # setup の中の npm と、npm の lifecycle script が同じ Node を使うように。
  PATH="$(dirname "$NODE_BIN"):${PATH}"
  export PATH
}

resolve_release() {
  step "最新の stable Release を確認"
  if [ -n "${REQUESTED_VERSION}" ]; then
    VERSION="${REQUESTED_VERSION#v}"
  else
    local json
    if json="$(fetch "https://api.github.com/repos/${BUZZASSIST_REPO}/releases/latest" 2>/dev/null)"; then
      VERSION="$(printf '%s' "$json" | "$NODE_BIN" -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>{const r=JSON.parse(s);if(r.draft||r.prerelease)process.exit(1);process.stdout.write(String(r.tag_name||"").replace(/^v/,""))})' 2>/dev/null || true)"
    fi
    if [ -z "${VERSION:-}" ] && have curl; then
      # API の回数制限に当たったとき: /releases/latest の転送先の tag 名を読む。
      VERSION="$(curl -fsSIL -o /dev/null -w '%{url_effective}' "https://github.com/${BUZZASSIST_REPO}/releases/latest" 2>/dev/null | sed -n 's#.*/releases/tag/v\{0,1\}\([0-9][0-9.]*\)$#\1#p')"
    fi
  fi
  case "${VERSION:-}" in
    [0-9]*.[0-9]*.[0-9]*) ;;
    *) fail "最新の Release の版を確認できませんでした。" "ネットワークを確認するか、BUZZASSIST_VERSION=0.1.26 のように版を指定してください。" ;;
  esac
  say "入れる版: ${VERSION}"
}

install_release() {
  step "BuzzAssist ${VERSION} を取得して照合"
  local name="buzzassist-canvas-mcp-${VERSION}.tgz"
  local base="https://github.com/${BUZZASSIST_REPO}/releases/download/v${VERSION}"
  APP="${APP_ROOT}/buzzassist-${VERSION}"
  if [ -f "${APP}/package.json" ] && [ "$("$NODE_BIN" -p "require(process.argv[1]).version" "${APP}/package.json" 2>/dev/null)" = "$VERSION" ] && [ -f "${APP}/scripts/setup-agents.mjs" ]; then
    say "展開済みの ${APP} を使います。"
    return
  fi
  mkdir -p "$APP_ROOT"
  local tmp
  tmp="$(mktemp -d "${APP_ROOT}/.download.XXXXXX")"
  fetch "${base}/${name}" "${tmp}/${name}" || { rm -rf "$tmp"; fail "Release の本体（${name}）を取得できませんでした。"; }
  fetch "${base}/${name}.sha256" "${tmp}/${name}.sha256" || { rm -rf "$tmp"; fail "Release のチェックサム（${name}.sha256）を取得できませんでした。" "照合できないものは入れません。"; }
  local expected actual
  expected="$(awk '{print $1; exit}' "${tmp}/${name}.sha256")"
  actual="$(sha256_of "${tmp}/${name}")"
  case "$expected" in
    [0-9a-f]*) ;;
    *) rm -rf "$tmp"; fail "Release のチェックサムファイルの形式が不正です。" ;;
  esac
  if [ "${#expected}" -ne 64 ] || [ "$expected" != "$actual" ]; then
    rm -rf "$tmp"
    fail "取得した Release の SHA-256 が一致しません。" "期待: ${expected}" "実際: ${actual}" "壊れた、または差し替えられた可能性があるので使いません。"
  fi
  tar -xzf "${tmp}/${name}" -C "$tmp" || { rm -rf "$tmp"; fail "Release の展開に失敗しました。"; }
  [ -f "${tmp}/package/scripts/setup-agents.mjs" ] || { rm -rf "$tmp"; fail "Release の中身に scripts/setup-agents.mjs がありません。"; }
  rm -rf "$APP"
  mv "${tmp}/package" "$APP"
  rm -rf "$tmp"
  printf '%s\n' "$APP" > "${APP_ROOT}/current.txt"
  say "展開しました: ${APP}"
}

detect_hosts() {
  step "Claude Code と Codex を探す"
  HOSTS=""
  local claude_candidates=("${HOME_DIR}/.local/bin/claude" "${HOME_DIR}/.claude/local/claude")
  if have claude; then
    HOSTS="claude"
  else
    for candidate in "${claude_candidates[@]}"; do
      if [ -x "$candidate" ]; then
        HOSTS="claude"
        PATH="$(dirname "$candidate"):${PATH}"
        export PATH
        break
      fi
    done
  fi
  local codex_found=""
  if [ -n "${CODEX_COMMAND:-}" ] && [ -x "${CODEX_COMMAND}" ]; then codex_found=1
  elif have codex; then codex_found=1
  else
    for candidate in "/Applications/ChatGPT.app/Contents/Resources/codex" "${HOME_DIR}/Applications/ChatGPT.app/Contents/Resources/codex" \
      "/Applications/Codex.app/Contents/Resources/codex" "${HOME_DIR}/Applications/Codex.app/Contents/Resources/codex"; do
      if [ -x "$candidate" ]; then codex_found=1; break; fi
    done
  fi
  if [ -n "$codex_found" ]; then HOSTS="${HOSTS:+${HOSTS},}codex"; fi
  if [ -z "$HOSTS" ]; then
    fail "Claude Code も Codex も見つかりませんでした。どちらかを入れてから、同じ1行をもう一度実行してください。" \
      "Claude Code: https://docs.anthropic.com/en/docs/claude-code/setup（macOS / Linux は curl -fsSL https://claude.ai/install.sh | bash）" \
      "Codex: ChatGPT デスクトップアプリ https://chatgpt.com/download/ または Codex CLI"
  fi
  say "見つけたホスト: ${HOSTS}"
}

run_setup() {
  step "setup-agents を実行（${HOSTS}）"
  mkdir -p "$PROJECT_DIR"
  local log
  log="$(mktemp "${TMPDIR:-/tmp}/buzzassist-setup.XXXXXX")"
  set +e
  "$NODE_BIN" "${APP}/scripts/setup-agents.mjs" --agents "$HOSTS" --project-dir "$PROJECT_DIR" ${PASSTHROUGH[@]+"${PASSTHROUGH[@]}"} </dev/null 2>&1 | tee "$log"
  local status=${PIPESTATUS[0]}
  set -e
  if [ "$status" -eq 0 ]; then
    rm -f "$log"
    say ""
    say "BuzzAssist ${VERSION} を入れました（${HOSTS}）。Claude Code / Codex を新しく開き直すと使えます。"
    say "作業フォルダ: ${PROJECT_DIR}"
    return 0
  fi
  local missing
  missing="$(sed -n 's/^  - \([a-z0-9-]*\): \(.*\)$/\1: \2/p' "$log" | head -20)"
  rm -f "$log"
  if [ "$status" -eq 2 ]; then
    printf '\n[BuzzAssist の導入を止めました] 動画ハーネスを回すための前提がまだ足りません（exit 2）。\n' >&2
    if [ -n "$missing" ]; then
      printf '足りないもの:\n' >&2
      printf '%s\n' "$missing" | sed 's/^/  - /' >&2
    fi
    printf '直してから、同じ1行をもう一度実行してください。キャンバスだけを先に使うなら、末尾に --allow-harness-not-ready を付けます:\n' >&2
    printf '  curl -fsSL https://raw.githubusercontent.com/%s/main/install.sh | bash -s -- --allow-harness-not-ready\n' "$BUZZASSIST_REPO" >&2
    exit 2
  fi
  fail "setup-agents が失敗しました（exit ${status}）。上の出力の最後のエラーを確認してください。" \
    "ホストの CLI（claude / codex）の導入やログインを直してから、同じ1行をもう一度実行してください。"
}

main() {
  HOME_DIR="${BUZZASSIST_SETUP_HOME:-${HOME:-}}"
  [ -n "$HOME_DIR" ] || fail "HOME が設定されていません。"
  TOOLS_DIR="${BUZZASSIST_TOOLS_DIR:-${HOME_DIR}/.buzzassist/tools}"
  APP_ROOT="${BUZZASSIST_APP_DIR:-${HOME_DIR}/.buzzassist/app}"
  PROJECT_DIR="${BUZZASSIST_PROJECT_DIR:-${HOME_DIR}/BuzzAssist}"
  REQUESTED_VERSION="${BUZZASSIST_VERSION:-}"
  PASSTHROUGH=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --project-dir) [ "$#" -ge 2 ] || fail "--project-dir にフォルダを指定してください。"; PROJECT_DIR="$2"; shift 2 ;;
      --version) [ "$#" -ge 2 ] || fail "--version に版を指定してください。"; REQUESTED_VERSION="$2"; shift 2 ;;
      --agent|--agents|--host) fail "$1 は指定できません。install.sh は入っているホストを自動で全部設定します。" ;;
      *) PASSTHROUGH+=("$1"); shift ;;
    esac
  done
  have tar || fail "tar が見つかりません。"
  detect_platform
  ensure_node
  resolve_release
  install_release
  detect_hosts
  run_setup
}

main "$@"
