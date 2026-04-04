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


def _appium_base_url() -> str:
    """
    Returns the correct WebDriver base URL for the running Appium server.
    Appium 1.x (including Appium Desktop) uses /wd/hub.
    Appium 2.x+ uses the root /.
    """
    import urllib.request
    # Try Appium 2.x root endpoint first
    try:
        urllib.request.urlopen(
            f"http://127.0.0.1:{_appium_port}/status", timeout=2)
        return f"http://127.0.0.1:{_appium_port}"
    except Exception:
        pass
    # Fall back to Appium 1.x /wd/hub
    return f"http://127.0.0.1:{_appium_port}/wd/hub"


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

    # Wait up to 10 s for the server to be ready (check both 1.x and 2.x paths)
    deadline = time.time() + 10
    while time.time() < deadline:
        if is_appium_server_running():
            log("Appium server ready.")
            return True
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


def _find_adb() -> str:
    """Returns path to adb, checking SDK platform-tools before PATH."""
    import shutil
    home = os.path.expanduser("~")
    sdk_roots = [
        os.environ.get("ANDROID_HOME", ""),
        os.environ.get("ANDROID_SDK_ROOT", ""),
        os.path.join(home, "Android", "Sdk"),
        os.path.join(home, "android-sdk"),
        "/opt/android-sdk",
    ]
    for root in sdk_roots:
        if not root:
            continue
        candidate = os.path.join(root, "platform-tools", "adb")
        if os.path.isfile(candidate):
            return candidate
    return shutil.which("adb") or "adb"


def _pull_apks(serial: str, package: str, output_dir: str,
               on_output: Callable[[str], None] | None = None) -> list[str]:
    """
    Pulls ALL APK files for a package (base APK + all split/library APKs)
    using `pm path --user 0` which lists every installed path.

    Returns a list of successfully pulled local file paths.
    """
    def log(msg):
        if on_output:
            on_output(msg)

    adb = _find_adb()

    # `pm path --user 0 <pkg>` returns one line per APK:
    #   package:/data/app/.../base.apk
    #   package:/data/app/.../split_config.arm64_v8a.apk
    #   …
    # Fall back to plain `pm path` if --user 0 isn't supported.
    device_paths = []
    for pm_args in [["pm", "path", "--user", "0", package],
                    ["pm", "path", package]]:
        try:
            r = subprocess.run(
                [adb, "-s", serial, "shell"] + pm_args,
                capture_output=True, text=True, timeout=15,
            )
            paths = re.findall(r"package:(.+\.apk)", r.stdout)
            if paths:
                device_paths = [p.strip() for p in paths]
                break
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            log(f"  adb pm path failed: {e}")
            return []

    if not device_paths:
        log(f"  Could not locate any APK for {package} on device.")
        return []

    os.makedirs(output_dir, exist_ok=True)
    log(f"  Found {len(device_paths)} APK file(s) for {package}")

    pulled = []
    for device_path in device_paths:
        filename = os.path.basename(device_path)
        local_path = os.path.join(output_dir, filename)
        log(f"  Pulling {filename} → {output_dir}/")
        try:
            r = subprocess.run(
                [adb, "-s", serial, "pull", device_path, local_path],
                capture_output=True, text=True, timeout=120,
            )
            if r.returncode == 0:
                pulled.append(local_path)
            else:
                log(f"  [WARN] pull failed for {filename}: {r.stderr.strip()}")
        except (FileNotFoundError, subprocess.TimeoutExpired) as e:
            log(f"  [WARN] pull error for {filename}: {e}")

    if pulled:
        log(f"  [OK] Pulled {len(pulled)}/{len(device_paths)} file(s) to {output_dir}")
    else:
        log(f"  [FAILED] No files pulled for {package}")

    return pulled


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
    from appium.options.android.uiautomator2.base import UiAutomator2Options
    from appium.webdriver.common.appiumby import AppiumBy
    from selenium.common.exceptions import NoSuchElementException

    def log(msg):
        if on_output:
            on_output(msg)

    serial = _get_device_serial(device_serial)
    if not serial:
        log("ERROR: No Android device/emulator found. Start one in the Device panel.")
        return []

    log(f"Connecting to device {serial}...")

    options = UiAutomator2Options()
    options.udid = serial
    options.no_reset = True
    # Don't set app_package/app_activity — Appium tries to force-stop and
    # relaunch the app, which fails on physical devices with "multiple activities".
    # Instead we connect to the device generically and use deepLink to navigate.
    options.auto_grant_permissions = True
    options.new_command_timeout = 120

    base_url = _appium_base_url()
    log(f"Connecting to Appium at {base_url}...")

    global _active_driver
    try:
        driver = webdriver.Remote(
            base_url,
            options=options,
        )
        _active_driver = driver
    except Exception as e:
        log(f"ERROR: Could not connect to Appium: {e}")
        return []

    def _find_by_uia(selector: str, timeout: int) -> object | None:
        """
        Finds an element using UiAutomator2 selector string.
        Polls every second up to timeout seconds.
        UiSelector can match on text(), textContains(), description(), etc.
        and can traverse the hierarchy with childSelector / fromParent.
        """
        deadline = time.time() + timeout
        while time.time() < deadline:
            if stop_event and stop_event.is_set():
                return None
            try:
                el = driver.find_element(AppiumBy.ANDROID_UIAUTOMATOR, selector)
                return el
            except NoSuchElementException:
                time.sleep(1)
        return None

    def _find_install_btn(timeout: int) -> object | None:
        """
        Finds the tappable Install/Update element on the Play Store app page.
        Play Store renders 'Install' as a TextView inside a clickable FrameLayout,
        so @text on Button won't work. We use several strategies in order:
          1. UiAutomator: clickable container whose child has text 'Install'/'Update'
          2. Broad text match across all clickable views
          3. resource-id fallback
        """
        deadline = time.time() + timeout
        while time.time() < deadline:
            if stop_event and stop_event.is_set():
                return None
            for selector in [
                # Strategy 1: clickable view containing a child with Install/Update text
                'new UiSelector().clickable(true).childSelector(new UiSelector().textMatches("(?i)install|update"))',
                # Strategy 2: any element (including TextView) with matching text that IS clickable
                'new UiSelector().textMatches("(?i)install|update").clickable(true)',
                # Strategy 3: description match
                'new UiSelector().descriptionMatches("(?i)install|update")',
            ]:
                try:
                    el = driver.find_element(AppiumBy.ANDROID_UIAUTOMATOR, selector)
                    return el
                except NoSuchElementException:
                    pass
            time.sleep(1)
        return None

    def _find_done_btn(timeout: int) -> object | None:
        """Finds Open/Uninstall after install completes."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            if stop_event and stop_event.is_set():
                return None
            for selector in [
                'new UiSelector().clickable(true).childSelector(new UiSelector().textMatches("(?i)^open$|^uninstall$"))',
                'new UiSelector().textMatches("(?i)^open$|^uninstall$").clickable(true)',
                'new UiSelector().descriptionMatches("(?i)^open$|^uninstall$")',
            ]:
                try:
                    el = driver.find_element(AppiumBy.ANDROID_UIAUTOMATOR, selector)
                    return el
                except NoSuchElementException:
                    pass
            time.sleep(1)
        return None

    # pulled_packages: list of package names successfully downloaded (not individual files)
    pulled_packages: list[str] = []
    # pulled: flat list of all local APK file paths (base + splits)
    pulled: list[str] = []

    try:
        for package in packages:
            if stop_event and stop_event.is_set():
                log("Cancelled.")
                break

            # Skip if already downloaded to the output directory
            pkg_dir = os.path.join(output_dir, package)
            if os.path.isdir(pkg_dir) and any(
                f.endswith(".apk") for f in os.listdir(pkg_dir)
            ):
                log(f"[{package}] Already exists in {pkg_dir} — skipping.")
                continue

            log(f"[{package}] Opening Play Store...")
            try:
                driver.execute_script(
                    "mobile: deepLink",
                    {"url": f"market://details?id={package}",
                     "package": _PLAY_STORE_PKG},
                )

                # Wait for page to settle
                time.sleep(4)

                if stop_event and stop_event.is_set():
                    log("Cancelled.")
                    break

                # Check if already installed on device (Open button present)
                already_on_device = _find_by_uia(
                    'new UiSelector().clickable(true).childSelector(new UiSelector().textMatches("(?i)^open$"))',
                    timeout=3,
                )
                if already_on_device:
                    log(f"[{package}] Already installed on device — pulling APKs...")
                else:
                    install_btn = _find_install_btn(timeout=15)
                    if stop_event and stop_event.is_set():
                        log("Cancelled.")
                        break

                    if not install_btn:
                        log(f"[{package}] WARNING: Could not find Install/Update button — skipping.")
                        continue

                    log(f"[{package}] Tapping Install...")
                    install_btn.click()
                    log(f"[{package}] Waiting for installation (up to 3 min)...")

                    done = _find_done_btn(timeout=180)
                    if stop_event and stop_event.is_set():
                        log("Cancelled.")
                        break
                    if not done:
                        log(f"[{package}] WARNING: Install timed out — skipping.")
                        continue
                    log(f"[{package}] Installed.")

                # Pull all APKs (base + splits/libs)
                paths = _pull_apks(serial, package, pkg_dir, on_output)
                if not paths:
                    log(f"[{package}] WARNING: Pull failed — not counting as downloaded.")
                else:
                    pulled.extend(paths)
                    pulled_packages.append(package)
                    log(f"[{package}] Saved {len(paths)} file(s) to {pkg_dir}")

                # Uninstall from device after pulling to free space
                log(f"[{package}] Uninstalling from device...")
                try:
                    adb = _find_adb()
                    subprocess.run(
                        [adb, "-s", serial, "uninstall", package],
                        capture_output=True, timeout=30,
                    )
                    log(f"[{package}] Uninstalled.")
                except Exception as e_uninstall:
                    log(f"[{package}] WARNING: Uninstall failed: {e_uninstall}")

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

    # Return package names (not individual file paths) so callers can count apps
    return pulled_packages
