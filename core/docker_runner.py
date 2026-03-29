"""
Docker invocation layer — runs LogInjector inside the madpro-injector container.
All communication is via subprocess + mounted volumes.
"""
import os
import subprocess
import threading
from typing import Callable


IMAGE_NAME = "madpro-injector"


def is_docker_available() -> bool:
    try:
        result = subprocess.run(
            ["docker", "info"],
            capture_output=True, text=True, timeout=10
        )
        return result.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


def image_exists() -> bool:
    try:
        result = subprocess.run(
            ["docker", "image", "inspect", IMAGE_NAME],
            capture_output=True, text=True, timeout=10
        )
        return result.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return False


def build_image(project_root: str, on_output: Callable[[str], None] | None = None) -> bool:
    """Build the Docker image from the project root."""
    dockerfile = os.path.join(project_root, "docker", "Dockerfile")
    cmd = ["docker", "build", "-t", IMAGE_NAME, "-f", dockerfile, project_root]
    return _stream_command(cmd, on_output)


def run_injection(
    primary_apk: str,
    apk_files: list[str],
    output_dir: str,
    class_filter: list[str],
    on_output: Callable[[str], None] | None = None,
    stop_event: threading.Event | None = None,
) -> bool:
    """
    Runs the inject command inside the Docker container.

    If all APK files share the same directory (split APKs), mounts that directory
    and passes it as -process-dir so Soot sees all splits.
    If it's a single APK, mounts only its parent dir and passes the specific file.

    Args:
        primary_apk:  path to the main APK (base.apk or lone file)
        apk_files:    all APK paths for this app (may be just [primary_apk])
        output_dir:   host path where the instrumented APK will be written
        class_filter: list of class name substrings/patterns to inject into
    """
    abs_output = os.path.abspath(output_dir)
    os.makedirs(abs_output, exist_ok=True)

    filter_csv = ",".join(class_filter) if class_filter else ""

    # Determine what to mount and pass to Soot
    apk_dirs = {os.path.dirname(os.path.abspath(f)) for f in apk_files}
    if len(apk_dirs) == 1 and len(apk_files) > 1:
        # All splits in the same dir — pass the whole directory
        mount_host = list(apk_dirs)[0]
        soot_input = "/input"
    else:
        # Single APK or splits in different dirs — pass just the primary file
        mount_host = os.path.dirname(os.path.abspath(primary_apk))
        soot_input = f"/input/{os.path.basename(primary_apk)}"

    cmd = [
        "docker", "run", "--rm",
        "-v", f"{mount_host}:/input:ro",
        "-v", f"{abs_output}:/output",
        IMAGE_NAME,
        "inject",
        soot_input,
        "/output",
    ]
    if filter_csv:
        cmd.append(filter_csv)

    return _stream_command(cmd, on_output, stop_event)


def get_main_activity(
    primary_apk: str,
    on_output: Callable[[str], None] | None = None,
) -> list[str]:
    """
    Runs apktool inside the container to decode AndroidManifest.xml and
    returns the fully-qualified main activity class name(s).
    """
    apk_parent = os.path.dirname(os.path.abspath(primary_apk))
    apk_name = os.path.basename(primary_apk)

    cmd = [
        "docker", "run", "--rm",
        "-v", f"{apk_parent}:/input:ro",
        IMAGE_NAME,
        "get-main-activity",
        f"/input/{apk_name}",
    ]

    activities = []

    def capture(line: str):
        line = line.strip()
        if not line:
            return
        # Only accept lines that look like a Java class name:
        # contains a dot, no spaces, no brackets, doesn't start with I:/W:/E:
        if ("." in line and " " not in line and
                not line.startswith(("I:", "W:", "E:", "ERROR", "[", "#"))):
            activities.append(line)

    _stream_command(cmd, capture)
    return activities


def _stream_command(
    cmd: list[str],
    on_output: Callable[[str], None] | None,
    stop_event: threading.Event | None = None,
) -> bool:
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )

        for line in iter(proc.stdout.readline, ""):
            if stop_event and stop_event.is_set():
                proc.terminate()
                return False
            if on_output:
                on_output(line.rstrip())

        proc.wait()
        return proc.returncode == 0

    except FileNotFoundError:
        if on_output:
            on_output("ERROR: docker not found. Is Docker installed and running?")
        return False
    except Exception as e:
        if on_output:
            on_output(f"ERROR: {e}")
        return False
