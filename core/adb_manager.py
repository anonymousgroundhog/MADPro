"""
ADB device detection and Android emulator management.
All calls use subprocess — same pattern as docker_runner.py.
"""
import os
import platform
import shutil
import subprocess
import threading
from typing import Callable


# ------------------------------------------------------------------ #
#  SDK tool discovery                                                  #
# ------------------------------------------------------------------ #

def _sdk_roots() -> list[str]:
    """Returns candidate Android SDK root directories, most-preferred first."""
    home = os.path.expanduser("~")
    roots = []
    # Explicit env vars take top priority
    for var in ("ANDROID_HOME", "ANDROID_SDK_ROOT"):
        val = os.environ.get(var, "").strip()
        if val:
            roots.append(val)
    # Common install locations
    roots += [
        os.path.join(home, "Android", "Sdk"),   # Android Studio default (Linux/Win)
        os.path.join(home, "Library", "Android", "sdk"),  # macOS
        os.path.join(home, "android-sdk"),
        "/opt/android-sdk",
        "/usr/local/android-sdk",
    ]
    return [r for r in roots if r]


def _find_sdk_tool(name: str) -> str | None:
    """
    Returns the full path to an Android SDK cmdline-tools binary.
    Searches the real Android SDK directories FIRST so we never pick up
    a system package (e.g. the F-Droid sdkmanager on Ubuntu) by accident.
    Falls back to PATH only when no SDK copy is found.
    """
    for sdk_root in _sdk_roots():
        # cmdline-tools/<version>/bin/<name>  — try newest version first
        cmdline_tools = os.path.join(sdk_root, "cmdline-tools")
        if os.path.isdir(cmdline_tools):
            for entry in sorted(os.listdir(cmdline_tools), reverse=True):
                candidate = os.path.join(cmdline_tools, entry, "bin", name)
                if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
                    return candidate
        # Legacy tools/bin layout
        legacy = os.path.join(sdk_root, "tools", "bin", name)
        if os.path.isfile(legacy) and os.access(legacy, os.X_OK):
            return legacy

    # Final fallback: anything on PATH
    return shutil.which(name)


def _sdk_env() -> dict:
    """
    Returns an env dict with ANDROID_HOME / ANDROID_SDK_ROOT set to the
    first valid SDK root we can find.  Needed so avdmanager/sdkmanager can
    locate the SDK even when the env vars aren't exported by the shell.
    """
    env = os.environ.copy()
    for root in _sdk_roots():
        if os.path.isdir(root):
            env["ANDROID_HOME"] = root
            env["ANDROID_SDK_ROOT"] = root
            return env
    return env


def _host_arch() -> str:
    """Maps platform.machine() to the Android system-image ABI suffix."""
    machine = platform.machine().lower()
    if machine in ("arm64", "aarch64"):
        return "arm64-v8a"
    return "x86_64"


def is_sdkmanager_available() -> bool:
    return _find_sdk_tool("sdkmanager") is not None


# ------------------------------------------------------------------ #
#  ADB                                                                 #
# ------------------------------------------------------------------ #

def is_adb_available() -> bool:
    try:
        subprocess.run(["adb", "version"], capture_output=True, timeout=5)
        return True
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


def list_adb_devices() -> list[dict]:
    """
    Returns list of connected devices/emulators.
    Each entry: {serial, model, type}  where type is 'device' or 'emulator'.
    """
    try:
        result = subprocess.run(
            ["adb", "devices", "-l"],
            capture_output=True, text=True, timeout=10
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return []

    devices = []
    for line in result.stdout.splitlines()[1:]:
        line = line.strip()
        if not line or "\toffline" in line or "\tunauthorized" in line:
            continue
        parts = line.split()
        if len(parts) < 2 or parts[1] != "device":
            continue
        serial = parts[0]
        model = next((p.split(":")[1] for p in parts if p.startswith("model:")), serial)
        device_type = "emulator" if serial.startswith("emulator-") else "device"
        devices.append({"serial": serial, "model": model, "type": device_type})

    return devices


# ------------------------------------------------------------------ #
#  AVD management                                                      #
# ------------------------------------------------------------------ #

def list_avds() -> list[str]:
    """Returns list of AVD names from avdmanager."""
    avdmanager = _find_sdk_tool("avdmanager")
    if not avdmanager:
        return []
    try:
        result = subprocess.run(
            [avdmanager, "list", "avd", "-c"],
            capture_output=True, text=True, timeout=15,
            env=_sdk_env(),
        )
        return [line.strip() for line in result.stdout.splitlines() if line.strip()]
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return []


def start_emulator(
    avd_name: str,
    on_output: Callable[[str], None] | None = None,
) -> subprocess.Popen | None:
    """
    Launches an AVD emulator as a background process.
    Returns the Popen handle so the caller can terminate it.
    """
    emulator = _find_sdk_tool("emulator") or "emulator"
    try:
        proc = subprocess.Popen(
            [emulator, "-avd", avd_name, "-no-snapshot-save"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            env=_sdk_env(),
        )

        def _read_output():
            for line in iter(proc.stdout.readline, ""):
                if on_output:
                    on_output(line.rstrip())

        threading.Thread(target=_read_output, daemon=True).start()
        return proc
    except FileNotFoundError:
        if on_output:
            on_output("ERROR: emulator binary not found. Install Android SDK emulator package.")
        return None


def stop_emulator(serial: str) -> bool:
    """Sends 'emu kill' via adb to gracefully stop an emulator."""
    try:
        result = subprocess.run(
            ["adb", "-s", serial, "emu", "kill"],
            capture_output=True, text=True, timeout=10
        )
        return result.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


def wait_for_boot(serial: str, timeout: int = 120) -> bool:
    """
    Polls adb until the emulator reports sys.boot_completed=1.
    Returns True if booted within timeout, False otherwise.
    """
    import time
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            result = subprocess.run(
                ["adb", "-s", serial, "shell", "getprop", "sys.boot_completed"],
                capture_output=True, text=True, timeout=5
            )
            if result.stdout.strip() == "1":
                return True
        except (FileNotFoundError, subprocess.TimeoutExpired):
            pass
        time.sleep(3)
    return False


# ------------------------------------------------------------------ #
#  Google Play emulator download                                       #
# ------------------------------------------------------------------ #

def list_gplay_system_images() -> list[dict]:
    """
    Queries sdkmanager for available (not yet installed) Google Play system
    images matching the host architecture.  Returns a list of dicts:
      { "package": "system-images;android-34;google_apis_playstore;x86_64",
        "label":   "Android 34 — Google Play (x86_64)" }
    Sorted newest API level first.
    """
    sdkmanager = _find_sdk_tool("sdkmanager")
    if not sdkmanager:
        return []

    arch = _host_arch()
    try:
        result = subprocess.run(
            [sdkmanager, "--list"],
            capture_output=True, text=True, timeout=60,
            env=_sdk_env(),
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return []

    images = []
    seen: set[str] = set()
    for line in result.stdout.splitlines():
        line = line.strip()
        if not line.startswith("system-images;"):
            continue
        pkg = line.split()[0]
        parts = pkg.split(";")
        if len(parts) != 4:
            continue
        _, api, tag, image_arch = parts
        if image_arch != arch:
            continue
        if "playstore" not in tag or "automotive" in tag:
            continue
        if pkg in seen:
            continue
        seen.add(pkg)

        # Human-readable label
        api_label = api.replace("android-", "API ")
        tag_label = "Google Play"
        label = f"{api_label} — {tag_label} ({image_arch})"
        images.append({"package": pkg, "label": label})

    # Sort: numeric API levels descending, non-numeric (CANARY etc.) last
    def _sort_key(item):
        api_str = item["package"].split(";")[1].replace("android-", "")
        try:
            return (0, -int(api_str))
        except ValueError:
            return (1, api_str)

    images.sort(key=_sort_key)
    return images


def _avd_name_for_image(system_image: str) -> str:
    """Derives a stable AVD name from a system image package string."""
    parts = system_image.split(";")
    api = parts[1].replace("android-", "api") if len(parts) > 1 else "unknown"
    return f"MADPro_GPlay_{api}"


def download_gplay_emulator(
    system_image: str,
    on_output: Callable[[str], None] | None = None,
    stop_event: threading.Event | None = None,
) -> bool:
    """
    Downloads the Google Play system image via sdkmanager and creates an AVD.
    Uses the Android SDK bundled sdkmanager (not the system F-Droid one).
    Returns True on success.
    """
    def log(msg: str):
        if on_output:
            on_output(msg)

    sdkmanager = _find_sdk_tool("sdkmanager")
    if not sdkmanager:
        log("ERROR: Android SDK sdkmanager not found.")
        log("Install Android SDK command-line tools:")
        log("  https://developer.android.com/studio#command-tools")
        log("Extract to ~/Android/Sdk/cmdline-tools/latest/ and re-try.")
        return False

    avdmanager = _find_sdk_tool("avdmanager")
    if not avdmanager:
        log("ERROR: avdmanager not found. Re-install Android SDK cmdline-tools.")
        return False

    avd_name = _avd_name_for_image(system_image)
    env = _sdk_env()

    log(f"Using sdkmanager: {sdkmanager}")
    log(f"System image: {system_image}")

    # Step 1: accept licenses
    log("Accepting SDK licenses...")
    try:
        lic_proc = subprocess.Popen(
            [sdkmanager, "--licenses"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            env=env,
        )
        # Send 'y' many times to accept all license prompts
        try:
            lic_proc.stdin.write("y\n" * 20)
            lic_proc.stdin.flush()
            lic_proc.stdin.close()
        except (BrokenPipeError, OSError):
            pass
        lic_proc.wait(timeout=30)
    except Exception as e:
        log(f"WARNING: license step failed ({e}), continuing anyway...")

    # Step 2: install system image
    log(f"Downloading system image (this may take several minutes)...")
    try:
        proc = subprocess.Popen(
            [sdkmanager, "--install", system_image],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            env=env,
        )
        try:
            proc.stdin.write("y\n" * 10)
            proc.stdin.flush()
            proc.stdin.close()
        except (BrokenPipeError, OSError):
            pass

        for line in iter(proc.stdout.readline, ""):
            if stop_event and stop_event.is_set():
                proc.terminate()
                log("Download cancelled.")
                return False
            line = line.rstrip()
            if line:
                log(line)

        proc.wait()
        if proc.returncode != 0:
            log(f"ERROR: sdkmanager exited with code {proc.returncode}")
            return False
    except FileNotFoundError:
        log("ERROR: sdkmanager not executable.")
        return False

    # Step 3: create AVD
    log(f"Creating AVD '{avd_name}'...")
    try:
        result = subprocess.run(
            [
                avdmanager, "create", "avd",
                "-n", avd_name,
                "-k", system_image,
                "--force",
            ],
            input="no\n",  # decline custom hardware profile prompt
            capture_output=True,
            text=True,
            timeout=60,
            env=env,
        )
        if result.returncode != 0:
            err = (result.stderr or result.stdout).strip()
            log(f"ERROR: avdmanager failed: {err}")
            return False
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        log(f"ERROR: avdmanager failed: {e}")
        return False

    log(f"AVD '{avd_name}' created successfully with Google Play Store.")
    return True
