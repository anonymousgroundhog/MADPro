"""
Log output panel — scrolling text widget that displays injection progress and output.
"""
import tkinter as tk
import customtkinter as ctk

from gui import styles


class LogPanel(ctk.CTkFrame):
    def __init__(self, master, **kwargs):
        super().__init__(master, fg_color=styles.BG_SECONDARY, corner_radius=styles.CORNER_RADIUS, **kwargs)
        self._build_ui()
        self._auto_scroll = True

    def _build_ui(self):
        header = ctk.CTkFrame(self, fg_color="transparent")
        header.pack(fill="x", padx=styles.PAD, pady=(styles.PAD, 2))

        ctk.CTkLabel(
            header, text="Output Log", font=styles.FONT_HEADING,
            text_color=styles.ACCENT
        ).pack(side="left")

        ctk.CTkButton(
            header, text="Clear", width=55, font=styles.FONT_SMALL,
            fg_color=styles.BG_CARD, hover_color=styles.ERROR,
            command=self.clear
        ).pack(side="right")

        ctk.CTkButton(
            header, text="Auto-scroll", width=85, font=styles.FONT_SMALL,
            fg_color=styles.BG_CARD, hover_color=styles.ACCENT,
            command=self._toggle_autoscroll
        ).pack(side="right", padx=(0, styles.PAD_SMALL))

        self._text = tk.Text(
            self,
            bg=styles.BG_PRIMARY, fg=styles.TEXT_PRIMARY,
            font=styles.FONT_CODE,
            state="disabled",
            relief="flat",
            bd=0,
            wrap="none",
            selectbackground=styles.BG_CARD,
            insertbackground=styles.TEXT_PRIMARY,
        )

        self._scrollbar_y = tk.Scrollbar(self, orient="vertical", command=self._text.yview)
        self._scrollbar_x = tk.Scrollbar(self, orient="horizontal", command=self._text.xview)
        self._text.configure(yscrollcommand=self._scrollbar_y.set,
                              xscrollcommand=self._scrollbar_x.set)

        self._scrollbar_x.pack(side="bottom", fill="x", padx=styles.PAD)
        self._scrollbar_y.pack(side="right", fill="y", pady=(0, styles.PAD))
        self._text.pack(fill="both", expand=True, padx=(styles.PAD, 0), pady=(0, styles.PAD))

        # Tag colors
        self._text.tag_config("ok", foreground=styles.SUCCESS)
        self._text.tag_config("error", foreground=styles.ERROR)
        self._text.tag_config("warn", foreground=styles.WARNING)
        self._text.tag_config("info", foreground=styles.INFO)
        self._text.tag_config("header", foreground=styles.ACCENT)
        self._text.tag_config("soot", foreground=styles.TEXT_PRIMARY)

    def _toggle_autoscroll(self):
        self._auto_scroll = not self._auto_scroll

    def append(self, line: str):
        """Append a line to the log. Can be called from any thread."""
        self.after(0, lambda: self._insert_line(line))

    def _insert_line(self, line: str):
        self._text.configure(state="normal")
        tag = self._classify_line(line)
        self._text.insert("end", line + "\n", tag)
        self._text.configure(state="disabled")
        if self._auto_scroll:
            self._text.see("end")

    def _classify_line(self, line: str) -> str:
        low = line.lower()
        if "[ok]" in low or "injection complete" in low or "complete" in low:
            return "ok"
        if "[failed]" in low or "error" in low or "exception" in low:
            return "error"
        if "warning" in low or "warn" in low or "skipping" in low:
            return "warn"
        if line.startswith("---"):
            return "header"
        if "sootinjection" in low or "entering method" in low:
            return "soot"
        if "info" in low:
            return "info"
        return ""

    def clear(self):
        self._text.configure(state="normal")
        self._text.delete("1.0", "end")
        self._text.configure(state="disabled")
