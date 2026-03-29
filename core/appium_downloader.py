"""
Appium-based APK downloader.

Automates the Google Play Store UI on a running Android emulator to install
apps, then pulls the APK via adb.  No Google account token required — the
emulator must already be signed in to a Google account.

Requirements (auto-installed via setup_appium()):
  npm install -g appium
  appium driver install uiautomator2

Python dependency (pip install Appium-Python-Client) is already available.
"""
import os
import re
import subprocess
import threading
import time
from typing import Callable


# ------------------------------------------------------------------ #
#  Setup / availability checks                                         #
# ------------------------------------------------------------------ #

def _find_appium_cli() -> str | None:
    """
    Returns a path to the appium CLI, checking:
      1. PATH (npm global install)
      2. Common npm global bin dirs
      3. Appium Desktop AppImage embedded node_modules
    Returns None if not found.
    """
    import shutil
    import glob

    # 1. On PATH
    found = shutil.which("appium")
    if found:
        return found

    # 2. Common npm global bin dirs
    home = os.path.expanduser("~")
    candidates = [
        os.path.join(home, ".npm-global", "bin", "appium"),
        os.path.join(home, ".local", "bin", "appium"),
        "/usr/local/bin/appium",
        "/usr/bin/appium",
    ]
    # nvm installs
    candidates += glob.glob(
        os.path.join(home, ".nvm", "versions", "node", "*", "bin", "appium"))

    for c in candidates:
        if os.path.isfile(c) and os.access(c, os.X_OK):
            return c

    return None


def is_appium_server_running() -> bool:
    """Returns True if an Appium server is already listening on port 4723."""
    import urllib.request
    import urllib.error
    for path in ("/status", "/wd/hub/status"):
        try:
            urllib.request.urlopen(
                f"http://127.0.0.1:{_appium_port}{path}", timeout=2)
            return True
        except Exception:
            pass
    return False


def is_appium_available() -> bool:
    """True if appium CLI is on PATH/known dirs OR server is already running."""
    return _find_appium_cli() is not None or is_appium_server_running()


def is_uia2_driver_installed() -> bool:
    """
    Returns True if the uiautomator2 driver is installed.
    When the Appium Desktop GUI app is running we trust it has the driver
    bundled (it ships with uiautomator2 by default in v1.x).
    """
    cli = _find_appium_cli()
    if cli:
        try:
            r = subprocess.run([cli, "driver", "list", "--installed"],
                               capture_output=True, text=True, timeout=15)
            return "uiautomator2" in r.stdout.lower()
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass

    # Appium Desktop 1.x ships uiautomator2 bundled — if server is running
    # we can assume the driver is available
    if is_appium_server_running():
        return True

    # Check Appium Desktop AppImage mount for embedded uia2 driver
    import glob
    mounts = glob.glob("/tmp/.mount_Appium*/resources/app/node_modules/appium-uiautomator2-driver")
    return bool(mounts)


def setup_appium(
    on_output: Callable[[str], None] | None = None,
    stop_event: threading.Event | None = None,
) -> bool:
    """
    Installs Appium and the uiautomator2 driver if not already present.
    Returns True when everything is ready.
    """
    def log(msg):
        if on_output:
            on_output(msg)

    if not is_appium_available():
        log("Installing Appium (npm install -g appium)...")
        try:
            proc = subprocess.Popen(
                ["npm", "install", "-g", "appium"],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            )
            for line in iter(proc.stdout.readline, ""):
                if stop_event and stop_event.is_set():
                    proc.terminate()
                    return False
                if line.strip():
                    log(line.rstrip())
            proc.wait()
            if proc.returncode != 0:
                log("ERROR: npm install failed. Ensure Node.js is installed.")
                return False
        except FileNotFoundError:
            log("ERROR: 'npm' not found. Install Node.js from https://nodejs.org")
            return False
    else:
        log("Appium already installed.")

    if not is_uia2_driver_installed():
        log("Installing uiautomator2 driver...")
        try:
            proc = subprocess.Popen(
                ["appium", "driver", "install", "uiautomator2"],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            )
            for line in iter(proc.stdout.readline, ""):
                if stop_event and stop_event.is_set():
                    proc.terminate()
                    return False
                if line.strip():
                    log(line.rstrip())
            proc.wait()
            if proc.returncode != 0:
                log("ERROR: uiautomator2 driver install failed.")
                return False
        except FileNotFoundError:
            log("ERROR: 'appium' command not found after install.")
            return False
    else:
        log("uiautomator2 driver already installed.")

    log("Appium setup complete.")
    return True


# ------------------------------------------------------------------ #
#  Appium server lifecycle                                             #
# ------------------------------------------------------------------ #

_appium_proc: subprocess.Popen | None = None
_appium_port: int = 4723
_active_driver = None  # holds the current webdriver session for cancellation


def start_appium_server(
    on_output: Callable[[str], None] | None = None,
) -> bool:
    """Starts the Appium server in the background. Returns True when ready."""
    global _appium_proc

    def log(msg):
        if on_output:
            on_output(msg)

    # Already running (our process or Appium Desktop)
    if is_appium_server_running():
        log("Appium server already running.")
        return True

    if _appium_proc and _appium_proc.poll() is None:
        return True

    cli = _find_appium_cli()
    if not cli:
        log("ERROR: Appium CLI not found and server is not running.")
        log("Start the Appium Desktop app and click the Start Server button.")
        return False

    try:
        _appium_proc = subprocess.Popen(
            [cli, "--port", str(_appium_port), "--log-level", "warn"],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
    except FileNotFoundError:
        log("ERROR: appium not found. Run Setup first.")
        return False

    # Drain output in background
    def _drain():
        for line in iter(_appium_proc.stdout.readline, ""):
            if on_output and line.strip():
                on_output(f"[appium] {line.rstrip()}")

    threading.Thread(target=_drain, daemon=True).start()

    # Wait up to 10 s for the server to be ready
    deadline = time.time() + 10
    while time.time() < deadline:
        try:
            import urllib.request
            urllib.request.urlopen(
                f"http://127.0.0.1:{_appium_port}/status", timeout=2)
            log("Appium server ready.")
            return True
        except Exception:
            time.sleep(0.5)

    log("WARNING: Appium server did not respond in time — proceeding anyway.")
    return True


def cancel_active_session(on_output: Callable[[str], None] | None = None):
    """Quits the active Appium driver session to unblock any waiting calls."""
    global _active_driver
    if _active_driver is not None:
        try:
            _active_driver.quit()
            if on_output:
                on_output("Appium session cancelled.")
        except Exception:
            pass
        _active_driver = None


def stop_appium_server():
    global _appium_proc
    if _appium_proc and _appium_proc.poll() is None:
        _appium_proc.terminate()
    _appium_proc = None


# ------------------------------------------------------------------ #
#  Play Store automation                                               #
# ------------------------------------------------------------------ #

_PLAY_STORE_PKG = "com.android.vending"
_PLAY_STORE_ACTIVITY = "com.google.android.finsky.activities.MainActivity"


def _get_device_serial(serial: str | None = None) -> str | None:
    """Returns the first available emulator serial if none specified."""
    from core.adb_manager import list_adb_devices
    devices = list_adb_devices()
    if not devices:
        return None
    if serial:
        return serial if any(d["serial"] == serial for d in devices) else None
    # Prefer emulator
    emu = next((d for d in devices if d["type"] == "emulator"), None)
    return (emu or devices[0])["serial"]


def _pull_apk(serial: str, package: str, output_dir: str,
              on_output: Callable[[str], None] | None = None) -> str | None:
    """
    Finds the installed APK path via pm path, pulls it with adb, and
    returns the local file path, or None on failure.
    """
    def log(msg):
        if on_output:
            on_output(msg)

    try:
        r = subprocess.run(
            ["adb", "-s", serial, "shell", "pm", "path", package],
            capture_output=True, text=True, timeout=15,
        )
        # output: "package:/data/app/…/base.apk"
        match = re.search(r"package:(.+\.apk)", r.stdout)
        if not match:
            log(f"  Could not locate APK for {package} on device.")
            return None
        device_path = match.group(1).strip()
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        log(f"  adb pm path failed: {e}")
        return None

    os.makedirs(output_dir, exist_ok=True)
    local_path = os.path.join(output_dir, f"{package}.apk")
    log(f"  Pulling {device_path} → {local_path}")
    try:
        r = subprocess.run(
            ["adb", "-s", serial, "pull", device_path, local_path],
            capture_output=True, text=True, timeout=120,
        )
        if r.returncode != 0:
            log(f"  adb pull failed: {r.stderr.strip()}")
            return None
        return local_path
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        log(f"  adb pull error: {e}")
        return None


def download_via_appium(
    packages: list[str],
    output_dir: str,
    device_serial: str | None = None,
    on_output: Callable[[str], None] | None = None,
    stop_event: threading.Event | None = None,
) -> list[str]:
    """
    For each package name:
      1. Opens Play Store on the emulator
      2. Searches for the package by ID
      3. Taps Install / Open (if already installed)
      4. Waits for installation
      5. Pulls the APK via adb

    Returns list of successfully pulled local APK paths.
    """
    from appium import webdriver
    from appium.options import AppiumOptions
    from appium.webdriver.common.appiumby import AppiumBy
    from selenium.webdriver.support.ui import WebDriverWait
    from selenium.webdriver.support import expected_conditions as EC
    from selenium.common.exceptions import TimeoutException, NoSuchElementException

    def log(msg):
        if on_output:
            on_output(msg)

    serial = _get_device_serial(device_serial)
    if not serial:
        log("ERROR: No Android device/emulator found. Start one in the Device panel.")
        return []

    log(f"Connecting to device {serial}...")

    options = AppiumOptions()
    options.platform_name = "Android"
    options.automation_name = "UiAutomator2"
    options.udid = serial
    options.no_reset = True
    options.load_capabilities({
        "appPackage": _PLAY_STORE_PKG,
        "appActivity": _PLAY_STORE_ACTIVITY,
        "autoGrantPermissions": True,
        "newCommandTimeout": 120,
    })

    global _active_driver
    try:
        driver = webdriver.Remote(
            f"http://127.0.0.1:{_appium_port}",
            options=options,
        )
        _active_driver = driver
    except Exception as e:
        log(f"ERROR: Could not connect to Appium: {e}")
        return []

    def _wait_for(xpath: str, timeout: int) -> object | None:
        """Polls for an element, checking stop_event every second. Returns element or None."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            if stop_event and stop_event.is_set():
                return None
            try:
                el = driver.find_element(AppiumBy.XPATH, xpath)
                return el
            except NoSuchElementException:
                time.sleep(1)
        return None

    pulled: list[str] = []

    try:
        for package in packages:
            if stop_event and stop_event.is_set():
                log("Cancelled.")
                break

            log(f"[{package}] Opening Play Store...")
            try:
                driver.execute_script(
                    "mobile: deepLink",
                    {"url": f"market://details?id={package}",
                     "package": _PLAY_STORE_PKG},
                )

                # Wait up to 10s for page to load
                for _ in range(10):
                    if stop_event and stop_event.is_set():
                        break
                    time.sleep(1)

                if stop_event and stop_event.is_set():
                    log("Cancelled.")
                    break

                # Check for Install / Update button
                install_btn = _wait_for(
                    '//android.widget.Button[@text="Install" or @text="Update"]',
                    timeout=15,
                )

                if stop_event and stop_event.is_set():
                    log("Cancelled.")
                    break

                if install_btn:
                    log(f"[{package}] Tapping Install...")
                    install_btn.click()
                    log(f"[{package}] Waiting for installation (up to 3 min)...")
                    open_btn = _wait_for(
                        '//android.widget.Button[@text="Open" or @text="Uninstall"]',
                        timeout=180,
                    )
                    if stop_event and stop_event.is_set():
                        log("Cancelled.")
                        break
                    if not open_btn:
                        log(f"[{package}] WARNING: Install timed out — skipping.")
                        continue
                    log(f"[{package}] Installed.")
                else:
                    # Check if already installed
                    open_btn = _wait_for(
                        '//android.widget.Button[@text="Open"]', timeout=5)
                    if open_btn:
                        log(f"[{package}] Already installed.")
                    else:
                        log(f"[{package}] WARNING: Could not find Install/Open — skipping.")
                        continue

                path = _pull_apk(serial, package, output_dir, on_output)
                if path:
                    pulled.append(path)
                    log(f"[{package}] Saved to {path}")

            except Exception as e:
                if stop_event and stop_event.is_set():
                    log("Cancelled.")
                    break
                log(f"[{package}] ERROR: {e}")
                continue

    finally:
        _active_driver = None
        try:
            driver.quit()
        except Exception:
            pass
        log("Appium session closed.")

    return pulled
