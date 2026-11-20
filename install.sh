#!/usr/bin/env bash
# install.sh — Linux installer for tlc-mcp-server
#
# Steps:
#   1. Preflight (Linux, curl/tar, distro info)
#   2. Node.js >= 18: use system node if adequate; otherwise install Node LTS
#      (official tarball, user-local under ~/.local — no sudo)
#   3. npm ci (falls back to npm install)
#   4. mkdir -p state out (gitignored runtime dirs)
#   5. npx playwright install chromium (pinned build; idempotent)
#      optional: --with-deps also runs playwright install-deps via sudo
#   6. Create ~/.config/tlc-mcp/credentials.env template if missing (chmod 600;
#      never overwrites an existing file)
#   7. Smoke test: spawn the MCP server over stdio, tools/list must show all tools
#
# Flags:
#   --with-deps         also install Chromium's OS libraries (needs sudo)
#   --no-node-install   fail instead of installing a user-local Node
#   --skip-smoke        skip the stdio smoke test
#   -h | --help         show usage
set -euo pipefail

if [ -t 1 ]; then
  C_OK=$'\e[32m'; C_WARN=$'\e[33m'; C_ERR=$'\e[31m'; C_BOLD=$'\e[1m'; C_OFF=$'\e[0m'
else
  C_OK=''; C_WARN=''; C_ERR=''; C_BOLD=''; C_OFF=''
fi
say()  { printf '%s\n' "$*"; }
ok()   { printf '%s[ok]%s   %s\n' "$C_OK" "$C_OFF" "$*"; }
info() { printf '%s[..]%s   %s\n' "$C_OK" "$C_OFF" "$*"; }
warn() { printf '%s[warn]%s %s\n' "$C_WARN" "$C_OFF" "$*"; }
die()  { printf '%s[error]%s %s\n' "$C_ERR" "$C_OFF" "$*" >&2; exit 1; }

ROOT="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
NODE_MIN=18
NODE_LTS_LINE=latest-v22.x
CRED_DIR="$HOME/.config/tlc-mcp"
LOCAL_NODE_DIR="$HOME/.local/share/tlc-mcp/node"

WITH_DEPS=0; SKIP_SMOKE=0; ALLOW_NODE_INSTALL=1

usage() {
  sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
}

for arg in "$@"; do
  case "$arg" in
    --with-deps)        WITH_DEPS=1 ;;
    --no-node-install)  ALLOW_NODE_INSTALL=0 ;;
    --skip-smoke)       SKIP_SMOKE=1 ;;
    -h|--help)          usage; exit 0 ;;
    *)                  die "unknown flag: $arg (see --help)" ;;
  esac
done

# ---------- 1. preflight ----------
say "${C_BOLD}tlc-mcp-server installer${C_OFF}  (project: $ROOT)"

[ "$(uname -s)" = "Linux" ] || die "this installer is Linux-only"
command -v curl >/dev/null 2>&1 || die "curl is required"
command -v tar  >/dev/null 2>&1 || die "tar is required"
[ -f "$ROOT/package.json" ] || die "run from the project root (package.json not found next to install.sh)"

OS_ID="unknown"
if [ -r /etc/os-release ]; then
  . /etc/os-release
  OS_ID="${ID:-unknown}"
fi
info "distro: $OS_ID ($(uname -m))"

# ---------- 2. node ----------
node_major() {
  command -v node >/dev/null 2>&1 || { echo 0; return; }
  command -v npm  >/dev/null 2>&1 || { echo 0; return; }
  local v; v="$(node -v 2>/dev/null)" || { echo 0; return; }
  v="${v#v}"; echo "${v%%.*}"
}

major="$(node_major)"
if [ "$major" -ge "$NODE_MIN" ]; then
  ok "node $(node -v) at $(command -v node) (npm $(npm -v))"
else
  if [ "$ALLOW_NODE_INSTALL" -eq 0 ]; then
    die "node >= $NODE_MIN with npm not found (--no-node-install set)"
  fi
  warn "node >= $NODE_MIN not found -> installing Node LTS ($NODE_LTS_LINE) user-local"
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64)  NARCH=x64 ;;
    aarch64) NARCH=arm64 ;;
    armv7l)  NARCH=armv7l ;;
    *) die "unsupported architecture: $ARCH" ;;
  esac
  BASE="https://nodejs.org/dist/$NODE_LTS_LINE"
  TARBALL="$(curl -fsSL "$BASE/" | grep -oE "node-v[0-9.]+-linux-${NARCH}\.tar\.(xz|gz)" | head -n1 || true)"
  [ -n "$TARBALL" ] || die "could not find a $NARCH tarball under $BASE (network?)"
  TMP="$(mktemp -d)"
  info "downloading $TARBALL"
  curl -fL "$BASE/$TARBALL" -o "$TMP/$TARBALL"
  case "$TARBALL" in
    *.xz) [ -e /usr/bin/xz ] || command -v xz >/dev/null 2>&1 || die "xz required for $TARBALL"; tar -xJf "$TMP/$TARBALL" -C "$TMP" ;;
    *.gz) tar -xzf "$TMP/$TARBALL" -C "$TMP" ;;
  esac
  SRC="$(find "$TMP" -mindepth 1 -maxdepth 1 -type d | head -n1)"
  mkdir -p "$HOME/.local/share/tlc-mcp" "$HOME/.local/bin"
  rm -rf "$LOCAL_NODE_DIR"
  mv "$SRC" "$LOCAL_NODE_DIR"
  rm -rf "$TMP"
  for b in node npm npx corepack; do
    [ -e "$LOCAL_NODE_DIR/bin/$b" ] && ln -sf "$LOCAL_NODE_DIR/bin/$b" "$HOME/.local/bin/$b"
  done
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) : ;;
    *) export PATH="$HOME/.local/bin:$PATH"
       warn "$HOME/.local/bin is not in your PATH — add it in your shell profile:"
       warn "  export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
  esac
  major="$(node_major)"
  [ "$major" -ge "$NODE_MIN" ] || die "node install finished but 'node' still unusable"
  ok "installed $(node -v) -> $LOCAL_NODE_DIR (symlinked into ~/.local/bin)"
fi

# ---------- 3. npm dependencies ----------
cd "$ROOT"
info "installing npm dependencies (npm ci)"
if npm ci --no-audit --no-fund; then
  ok "npm ci complete"
else
  warn "npm ci failed; falling back to npm install"
  npm install --no-audit --no-fund || die "npm install failed"
  ok "npm install complete"
fi

# ---------- 4. runtime dirs ----------
mkdir -p "$ROOT/state" "$ROOT/out"
ok "runtime dirs ready (state/, out/ — both gitignored)"

# ---------- 5. playwright chromium ----------
info "installing Playwright Chromium (pinned build, idempotent)"
npx playwright install chromium || die "playwright chromium install failed"
ok "playwright chromium ready"
if [ "$WITH_DEPS" -eq 1 ]; then
  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    sudo npx playwright install-deps chromium && ok "chromium OS dependencies installed"
  else
    warn "--with-deps needs passwordless sudo; run manually instead:"
    warn "  sudo npx playwright install-deps chromium"
  fi
elif [ "$OS_ID" = "ubuntu" ] || [ "$OS_ID" = "debian" ] || [ "${VARIANT_ID:-}" = "ubuntu" ]; then
  info "if chromium fails to launch on this Debian/Ubuntu host, run: sudo npx playwright install-deps chromium (or re-run with --with-deps)"
fi

# ---------- 6. credentials skeleton ----------
if [ -f "$CRED_DIR/credentials.env" ]; then
  ok "credentials file exists: $CRED_DIR/credentials.env (left untouched)"
else
  mkdir -p -m 700 "$CRED_DIR"
  cat > "$CRED_DIR/credentials.env" <<'EOF'
TLC_EMAIL=you@example.com
TLC_PASSWORD=***
EOF
  chmod 600 "$CRED_DIR/credentials.env"
  warn "created TEMPLATE credentials file — edit it before first use:"
  warn "  $CRED_DIR/credentials.env  (chmod 600 applied)"
fi

# ---------- 7. smoke test ----------
if [ "$SKIP_SMOKE" -eq 0 ]; then
  info "smoke test: stdio JSON-RPC tools/list against src/index.js"
  cat > "$ROOT/out/install-smoke.mjs" <<'EOF'
// spawn the MCP server, initialize, tools/list, assert the full tool surface
import { spawn } from 'child_process';
const p = spawn(process.execPath, ['src/index.js'], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'inherit'] });
let buf = '';
p.stdout.on('data', (d) => (buf += d));
const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'install-smoke', version: '0' } } });
await wait(1500);
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
await wait(2500);
let found = null;
for (const l of buf.split('\n').filter(Boolean)) {
  let m; try { m = JSON.parse(l); } catch { continue; }
  if (m.id === 2 && m.result?.tools) found = m.result.tools;
}
p.kill();
if (!found) { console.error('SMOKE FAIL: no tools/list response from server'); process.exit(1); }
const EXPECT = ['tlc_login','tlc_calendar_report','tlc_event_details','tlc_event_create','tlc_event_update','tlc_event_delete','tlc_event_lessons','tlc_event_add_lesson','tlc_lessons_report','tlc_lesson_delete','tlc_advancement_report','tlc_ical_feeds','tlc_fetch_page'];
const missing = EXPECT.filter((n) => !found.some((t) => t.name === n));
if (missing.length) { console.error('SMOKE FAIL: missing tools:', missing.join(', ')); process.exit(1); }
console.log(`SMOKE OK: ${found.length} tools -> ${found.map((t) => t.name).join(', ')}`);
EOF
  ( cd "$ROOT" && node out/install-smoke.mjs ) || die "smoke test failed — see docs/USAGE.md troubleshooting"
  ok "MCP surface verified"
else
  info "smoke test skipped (--skip-smoke)"
fi

# ---------- summary ----------
say ""
say "${C_BOLD}Install complete.${C_OFF} Next steps:"
say "  1. Put real credentials in ${C_BOLD}$CRED_DIR/credentials.env${C_OFF} (email + TLC password)."
say "  2. Register the server with your MCP client:"
say "     {\"mcpServers\": {\"tlc\": {\"command\": \"node\", \"args\": [\"$ROOT/src/index.js\"]}}}"
say "     (quote the path; note: absolute node path may be needed in GUI clients)"
say "  3. First call to tlc_login may trigger SMS 2FA: it returns needs_sms_code, then"
say "     re-call tlc_login with {\"sms_code\": \"...\"} to complete the trusted device (~30 days)."
say "  4. Docs: docs/USAGE.md (tool reference) and docs/ARCHITECTURE.md (components & deps)."
say "  Never commit state/ or out/ — both hold live session data and secret feed URLs."
