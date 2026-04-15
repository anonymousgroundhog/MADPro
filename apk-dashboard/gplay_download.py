"""
Bridge script: called by tools-api.js to download APKs via the Play Store
using Appium + ADB (no Google account token required).

Usage:
  python gplay_download.py <device_serial_or_""> <output_dir> <timeout_sec> <pkg1> [pkg2 ...]

Output is line-buffered plain text streamed to stdout.
Exit code 0 = success, non-zero = failure.
"""
import sys
import os

# Add project root to path so core.* imports work
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, PROJECT_ROOT)


def log(msg: str):
    print(msg, flush=True)


def main():
    if len(sys.argv) < 5:
        log("Usage: gplay_download.py <device_serial|''>  <output_dir>  <timeout_sec>  <pkg> [pkg ...]")
        sys.exit(1)

    device_serial = sys.argv[1] if sys.argv[1] else None
    output_dir    = sys.argv[2]
    timeout_sec   = int(sys.argv[3]) if sys.argv[3].isdigit() else 180
    packages      = sys.argv[4:]

    os.makedirs(output_dir, exist_ok=True)

    from core.appium_downloader import (
        is_appium_available, is_uia2_driver_installed,
        start_appium_server, download_via_appium,
    )

    if not is_appium_available():
        log("ERROR: Appium is not installed.")
        log("  Install: npm install -g appium")
        log("  Then:    appium driver install uiautomator2")
        sys.exit(1)

    if not is_uia2_driver_installed():
        log("ERROR: Appium uiautomator2 driver not installed.")
        log("  Run: appium driver install uiautomator2")
        sys.exit(1)

    log("Starting Appium server...")
    ok = start_appium_server(on_output=log)
    if not ok:
        log("ERROR: Appium server failed to start.")
        sys.exit(1)

    log(f"Downloading {len(packages)} app(s) via Play Store on device: {device_serial or 'first available'}...")
    pulled = download_via_appium(
        packages=packages,
        output_dir=output_dir,
        device_serial=device_serial,
        on_output=log,
        timeout_sec=timeout_sec,
    )

    log(f"--- Done: {len(pulled)}/{len(packages)} app(s) downloaded ---")
    for pkg in pulled:
        log(f"  Downloaded: {pkg}")

    sys.exit(0 if pulled else 1)


if __name__ == "__main__":
    main()
