"""
Recursively discovers APK files in a directory.

Groups split APKs (base.apk + config.*.apk in the same folder) under one app entry.
Returns AppTarget objects so the injector can pass the whole directory to Soot.
"""
import os
from dataclasses import dataclass, field


@dataclass
class AppTarget:
    """Represents one app — may contain multiple APK files (split APKs)."""
    label: str               # human-readable name shown in the GUI
    apk_dir: str             # directory containing the APK(s)
    apk_files: list[str]     # all APK paths in this app
    primary_apk: str         # the main APK (base.apk or the lone file) for class enumeration


def collect_app_targets(base_dir: str) -> list[AppTarget]:
    """
    Scans base_dir recursively and groups APKs into AppTarget entries.

    Rules:
    - A directory that contains one or more .apk files becomes ONE AppTarget.
      Its label is the directory name (relative path from base_dir for nested dirs).
      Soot receives the whole directory via -process-dir.
    - A bare .apk directly inside base_dir becomes its own AppTarget with the
      file's parent dir as the apk_dir.

    Returns list sorted by label.
    """
    targets: list[AppTarget] = []
    base_dir = os.path.abspath(base_dir)

    # Track which directories we've already processed
    seen_dirs: set[str] = set()

    for root, dirs, files in os.walk(base_dir):
        apks_here = [f for f in files if f.lower().endswith(".apk")]
        if not apks_here:
            continue

        abs_root = os.path.abspath(root)
        if abs_root in seen_dirs:
            continue
        seen_dirs.add(abs_root)

        full_paths = [os.path.join(abs_root, f) for f in sorted(apks_here)]

        # Label: relative path from base_dir, or just the dir name if top-level
        rel = os.path.relpath(abs_root, base_dir)
        if rel == ".":
            # APKs sitting directly in the chosen directory
            # Create one target per APK file
            for apk_path in full_paths:
                stem = os.path.splitext(os.path.basename(apk_path))[0]
                targets.append(AppTarget(
                    label=stem,
                    apk_dir=abs_root,
                    apk_files=[apk_path],
                    primary_apk=apk_path,
                ))
        else:
            # All APKs in this subdirectory belong to one app
            label = rel.replace(os.sep, "/")

            # Primary APK: prefer base.apk, otherwise the first alphabetically
            primary = next(
                (p for p in full_paths if os.path.basename(p).lower() == "base.apk"),
                full_paths[0]
            )

            targets.append(AppTarget(
                label=label,
                apk_dir=abs_root,
                apk_files=full_paths,
                primary_apk=primary,
            ))

    return sorted(targets, key=lambda t: t.label.lower())


# ---------------------------------------------------------------------------
# Legacy flat list helper (kept for backwards compat with GUI display)
# ---------------------------------------------------------------------------

def collect_apk_targets(base_dir: str) -> list[tuple[str, str]]:
    """
    Returns (primary_apk_path, label) for each app.
    Used by the GUI's directory picker callback.
    """
    return [(t.primary_apk, t.label) for t in collect_app_targets(base_dir)]
