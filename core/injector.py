"""
Orchestrates the full injection pipeline for one or more apps.
"""
import os
import shutil
import threading
from typing import Callable

from core import docker_runner
from core.apk_scanner import collect_app_targets


def inject_apks(
    apk_targets: list[tuple[str, str]],
    selected_classes: dict[str, list[str]],
    output_base_dir: str,
    on_log: Callable[[str], None],
    on_progress: Callable[[int, int], None],
    stop_event: threading.Event,
) -> dict[str, str]:
    """
    Injects into each app whose label appears in selected_classes.

    apk_targets is a list of (primary_apk_path, label).
    We re-scan the app's directory to find all APK files (split APKs),
    then pass them all to Docker.
    """
    results: dict[str, str] = {}
    total = len(apk_targets)

    # Build a label -> AppTarget map by re-scanning each app's directory
    # (avoids storing AppTarget objects in the GUI layer)
    label_to_app: dict[str, object] = {}
    seen_dirs: set[str] = set()
    for primary_apk, label in apk_targets:
        apk_dir = os.path.dirname(os.path.abspath(primary_apk))
        if apk_dir not in seen_dirs:
            seen_dirs.add(apk_dir)
            for app in collect_app_targets(apk_dir):
                # Match by primary apk filename
                if os.path.abspath(app.primary_apk) == os.path.abspath(primary_apk):
                    label_to_app[label] = app
                    break
        if label not in label_to_app:
            # Fallback: single-file target
            class _FallbackApp:
                pass
            fb = _FallbackApp()
            fb.primary_apk = primary_apk
            fb.apk_files = [primary_apk]
            label_to_app[label] = fb

    for i, (primary_apk, label) in enumerate(apk_targets):
        if stop_event.is_set():
            results[label] = "cancelled"
            continue

        on_progress(i, total)

        if label not in selected_classes:
            results[label] = "skipped"
            continue

        class_filter = selected_classes[label]
        app = label_to_app.get(label)
        apk_files = app.apk_files if app else [primary_apk]

        safe_label = label.replace("/", "_").replace(" ", "_")
        apk_output_dir = os.path.join(output_base_dir, safe_label)

        on_log(f"--- Injecting [{label}] ---")
        on_log(f"    APKs    : {', '.join(os.path.basename(f) for f in apk_files)}")
        on_log(f"    Output  : {apk_output_dir}")
        on_log(f"    Filter  : {', '.join(class_filter) if class_filter else '(all classes)'}")

        success = docker_runner.run_injection(
            primary_apk=primary_apk,
            apk_files=apk_files,
            output_dir=apk_output_dir,
            class_filter=class_filter,
            on_output=on_log,
            stop_event=stop_event,
        )

        if stop_event.is_set():
            results[label] = "cancelled"
            # Clean up partial output
            if os.path.isdir(apk_output_dir):
                shutil.rmtree(apk_output_dir, ignore_errors=True)
                on_log(f"    Cleaned up partial output: {apk_output_dir}")
        elif success:
            results[label] = "ok"
            on_log(f"    [OK] {label} injection complete.")
        else:
            results[label] = "failed"
            on_log(f"    [FAILED] {label} injection failed.")
            # Remove failed output directory so it doesn't leave corrupt APKs
            if os.path.isdir(apk_output_dir):
                shutil.rmtree(apk_output_dir, ignore_errors=True)
                on_log(f"    Removed failed output dir: {apk_output_dir}")

    on_progress(total, total)
    return results
