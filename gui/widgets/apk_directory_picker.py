"""
Directory picker widget — lets user browse to a directory and triggers APK discovery.
"""
import os
import threading
import tkinter as tk
from tkinter import filedialog
import customtkinter as ctk

from gui import styles


class ApkDirectoryPicker(ctk.CTkFrame):
    def __init__(self, master, on_apks_found, **kwargs):
        super().__init__(master, fg_color=styles.BG_SECONDARY, corner_radius=styles.CORNER_RADIUS, **kwargs)
        self._on_apks_found = on_apks_found
        self._selected_dir = tk.StringVar(value="")
        self._build_ui()

    def _build_ui(self):
        ctk.CTkLabel(
            self, text="APK Directory", font=styles.FONT_HEADING,
            text_color=styles.ACCENT
        ).pack(anchor="w", padx=styles.PAD, pady=(styles.PAD, 2))

        row = ctk.CTkFrame(self, fg_color="transparent")
        row.pack(fill="x", padx=styles.PAD, pady=(0, styles.PAD))

        self._dir_entry = ctk.CTkEntry(
            row, textvariable=self._selected_dir,
            placeholder_text="Select a directory containing APKs...",
            font=styles.FONT_BODY, text_color=styles.TEXT_PRIMARY,
            fg_color=styles.BG_PRIMARY, border_color=styles.BG_CARD,
        )
        self._dir_entry.pack(side="left", fill="x", expand=True, padx=(0, styles.PAD_SMALL))

        self._browse_btn = ctk.CTkButton(
            row, text="Browse", width=80, font=styles.FONT_BODY,
            fg_color=styles.BG_CARD, hover_color=styles.ACCENT,
            command=self._browse
        )
        self._browse_btn.pack(side="right")

        self._status_label = ctk.CTkLabel(
            self, text="", font=styles.FONT_SMALL,
            text_color=styles.TEXT_SECONDARY
        )
        self._status_label.pack(anchor="w", padx=styles.PAD, pady=(0, styles.PAD_SMALL))

    def _browse(self):
        directory = filedialog.askdirectory(title="Select APK Directory")
        if directory:
            self._selected_dir.set(directory)
            self._scan_directory(directory)

    def _scan_directory(self, directory: str):
        self._status_label.configure(text="Scanning...", text_color=styles.INFO)
        self._browse_btn.configure(state="disabled")

        def worker():
            from core.apk_scanner import collect_apk_targets
            apk_targets = collect_apk_targets(directory)
            self.after(0, lambda: self._on_scan_complete(apk_targets))

        threading.Thread(target=worker, daemon=True).start()

    def _on_scan_complete(self, apk_targets: list):
        self._browse_btn.configure(state="normal")
        count = len(apk_targets)
        if count == 0:
            self._status_label.configure(
                text="No APKs found in this directory.",
                text_color=styles.WARNING
            )
        else:
            self._status_label.configure(
                text=f"Found {count} APK{'s' if count != 1 else ''}",
                text_color=styles.SUCCESS
            )
        self._on_apks_found(apk_targets)

    def get_directory(self) -> str:
        return self._selected_dir.get()
