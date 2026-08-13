#!/bin/bash

set -euo pipefail

SERVICE_LABEL="com.ozon.gmv-dashboard"
NOTIFIER_LABEL="com.ozon.gmv-notifier"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
DATA_DIR="$PROJECT_DIR/.data"
LOG_DIR="$DATA_DIR/logs"
PLIST_TEMPLATE="$SCRIPT_DIR/com.ozon.gmv-dashboard.plist.template"
PLIST_PATH="$HOME/Library/LaunchAgents/$SERVICE_LABEL.plist"
NOTIFIER_PLIST_TEMPLATE="$SCRIPT_DIR/com.ozon.gmv-notifier.plist.template"
NOTIFIER_PLIST_PATH="$HOME/Library/LaunchAgents/$NOTIFIER_LABEL.plist"
SERVICE_TARGET="gui/$(id -u)/$SERVICE_LABEL"
NOTIFIER_TARGET="gui/$(id -u)/$NOTIFIER_LABEL"
NOTIFIER_APP="$DATA_DIR/bin/OzonGMVNotifier.app"
NOTIFIER_BIN="$NOTIFIER_APP/Contents/MacOS/OzonGMVNotifier"
NOTIFIER_INFO_PLIST="$SCRIPT_DIR/OzonGMVNotifier.Info.plist"
NOTIFIER_ICON_SOURCE="$SCRIPT_DIR/OzonGMVNotifierIcon.svg"
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

function notifier_is_loaded() {
  launchctl print "$NOTIFIER_TARGET" >/dev/null 2>&1
}

function wait_until_notifier_unloaded() {
  local attempt
  for attempt in $(seq 1 25); do
    if ! notifier_is_loaded; then
      return 0
    fi
    sleep 1
  done
  echo "The previous notification LaunchAgent did not stop within 25 seconds." >&2
  return 1
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
  # OpenCLI uses `#!/usr/bin/env node`, so launchd must receive Node's directory explicitly.
  local service_path
  service_path="$(dirname "$node_path"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
  local temporary_plist="$PLIST_PATH.tmp"
  mkdir -p "$(dirname "$PLIST_PATH")" "$LOG_DIR"
  sed \
    -e "s|__NODE_BIN__|$(escape_sed_replacement "$node_path")|g" \
    -e "s|__PROJECT_DIR__|$(escape_sed_replacement "$PROJECT_DIR")|g" \
    -e "s|__DATA_DIR__|$(escape_sed_replacement "$DATA_DIR")|g" \
    -e "s|__SERVICE_PATH__|$(escape_sed_replacement "$service_path")|g" \
    -e "s|__STDOUT_PATH__|$(escape_sed_replacement "$LOG_DIR/launchd.stdout.log")|g" \
    -e "s|__STDERR_PATH__|$(escape_sed_replacement "$LOG_DIR/launchd.stderr.log")|g" \
    "$PLIST_TEMPLATE" > "$temporary_plist"
  plutil -lint "$temporary_plist" >/dev/null
  chmod 600 "$temporary_plist"
  mv "$temporary_plist" "$PLIST_PATH"
}

function render_notifier_plist() {
  local node_path="$1"
  local temporary_plist="$NOTIFIER_PLIST_PATH.tmp"
  mkdir -p "$(dirname "$NOTIFIER_PLIST_PATH")" "$LOG_DIR" "$DATA_DIR/notifier"
  sed \
    -e "s|__NODE_BIN__|$(escape_sed_replacement "$node_path")|g" \
    -e "s|__PROJECT_DIR__|$(escape_sed_replacement "$PROJECT_DIR")|g" \
    -e "s|__NOTIFIER_DATA_DIR__|$(escape_sed_replacement "$DATA_DIR/notifier")|g" \
    -e "s|__MAC_NOTIFIER_BIN__|$(escape_sed_replacement "$NOTIFIER_BIN")|g" \
    -e "s|__STDOUT_PATH__|$(escape_sed_replacement "$LOG_DIR/notifier.stdout.log")|g" \
    -e "s|__STDERR_PATH__|$(escape_sed_replacement "$LOG_DIR/notifier.stderr.log")|g" \
    "$NOTIFIER_PLIST_TEMPLATE" > "$temporary_plist"
  plutil -lint "$temporary_plist" >/dev/null
  chmod 600 "$temporary_plist"
  mv "$temporary_plist" "$NOTIFIER_PLIST_PATH"
}

function build_macos_notifier() {
  local swift_source="$SCRIPT_DIR/OzonGMVNotifier.swift"
  local iconset="$DATA_DIR/bin/OzonGMVNotifier.iconset"
  if ! xcrun --find swiftc >/dev/null 2>&1; then
    echo "Apple Command Line Tools are required to build the macOS notification helper." >&2
    exit 1
  fi
  mkdir -p "$NOTIFIER_APP/Contents/MacOS" "$NOTIFIER_APP/Contents/Resources" "$iconset"
  cp "$NOTIFIER_INFO_PLIST" "$NOTIFIER_APP/Contents/Info.plist"
  local icon_size
  for icon_size in 16 32 128 256 512; do
    sips -s format png -z "$icon_size" "$icon_size" "$NOTIFIER_ICON_SOURCE" \
      --out "$iconset/icon_${icon_size}x${icon_size}.png" >/dev/null
    sips -s format png -z "$((icon_size * 2))" "$((icon_size * 2))" "$NOTIFIER_ICON_SOURCE" \
      --out "$iconset/icon_${icon_size}x${icon_size}@2x.png" >/dev/null
  done
  iconutil -c icns "$iconset" -o "$NOTIFIER_APP/Contents/Resources/OzonGMVNotifier.icns"
  rm -r "$iconset"
  xcrun --sdk macosx swiftc -suppress-warnings \
    -framework AppKit \
    -framework UserNotifications \
    "$swift_source" \
    -o "$NOTIFIER_BIN"
  chmod 755 "$NOTIFIER_BIN"
  plutil -lint "$NOTIFIER_APP/Contents/Info.plist" >/dev/null
  codesign --force --deep --sign - "$NOTIFIER_APP" >/dev/null
  # Register the hidden app so Notification Center can resolve its stable bundle identity.
  local launch_services_register="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
  "$launch_services_register" -f "$NOTIFIER_APP"
}

function register_notifier() {
  local node_path="$1"
  build_macos_notifier
  render_notifier_plist "$node_path"
  if notifier_is_loaded; then
    launchctl bootout "$NOTIFIER_TARGET"
    wait_until_notifier_unloaded
  fi
  launchctl bootstrap "$DOMAIN_TARGET" "$NOTIFIER_PLIST_PATH"
  launchctl enable "$NOTIFIER_TARGET"
  launchctl kickstart -k "$NOTIFIER_TARGET"
}

function wait_until_ready() {
  local attempt
  # launchd may throttle a recently restarted KeepAlive job for slightly over 30 seconds.
  for attempt in $(seq 1 60); do
    if curl --silent --fail --max-time 5 "$ADMIN_READY_URL" >/dev/null; then
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
  register_notifier "$node_path"
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
  if notifier_is_loaded; then
    echo "Notification agent: loaded"
  else
    echo "Notification agent: not loaded" >&2
  fi
  if curl --silent --fail --max-time 5 "$ADMIN_READY_URL" >/dev/null; then
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
  if notifier_is_loaded; then
    launchctl kickstart -k "$NOTIFIER_TARGET"
  else
    register_notifier "$(resolve_node)"
  fi
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
  if notifier_is_loaded; then
    launchctl bootout "$NOTIFIER_TARGET"
  fi
  if [[ -f "$NOTIFIER_PLIST_PATH" ]]; then
    rm "$NOTIFIER_PLIST_PATH"
  fi
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
