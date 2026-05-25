#!/usr/bin/env bash
# start-emulator.sh — launch an API 36 AVD with the correct renderer flags.
#
# Usage:
#   ./start-emulator.sh [avd-name]
#
# Defaults to Research_36 (android-36 / google_apis / x86_64).
#
# Why -feature GuestAngle:
#   Emulator 36.x disables GuestAngle for API > 35 by default, leaving the
#   window as a solid grey screen. Forcing it enables Vulkan composition and
#   the skiavk renderer, which produces a working display on Intel/Mesa hosts.

set -euo pipefail

AVD="${1:-Research_36}"
SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Android/Sdk}}"
EMULATOR="$SDK/emulator/emulator"
ADB="$SDK/platform-tools/adb"

# ── Sanity checks ─────────────────────────────────────────────────────────────

if [[ ! -x "$EMULATOR" ]]; then
  echo "ERROR: emulator not found at $EMULATOR"
  echo "       Set ANDROID_HOME or install the Android SDK emulator package."
  exit 1
fi

if [[ ! -x "$ADB" ]]; then
  echo "ERROR: adb not found at $ADB"
  exit 1
fi

# Check AVD exists
if ! "$SDK/cmdline-tools/latest/bin/avdmanager" list avd -c 2>/dev/null | grep -qx "$AVD"; then
  echo "ERROR: AVD '$AVD' not found."
  echo "Available AVDs:"
  "$SDK/cmdline-tools/latest/bin/avdmanager" list avd -c 2>/dev/null || true
  exit 1
fi

# ── Kill any existing instance of this AVD ────────────────────────────────────

pkill -f "emulator.*-avd $AVD" 2>/dev/null || true
sleep 1

# ── Launch ────────────────────────────────────────────────────────────────────

echo "[INFO] Launching AVD: $AVD"
echo "[INFO] Emulator: $EMULATOR"
echo "[INFO] Display: ${DISPLAY:-not set}"

"$EMULATOR" \
  -avd "$AVD" \
  -gpu host \
  -no-snapshot \
  -feature -Vulkan \
  &

EMU_PID=$!
echo "[INFO] Emulator PID: $EMU_PID"

# ── Wait for ADB device to come online ───────────────────────────────────────

echo "[INFO] Waiting for device to appear in ADB..."
TIMEOUT=300
ELAPSED=0
SERIAL=""

while [[ $ELAPSED -lt $TIMEOUT ]]; do
  SERIAL=$("$ADB" devices 2>/dev/null \
    | awk '/^emulator-[0-9]+[[:space:]]+device$/ {print $1}' \
    | tail -1)
  if [[ -n "$SERIAL" ]]; then
    echo "[INFO] Device online: $SERIAL"
    break
  fi
  sleep 3
  ELAPSED=$((ELAPSED + 3))
done

if [[ -z "$SERIAL" ]]; then
  echo "ERROR: No emulator came online within ${TIMEOUT}s"
  kill "$EMU_PID" 2>/dev/null || true
  exit 1
fi

# ── Wait for boot_completed ───────────────────────────────────────────────────

echo "[INFO] Waiting for boot to complete..."
"$ADB" -s "$SERIAL" wait-for-device

ELAPSED=0
while [[ $ELAPSED -lt $TIMEOUT ]]; do
  BOOTED=$("$ADB" -s "$SERIAL" shell getprop sys.boot_completed 2>/dev/null | tr -d '[:space:]')
  if [[ "$BOOTED" == "1" ]]; then
    echo "[INFO] Boot complete."
    break
  fi
  sleep 3
  ELAPSED=$((ELAPSED + 3))
done

if [[ "$BOOTED" != "1" ]]; then
  echo "ERROR: Boot did not complete within ${TIMEOUT}s"
  exit 1
fi

# ── Wake screen ───────────────────────────────────────────────────────────────

sleep 2
"$ADB" -s "$SERIAL" shell input keyevent KEYCODE_WAKEUP 2>/dev/null || true
sleep 1
"$ADB" -s "$SERIAL" shell input keyevent KEYCODE_MENU   2>/dev/null || true
sleep 2

echo ""
echo "[OK] Emulator ready — serial: $SERIAL"
echo "     madpro instrument <apk-dir> -d $SERIAL"
