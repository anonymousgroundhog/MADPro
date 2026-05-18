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
import json
import os
import re
import subprocess
import threading
import time
from typing import Callable

SKIP_LIST_FILENAME = ".skip_list.json"


def _load_skip_list(output_dir: str) -> dict:
    path = os.path.join(output_dir, SKIP_LIST_FILENAME)
    if not os.path.isfile(path):
        return {}
    try:
        with open(path) as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _save_skip_entry(output_dir: str, package: str, reason: str):
    path = os.path.join(output_dir, SKIP_LIST_FILENAME)
    data = _load_skip_list(output_dir)
    data[package] = {"reason": reason, "ts": int(time.time())}
    try:
        os.makedirs(output_dir, exist_ok=True)
        with open(path, "w") as f:
            json.dump(data, f, indent=2)
    except OSError:
        pass


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
    # Appium Desktop 1.x ships uiautomator2 bundled — if server is running
    # we can assume the driver is available
    if is_appium_server_running():
        return True

    cli = _find_appium_cli()
    if cli:
        try:
            r = subprocess.run([cli, "driver", "list", "--installed"],
                               capture_output=True, text=True, timeout=15)
            return "uiautomator2" in r.stdout.lower()
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass

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
               on_output: Callable[[str], None] | None = None,
               timeout_sec: int = 60,
               stop_event: threading.Event | None = None) -> list[str]:
    """
    Pulls ALL APK files for a package (base APK + all split/library APKs)
    using `pm path --user 0` which lists every installed path.

    Polls `pm path` until the package is registered or `timeout_sec` elapses
    (Play Store reports "Installed" via UI before the package manager has
    committed the install on slow devices). On total failure, removes
    `output_dir` if it's empty so failed installs do not leave orphans behind.

    Returns a list of successfully pulled local file paths.
    """
    def log(msg):
        if on_output:
            on_output(msg)

    adb = _find_adb()

    def _cleanup_empty_dir():
        try:
            if os.path.isdir(output_dir) and not os.listdir(output_dir):
                os.rmdir(output_dir)
        except Exception:
            pass

    pm_strategies = [
        ["pm", "path", "--user", "0", package],
        ["pm", "path", package],
        ["cmd", "package", "path", package],
        ["pm", "list", "packages", "-f", package],  # last resort, format differs
    ]

    device_paths: list[str] = []
    deadline = time.time() + max(int(timeout_sec or 0), 5)
    poll_interval = 5  # seconds between probes
    attempt = 0
    last_progress_log = 0.0
    while time.time() < deadline:
        if stop_event and stop_event.is_set():
            log(f"  [{package}] pm path polling cancelled.")
            _cleanup_empty_dir()
            return []
        attempt += 1
        for pm_args in pm_strategies:
            try:
                r = subprocess.run(
                    [adb, "-s", serial, "shell"] + pm_args,
                    capture_output=True, text=True, timeout=15,
                )
            except (FileNotFoundError, subprocess.TimeoutExpired) as e:
                log(f"  adb pm path failed: {e}")
                _cleanup_empty_dir()
                return []
            stdout = r.stdout or ""
            # Both `pm path` and `cmd package path` emit `package:/path/to/.apk`.
            paths = re.findall(r"package:(.+\.apk)", stdout)
            if not paths and pm_args[:3] == ["pm", "list", "packages"]:
                # `pm list packages -f <pkg>` emits `package:/path/=<pkg>`.
                paths = re.findall(r"package:(\S+\.apk)=", stdout)
            if paths:
                device_paths = [p.strip() for p in paths]
                break
        if device_paths:
            break
        # Heartbeat every ~30s so the user/UI knows we're still polling.
        now = time.time()
        if now - last_progress_log >= 30:
            remaining = max(0, int(deadline - now))
            log(f"  [{package}] Waiting for package manager to register install — "
                f"{remaining}s of {int(timeout_sec)}s budget remaining (poll {attempt}).")
            last_progress_log = now
        # Sleep but wake early if cancelled.
        slept = 0.0
        while slept < poll_interval and time.time() < deadline:
            if stop_event and stop_event.is_set():
                break
            time.sleep(0.5)
            slept += 0.5

    if not device_paths:
        log(f"  Could not locate any APK for {package} on device after {int(timeout_sec)}s.")
        _cleanup_empty_dir()
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
        _cleanup_empty_dir()

    return pulled


def _make_appium_session(serial: str, base_url: str):
    """Create a new UiAutomator2 Appium session. Returns driver or raises."""
    from appium import webdriver
    from appium.options.android.uiautomator2.base import UiAutomator2Options
    options = UiAutomator2Options()
    options.udid = serial
    options.no_reset = True
    options.auto_grant_permissions = True
    # 3600s = 1 hour; prevents session expiry during long adb pull operations
    options.new_command_timeout = 3600
    return webdriver.Remote(base_url, options=options)


def _run_package_loop(
    driver,
    packages: list[str],
    output_dir: str,
    serial: str,
    base_url: str,
    on_output: Callable[[str], None] | None = None,
    stop_event: threading.Event | None = None,
    timeout_sec: int = 180,
) -> list[str]:
    """
    Core per-package download loop reused by both download_via_appium and
    download_category_via_appium.  Operates on an existing Appium driver session.

    Returns list of successfully downloaded package names.
    Mutates `driver` ref via nonlocal — caller should track _active_driver separately.
    """
    from appium.webdriver.common.appiumby import AppiumBy
    from selenium.common.exceptions import NoSuchElementException

    def log(msg):
        if on_output:
            on_output(msg)

    def _find_by_uia(selector: str, timeout: int):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if stop_event and stop_event.is_set():
                return None
            try:
                return driver.find_element(AppiumBy.ANDROID_UIAUTOMATOR, selector)
            except NoSuchElementException:
                time.sleep(1)
        return None

    def _tap_btn_by_label(label_pattern: str, timeout: int) -> bool:
        """
        Find a button whose visible label (text or content-desc) matches
        label_pattern (case-insensitive regex) and tap it — regardless of whether
        the matched element itself is clickable.  Play Store renders button labels
        as non-clickable TextViews/Views inside a clickable parent container, so
        we locate the label element and tap via its centre coordinates.
        Returns True if tapped within timeout.
        """
        deadline = time.time() + timeout
        while time.time() < deadline:
            if stop_event and stop_event.is_set():
                return False
            for selector in [
                f'new UiSelector().textMatches("(?i){label_pattern}")',
                f'new UiSelector().descriptionMatches("(?i){label_pattern}")',
            ]:
                try:
                    el = driver.find_element(AppiumBy.ANDROID_UIAUTOMATOR, selector)
                    loc    = el.location
                    size   = el.size
                    cx     = int(loc["x"] + size["width"]  / 2)
                    cy     = int(loc["y"] + size["height"] / 2)
                    driver.tap([(cx, cy)])
                    return True
                except (NoSuchElementException, Exception):
                    pass
            time.sleep(1)
        return False

    def _find_install_btn(timeout: int):
        """Return the Install/Update label element (may be non-clickable)."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            if stop_event and stop_event.is_set():
                return None
            for selector in [
                'new UiSelector().textMatches("(?i)^install$|^update$")',
                'new UiSelector().descriptionMatches("(?i)^install$|^update$")',
                # Fallback: clickable parent with Install child (older Play Store)
                'new UiSelector().clickable(true).childSelector(new UiSelector().textMatches("(?i)install|update"))',
            ]:
                try:
                    return driver.find_element(AppiumBy.ANDROID_UIAUTOMATOR, selector)
                except NoSuchElementException:
                    pass
            time.sleep(1)
        return None

    # Compiled once, reused every call
    _PRICE_RE = re.compile(
        r'[$€£¥₹₩₪₫₱฿]\s*\d|'
        r'\d\s*[$€£¥₹₩₪₫₱฿]|'
        r'\b(?:USD|EUR|GBP|JPY|INR|CAD|AUD|CHF|CNY|KRW|MXN|BRL|ZAR)\b\s*\d'
    )
    _SKIP_RE = re.compile(
        r'(?i)not available|not compatible|incompatible|'
        r"isn.t available|isn.t compatible|not sold|item not found|"
        r'your device|not supported|purchase|refund|'
        r'\bbuy\b|\bbuy for\b'
    )

    def _should_skip_immediately() -> tuple[bool, str]:
        """
        Single page-source scan (fast, one call) for skip signals:
          - Any $ or currency symbol adjacent to digits → paid
          - Error/incompatibility phrases → skip
          - Buy button text → paid
        Returns (should_skip, reason).
        """
        try:
            src = driver.page_source or ""
        except Exception:
            return False, ""

        m = _PRICE_RE.search(src)
        if m:
            snippet = src[max(0, m.start()-10):m.end()+10].replace('\n', ' ')
            return True, f"price: {snippet[:50]}"

        m = _SKIP_RE.search(src)
        if m:
            snippet = src[max(0, m.start()-10):m.end()+10].replace('\n', ' ')
            return True, f"skip phrase: {snippet[:50]}"

        return False, ""

    def _find_done_btn(timeout: int):
        """Return the Open/Uninstall label element (may be non-clickable)."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            if stop_event and stop_event.is_set():
                return None
            for selector in [
                'new UiSelector().textMatches("(?i)^open$|^uninstall$")',
                'new UiSelector().descriptionMatches("(?i)^open$|^uninstall$")',
                'new UiSelector().clickable(true).childSelector(new UiSelector().textMatches("(?i)^open$|^uninstall$"))',
            ]:
                try:
                    return driver.find_element(AppiumBy.ANDROID_UIAUTOMATOR, selector)
                except NoSuchElementException:
                    pass
            time.sleep(1)
        return None

    def _is_pkg_on_device(pkg: str) -> bool:
        try:
            adb = _find_adb()
            r = subprocess.run(
                [adb, "-s", serial, "shell", "pm", "path", "--user", "0", pkg],
                capture_output=True, text=True, timeout=10,
            )
            if "package:" in (r.stdout or ""):
                return True
            r = subprocess.run(
                [adb, "-s", serial, "shell", "pm", "path", pkg],
                capture_output=True, text=True, timeout=10,
            )
            return "package:" in (r.stdout or "")
        except Exception:
            return False

    def _uninstall_pkg(pkg: str):
        try:
            adb = _find_adb()
            subprocess.run([adb, "-s", serial, "uninstall", pkg], capture_output=True, timeout=30)
            log(f"[{pkg}] Uninstalled.")
        except Exception as e_uninstall:
            log(f"[{pkg}] WARNING: Uninstall failed: {e_uninstall}")

    pulled_packages: list[str] = []

    for package in packages:
        if stop_event and stop_event.is_set():
            log("Cancelled.")
            break

        pkg_dir = os.path.join(output_dir, package)
        if os.path.isdir(pkg_dir) and any(f.endswith(".apk") for f in os.listdir(pkg_dir)):
            log(f"[{package}] Already exists in {pkg_dir} — skipping.")
            continue

        is_temp = package.startswith("__temp_")
        log(f"[{package}] {'Already on app page' if is_temp else 'Opening Play Store'}...")
        install_attempted = False
        session_dead = False
        pull_pkg = package  # may be updated to real pkg name for temp packages

        # Snapshot installed packages before install so we can diff after to find new pkg
        pre_install_pkgs: set[str] = set()
        if is_temp:
            try:
                r = subprocess.run(
                    [_find_adb(), "-s", serial, "shell", "pm", "list", "packages"],
                    capture_output=True, text=True, timeout=20,
                )
                pre_install_pkgs = set(re.findall(r"package:(\S+)", r.stdout))
            except Exception:
                pass
        try:
            if not is_temp:
                try:
                    driver.execute_script(
                        "mobile: deepLink",
                        {"url": f"market://details?id={package}", "package": _PLAY_STORE_PKG},
                    )
                except Exception as e_deep:
                    msg = str(e_deep).lower()
                    if "invalidsessionid" in msg or ("session" in msg and "not" in msg):
                        log(f"[{package}] ERROR: Appium session lost: {e_deep}")
                        session_dead = True
                        raise
                    log(f"[{package}] ERROR: deepLink failed: {e_deep} — skipping.")
                    _save_skip_entry(output_dir, package, f"deeplink_failed: {e_deep}")
                    continue

            # Wait for page to fully render — Play Store can be slow
            time.sleep(6)

            if stop_event and stop_event.is_set():
                log("Cancelled.")
                break

            # Fast skip check immediately after render
            skip, reason = _should_skip_immediately()
            if skip:
                log(f"[{package}] Skipping — {reason}")
                _save_skip_entry(output_dir, package, reason)
                continue

            def _tap_el(el) -> bool:
                """Tap element by centre coordinates regardless of clickability."""
                try:
                    loc = el.location
                    sz  = el.size
                    cx  = int(loc["x"] + sz["width"]  / 2)
                    cy  = int(loc["y"] + sz["height"] / 2)
                    driver.tap([(cx, cy)])
                    return True
                except Exception:
                    return False

            # ── Determine page state: Uninstall / Install / neither ───────────
            # Poll up to 20s for the page to show a recognisable button.
            # Priority: Uninstall > Open > Install/Update > paid
            page_state = None
            state_el   = None
            deadline_state = time.time() + 20
            while time.time() < deadline_state:
                if stop_event and stop_event.is_set():
                    break

                # Re-check skip signals each poll iteration (price may load late)
                skip, reason = _should_skip_immediately()
                if skip:
                    log(f"[{package}] Skipping mid-poll — {reason}")
                    _save_skip_entry(output_dir, package, reason)
                    page_state = "skip"
                    break

                for label, state in [
                    (r"^uninstall$",     "uninstall"),
                    (r"^open$",          "open"),
                    (r"^install$|^update$", "install"),
                ]:
                    try:
                        el = driver.find_element(
                            AppiumBy.ANDROID_UIAUTOMATOR,
                            f'new UiSelector().textMatches("(?i){label}")',
                        )
                        page_state = state
                        state_el   = el
                        break
                    except NoSuchElementException:
                        pass
                    try:
                        el = driver.find_element(
                            AppiumBy.ANDROID_UIAUTOMATOR,
                            f'new UiSelector().descriptionMatches("(?i){label}")',
                        )
                        page_state = state
                        state_el   = el
                        break
                    except NoSuchElementException:
                        pass
                if page_state:
                    break
                time.sleep(1)

            if page_state == "skip":
                continue  # already logged and saved above

            if not page_state:
                log(f"[{package}] WARNING: No Install/Uninstall/Open button found — skipping.")
                _save_skip_entry(output_dir, package, "no_button_found")
                continue

            # ── Handle Uninstall: app already on device → pull then uninstall ─
            if page_state == "uninstall":
                log(f"[{package}] Uninstall button visible — app already installed, pulling APKs...")
                install_attempted = True  # triggers cleanup in finally

            # ── Handle Open: installed, pull directly ─────────────────────────
            elif page_state == "open":
                log(f"[{package}] Open button visible — app installed, pulling APKs...")
                install_attempted = True

            # ── Handle Install: tap, wait with retries for UI latency ─────────
            else:
                log(f"[{package}] Tapping Install...")
                _tap_el(state_el)
                install_attempted = True

                # Retry tap up to 3 times in case of UI latency / missed tap
                for attempt in range(3):
                    time.sleep(3)
                    # Check if still showing Install (tap didn't register)
                    still_install = False
                    try:
                        driver.find_element(
                            AppiumBy.ANDROID_UIAUTOMATOR,
                            'new UiSelector().textMatches("(?i)^install$|^update$")',
                        )
                        still_install = True
                    except NoSuchElementException:
                        pass
                    if still_install:
                        log(f"[{package}] Install tap may not have registered — retrying ({attempt+1}/3)...")
                        try:
                            el2 = driver.find_element(
                                AppiumBy.ANDROID_UIAUTOMATOR,
                                'new UiSelector().textMatches("(?i)^install$|^update$")',
                            )
                            _tap_el(el2)
                        except NoSuchElementException:
                            break  # button gone — install started
                    else:
                        break  # button gone — install in progress

                log(f"[{package}] Waiting for installation (up to {timeout_sec/60:.0f} min)...")
                done = _find_done_btn(timeout=timeout_sec)
                if stop_event and stop_event.is_set():
                    log("Cancelled.")
                    break
                if not done:
                    log(f"[{package}] WARNING: Install timed out — skipping.")
                    _save_skip_entry(output_dir, package, "install_timeout")
                    continue
                log(f"[{package}] Installed.")

            # For temp packages (package ID unknown from dumpsys before install),
            # read the real package name from the foreground activity now that
            # the app is installed and the Play Store detail page is showing it.
            pull_pkg = package
            if is_temp:
                resolved = None
                # Strategy 1: dumpsys activity activities (market:// deep link in stack)
                for _ in range(5):
                    try:
                        r = subprocess.run(
                            [_find_adb(), "-s", serial, "shell", "dumpsys", "activity", "activities"],
                            capture_output=True, text=True, timeout=15,
                        )
                        out = r.stdout
                        for pat in [
                            r'dat=market://details\?id=([A-Za-z][A-Za-z0-9_.]+)',
                            r'dat=https?://market\.android\.com/details\?id=([A-Za-z][A-Za-z0-9_.]+)',
                            r'dat=https?://play\.google\.com/store/apps/details\?id=([A-Za-z][A-Za-z0-9_.]+)',
                        ]:
                            m = re.search(pat, out)
                            if m:
                                resolved = m.group(1)
                                break
                        if resolved:
                            break
                    except Exception:
                        pass
                    time.sleep(1)

                # Strategy 2: diff pm list packages against pre-install snapshot
                if not resolved and pre_install_pkgs:
                    for attempt_diff in range(6):
                        try:
                            r = subprocess.run(
                                [_find_adb(), "-s", serial, "shell", "pm", "list", "packages"],
                                capture_output=True, text=True, timeout=20,
                            )
                            post_pkgs = set(re.findall(r"package:(\S+)", r.stdout))
                            new_pkgs = post_pkgs - pre_install_pkgs
                            new_pkgs = {p for p in new_pkgs if "." in p and not p.startswith("android.")}
                            if new_pkgs:
                                resolved = sorted(new_pkgs)[0]
                                log(f"[{package}] Resolved via package diff: {resolved}")
                                break
                        except Exception:
                            pass
                        time.sleep(3)

                # Strategy 3: page source scrape for package ID
                if not resolved:
                    try:
                        src = driver.page_source or ""
                        for pat in [
                            r'details\?id=([A-Za-z][A-Za-z0-9_.]+)',
                            r'"appId"\s*:\s*"([A-Za-z][A-Za-z0-9_.]+)"',
                        ]:
                            m = re.search(pat, src)
                            if m:
                                candidate = m.group(1)
                                if "." in candidate:
                                    resolved = candidate
                                    log(f"[{package}] Resolved via page source: {resolved}")
                                    break
                    except Exception:
                        pass

                # Strategy 4: already-installed app — search pm list packages by label keywords.
                # Applies when page_state was "uninstall" or "open" (app already on device
                # before our snapshot, so diff won't find it).
                if not resolved and page_state in ("uninstall", "open"):
                    try:
                        # Extract meaningful keywords from __temp_ label
                        # e.g. "__temp_Shipt__Shopper_and_Driver" → ["shipt", "shopper", "driver"]
                        raw_label = package.replace("__temp_", "").replace("_", " ").lower()
                        keywords = [w for w in raw_label.split() if len(w) >= 4
                                    and w not in ("and", "the", "for", "with", "app", "apps")]
                        if keywords:
                            r = subprocess.run(
                                [_find_adb(), "-s", serial, "shell", "pm", "list", "packages", "-f"],
                                capture_output=True, text=True, timeout=25,
                            )
                            # Score each package by how many keywords appear in its path/name
                            best_pkg, best_score = None, 0
                            for line in r.stdout.splitlines():
                                m2 = re.match(r"package:(\S+\.apk)=(\S+)", line)
                                if not m2:
                                    continue
                                pkg_name = m2.group(2).lower()
                                score = sum(1 for kw in keywords if kw in pkg_name)
                                if score > best_score:
                                    best_score, best_pkg = score, m2.group(2)
                            if best_pkg and best_score >= 1:
                                resolved = best_pkg
                                log(f"[{package}] Resolved via keyword match (score={best_score}): {resolved}")
                    except Exception:
                        pass

                if resolved:
                    pull_pkg = resolved
                    pkg_dir  = os.path.join(output_dir, resolved)
                else:
                    log(f"[{package}] WARNING: Still could not resolve package — pulling to temp dir, aapt will rename later.")

            # If still unresolved (pull_pkg is still a __temp_ name), find APK
            # by diffing pm list packages -f against pre-install snapshot paths.
            # This avoids a 300s poll loop against a package name that can't exist.
            if pull_pkg.startswith("__temp_"):
                paths = []
                if pre_install_pkgs:
                    try:
                        r = subprocess.run(
                            [_find_adb(), "-s", serial, "shell", "pm", "list", "packages", "-f"],
                            capture_output=True, text=True, timeout=25,
                        )
                        # format: package:/data/app/...=com.example.pkg
                        for line in r.stdout.splitlines():
                            m = re.match(r"package:(\S+\.apk)=(\S+)", line)
                            if not m:
                                continue
                            apk_path, pkg_name = m.group(1), m.group(2)
                            if pkg_name not in pre_install_pkgs and "." in pkg_name:
                                os.makedirs(pkg_dir, exist_ok=True)
                                dest = os.path.join(pkg_dir, os.path.basename(apk_path))
                                r2 = subprocess.run(
                                    [_find_adb(), "-s", serial, "pull", apk_path, dest],
                                    capture_output=True, timeout=60,
                                )
                                if r2.returncode == 0 and os.path.exists(dest):
                                    paths.append(dest)
                                    # rename temp dir to real pkg
                                    real_dir = os.path.join(output_dir, pkg_name)
                                    if not os.path.isdir(real_dir):
                                        os.rename(pkg_dir, real_dir)
                                        pkg_dir = real_dir
                                    pull_pkg = pkg_name
                                    log(f"[{package}] Resolved via path diff: {pkg_name}, pulled {dest}")
                                    break
                    except Exception as e_diff:
                        log(f"[{package}] WARNING: Path diff pull failed: {e_diff}")

                # Already-installed fallback: keyword-match pm list packages -f
                # (app was in pre_install_pkgs so diff missed it)
                if not paths and page_state in ("uninstall", "open"):
                    try:
                        raw_label = package.replace("__temp_", "").replace("_", " ").lower()
                        keywords = [w for w in raw_label.split() if len(w) >= 4
                                    and w not in ("and", "the", "for", "with", "app", "apps")]
                        if keywords:
                            r = subprocess.run(
                                [_find_adb(), "-s", serial, "shell", "pm", "list", "packages", "-f"],
                                capture_output=True, text=True, timeout=25,
                            )
                            best_apk, best_pkg_n, best_score = None, None, 0
                            for line in r.stdout.splitlines():
                                m2 = re.match(r"package:(\S+\.apk)=(\S+)", line)
                                if not m2:
                                    continue
                                pkg_name_lc = m2.group(2).lower()
                                score = sum(1 for kw in keywords if kw in pkg_name_lc)
                                if score > best_score:
                                    best_score, best_apk, best_pkg_n = score, m2.group(1), m2.group(2)
                            if best_apk and best_score >= 1:
                                os.makedirs(pkg_dir, exist_ok=True)
                                dest = os.path.join(pkg_dir, os.path.basename(best_apk))
                                r2 = subprocess.run(
                                    [_find_adb(), "-s", serial, "pull", best_apk, dest],
                                    capture_output=True, timeout=60,
                                )
                                if r2.returncode == 0 and os.path.exists(dest):
                                    paths.append(dest)
                                    real_dir = os.path.join(output_dir, best_pkg_n)
                                    if not os.path.isdir(real_dir):
                                        os.rename(pkg_dir, real_dir)
                                        pkg_dir = real_dir
                                    pull_pkg = best_pkg_n
                                    log(f"[{package}] Resolved already-installed via keyword (score={best_score}): {best_pkg_n}")
                    except Exception as e_kw:
                        log(f"[{package}] WARNING: Keyword pull failed: {e_kw}")

                if not paths:
                    log(f"[{package}] WARNING: Could not resolve or pull APK — skipping.")
                    _save_skip_entry(output_dir, package, "unresolved_temp")
            else:
                paths = _pull_apks(serial, pull_pkg, pkg_dir, on_output, timeout_sec=timeout_sec, stop_event=stop_event)

            if not paths:
                log(f"[{package}] WARNING: Pull failed — not counting as downloaded.")
                _save_skip_entry(output_dir, package, "pull_failed")
            else:
                pulled_packages.append(pull_pkg)
                log(f"[{package}] Saved {len(paths)} file(s) to {pkg_dir}")

        except Exception as e:
            if stop_event and stop_event.is_set():
                log("Cancelled.")
                break
            log(f"[{package}] ERROR: {e}")
            msg = str(e).lower()
            if "invalidsessionid" in msg or ("session" in msg and "not" in msg):
                session_dead = True
            else:
                _save_skip_entry(output_dir, package, f"exception: {e}")
        finally:
            if install_attempted or _is_pkg_on_device(pull_pkg):
                log(f"[{package}] Cleaning up — uninstalling {pull_pkg} from device...")
                _uninstall_pkg(pull_pkg)

        if session_dead:
            log("Recreating Appium session to continue with remaining apps...")
            try:
                try:
                    driver.quit()
                except Exception:
                    pass
                driver = _make_appium_session(serial, base_url)
                global _active_driver
                _active_driver = driver
                log("Appium session recreated.")
            except Exception as e_recreate:
                log(f"ERROR: Could not recreate Appium session: {e_recreate} — aborting remaining apps.")
                break

    return pulled_packages


def download_via_appium(
    packages: list[str],
    output_dir: str,
    device_serial: str | None = None,
    on_output: Callable[[str], None] | None = None,
    stop_event: threading.Event | None = None,
    timeout_sec: int = 180,
) -> list[str]:
    """
    For each package name:
      1. Opens Play Store on the emulator
      2. Searches for the package by ID
      3. Taps Install / Open (if already installed)
      4. Waits for installation
      5. Pulls the APK via adb

    Returns list of successfully downloaded package names.
    """
    def log(msg):
        if on_output:
            on_output(msg)

    serial = _get_device_serial(device_serial)
    if not serial:
        log("ERROR: No Android device/emulator found. Start one in the Device panel.")
        return []

    # Filter out previously-skipped/failed packages so retries don't re-run them.
    skip_list = _load_skip_list(output_dir)
    if skip_list:
        before = len(packages)
        filtered = [p for p in packages if p not in skip_list]
        removed = before - len(filtered)
        if removed:
            log(f"[SKIP_LIST] Filtering {removed} previously-skipped/failed package(s). "
                f"Remove {SKIP_LIST_FILENAME} from {output_dir} to retry them.")
        packages = filtered
        if not packages:
            log("[SKIP_LIST] All requested packages already in skip list — nothing to do.")
            return []

    log(f"Connecting to device {serial}...")
    base_url = _appium_base_url()
    log(f"Connecting to Appium at {base_url}...")

    global _active_driver
    try:
        driver = _make_appium_session(serial, base_url)
        _active_driver = driver
    except Exception as e:
        log(f"ERROR: Could not connect to Appium: {e}")
        return []

    try:
        return _run_package_loop(
            driver=driver,
            packages=packages,
            output_dir=output_dir,
            serial=serial,
            base_url=base_url,
            on_output=on_output,
            stop_event=stop_event,
            timeout_sec=timeout_sec,
        )
    finally:
        _active_driver = None
        try:
            driver.quit()
        except Exception:
            pass
        log("Appium session closed.")


def _resolve_pkg_from_apk(
    apk_dir: str,
    log: Callable[[str], None] | None = None,
) -> str | None:
    """
    Use aapt/aapt2 to extract the package name from any .apk file found in
    `apk_dir`.  Returns the package name string or None on failure.
    """
    import shutil as _shutil

    apk_files = [
        os.path.join(apk_dir, f)
        for f in os.listdir(apk_dir)
        if f.lower().endswith(".apk")
    ]
    if not apk_files:
        return None

    # Prefer base.apk if present
    base = next((f for f in apk_files if os.path.basename(f).lower() == "base.apk"), apk_files[0])

    for tool in ("aapt2", "aapt"):
        tool_path = _shutil.which(tool)
        if not tool_path:
            continue
        try:
            r = subprocess.run(
                [tool_path, "dump", "badging", base],
                capture_output=True, text=True, timeout=30,
            )
            m = re.search(r"^package: name='([^']+)'", r.stdout, re.MULTILINE)
            if m:
                pkg = m.group(1).strip()
                if log:
                    log(f"[aapt] Resolved package: {pkg} (from {os.path.basename(base)})")
                return pkg
        except Exception as e:
            if log:
                log(f"[aapt] {tool} failed: {e}")
            continue

    return None


def download_category_via_appium(
    category_id: str,
    count: int,
    output_dir: str,
    device_serial: str | None = None,
    on_output: Callable[[str], None] | None = None,
    stop_event: threading.Event | None = None,
    timeout_sec: int = 180,
) -> list[str]:
    """
    Navigates the Play Store UI (Apps → Categories → <category>) and downloads
    up to `count` apps not previously downloaded to `output_dir`.

    Navigation path mirrors what the user does manually:
      1. Launch Play Store main screen.
      2. Tap the "Apps" tab.
      3. Tap "Categories" (or scroll to find it).
      4. Tap the target category name.
      5. Tap each app card → read package ID via `dumpsys activity top` → download.
      6. Scroll down continuously until `count` apps collected.

    Returns list of successfully downloaded package names.
    """
    from appium.webdriver.common.appiumby import AppiumBy
    from selenium.common.exceptions import NoSuchElementException, StaleElementReferenceException

    # Map category_id → human-readable display name used in Play Store UI
    from core.play_categories import CATEGORIES
    _CAT_DISPLAY = {cid: name for cid, name in CATEGORIES}

    def log(msg):
        if on_output:
            on_output(msg)

    serial = _get_device_serial(device_serial)
    if not serial:
        log("ERROR: No Android device/emulator found.")
        return []

    adb = _find_adb()
    base_url = _appium_base_url()
    log(f"[CATEGORY BROWSE] Connecting to Appium at {base_url}...")

    global _active_driver
    try:
        driver = _make_appium_session(serial, base_url)
        _active_driver = driver
    except Exception as e:
        log(f"ERROR: Could not connect to Appium: {e}")
        return []

    pulled_packages: list[str] = []
    seen_packages: set[str] = set()
    tapped_descs: set[str] = set()

    # ── helpers ──────────────────────────────────────────────────────────────

    def _is_session_alive() -> bool:
        try:
            driver.current_activity  # lightweight probe
            return True
        except Exception:
            return False

    def _recreate_session() -> bool:
        """Quit dead session and open a fresh one. Updates module-level driver ref."""
        nonlocal driver
        log("[CATEGORY BROWSE] Session dead — recreating...")
        try:
            driver.quit()
        except Exception:
            pass
        try:
            driver = _make_appium_session(serial, base_url)
            global _active_driver
            _active_driver = driver
            log("[CATEGORY BROWSE] Session recreated.")
            return True
        except Exception as e:
            log(f"[CATEGORY BROWSE] ERROR: Could not recreate session: {e}")
            return False

    def _already_downloaded(pkg: str) -> bool:
        pkg_dir = os.path.join(output_dir, pkg)
        return os.path.isdir(pkg_dir) and any(f.endswith(".apk") for f in os.listdir(pkg_dir))

    def _tap(selector: str, timeout: int = 10, label: str = "") -> bool:
        """Find element by UiAutomator selector and tap it. Returns True on success."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            if stop_event and stop_event.is_set():
                return False
            try:
                el = driver.find_element(AppiumBy.ANDROID_UIAUTOMATOR, selector)
                el.click()
                return True
            except (NoSuchElementException, StaleElementReferenceException):
                time.sleep(1)
        if label:
            log(f"[CATEGORY BROWSE] Could not find '{label}' within {timeout}s")
        return False

    def _tap_text(text: str, timeout: int = 10) -> bool:
        """Tap the first element whose text or content-desc exactly matches."""
        return _tap(
            f'new UiSelector().textMatches("(?i){re.escape(text)}")',
            timeout=timeout,
            label=text,
        ) or _tap(
            f'new UiSelector().descriptionMatches("(?i){re.escape(text)}")',
            timeout=5,
            label=text,
        )

    def _tap_text_contains(text: str, timeout: int = 10) -> bool:
        """Tap the first element whose text contains the given string."""
        return _tap(
            f'new UiSelector().textContains("{text}")',
            timeout=timeout,
            label=text,
        ) or _tap(
            f'new UiSelector().descriptionContains("{text}")',
            timeout=5,
            label=text,
        )

    def _scroll_down():
        try:
            size = driver.get_window_size()
            mid_x   = int(size["width"] * 0.5)
            start_y = int(size["height"] * 0.75)
            end_y   = int(size["height"] * 0.25)
            driver.swipe(mid_x, start_y, mid_x, end_y, duration=800)
            time.sleep(1.5)
        except Exception:
            pass

    # Track which arrow sections we've already entered so we don't re-tap them
    tapped_arrows: set[str] = set()

    def _tap_next_arrow() -> str | None:
        """
        Find and tap the next untapped section arrow button on the category page.
        Play Store renders these as clickable ImageView elements adjacent to section
        headers. content-desc examples:
          "More results for Top free business apps"
          "More results for Recommended for you"
        Falls back to any clickable ImageView whose content-desc contains "More results".
        Returns the section label if tapped, None if none left.
        """
        selectors = [
            # Primary: confirmed from live uiautomator dump
            'new UiSelector().descriptionStartsWith("More results for ")'
            '.className("android.widget.ImageView").clickable(true)',
            # Fallback: any clickable ImageView with "More results" in desc
            'new UiSelector().descriptionContains("More results")'
            '.className("android.widget.ImageView").clickable(true)',
            # Fallback: clickable ImageView with "See more" or "View all"
            'new UiSelector().descriptionMatches("(?i)see more.*|view all.*")'
            '.className("android.widget.ImageView").clickable(true)',
        ]
        for selector in selectors:
            try:
                elements = driver.find_elements(AppiumBy.ANDROID_UIAUTOMATOR, selector)
                for el in elements:
                    try:
                        desc = (el.get_attribute("content-desc") or "").strip()
                        if not desc:
                            desc = f"_arrow_{el.id}"
                        if desc in tapped_arrows:
                            continue
                        tapped_arrows.add(desc)
                        log(f"[CATEGORY BROWSE] Tapping arrow: '{desc}'")
                        el.click()
                        time.sleep(3)
                        return desc
                    except Exception:
                        continue
            except Exception:
                continue
        return None

    def _press_back():
        try:
            driver.press_keycode(4)  # KEYCODE_BACK
            time.sleep(1.5)
        except Exception:
            pass

    def _get_pkg_from_foreground() -> str | None:
        """
        Extract the Play Store app package ID currently shown in the detail page.
        Uses `dumpsys activity activities` and searches the com.android.vending
        task for a market:// or market.android.com Intent with an id= param.
        """
        for _ in range(5):
            try:
                r = subprocess.run(
                    [adb, "-s", serial, "shell", "dumpsys", "activity", "activities"],
                    capture_output=True, text=True, timeout=15,
                )
                out = r.stdout
                # Only look inside the vending task block
                vending_block = ""
                in_vending = False
                for line in out.splitlines():
                    if "com.android.vending" in line and ("Task{" in line or "TASK" in line):
                        in_vending = True
                    elif in_vending and ("Task{" in line or "TASK" in line) and "com.android.vending" not in line:
                        in_vending = False
                    if in_vending:
                        vending_block += line + "\n"

                search_text = vending_block if vending_block else out
                # Pattern: dat=market://details?id=com.foo  OR  dat=http://market.android.com/details?id=com.foo
                for pat in [
                    r'dat=market://details\?id=([A-Za-z][A-Za-z0-9_.]+)',
                    r'dat=https?://market\.android\.com/details\?id=([A-Za-z][A-Za-z0-9_.]+)',
                    r'dat=https?://play\.google\.com/store/apps/details\?id=([A-Za-z][A-Za-z0-9_.]+)',
                ]:
                    m = re.search(pat, search_text)
                    if m:
                        return m.group(1)
            except Exception:
                pass
            time.sleep(1)
        return None

    def _get_visible_app_cards(sublist_mode: bool = False) -> list[tuple]:
        """
        Return list of (element, label, by_coord) for all visible app cards not yet tapped.
        by_coord=True means the element is not clickable and must be tapped via coordinates.

        Category page cards (mini_blurb):
          resource-id=com.android.vending:id/mini_blurb, clickable=true
          content-desc: "App: <name>\nStar rating: X.X\n..."

        Sub-list page cards (after arrow tap):
          clickable=false, content-desc: "<AppName>\n<Dev>\n<Cat>\nStar rating: X.X\n..."
          These must be tapped by coordinate.

        Fallback: any clickable element whose content-desc starts with "App: ".
        """
        cards = []

        def _parse_label_app(desc: str) -> str:
            m = re.match(r'^App:\s*(.+?)(?:\n|$)', desc)
            return m.group(1).strip() if m else desc.strip()

        def _parse_label_sublist(desc: str) -> str:
            # First line is the app name
            return desc.split("\n")[0].strip()

        if sublist_mode:
            # Sub-list page: cards are NOT clickable, content-desc format:
            #   "<AppName>\n<Dev>\n<Category>\nStar rating: X.X\n..."
            # UiAutomator descriptionContains matches substring — use "Star rating:"
            # to identify card elements, then filter out "Expand content for ..." siblings.
            for selector in [
                'new UiSelector().descriptionContains("Star rating:")',
                'new UiSelector().descriptionContains("star rating:")',
            ]:
                try:
                    all_els = driver.find_elements(AppiumBy.ANDROID_UIAUTOMATOR, selector)
                    for el in all_els:
                        try:
                            desc = (el.get_attribute("content-desc") or "").strip()
                            if not desc:
                                continue
                            if desc.startswith("App:"):
                                continue  # category page card, skip
                            if desc.lower().startswith("expand content"):
                                continue  # "Expand content for <name>" sibling
                            label = _parse_label_sublist(desc)
                            if not label or label in tapped_descs:
                                continue
                            cards.append((el, label, True))  # tap by coord
                        except StaleElementReferenceException:
                            continue
                    if cards:
                        break
                except Exception:
                    continue
            return cards

        # Category page: primary — mini_blurb
        try:
            elements = driver.find_elements(
                AppiumBy.ANDROID_UIAUTOMATOR,
                'new UiSelector().resourceId("com.android.vending:id/mini_blurb")'
                '.clickable(true)',
            )
            for el in elements:
                try:
                    desc = (el.get_attribute("content-desc") or "").strip()
                    if not desc:
                        continue
                    label = _parse_label_app(desc)
                    if label and label not in tapped_descs:
                        cards.append((el, label, False))
                except StaleElementReferenceException:
                    continue
        except Exception:
            pass

        # Fallback: clickable elements with "App: " prefix
        if not cards:
            try:
                elements = driver.find_elements(
                    AppiumBy.ANDROID_UIAUTOMATOR,
                    'new UiSelector().descriptionStartsWith("App: ").clickable(true)',
                )
                for el in elements:
                    try:
                        desc = (el.get_attribute("content-desc") or "").strip()
                        label = _parse_label_app(desc)
                        if label and label not in tapped_descs:
                            cards.append((el, label, False))
                    except StaleElementReferenceException:
                        continue
            except Exception:
                pass

        # Top Charts ranked list: clickable items whose content-desc contains a star/rating
        # e.g. "Indeed Job Search\nBusiness · Long-term employment\n4.7 ★\nEditors' Choice"
        # These lack "App:" prefix and "Star rating:" text — match by star character or rating pattern.
        if not cards:
            for selector in [
                'new UiSelector().clickable(true).descriptionContains("★")',
                'new UiSelector().clickable(true).descriptionMatches(".*[0-9]\\.[0-9].*")',
            ]:
                try:
                    elements = driver.find_elements(AppiumBy.ANDROID_UIAUTOMATOR, selector)
                    for el in elements:
                        try:
                            desc = (el.get_attribute("content-desc") or "").strip()
                            if not desc or len(desc) < 5:
                                continue
                            # Skip filter chips, nav tabs, and single-word UI elements
                            first_line = desc.split("\n")[0].strip()
                            if not first_line or len(first_line) < 3:
                                continue
                            # Must have at least 2 lines (name + category/rating) to be a real app card
                            if "\n" not in desc:
                                continue
                            label = first_line
                            if label in tapped_descs:
                                continue
                            cards.append((el, label, False))
                        except StaleElementReferenceException:
                            continue
                    if cards:
                        break
                except Exception:
                    continue

        return cards

    # ── navigation: Play Store → Apps → Categories → target category ─────────

    def _navigate_to_category_page() -> bool:
        """
        Open Play Store and navigate: Apps tab → Categories → target category.
        Recreates the Appium session first if it has died (e.g. new_command_timeout).
        Returns True if we land on the category app list.
        """
        nonlocal driver

        if not _is_session_alive():
            if not _recreate_session():
                return False

        cat_display = _CAT_DISPLAY.get(category_id, "")
        # Extract short label for matching (e.g. "Business" from "Business", "Action" from "Games: Action")
        if ":" in cat_display:
            cat_short = cat_display.split(":", 1)[1].strip()
        else:
            cat_short = cat_display

        log(f"[CATEGORY BROWSE] Launching Play Store...")
        try:
            driver.execute_script(
                "mobile: deepLink",
                {"url": "market://", "package": _PLAY_STORE_PKG},
            )
        except Exception:
            try:
                driver.activate_app(_PLAY_STORE_PKG)
            except Exception as e:
                log(f"[CATEGORY BROWSE] ERROR: Cannot open Play Store: {e}")
                # Session may have died mid-call — try one recreation
                if _recreate_session():
                    try:
                        driver.execute_script(
                            "mobile: deepLink",
                            {"url": "market://", "package": _PLAY_STORE_PKG},
                        )
                    except Exception:
                        return False
                else:
                    return False
        time.sleep(4)

        # Tap "Apps" tab
        log("[CATEGORY BROWSE] Tapping 'Apps' tab...")
        if not _tap_text("Apps", timeout=10):
            # Some Play Store versions use bottom nav icons without text
            log("[CATEGORY BROWSE] 'Apps' tab not found by text — trying content-desc...")
            if not _tap(
                'new UiSelector().descriptionContains("Apps")',
                timeout=5, label="Apps tab"
            ):
                log("[CATEGORY BROWSE] WARNING: Could not find Apps tab — proceeding anyway")
        time.sleep(2)

        # Look for "Categories" and tap it
        log("[CATEGORY BROWSE] Looking for 'Categories'...")
        found_categories = False
        for attempt in range(6):
            if _tap_text_contains("Categories", timeout=4):
                found_categories = True
                break
            _scroll_down()

        if not found_categories:
            log("[CATEGORY BROWSE] WARNING: 'Categories' not found — trying direct category deep link fallback")
            # Fallback: try Play Store category URL directly
            try:
                driver.execute_script(
                    "mobile: deepLink",
                    {"url": f"market://search?q=&c=apps&cat={category_id}",
                     "package": _PLAY_STORE_PKG},
                )
                time.sleep(4)
                return True
            except Exception:
                return False
        time.sleep(3)

        # Now find and tap the target category
        log(f"[CATEGORY BROWSE] Looking for category '{cat_short}'...")
        for attempt in range(10):
            if _tap_text_contains(cat_short, timeout=4):
                time.sleep(3)
                return True
            _scroll_down()

        log(f"[CATEGORY BROWSE] WARNING: Category '{cat_short}' not found in list")
        return False

    # ── shared card-download helper ───────────────────────────────────────────

    def _tap_el_by_coord(el) -> bool:
        """Tap element centre regardless of clickability."""
        try:
            loc = el.location
            sz  = el.size
            cx  = int(loc["x"] + sz["width"]  / 2)
            cy  = int(loc["y"] + sz["height"] / 2)
            driver.tap([(cx, cy)])
            return True
        except Exception:
            return False

    def _download_card(el, label: str, by_coord: bool) -> bool:
        """
        Tap an app card (category page or sub-list), download+pull the APK,
        uninstall, then return True if successfully pulled.
        Already modifies pulled_packages, seen_packages in the outer scope.
        """
        nonlocal driver
        tapped_descs.add(label)

        # Tap the card
        try:
            if by_coord:
                if not _tap_el_by_coord(el):
                    return False
            else:
                el.click()
        except (StaleElementReferenceException, Exception):
            return False
        time.sleep(3)

        pkg = _get_pkg_from_foreground()
        use_temp = pkg is None
        if use_temp:
            safe_label = re.sub(r'[^A-Za-z0-9_\-]', '_', label[:60])
            pkg = f"__temp_{safe_label}"
            log(f"[CATEGORY BROWSE] Could not read package ID for '{label[:40]}' — using temp dir, aapt will resolve.")

        if pkg in seen_packages and not use_temp:
            _press_back()
            time.sleep(1)
            return False

        seen_packages.add(pkg)

        log(f"[CATEGORY BROWSE] [{pkg}] Downloading ({len(pulled_packages)+1}/{count})...")
        temp_dir = os.path.join(output_dir, pkg)
        result = _run_package_loop(
            driver=driver,
            packages=[pkg],
            output_dir=output_dir,
            serial=serial,
            base_url=base_url,
            on_output=on_output,
            stop_event=stop_event,
            timeout_sec=timeout_sec,
        )

        if use_temp and os.path.isdir(temp_dir):
            real_pkg = _resolve_pkg_from_apk(temp_dir, log)
            if real_pkg:
                final_dir = os.path.join(output_dir, real_pkg)
                if os.path.isdir(final_dir):
                    log(f"[CATEGORY BROWSE] [{real_pkg}] Already downloaded (resolved via aapt) — removing temp dir.")
                    import shutil as _shutil2
                    _shutil2.rmtree(temp_dir, ignore_errors=True)
                else:
                    os.rename(temp_dir, final_dir)
                    log(f"[CATEGORY BROWSE] Resolved temp dir → {real_pkg}")
                    if result:
                        result = [real_pkg]
                    seen_packages.add(real_pkg)
                try:
                    subprocess.run([adb, "-s", serial, "uninstall", real_pkg],
                                   capture_output=True, timeout=30)
                except Exception:
                    pass
            else:
                log(f"[CATEGORY BROWSE] WARNING: aapt could not resolve package — keeping temp dir {pkg}")

        if result:
            pulled_packages.extend(result)
            log(f"[CATEGORY BROWSE] Progress: {len(pulled_packages)}/{count}")
            return True
        return False

    def _get_sublist_cards() -> list[tuple]:
        """
        Get app cards on a sub-list page. The sub-list page looks identical
        to the category page (grid of clickable app tiles). Try both the
        standard mini_blurb selector and the Star-rating fallback for pages
        with non-clickable cards (horizontal scroll sections).
        """
        # Standard grid cards (same as category page)
        cards = _get_visible_app_cards(sublist_mode=False)
        if cards:
            return cards
        # Non-clickable card fallback (horizontal row, tap by coord)
        return _get_visible_app_cards(sublist_mode=True)

    def _harvest_sublist(section_label: str):
        """
        Harvest all apps from a sub-list page (opened by tapping a section arrow).
        Sub-list looks like the screenshot: a full-page grid of clickable app cards.
        For each card: tap → download → pull → uninstall → Back to sub-list → next card.
        Scrolls until all visible cards exhausted or count reached, then presses Back.
        """
        log(f"[CATEGORY BROWSE] Harvesting sub-list: '{section_label}'")
        sublist_dry = 0
        MAX_SUBLIST_DRY = 10

        while len(pulled_packages) < count:
            if stop_event and stop_event.is_set():
                break

            cards = _get_sublist_cards()
            if not cards:
                sublist_dry += 1
                if sublist_dry >= MAX_SUBLIST_DRY:
                    log(f"[CATEGORY BROWSE] Sub-list '{section_label}' exhausted after {MAX_SUBLIST_DRY} dry scrolls.")
                    break
                _scroll_down()
                continue

            sublist_dry = 0
            for el, label, by_coord in cards:
                if stop_event and stop_event.is_set():
                    break
                if len(pulled_packages) >= count:
                    break
                _download_card(el, label, by_coord)
                # _run_package_loop leaves driver on app detail page (or Play Store main).
                # Press Back to return to the sub-list page for the next card.
                _press_back()
                time.sleep(2)

            if len(pulled_packages) < count and not (stop_event and stop_event.is_set()):
                _scroll_down()

        log(f"[CATEGORY BROWSE] Sub-list '{section_label}' done — pressing Back to category.")
        _press_back()
        time.sleep(2)

    # ── main loop ────────────────────────────────────────────────────────────
    # Strategy: the category page shows section headers with → arrows
    # (e.g. "Based on your recent activity →", "Recommended for you →").
    # Each arrow leads to a full sub-list of that section.
    # We tap every arrow we find, harvest its sub-list, then scroll down
    # to find more arrows until count is reached or the page is exhausted.

    try:
        if not _navigate_to_category_page():
            log("[CATEGORY BROWSE] ERROR: Could not navigate to category page.")
            return []

        log(f"[CATEGORY BROWSE] On category page — scanning for section arrows...")
        no_new_arrow_scrolls = 0
        MAX_DRY_SCROLLS = 20

        while len(pulled_packages) < count:
            if stop_event and stop_event.is_set():
                log("Cancelled.")
                break

            # Always try arrows first — tap the next untapped one visible on screen
            section = _tap_next_arrow()
            if section:
                log(f"[CATEGORY BROWSE] Tapped arrow '{section}' — entering sub-list.")
                time.sleep(2)
                _harvest_sublist(section)
                if stop_event and stop_event.is_set():
                    break
                if len(pulled_packages) >= count:
                    break
                # Re-navigate to category page to find next arrow
                if not _navigate_to_category_page():
                    log("[CATEGORY BROWSE] WARNING: Lost category page after sub-list — retrying.")
                    if not _navigate_to_category_page():
                        log("[CATEGORY BROWSE] ERROR: Cannot recover category page — stopping.")
                        break
                no_new_arrow_scrolls = 0
                continue

            # No untapped arrow visible — scroll down to reveal more
            no_new_arrow_scrolls += 1
            if no_new_arrow_scrolls >= MAX_DRY_SCROLLS:
                log(f"[CATEGORY BROWSE] No more section arrows after {MAX_DRY_SCROLLS} scrolls — stopping.")
                break
            _scroll_down()

    finally:
        _active_driver = None
        try:
            driver.quit()
        except Exception:
            pass
        log("[CATEGORY BROWSE] Appium session closed.")

    return pulled_packages
