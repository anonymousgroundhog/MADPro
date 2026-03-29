"""
Class/pattern injection panel.

Users enter partial match patterns or wildcards.
MainActivity is auto-detected from AndroidManifest.xml via apktool in Docker.
Apps can be individually ignored (skipped during injection).
"""
import threading
import tkinter as tk
import customtkinter as ctk

from gui import styles


class ClassListPanel(ctk.CTkFrame):
    def __init__(self, master, **kwargs):
        super().__init__(master, fg_color=styles.BG_SECONDARY,
                         corner_radius=styles.CORNER_RADIUS, **kwargs)

        # label -> list of pattern strings
        self._patterns: dict[str, list[str]] = {}
        # label -> bool (True = ignored, skip during injection)
        self._ignored: dict[str, bool] = {}
        # label -> primary_apk path
        self._label_to_apk: dict[str, str] = {}
        # ordered list of labels
        self._labels: list[str] = []
        # section widget refs
        self._sections: dict[str, ctk.CTkFrame] = {}

        self._build_ui()

    # ------------------------------------------------------------------ #
    #  UI construction                                                     #
    # ------------------------------------------------------------------ #

    def _build_ui(self):
        header = ctk.CTkFrame(self, fg_color="transparent")
        header.pack(fill="x", padx=styles.PAD, pady=(styles.PAD, 2))

        ctk.CTkLabel(header, text="Injection Patterns", font=styles.FONT_HEADING,
                     text_color=styles.ACCENT).pack(side="left")

        self._count_label = ctk.CTkLabel(header, text="", font=styles.FONT_SMALL,
                                          text_color=styles.TEXT_SECONDARY)
        self._count_label.pack(side="right")

        # Pattern entry row
        entry_row = ctk.CTkFrame(self, fg_color="transparent")
        entry_row.pack(fill="x", padx=styles.PAD, pady=(styles.PAD_SMALL, 0))

        self._pattern_var = tk.StringVar()
        self._entry = ctk.CTkEntry(
            entry_row, textvariable=self._pattern_var,
            placeholder_text="Class name or pattern  (e.g. MainActivity, com.example.*, *Login*)",
            font=styles.FONT_BODY, text_color=styles.TEXT_PRIMARY,
            fg_color=styles.BG_PRIMARY, border_color=styles.BG_CARD,
        )
        self._entry.pack(side="left", fill="x", expand=True, padx=(0, styles.PAD_SMALL))
        self._entry.bind("<Return>", lambda _: self._add_pattern())

        ctk.CTkButton(
            entry_row, text="Add Pattern", width=100, font=styles.FONT_SMALL,
            fg_color=styles.ACCENT, hover_color=styles.ACCENT_HOVER,
            command=self._add_pattern,
        ).pack(side="right", padx=(styles.PAD_SMALL, 0))

        ctk.CTkButton(
            entry_row, text="Clear All", width=80, font=styles.FONT_SMALL,
            fg_color=styles.BG_CARD, hover_color=styles.ERROR,
            command=self._clear_all_patterns,
        ).pack(side="right")

        # Help text
        ctk.CTkLabel(
            self,
            text="Patterns matched as substrings or wildcards (*). "
                 "★ = auto-detected MainActivity.  Toggle Ignore to skip an app.",
            font=styles.FONT_SMALL, text_color=styles.TEXT_MUTED,
            justify="left", anchor="w",
        ).pack(fill="x", padx=styles.PAD, pady=(2, styles.PAD_SMALL))

        # Scrollable app list
        self._scroll = ctk.CTkScrollableFrame(
            self, fg_color=styles.BG_PRIMARY,
            scrollbar_button_color=styles.BG_CARD,
            scrollbar_button_hover_color=styles.ACCENT,
        )
        self._scroll.pack(fill="both", expand=True, padx=styles.PAD, pady=(0, styles.PAD))

    # ------------------------------------------------------------------ #
    #  Public API                                                          #
    # ------------------------------------------------------------------ #

    def load_apks(self, apk_targets: list[tuple[str, str]]):
        """Called when APKs are discovered. Rebuilds the app section list."""
        self._patterns = {}
        self._ignored = {}
        self._label_to_apk = {}
        self._labels = []
        self._sections = {}

        for w in self._scroll.winfo_children():
            w.destroy()

        if not apk_targets:
            ctk.CTkLabel(self._scroll, text="No APKs found.",
                         font=styles.FONT_BODY, text_color=styles.TEXT_MUTED).pack(pady=20)
            self._update_count()
            return

        for primary_apk, label in apk_targets:
            self._labels.append(label)
            self._patterns[label] = []
            self._ignored[label] = False
            self._label_to_apk[label] = primary_apk
            self._create_app_section(label, primary_apk)

        self._update_count()

        # Auto-detect MainActivity for each app in background
        for primary_apk, label in apk_targets:
            threading.Thread(
                target=self._fetch_main_activity,
                args=(label, primary_apk),
                daemon=True,
            ).start()

    def get_selected(self) -> dict[str, list[str]]:
        """
        Returns label -> list[pattern] for apps that are NOT ignored
        and have at least one pattern.
        """
        return {
            label: list(patterns)
            for label, patterns in self._patterns.items()
            if patterns and not self._ignored.get(label, False)
        }

    def get_ignored_labels(self) -> list[str]:
        return [label for label, ignored in self._ignored.items() if ignored]

    # ------------------------------------------------------------------ #
    #  App section widgets                                                 #
    # ------------------------------------------------------------------ #

    def _create_app_section(self, label: str, primary_apk: str):
        section = ctk.CTkFrame(self._scroll, fg_color=styles.BG_SECONDARY, corner_radius=6)
        section.pack(fill="x", pady=(0, 6))

        # Header row — pack right-side widgets FIRST so expand label doesn't push them off
        hrow = ctk.CTkFrame(section, fg_color="transparent")
        hrow.pack(fill="x", padx=8, pady=(6, 2))

        # Ignore toggle button (pack right before the expanding label)
        ignore_btn = ctk.CTkButton(
            hrow, text="Ignore", width=68, height=26, font=styles.FONT_SMALL,
            fg_color=styles.BG_CARD, hover_color="#7f1d1d",
            command=lambda l=label: self._toggle_ignore(l),
        )
        ignore_btn.pack(side="right", padx=(4, 0))

        ctk.CTkLabel(hrow, text=primary_apk, font=styles.FONT_SMALL,
                     text_color=styles.TEXT_MUTED, anchor="e").pack(side="right", padx=(0, 4))

        name_label = ctk.CTkLabel(hrow, text=label, font=styles.FONT_HEADING,
                                   text_color=styles.TEXT_PRIMARY, anchor="w")
        name_label.pack(side="left", fill="x", expand=True)

        # Loading indicator
        loading = ctk.CTkLabel(section, text="Detecting MainActivity...",
                                font=styles.FONT_SMALL, text_color=styles.TEXT_MUTED)
        loading.pack(anchor="w", padx=20, pady=(0, 2))

        # Chips row
        chips_row = ctk.CTkFrame(section, fg_color="transparent")
        chips_row.pack(fill="x", padx=8, pady=(0, 6))

        # Store widget refs on the section object
        section._label = label
        section._loading_label = loading
        section._chips_row = chips_row
        section._ignore_btn = ignore_btn
        section._name_label = name_label

        self._sections[label] = section

    def _toggle_ignore(self, label: str):
        currently_ignored = self._ignored.get(label, False)
        new_state = not currently_ignored
        self._ignored[label] = new_state

        section = self._sections.get(label)
        if not section:
            return

        if new_state:
            # Visual: grey out the section, change button to "Include"
            section.configure(fg_color="#2a1a1a")
            section._ignore_btn.configure(
                text="Include", fg_color="#7f1d1d", hover_color=styles.SUCCESS
            )
            section._name_label.configure(text_color=styles.TEXT_MUTED)
        else:
            # Restore
            section.configure(fg_color=styles.BG_SECONDARY)
            section._ignore_btn.configure(
                text="Ignore", fg_color=styles.BG_CARD, hover_color="#7f1d1d"
            )
            section._name_label.configure(text_color=styles.TEXT_PRIMARY)

        self._update_count()

    # ------------------------------------------------------------------ #
    #  MainActivity detection                                              #
    # ------------------------------------------------------------------ #

    def _fetch_main_activity(self, label: str, primary_apk: str):
        try:
            from core.docker_runner import get_main_activity
            activities = get_main_activity(primary_apk)
        except Exception:
            activities = []
        self.after(0, lambda: self._on_main_activity_found(label, activities))

    def _on_main_activity_found(self, label: str, activities: list[str]):
        if label not in self._sections:
            return
        section = self._sections[label]

        if hasattr(section, '_loading_label'):
            section._loading_label.destroy()
            del section._loading_label

        if not activities:
            ctk.CTkLabel(section, text="No MainActivity detected — add patterns manually.",
                         font=styles.FONT_SMALL, text_color=styles.TEXT_MUTED
                         ).pack(anchor="w", padx=20, pady=(0, 4))
        else:
            for activity in activities:
                pattern = activity if "." in activity else f"*{activity}"
                self._add_chip_to_app(label, pattern, auto=True)

        self._update_count()

    # ------------------------------------------------------------------ #
    #  Pattern / chip management                                           #
    # ------------------------------------------------------------------ #

    def _add_pattern(self):
        """Add the entry-box pattern to all non-ignored apps."""
        pattern = self._pattern_var.get().strip()
        if not pattern:
            return
        for label in self._labels:
            self._add_chip_to_app(label, pattern)
        self._pattern_var.set("")
        self._update_count()

    def _add_chip_to_app(self, label: str, pattern: str, auto: bool = False):
        if label not in self._sections:
            return
        if pattern in self._patterns.get(label, []):
            return  # deduplicate

        self._patterns.setdefault(label, []).append(pattern)

        chips_row = self._sections[label]._chips_row
        chip_color = "#1d4ed8" if auto else "#7c3aed"

        chip = ctk.CTkFrame(chips_row, fg_color=chip_color, corner_radius=4)
        chip.pack(side="left", padx=(0, 4), pady=2)

        prefix = "★ " if auto else ""
        ctk.CTkLabel(chip, text=f"{prefix}{pattern}", font=styles.FONT_SMALL,
                     text_color="#ffffff").pack(side="left", padx=(6, 2))

        ctk.CTkButton(
            chip, text="×", width=18, height=18, font=styles.FONT_SMALL,
            fg_color="transparent", hover_color="#7f1d1d", text_color="#ffffff",
            command=lambda l=label, p=pattern, c=chip: self._remove_chip(l, p, c),
        ).pack(side="right", padx=(0, 2))

    def _remove_chip(self, label: str, pattern: str, chip_widget):
        chip_widget.destroy()
        if label in self._patterns and pattern in self._patterns[label]:
            self._patterns[label].remove(pattern)
        self._update_count()

    def _clear_all_patterns(self):
        """Remove every chip from every app section."""
        for label, section in self._sections.items():
            for widget in section._chips_row.winfo_children():
                widget.destroy()
            self._patterns[label] = []
        self._update_count()

    # ------------------------------------------------------------------ #
    #  Count display                                                       #
    # ------------------------------------------------------------------ #

    def _update_count(self):
        ignored = sum(1 for v in self._ignored.values() if v)
        active = len(self._labels) - ignored
        total_patterns = sum(
            len(v) for label, v in self._patterns.items()
            if not self._ignored.get(label)
        )
        ignored_str = f"  |  {ignored} ignored" if ignored else ""
        self._count_label.configure(
            text=f"{total_patterns} pattern(s) across {active} app(s){ignored_str}"
        )
