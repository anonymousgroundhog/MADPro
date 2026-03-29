"""
Download settings panel — output dir, backend selector, auth token,
start/cancel buttons, progress bar, status.
"""
import os
import subprocess
import threading
import tkinter as tk
from tkinter import filedialog
import customtkinter as ctk

from gui import styles


class DownloadPanel(ctk.CTkFrame):
    def __init__(self, master, on_start, on_cancel, **kwargs):
        super().__init__(master, fg_color=styles.BG_SECONDARY,
                         corner_radius=styles.CORNER_RADIUS, **kwargs)
        self._on_start = on_start
        self._on_cancel = on_cancel
        self._stop_event: threading.Event | None = None
        self._output_dir = tk.StringVar(
            value=os.path.expanduser("~/MADPro_Downloads"))
        self._backend_var = tk.StringVar(value="apkpure")
        self._build_ui()

    def _build_ui(self):
        ctk.CTkLabel(self, text="Download Settings", font=styles.FONT_HEADING,
                     text_color=styles.ACCENT).pack(
            anchor="w", padx=styles.PAD, pady=(styles.PAD, 4))

        # apkeep status
        self._tool_label = ctk.CTkLabel(
            self, text="Checking for apkeep...",
            font=styles.FONT_SMALL, text_color=styles.WARNING)
        self._tool_label.pack(anchor="w", padx=styles.PAD,
                               pady=(0, styles.PAD_SMALL))

        # Output directory
        out_row = ctk.CTkFrame(self, fg_color="transparent")
        out_row.pack(fill="x", padx=styles.PAD, pady=(0, styles.PAD_SMALL))

        ctk.CTkLabel(out_row, text="Output:", font=styles.FONT_BODY,
                     text_color=styles.TEXT_SECONDARY, width=55).pack(side="left")

        ctk.CTkEntry(out_row, textvariable=self._output_dir,
                     font=styles.FONT_BODY, text_color=styles.TEXT_PRIMARY,
                     fg_color=styles.BG_PRIMARY,
                     border_color=styles.BG_CARD).pack(
            side="left", fill="x", expand=True, padx=(4, styles.PAD_SMALL))

        ctk.CTkButton(out_row, text="Browse", width=70, font=styles.FONT_SMALL,
                      fg_color=styles.BG_CARD, hover_color=styles.ACCENT,
                      command=self._browse_output).pack(side="right")

        # Backend selector
        backend_row = ctk.CTkFrame(self, fg_color="transparent")
        backend_row.pack(fill="x", padx=styles.PAD, pady=(0, styles.PAD_SMALL))

        ctk.CTkLabel(backend_row, text="Source:", font=styles.FONT_BODY,
                     text_color=styles.TEXT_SECONDARY, width=55).pack(side="left")

        ctk.CTkRadioButton(
            backend_row, text="ApkPure  (no auth required)",
            variable=self._backend_var, value="apkpure",
            font=styles.FONT_BODY, text_color=styles.TEXT_PRIMARY,
            fg_color=styles.ACCENT, hover_color=styles.ACCENT_HOVER,
            command=self._on_backend_changed,
        ).pack(side="left", padx=(4, styles.PAD))

        ctk.CTkRadioButton(
            backend_row, text="Google Play  (token required)",
            variable=self._backend_var, value="google-play",
            font=styles.FONT_BODY, text_color=styles.TEXT_PRIMARY,
            fg_color=styles.ACCENT, hover_color=styles.ACCENT_HOVER,
            command=self._on_backend_changed,
        ).pack(side="left")

        # Google Play auth fields (hidden by default)
        self._auth_frame = ctk.CTkFrame(self, fg_color="transparent")
        self._auth_frame.pack(fill="x", padx=styles.PAD,
                               pady=(0, styles.PAD_SMALL))

        email_row = ctk.CTkFrame(self._auth_frame, fg_color="transparent")
        email_row.pack(fill="x", pady=(0, 2))
        ctk.CTkLabel(email_row, text="Email:", font=styles.FONT_SMALL,
                     text_color=styles.TEXT_SECONDARY, width=55).pack(side="left")
        self._email_var = tk.StringVar()
        ctk.CTkEntry(email_row, textvariable=self._email_var,
                     placeholder_text="Google account email",
                     font=styles.FONT_BODY, fg_color=styles.BG_PRIMARY,
                     border_color=styles.BG_CARD).pack(
            side="left", fill="x", expand=True, padx=(4, 0))

        token_row = ctk.CTkFrame(self._auth_frame, fg_color="transparent")
        token_row.pack(fill="x")
        ctk.CTkLabel(token_row, text="Token:", font=styles.FONT_SMALL,
                     text_color=styles.TEXT_SECONDARY, width=55).pack(side="left")
        self._token_var = tk.StringVar()
        ctk.CTkEntry(token_row, textvariable=self._token_var,
                     placeholder_text="AAS token (from gplaycli --token)",
                     show="•", font=styles.FONT_BODY,
                     fg_color=styles.BG_PRIMARY,
                     border_color=styles.BG_CARD).pack(
            side="left", fill="x", expand=True, padx=(4, 0))

        self._auth_frame.pack_forget()  # hidden until google-play selected

        # Buttons
        btn_row = ctk.CTkFrame(self, fg_color="transparent")
        btn_row.pack(fill="x", padx=styles.PAD, pady=(0, styles.PAD_SMALL))

        self._start_btn = ctk.CTkButton(
            btn_row, text="Start Download", font=styles.FONT_BODY,
            fg_color=styles.ACCENT, hover_color=styles.ACCENT_HOVER,
            command=self._on_start)
        self._start_btn.pack(side="left", padx=(0, styles.PAD_SMALL))

        self._cancel_btn = ctk.CTkButton(
            btn_row, text="Cancel", font=styles.FONT_BODY,
            fg_color="#7f1d1d", hover_color="#991b1b",
            command=self._do_cancel, state="disabled")
        self._cancel_btn.pack(side="left")

        ctk.CTkButton(
            btn_row, text="Open Output", font=styles.FONT_BODY,
            fg_color=styles.BG_CARD, hover_color=styles.ACCENT,
            command=self._open_output).pack(side="right")

        # Progress
        self._progress = ctk.CTkProgressBar(
            self, mode="determinate",
            fg_color=styles.BG_PRIMARY, progress_color=styles.ACCENT)
        self._progress.pack(fill="x", padx=styles.PAD,
                             pady=(0, styles.PAD_SMALL))
        self._progress.set(0)

        # Status
        self._status = ctk.CTkLabel(self, text="Ready",
                                     font=styles.FONT_SMALL,
                                     text_color=styles.TEXT_SECONDARY)
        self._status.pack(anchor="w", padx=styles.PAD,
                           pady=(0, styles.PAD))

        # Check apkeep availability
        import threading
        threading.Thread(target=self._check_apkeep, daemon=True).start()

    def _check_apkeep(self):
        from core.apk_downloader import is_apkeep_available
        ok = is_apkeep_available()
        self.after(0, lambda: self._tool_label.configure(
            text="apkeep: ready" if ok else
                 "apkeep not found — install: cargo install apkeep  "
                 "or download from github.com/EFForg/apkeep/releases",
            text_color=styles.SUCCESS if ok else styles.ERROR,
        ))

    def _on_backend_changed(self):
        if self._backend_var.get() == "google-play":
            self._auth_frame.pack(fill="x", padx=styles.PAD,
                                   pady=(0, styles.PAD_SMALL),
                                   before=self._status.master)
        else:
            self._auth_frame.pack_forget()

    def _browse_output(self):
        d = filedialog.askdirectory(title="Select Download Output Directory")
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

    # ------------------------------------------------------------------ #
    #  Public API                                                          #
    # ------------------------------------------------------------------ #

    def get_output_dir(self) -> str:
        return self._output_dir.get()

    def get_backend(self) -> str:
        return self._backend_var.get()

    def get_email(self) -> str:
        return self._email_var.get().strip()

    def get_token(self) -> str:
        return self._token_var.get().strip()

    def set_status(self, text: str, color: str = styles.TEXT_SECONDARY):
        self._status.configure(text=text, text_color=color)

    def set_progress(self, current: int, total: int):
        val = current / total if total > 0 else 0
        self._progress.configure(mode="determinate")
        self._progress.set(val)
        self.set_status(f"Downloading {current}/{total}...")

    def set_busy(self, busy: bool,
                 stop_event: threading.Event | None = None):
        self._stop_event = stop_event
        if busy:
            self._progress.configure(mode="indeterminate")
            self._progress.start()
            self._start_btn.configure(state="disabled")
            self._cancel_btn.configure(state="normal")
        else:
            self._progress.stop()
            self._progress.configure(mode="determinate")
            self._progress.set(0)
            self._start_btn.configure(state="normal")
            self._cancel_btn.configure(state="disabled")
