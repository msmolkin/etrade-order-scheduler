#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Create deployment artifacts for the E*TRADE OTP relay and (optionally) enable a Tailscale Funnel.

Default behavior:
- writes a relay env file under .generated/otp-relay/
- writes a systemd service unit under .generated/otp-relay/
- writes exact install/funnel commands under .generated/otp-relay/
- writes an .env snippet for the trade-placer app under .generated/otp-relay/

Examples:
  ./create-otp-relay-setup.sh --secret 'replace-me'
  ./create-otp-relay-setup.sh --secret 'replace-me' --update-dotenv
  ./create-otp-relay-setup.sh --secret 'replace-me' --apply
  ./create-otp-relay-setup.sh --secret 'replace-me' --apply --enable-funnel
  ./create-otp-relay-setup.sh --secret 'replace-me' --output-dir /tmp/otp-relay

Options:
  --secret VALUE          Shared secret used by both the relay and /api/auth/auto/webhook.
  --relay-port VALUE      Local relay port to expose with Tailscale Funnel. Default: 3102
  --app-port VALUE        Local trade-placer HTTP port. Default: 3001
  --app-host VALUE        Local trade-placer host. Default: 127.0.0.1
  --relay-host VALUE      Local relay bind host. Default: 127.0.0.1
  --output-dir PATH       Where to write generated files. Default: <repo>/.generated/otp-relay
  --service-name NAME     systemd service name. Default: etrade-otp-relay
  --update-dotenv         Upsert ETRADE_AUTO_AUTH_WEBHOOK_SECRET into <repo>/.env
  --apply                 Install and start the generated systemd service on this machine
  --enable-funnel         Run 'tailscale funnel --bg localhost:<relay-port>' after install
  --help                  Show this help
EOF
}

require_command() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing required command: $cmd" >&2
    exit 1
  fi
}

generate_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    python - <<'PY'
import secrets
print(secrets.token_hex(32))
PY
  fi
}

upsert_env_value() {
  local file="$1"
  local key="$2"
  local value="$3"

  touch "$file"
  if grep -qE "^${key}=" "$file"; then
    python - "$file" "$key" "$value" <<'PY'
from pathlib import Path
import sys
path = Path(sys.argv[1])
key = sys.argv[2]
value = sys.argv[3]
lines = path.read_text().splitlines()
out = []
replaced = False
for line in lines:
    if line.startswith(f"{key}=") and not replaced:
        out.append(f"{key}={value}")
        replaced = True
    else:
        out.append(line)
if not replaced:
    out.append(f"{key}={value}")
path.write_text("\n".join(out) + "\n")
PY
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
}

SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$SCRIPT_PATH"
RELAY_SCRIPT="$REPO_ROOT/docs/google-apps-script/otp-webhook-relay.mjs"
DOTENV_PATH="$REPO_ROOT/.env"
NODE_BIN="$(command -v node || true)"
TAILSCALE_BIN="$(command -v tailscale || true)"

SECRET=""
RELAY_PORT="3102"
APP_PORT="3001"
APP_HOST="127.0.0.1"
RELAY_HOST="127.0.0.1"
OUTPUT_DIR="$REPO_ROOT/.generated/otp-relay"
SERVICE_NAME="etrade-otp-relay"
UPDATE_DOTENV="0"
APPLY="0"
ENABLE_FUNNEL="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --secret)
      SECRET="${2:-}"
      shift 2
      ;;
    --relay-port)
      RELAY_PORT="${2:-}"
      shift 2
      ;;
    --app-port)
      APP_PORT="${2:-}"
      shift 2
      ;;
    --app-host)
      APP_HOST="${2:-}"
      shift 2
      ;;
    --relay-host)
      RELAY_HOST="${2:-}"
      shift 2
      ;;
    --output-dir)
      OUTPUT_DIR="${2:-}"
      shift 2
      ;;
    --service-name)
      SERVICE_NAME="${2:-}"
      shift 2
      ;;
    --update-dotenv)
      UPDATE_DOTENV="1"
      shift
      ;;
    --apply)
      APPLY="1"
      shift
      ;;
    --enable-funnel)
      ENABLE_FUNNEL="1"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$SECRET" ]]; then
  SECRET="$(generate_secret)"
fi

if [[ ! -f "$RELAY_SCRIPT" ]]; then
  echo "Relay script not found: $RELAY_SCRIPT" >&2
  exit 1
fi

require_command node

mkdir -p "$OUTPUT_DIR"
UPSTREAM_URL="http://${APP_HOST}:${APP_PORT}/api/auth/auto/webhook"
ENV_FILE="$OUTPUT_DIR/${SERVICE_NAME}.env"
SERVICE_FILE="$OUTPUT_DIR/${SERVICE_NAME}.service"
APP_ENV_SNIPPET="$OUTPUT_DIR/${SERVICE_NAME}.app-env"
INSTALL_FILE="$OUTPUT_DIR/${SERVICE_NAME}.install.txt"
FUNNEL_FILE="$OUTPUT_DIR/${SERVICE_NAME}.funnel.txt"
SUMMARY_FILE="$OUTPUT_DIR/${SERVICE_NAME}.summary.txt"

cat > "$ENV_FILE" <<EOF
RELAY_PORT=${RELAY_PORT}
RELAY_HOST=${RELAY_HOST}
RELAY_UPSTREAM_URL=${UPSTREAM_URL}
RELAY_SHARED_SECRET=${SECRET}
EOF

cat > "$APP_ENV_SNIPPET" <<EOF
ETRADE_AUTO_AUTH_WEBHOOK_SECRET=${SECRET}
EOF

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=E*TRADE OTP Webhook Relay
After=network-online.target tailscaled.service
Wants=network-online.target tailscaled.service

[Service]
Type=simple
WorkingDirectory=${REPO_ROOT}
EnvironmentFile=${ENV_FILE}
ExecStart=${NODE_BIN} ${RELAY_SCRIPT}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

cat > "$INSTALL_FILE" <<EOF
# 1) Make sure the main app uses the same webhook secret.
#    Either append this line to ${DOTENV_PATH}:
ETRADE_AUTO_AUTH_WEBHOOK_SECRET=${SECRET}

# 2) Install the relay as a systemd service.
sudo cp ${SERVICE_FILE} /etc/systemd/system/${SERVICE_NAME}.service
sudo systemctl daemon-reload
sudo systemctl enable --now ${SERVICE_NAME}.service
sudo systemctl status ${SERVICE_NAME}.service --no-pager
EOF

cat > "$FUNNEL_FILE" <<EOF
# Expose ONLY the relay with Tailscale Funnel.
${TAILSCALE_BIN:-tailscale} funnel --bg localhost:${RELAY_PORT}
${TAILSCALE_BIN:-tailscale} funnel status
EOF

cat > "$SUMMARY_FILE" <<EOF
E*TRADE OTP relay setup artifacts created.

Repo root: ${REPO_ROOT}
Relay script: ${RELAY_SCRIPT}
Relay env: ${ENV_FILE}
Systemd unit: ${SERVICE_FILE}
App env snippet: ${APP_ENV_SNIPPET}
Install commands: ${INSTALL_FILE}
Funnel commands: ${FUNNEL_FILE}

Relay listens on: http://${RELAY_HOST}:${RELAY_PORT}
Relay forwards to: ${UPSTREAM_URL}
Shared secret: ${SECRET}
EOF

if [[ "$UPDATE_DOTENV" == "1" ]]; then
  upsert_env_value "$DOTENV_PATH" "ETRADE_AUTO_AUTH_WEBHOOK_SECRET" "$SECRET"
fi

if [[ "$APPLY" == "1" ]]; then
  require_command sudo
  require_command systemctl
  sudo cp "$SERVICE_FILE" "/etc/systemd/system/${SERVICE_NAME}.service"
  sudo systemctl daemon-reload
  sudo systemctl enable --now "${SERVICE_NAME}.service"
fi

if [[ "$ENABLE_FUNNEL" == "1" ]]; then
  if [[ "$APPLY" != "1" ]]; then
    echo "--enable-funnel requires --apply in this script." >&2
    exit 1
  fi
  require_command tailscale
  tailscale funnel --bg "localhost:${RELAY_PORT}"
fi

cat "$SUMMARY_FILE"

if [[ "$UPDATE_DOTENV" != "1" ]]; then
  echo
  echo "Next: append the app env snippet to ${DOTENV_PATH} or rerun with --update-dotenv"
fi

echo
echo "Apps Script should POST to the public Funnel URL that points to localhost:${RELAY_PORT}."
echo "After enabling Funnel, run: ${TAILSCALE_BIN:-tailscale} funnel status"
