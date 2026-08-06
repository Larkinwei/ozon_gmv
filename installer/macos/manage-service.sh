#!/bin/bash

set -euo pipefail

SERVICE_LABEL="com.ozon.gmv-dashboard"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
DATA_DIR="$PROJECT_DIR/.data"
LOG_DIR="$DATA_DIR/logs"
PLIST_TEMPLATE="$SCRIPT_DIR/com.ozon.gmv-dashboard.plist.template"
PLIST_PATH="$HOME/Library/LaunchAgents/$SERVICE_LABEL.plist"
SERVICE_TARGET="gui/$(id -u)/$SERVICE_LABEL"
DOMAIN_TARGET="gui/$(id -u)"
ADMIN_READY_URL="http://127.0.0.1:3001/readyz"
ACTION="${1:-}"

function print_usage() {
  echo "Usage: $0 {install|status|restart|update|uninstall}"
}

function require_macos() {
  if [[ "$(uname -s)" != "Darwin" ]]; then
    echo "This service manager only supports macOS." >&2
    exit 1
  fi
}

function resolve_node() {
  local node_path
  node_path="$(command -v node || true)"
  if [[ -z "$node_path" ]]; then
    echo "Node.js 24 or newer is required." >&2
    exit 1
  fi
  local node_major
  node_major="$($node_path -p 'process.versions.node.split(".")[0]')"
  if (( node_major < 24 )); then
    echo "Node.js 24 or newer is required; found $($node_path --version)." >&2
    exit 1
  fi
  echo "$node_path"
}

function service_is_loaded() {
  launchctl print "$SERVICE_TARGET" >/dev/null 2>&1
}

function wait_until_unloaded() {
  local attempt
  for attempt in $(seq 1 25); do
    if ! service_is_loaded; then
      return 0
    fi
    sleep 1
  done
  echo "The previous LaunchAgent instance did not stop within 25 seconds." >&2
  return 1
}

function assert_ports_available() {
  local port
  for port in 3001 3002; do
    local pids
    pids="$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    if [[ -n "$pids" ]]; then
      echo "Port $port is already in use by PID(s): $pids" >&2
      echo "Stop the existing process before installing the LaunchAgent; no process was terminated." >&2
      exit 1
    fi
  done
}

function build_project() {
  echo "Building the production application..."
  (cd "$PROJECT_DIR" && npm run build)
}

function escape_sed_replacement() {
  printf '%s' "$1" | sed -e 's/[&|]/\\&/g'
}

function render_plist() {
  local node_path="$1"
  local temporary_plist="$PLIST_PATH.tmp"
  mkdir -p "$(dirname "$PLIST_PATH")" "$LOG_DIR"
  sed \
    -e "s|__NODE_BIN__|$(escape_sed_replacement "$node_path")|g" \
    -e "s|__PROJECT_DIR__|$(escape_sed_replacement "$PROJECT_DIR")|g" \
    -e "s|__DATA_DIR__|$(escape_sed_replacement "$DATA_DIR")|g" \
    -e "s|__STDOUT_PATH__|$(escape_sed_replacement "$LOG_DIR/launchd.stdout.log")|g" \
    -e "s|__STDERR_PATH__|$(escape_sed_replacement "$LOG_DIR/launchd.stderr.log")|g" \
    "$PLIST_TEMPLATE" > "$temporary_plist"
  plutil -lint "$temporary_plist" >/dev/null
  chmod 600 "$temporary_plist"
  mv "$temporary_plist" "$PLIST_PATH"
}

function wait_until_ready() {
  local attempt
  # launchd may throttle a recently restarted KeepAlive job for slightly over 30 seconds.
  for attempt in $(seq 1 60); do
    if curl --silent --fail --max-time 2 "$ADMIN_READY_URL" >/dev/null; then
      echo "Ozon GMV Dashboard is ready at http://127.0.0.1:3001"
      return 0
    fi
    sleep 1
  done
  echo "The service did not become ready within 60 seconds." >&2
  echo "Inspect $LOG_DIR/launchd.stderr.log and $LOG_DIR/launchd.stdout.log." >&2
  return 1
}

function register_service() {
  local node_path="$1"
  if ! service_is_loaded; then
    assert_ports_available
  fi
  render_plist "$node_path"
  if service_is_loaded; then
    launchctl bootout "$SERVICE_TARGET"
    wait_until_unloaded
  fi
  launchctl bootstrap "$DOMAIN_TARGET" "$PLIST_PATH"
  launchctl enable "$SERVICE_TARGET"
  launchctl kickstart -k "$SERVICE_TARGET"
  wait_until_ready
}

function install_service() {
  local node_path
  node_path="$(resolve_node)"
  build_project
  register_service "$node_path"
}

function print_status() {
  if ! service_is_loaded; then
    echo "Ozon GMV Dashboard LaunchAgent is not loaded."
    return 1
  fi
  launchctl print "$SERVICE_TARGET" | awk '/state =|pid =|last exit code =/ { print }'
  if curl --silent --fail --max-time 2 "$ADMIN_READY_URL" >/dev/null; then
    echo "Health: ready"
    echo "Dashboard: http://127.0.0.1:3001"
  else
    echo "Health: not ready" >&2
    return 1
  fi
}

function restart_service() {
  if ! service_is_loaded; then
    echo "The LaunchAgent is not installed. Run npm run service:mac:install first." >&2
    exit 1
  fi
  launchctl kickstart -k "$SERVICE_TARGET"
  wait_until_ready
}

function update_service() {
  local node_path
  node_path="$(resolve_node)"
  if ! service_is_loaded; then
    install_service
    return
  fi
  build_project
  register_service "$node_path"
}

function uninstall_service() {
  if service_is_loaded; then
    launchctl bootout "$SERVICE_TARGET"
  fi
  if [[ -f "$PLIST_PATH" ]]; then
    rm "$PLIST_PATH"
  fi
  echo "LaunchAgent removed. Application data remains in $DATA_DIR."
}

require_macos
case "$ACTION" in
  install) install_service ;;
  status) print_status ;;
  restart) restart_service ;;
  update) update_service ;;
  uninstall) uninstall_service ;;
  *) print_usage; exit 1 ;;
esac
