"""
Download APKs view — assembles DevicePanel, CategoryPanel, DownloadPanel,
and LogPanel into a two-column layout matching the Inject tab style.
Owns the download thread lifecycle.
"""
import threading
import customtkinter as ctk

from gui import styles
from gui.widgets.device_panel import DevicePanel
from gui.widgets.category_panel import CategoryPanel
from gui.widgets.download_panel import DownloadPanel
from gui.widgets.log_panel import LogPanel


class DownloadView(ctk.CTkFrame):
    def __init__(self, master, **kwargs):
        super().__init__(master, fg_color="transparent", **kwargs)
        self._build_ui()

    def _build_ui(self):
        # Left column — device + categories
        left = ctk.CTkFrame(self, fg_color="transparent",
                             width=styles.SIDEBAR_WIDTH)
        left.pack(side="left", fill="both",
                  padx=(0, styles.PAD_SMALL))
        left.pack_propagate(False)

        self._device_panel = DevicePanel(left)
        self._device_panel.pack(fill="x", pady=(0, styles.PAD_SMALL))

        self._category_panel = CategoryPanel(left)
        self._category_panel.pack(fill="both", expand=True)

        # Right column — settings + log
        right = ctk.CTkFrame(self, fg_color="transparent")
        right.pack(side="left", fill="both", expand=True)

        self._download_panel = DownloadPanel(
            right,
            on_start=self._start_download,
            on_cancel=self._cancel_download,
        )
        self._download_panel.pack(fill="x", pady=(0, styles.PAD_SMALL))

        self._log = LogPanel(right)
        self._log.pack(fill="both", expand=True)

        self._log.append("Select categories and click Start Download.")
        self._log.append(
            "ApkPure: downloads via apkeep (no auth required). "
            "Google Play: automates the Play Store on your emulator via Appium."
        )

    # ------------------------------------------------------------------ #
    #  Download orchestration                                              #
    # ------------------------------------------------------------------ #

    def _start_download(self):
        selected_cats = self._category_panel.get_selected()
        if not selected_cats:
            self._log.append("No categories selected — check at least one category.")
            return

        count = self._category_panel.get_count()
        output_dir = self._download_panel.get_output_dir()
        backend = self._download_panel.get_backend()

        from core.apk_downloader import get_top_packages, DownloadJob

        if backend == "google-play":
            # Collect all packages across categories then hand to Appium
            from core.appium_downloader import (
                is_appium_available, is_uia2_driver_installed,
                start_appium_server, download_via_appium,
            )
            if not is_appium_available() or not is_uia2_driver_installed():
                self._log.append(
                    "Appium is not set up. Select Google Play source and "
                    "click Setup Appium first."
                )
                return

            all_packages: list[str] = []
            for cat_id, cat_name in selected_cats:
                pkgs = get_top_packages(cat_id, count, backend,
                                        on_log=self._log.append)
                all_packages.extend(pkgs)

            if not all_packages:
                self._log.append("No packages found for the selected categories.")
                return

            device_serial = self._device_panel.get_selected_serial()
            self._log.append(
                f"--- Starting Appium download: {len(all_packages)} app(s) "
                f"via Play Store on {device_serial or 'first available device'} ---"
            )

            self._stop_event = threading.Event()
            stop_event = self._stop_event
            self._download_panel.set_busy(True, stop_event)

            def worker():
                self._log.append("Starting Appium server...")
                start_appium_server(on_output=self._log.append)
                pulled = download_via_appium(
                    packages=all_packages,
                    output_dir=output_dir,
                    device_serial=device_serial,
                    on_output=self._log.append,
                    stop_event=stop_event,
                )
                if stop_event.is_set():
                    self.after(0, lambda: self._on_done({}))
                    return
                results = {p: ("ok" if any(p in path for path in pulled)
                               else "failed")
                           for p in all_packages}
                self.after(0, lambda: self._on_done(results))

        else:
            # ApkPure via apkeep
            jobs = []
            for cat_id, cat_name in selected_cats:
                packages = get_top_packages(cat_id, count, backend,
                                            on_log=self._log.append)
                if packages:
                    jobs.append(DownloadJob(
                        category_id=cat_id,
                        category_name=cat_name,
                        packages=packages,
                        output_dir=output_dir,
                        backend=backend,
                    ))

            if not jobs:
                self._log.append("No packages found for the selected categories.")
                return

            total_pkgs = sum(len(j.packages) for j in jobs)
            self._log.append(
                f"--- Starting download: {len(jobs)} categor(ies), "
                f"{total_pkgs} app(s), backend=apkpure ---"
            )

            self._stop_event = threading.Event()
            stop_event = self._stop_event
            self._download_panel.set_busy(True, stop_event)

            def worker():
                from core.apk_downloader import run_download_jobs
                results = run_download_jobs(
                    jobs=jobs,
                    on_log=self._log.append,
                    on_progress=lambda c, t: self.after(
                        0, lambda: self._download_panel.set_progress(c, t)),
                    stop_event=stop_event,
                )
                self.after(0, lambda: self._on_done(results))

        threading.Thread(target=worker, daemon=True).start()

    def _cancel_download(self):
        if hasattr(self, "_stop_event") and self._stop_event:
            self._stop_event.set()
        # Force-quit any active Appium session so WebDriverWait unblocks
        from core.appium_downloader import cancel_active_session
        cancel_active_session(on_output=self._log.append)
        self._log.append("Cancelling download...")

    def _on_done(self, results: dict[str, str]):
        self._download_panel.set_busy(False)
        ok = sum(1 for v in results.values() if v == "ok")
        failed = sum(1 for v in results.values() if v == "failed")
        cancelled = sum(1 for v in results.values() if v == "cancelled")

        parts = [f"{ok} downloaded"]
        if failed:
            parts.append(f"{failed} failed")
        if cancelled:
            parts.append(f"{cancelled} cancelled")

        summary = ", ".join(parts)
        color = (styles.SUCCESS if failed == 0 and cancelled == 0
                 else styles.WARNING if ok > 0 else styles.ERROR)

        self._download_panel.set_status(summary, color)
        self._log.append(f"--- Download complete: {summary} ---")
        self._log.append(
            f"    Output: {self._download_panel.get_output_dir()}")
