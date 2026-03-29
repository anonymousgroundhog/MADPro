"""
Action panel — inject button, progress bar, output directory, status.
"""
import os
import subprocess
import threading
import tkinter as tk
from tkinter import filedialog
import customtkinter as ctk

from gui import styles


class ActionPanel(ctk.CTkFrame):
    def __init__(self, master, on_inject, on_build_image, **kwargs):
        super().__init__(master, fg_color=styles.BG_SECONDARY, corner_radius=styles.CORNER_RADIUS, **kwargs)
        self._on_inject = on_inject
        self._on_build_image = on_build_image
        self._output_dir = tk.StringVar(value=os.path.expanduser("~/MADPro_Output"))
        self._build_ui()

    def _build_ui(self):
        ctk.CTkLabel(
            self, text="Actions", font=styles.FONT_HEADING,
            text_color=styles.ACCENT
        ).pack(anchor="w", padx=styles.PAD, pady=(styles.PAD, 4))

        # Output directory row
        out_row = ctk.CTkFrame(self, fg_color="transparent")
        out_row.pack(fill="x", padx=styles.PAD, pady=(0, styles.PAD_SMALL))

        ctk.CTkLabel(
            out_row, text="Output:", font=styles.FONT_BODY,
            text_color=styles.TEXT_SECONDARY, width=60
        ).pack(side="left")

        ctk.CTkEntry(
            out_row, textvariable=self._output_dir,
            font=styles.FONT_BODY, text_color=styles.TEXT_PRIMARY,
            fg_color=styles.BG_PRIMARY, border_color=styles.BG_CARD,
        ).pack(side="left", fill="x", expand=True, padx=(4, styles.PAD_SMALL))

        ctk.CTkButton(
            out_row, text="Browse", width=70, font=styles.FONT_SMALL,
            fg_color=styles.BG_CARD, hover_color=styles.ACCENT,
            command=self._browse_output
        ).pack(side="right")

        # Button row
        btn_row = ctk.CTkFrame(self, fg_color="transparent")
        btn_row.pack(fill="x", padx=styles.PAD, pady=(0, styles.PAD_SMALL))

        self._build_btn = ctk.CTkButton(
            btn_row, text="Build Docker Image", font=styles.FONT_BODY,
            fg_color=styles.BG_CARD, hover_color="#2563eb",
            command=self._on_build_image
        )
        self._build_btn.pack(side="left", padx=(0, styles.PAD_SMALL))

        self._inject_btn = ctk.CTkButton(
            btn_row, text="Inject Selected Classes", font=styles.FONT_BODY,
            fg_color=styles.ACCENT, hover_color=styles.ACCENT_HOVER,
            command=self._on_inject
        )
        self._inject_btn.pack(side="left")

        self._cancel_btn = ctk.CTkButton(
            btn_row, text="Cancel", font=styles.FONT_BODY,
            fg_color="#7f1d1d", hover_color="#991b1b",
            command=self._do_cancel, state="disabled"
        )
        self._cancel_btn.pack(side="left", padx=(styles.PAD_SMALL, 0))

        self._open_btn = ctk.CTkButton(
            btn_row, text="Open Output", font=styles.FONT_BODY,
            fg_color=styles.BG_CARD, hover_color=styles.ACCENT,
            command=self._open_output
        )
        self._open_btn.pack(side="right")

        # Progress bar
        self._progress = ctk.CTkProgressBar(
            self, mode="indeterminate",
            fg_color=styles.BG_PRIMARY, progress_color=styles.ACCENT
        )
        self._progress.pack(fill="x", padx=styles.PAD, pady=(0, styles.PAD_SMALL))
        self._progress.set(0)

        # Status label
        self._status_label = ctk.CTkLabel(
            self, text="Ready", font=styles.FONT_SMALL,
            text_color=styles.TEXT_SECONDARY
        )
        self._status_label.pack(anchor="w", padx=styles.PAD, pady=(0, styles.PAD))

        self._stop_event: threading.Event | None = None

    def _browse_output(self):
        d = filedialog.askdirectory(title="Select Output Directory")
        if d:
            self._output_dir.set(d)

    def _open_output(self):
        out = self._output_dir.get()
        os.makedirs(out, exist_ok=True)
        try:
            subprocess.Popen(["xdg-open", out])
        except Exception:
            pass

    def _do_cancel(self):
        if self._stop_event:
            self._stop_event.set()
        self.set_status("Cancelling...", styles.WARNING)

    def get_output_dir(self) -> str:
        return self._output_dir.get()

    def set_status(self, text: str, color: str = styles.TEXT_SECONDARY):
        self._status_label.configure(text=text, text_color=color)

    def set_busy(self, busy: bool, stop_event: threading.Event | None = None):
        self._stop_event = stop_event
        if busy:
            self._progress.configure(mode="indeterminate")
            self._progress.start()
            self._inject_btn.configure(state="disabled")
            self._build_btn.configure(state="disabled")
            self._cancel_btn.configure(state="normal")
        else:
            self._progress.stop()
            self._progress.configure(mode="determinate")
            self._progress.set(0)
            self._inject_btn.configure(state="normal")
            self._build_btn.configure(state="normal")
            self._cancel_btn.configure(state="disabled")

    def set_progress(self, current: int, total: int):
        if total > 0:
            self._progress.configure(mode="determinate")
            self._progress.set(current / total)
            self.set_status(f"Processing {current}/{total}...")
