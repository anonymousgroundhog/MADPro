"""
Google Play category selection panel.
Scrollable checklist of categories with per-category or global app count.
"""
import tkinter as tk
import customtkinter as ctk

from gui import styles
from core.play_categories import CATEGORIES


class CategoryPanel(ctk.CTkFrame):
    def __init__(self, master, **kwargs):
        super().__init__(master, fg_color=styles.BG_SECONDARY,
                         corner_radius=styles.CORNER_RADIUS, **kwargs)
        self._vars: dict[str, tk.BooleanVar] = {}
        self._build_ui()

    def _build_ui(self):
        # Header
        header = ctk.CTkFrame(self, fg_color="transparent")
        header.pack(fill="x", padx=styles.PAD, pady=(styles.PAD, 4))

        ctk.CTkLabel(header, text="Categories", font=styles.FONT_HEADING,
                     text_color=styles.ACCENT).pack(side="left")

        self._selected_count = ctk.CTkLabel(
            header, text="0 selected", font=styles.FONT_SMALL,
            text_color=styles.TEXT_SECONDARY)
        self._selected_count.pack(side="right")

        # Toolbar: select-all / clear + count input
        toolbar = ctk.CTkFrame(self, fg_color="transparent")
        toolbar.pack(fill="x", padx=styles.PAD, pady=(0, styles.PAD_SMALL))

        ctk.CTkButton(toolbar, text="All", width=44, font=styles.FONT_SMALL,
                      fg_color=styles.BG_CARD, hover_color=styles.ACCENT,
                      command=self._select_all).pack(side="left",
                                                      padx=(0, styles.PAD_SMALL))

        ctk.CTkButton(toolbar, text="None", width=50, font=styles.FONT_SMALL,
                      fg_color=styles.BG_CARD, hover_color=styles.ERROR,
                      command=self._select_none).pack(side="left")

        # Apps per category
        ctk.CTkLabel(toolbar, text="Apps per category:",
                     font=styles.FONT_SMALL,
                     text_color=styles.TEXT_SECONDARY).pack(
            side="right", padx=(styles.PAD_SMALL, 4))

        self._count_var = tk.StringVar(value="10")
        ctk.CTkEntry(toolbar, textvariable=self._count_var,
                     width=50, font=styles.FONT_BODY,
                     fg_color=styles.BG_PRIMARY,
                     border_color=styles.BG_CARD,
                     justify="center").pack(side="right")

        # Scrollable category list
        scroll = ctk.CTkScrollableFrame(
            self, fg_color=styles.BG_PRIMARY,
            scrollbar_button_color=styles.BG_CARD,
            scrollbar_button_hover_color=styles.ACCENT,
        )
        scroll.pack(fill="both", expand=True, padx=styles.PAD,
                    pady=(0, styles.PAD))

        # Group headers: Games and Apps
        game_cats = [(cid, name) for cid, name in CATEGORIES
                     if cid.startswith("GAME_")]
        app_cats = [(cid, name) for cid, name in CATEGORIES
                    if not cid.startswith("GAME_")]

        self._add_group(scroll, "Games", game_cats)
        self._add_group(scroll, "Apps", app_cats)

    def _add_group(self, parent, title: str, cats: list[tuple[str, str]]):
        # Group label
        ctk.CTkLabel(parent, text=title, font=styles.FONT_SMALL,
                     text_color=styles.TEXT_SECONDARY,
                     anchor="w").pack(fill="x", padx=4, pady=(8, 2))

        ctk.CTkFrame(parent, fg_color=styles.BG_CARD, height=1).pack(
            fill="x", padx=4, pady=(0, 4))

        for cat_id, display_name in cats:
            var = tk.BooleanVar(value=False)
            self._vars[cat_id] = var

            # Strip group prefix for display ("Games: Action" → "Action")
            short_name = display_name.split(": ", 1)[-1]

            ctk.CTkCheckBox(
                parent,
                text=short_name,
                variable=var,
                font=styles.FONT_BODY,
                text_color=styles.TEXT_PRIMARY,
                fg_color=styles.ACCENT,
                hover_color=styles.ACCENT_HOVER,
                border_color=styles.TEXT_MUTED,
                command=self._update_count,
            ).pack(anchor="w", padx=8, pady=2)

    def _select_all(self):
        for v in self._vars.values():
            v.set(True)
        self._update_count()

    def _select_none(self):
        for v in self._vars.values():
            v.set(False)
        self._update_count()

    def _update_count(self):
        n = sum(1 for v in self._vars.values() if v.get())
        self._selected_count.configure(text=f"{n} selected")

    # ------------------------------------------------------------------ #
    #  Public API                                                          #
    # ------------------------------------------------------------------ #

    def get_selected(self) -> list[tuple[str, str]]:
        """Returns [(cat_id, display_name), ...] for checked categories."""
        result = []
        for cat_id, display_name in CATEGORIES:
            if self._vars.get(cat_id, tk.BooleanVar()).get():
                result.append((cat_id, display_name))
        return result

    def get_count(self) -> int:
        try:
            val = int(self._count_var.get())
            return max(1, min(val, 100))
        except ValueError:
            return 10
