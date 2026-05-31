#!/usr/bin/env bash
# Sources etrade-morning.sh in dry-run mode and verifies the right
# service-management primitives get defined for the current platform.
set -euo pipefail

export ETRADE_MORNING_DRY_RUN=1
# shellcheck disable=SC1091
source "$(dirname "$0")/../etrade-morning.sh"

if [[ "$(uname -s)" == "Linux" ]]; then
  declare -F start_service > /dev/null || { echo "FAIL: start_service not defined on Linux"; exit 1; }
  declare -f start_service | grep -q systemctl || { echo "FAIL: Linux start_service should use systemctl"; exit 1; }
  declare -f stop_service  | grep -q systemctl || { echo "FAIL: Linux stop_service should use systemctl"; exit 1; }
else
  declare -F start_service > /dev/null || { echo "FAIL: start_service not defined on macOS"; exit 1; }
  declare -f start_service | grep -q screen || { echo "FAIL: macOS start_service should use screen"; exit 1; }
fi

echo "PASS"
