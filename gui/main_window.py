"""
MADPro main application window.
Tab 1 — Inject APKs: directory picker + class patterns + Soot injection
Tab 2 — Download APKs: device selector + Play Store categories + apkeep download
"""
import os
import threading
import customtkinter as ctk

from gui import styles
from gui.widgets.apk_directory_picker import ApkDirectoryPicker
from gui.widgets.class_list_panel import ClassListPanel
from gui.widgets.action_panel import ActionPanel
from gui.widgets.log_panel import LogPanel


class MainWindow(ctk.CTk):
    def __init__(self):
        super().__init__()
        self.title("MADPro — Mobile APK Decompiler & Injector")
        self.geometry("1400x860")
        self.minsize(1100, 700)
        self.configure(fg_color=styles.BG_PRIMARY)
        self._apk_targets: list[tuple[str, str]] = []
        self._build_ui()
        self._check_docker_on_startup()

    def _build_ui(self):
        # Title bar (above all tabs)
        title_bar = ctk.CTkFrame(self, fg_color=styles.BG_SECONDARY,
                                  height=48, corner_radius=0)
        title_bar.pack(fill="x", side="top")
        title_bar.pack_propagate(False)

        ctk.CTkLabel(title_bar, text="MADPro",
                     font=styles.FONT_TITLE,
                     text_color=styles.ACCENT).pack(side="left", padx=16, pady=8)

        ctk.CTkLabel(title_bar, text="Mobile APK Decompiler & Injector",
                     font=styles.FONT_BODY,
                     text_color=styles.TEXT_SECONDARY).pack(
            side="left", padx=(0, 16), pady=8)

        self._docker_status_label = ctk.CTkLabel(
            title_bar, text="Checking Docker...",
            font=styles.FONT_SMALL, text_color=styles.WARNING)
        self._docker_status_label.pack(side="right", padx=16)

        # Tab view
        self._tabs = ctk.CTkTabview(
            self,
            fg_color=styles.BG_PRIMARY,
            segmented_button_fg_color=styles.BG_SECONDARY,
            segmented_button_selected_color=styles.ACCENT,
            segmented_button_selected_hover_color=styles.ACCENT_HOVER,
            segmented_button_unselected_color=styles.BG_SECONDARY,
            segmented_button_unselected_hover_color=styles.BG_CARD,
            text_color=styles.TEXT_PRIMARY,
            text_color_disabled=styles.TEXT_MUTED,
        )
        self._tabs.pack(fill="both", expand=True,
                        padx=styles.PAD, pady=(styles.PAD_SMALL, styles.PAD))
        self._tabs.add("Inject APKs")
        self._tabs.add("Download APKs")

        self._build_inject_tab(self._tabs.tab("Inject APKs"))
        self._build_download_tab(self._tabs.tab("Download APKs"))

    # ------------------------------------------------------------------ #
    #  Tab 1 — Inject APKs                                                #
    # ------------------------------------------------------------------ #

    def _build_inject_tab(self, tab):
        content = ctk.CTkFrame(tab, fg_color="transparent")
        content.pack(fill="both", expand=True)

        # Left column
        left = ctk.CTkFrame(content, fg_color="transparent",
                             width=styles.SIDEBAR_WIDTH)
        left.pack(side="left", fill="both", padx=(0, styles.PAD_SMALL))
        left.pack_propagate(False)

        self._dir_picker = ApkDirectoryPicker(
            left, on_apks_found=self._on_apks_found)
        self._dir_picker.pack(fill="x", pady=(0, styles.PAD_SMALL))

        self._class_list = ClassListPanel(left)
        self._class_list.pack(fill="both", expand=True)

        # Right column
        right = ctk.CTkFrame(content, fg_color="transparent")
        right.pack(side="left", fill="both", expand=True)

        self._action_panel = ActionPanel(
            right,
            on_inject=self._start_injection,
            on_build_image=self._start_build_image,
        )
        self._action_panel.pack(fill="x", pady=(0, styles.PAD_SMALL))

        self._log_panel = LogPanel(right)
        self._log_panel.pack(fill="both", expand=True)

    # ------------------------------------------------------------------ #
    #  Tab 2 — Download APKs                                              #
    # ------------------------------------------------------------------ #

    def _build_download_tab(self, tab):
        from views.download_view import DownloadView
        view = DownloadView(tab)
        view.pack(fill="both", expand=True)

    # ------------------------------------------------------------------ #
    #  Docker status                                                       #
    # ------------------------------------------------------------------ #

    def _check_docker_on_startup(self):
        def check():
            from core.docker_runner import is_docker_available, image_exists
            docker_ok = is_docker_available()
            img_ok = image_exists() if docker_ok else False
            self.after(0, lambda: self._update_docker_status(docker_ok, img_ok))
        threading.Thread(target=check, daemon=True).start()

    def _update_docker_status(self, docker_ok: bool, image_ok: bool):
        if not docker_ok:
            self._docker_status_label.configure(
                text="Docker: NOT AVAILABLE", text_color=styles.ERROR)
            self._log_panel.append(
                "ERROR: Docker is not available. Install Docker and ensure it's running.")
        elif not image_ok:
            self._docker_status_label.configure(
                text="Docker: Image not built", text_color=styles.WARNING)
            self._log_panel.append(
                "Docker is running but the madpro-injector image is not built.\n"
                "Click 'Build Docker Image' to build it.")
        else:
            self._docker_status_label.configure(
                text="Docker: Ready", text_color=styles.SUCCESS)
            self._log_panel.append("Docker image ready. Select a directory to begin.")

    # ------------------------------------------------------------------ #
    #  Inject tab — APK discovery                                         #
    # ------------------------------------------------------------------ #

    def _on_apks_found(self, apk_targets: list[tuple[str, str]]):
        self._apk_targets = apk_targets
        self._class_list.load_apks(apk_targets)
        if apk_targets:
            self._log_panel.append(
                f"Found {len(apk_targets)} APK(s). Detecting main activities...")
            for path, label in apk_targets:
                self._log_panel.append(f"  [{label}] {path}")

    # ------------------------------------------------------------------ #
    #  Inject tab — Docker image build                                    #
    # ------------------------------------------------------------------ #

    def _start_build_image(self):
        project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

        platforms_dir = os.path.join(project_root, "android", "platforms")
        if not os.path.isdir(platforms_dir) or not os.listdir(platforms_dir):
            self._log_panel.append(
                "ERROR: android/platforms/ directory is empty.\n"
                "       Run: make copy-assets")
            return

        jar_libs_dir = os.path.join(project_root, "jar_libs")
        if not os.path.isdir(jar_libs_dir) or not os.listdir(jar_libs_dir):
            self._log_panel.append(
                "ERROR: jar_libs/ directory is empty.\n"
                "       Run: make copy-assets")
            return

        stop_event = threading.Event()
        self._action_panel.set_busy(True, stop_event)
        self._action_panel.set_status("Building Docker image...", styles.INFO)
        self._log_panel.append(
            "--- Building Docker image (this may take a few minutes) ---")

        def worker():
            from core.docker_runner import build_image
            success = build_image(project_root,
                                  on_output=self._log_panel.append)
            self.after(0, lambda: self._on_build_done(success))

        threading.Thread(target=worker, daemon=True).start()

    def _on_build_done(self, success: bool):
        self._action_panel.set_busy(False)
        if success:
            self._action_panel.set_status(
                "Docker image built successfully.", styles.SUCCESS)
            self._log_panel.append("--- Docker image build complete ---")
            self._check_docker_on_startup()
        else:
            self._action_panel.set_status(
                "Docker image build failed.", styles.ERROR)
            self._log_panel.append("--- Docker image build FAILED ---")

    # ------------------------------------------------------------------ #
    #  Inject tab — Soot injection                                        #
    # ------------------------------------------------------------------ #

    def _start_injection(self):
        if not self._apk_targets:
            self._log_panel.append("No APKs loaded. Select a directory first.")
            return

        selected = self._class_list.get_selected()
        if not selected:
            self._log_panel.append(
                "No injection patterns defined. "
                "Add a pattern or wait for MainActivity detection.")
            return

        label_to_path = {label: path for path, label in self._apk_targets}
        inject_targets = [
            (label_to_path[label], label)
            for label in selected if label in label_to_path
        ]

        if not inject_targets:
            self._log_panel.append(
                "No matching APK targets found for the current patterns.")
            return

        output_dir = self._action_panel.get_output_dir()
        stop_event = threading.Event()
        self._action_panel.set_busy(True, stop_event)
        self._action_panel.set_status(
            f"Injecting {len(inject_targets)} APK(s)...", styles.INFO)
        self._log_panel.append(
            f"--- Starting injection: {len(inject_targets)} APK(s) ---")

        def worker():
            from core.injector import inject_apks
            results = inject_apks(
                apk_targets=inject_targets,
                selected_classes=selected,
                output_base_dir=output_dir,
                on_log=self._log_panel.append,
                on_progress=lambda c, t: self.after(
                    0, lambda: self._action_panel.set_progress(c, t)),
                stop_event=stop_event,
            )
            self.after(0, lambda: self._on_injection_done(results))

        threading.Thread(target=worker, daemon=True).start()

    def _on_injection_done(self, results: dict[str, str]):
        self._action_panel.set_busy(False)
        ok = sum(1 for v in results.values() if v == "ok")
        failed = sum(1 for v in results.values() if v == "failed")
        cancelled = sum(1 for v in results.values() if v == "cancelled")

        summary = f"Done: {ok} succeeded, {failed} failed"
        if cancelled:
            summary += f", {cancelled} cancelled"

        color = (styles.SUCCESS if failed == 0
                 else styles.WARNING if ok > 0 else styles.ERROR)
        self._action_panel.set_status(summary, color)
        self._log_panel.append(f"--- Injection complete: {summary} ---")
        self._log_panel.append(
            f"    Output: {self._action_panel.get_output_dir()}")
