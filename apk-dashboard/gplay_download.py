"""
Bridge script: called by tools-api.js to download APKs via the Play Store
using Appium + ADB (no Google account token required).

Usage (package list mode):
  python gplay_download.py <device_serial|''>  <output_dir>  <timeout_sec>  <pkg> [pkg ...]

Usage (category-browse mode — triggered when scrape falls short of requested count):
  python gplay_download.py --browse-category <CAT_ID> --count <N> <device_serial|''>  <output_dir>  <timeout_sec>

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


def _ensure_appium():
    from core.appium_downloader import (
        is_appium_available, is_uia2_driver_installed,
        start_appium_server,
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


def main():
    args = sys.argv[1:]

    # --- Category-browse mode ---
    if len(args) >= 2 and args[0] == "--browse-category":
        category_id = args[1]
        remaining_args = args[2:]

        count = 10  # default
        if remaining_args and remaining_args[0] == "--count":
            count = int(remaining_args[1])
            remaining_args = remaining_args[2:]

        if len(remaining_args) < 3:
            log("Usage: gplay_download.py --browse-category <CAT_ID> --count <N> <serial|''> <output_dir> <timeout_sec>")
            sys.exit(1)

        device_serial = remaining_args[0] if remaining_args[0] else None
        output_dir    = remaining_args[1]
        timeout_sec   = int(remaining_args[2]) if remaining_args[2].isdigit() else 180

        os.makedirs(output_dir, exist_ok=True)
        _ensure_appium()

        from core.appium_downloader import download_category_via_appium

        log(f"[CATEGORY BROWSE] {category_id}: collecting up to {count} app(s) via Play Store category page...")
        pulled = download_category_via_appium(
            category_id=category_id,
            count=count,
            output_dir=output_dir,
            device_serial=device_serial,
            on_output=log,
            timeout_sec=timeout_sec,
        )
        log(f"--- Done: {len(pulled)}/{count} app(s) downloaded from category {category_id} ---")
        for pkg in pulled:
            log(f"  Downloaded: {pkg}")
        sys.exit(0 if pulled else 1)

    # --- Package list mode ---
    if len(args) < 4:
        log("Usage: gplay_download.py <device_serial|''>  <output_dir>  <timeout_sec>  <pkg> [pkg ...]")
        sys.exit(1)

    device_serial = args[0] if args[0] else None
    output_dir    = args[1]
    timeout_sec   = int(args[2]) if args[2].isdigit() else 180
    packages      = args[3:]

    os.makedirs(output_dir, exist_ok=True)
    _ensure_appium()

    from core.appium_downloader import download_via_appium

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
