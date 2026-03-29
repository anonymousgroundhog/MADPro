"""
Device panel — shows connected ADB devices and emulator management.
Polls adb every 5 seconds for device changes.
"""
import subprocess
import threading
import tkinter as tk
import customtkinter as ctk

from gui import styles


class DevicePanel(ctk.CTkFrame):
    def __init__(self, master, on_device_changed=None, **kwargs):
        super().__init__(master, fg_color=styles.BG_SECONDARY,
                         corner_radius=styles.CORNER_RADIUS, **kwargs)
        self._on_device_changed = on_device_changed
        self._devices: list[dict] = []
        self._avds: list[str] = []
        self._emulator_proc: subprocess.Popen | None = None
        self._selected_serial: str | None = None
        self._polling = True
        # list of {"package": ..., "label": ...} from sdkmanager
        self._gplay_images: list[dict] = []
        self._dl_stop_event: threading.Event | None = None

        self._build_ui()
        self._refresh_devices()
        self._start_polling()

    def _build_ui(self):
        ctk.CTkLabel(self, text="Device", font=styles.FONT_HEADING,
                     text_color=styles.ACCENT).pack(anchor="w", padx=styles.PAD,
                                                     pady=(styles.PAD, 4))

        # Status row
        status_row = ctk.CTkFrame(self, fg_color="transparent")
        status_row.pack(fill="x", padx=styles.PAD, pady=(0, styles.PAD_SMALL))

        self._status_dot = ctk.CTkLabel(status_row, text="●", width=16,
                                         font=styles.FONT_BODY,
                                         text_color=styles.TEXT_MUTED)
        self._status_dot.pack(side="left")

        self._status_label = ctk.CTkLabel(status_row, text="Checking...",
                                           font=styles.FONT_SMALL,
                                           text_color=styles.TEXT_SECONDARY,
                                           anchor="w")
        self._status_label.pack(side="left", fill="x", expand=True, padx=(4, 0))

        ctk.CTkButton(status_row, text="Refresh", width=70,
                      font=styles.FONT_SMALL, fg_color=styles.BG_CARD,
                      hover_color=styles.ACCENT,
                      command=self._refresh_devices).pack(side="right")

        # Device selector
        self._device_var = tk.StringVar()
        self._device_menu = ctk.CTkOptionMenu(
            self, variable=self._device_var,
            values=["No devices found"],
            font=styles.FONT_SMALL,
            fg_color=styles.BG_CARD,
            button_color=styles.BG_CARD,
            button_hover_color=styles.ACCENT,
            command=self._on_device_selected,
        )
        self._device_menu.pack(fill="x", padx=styles.PAD, pady=(0, styles.PAD_SMALL))

        # Divider
        ctk.CTkFrame(self, fg_color=styles.BG_CARD, height=1).pack(
            fill="x", padx=styles.PAD, pady=(0, styles.PAD_SMALL))

        # ── Emulator (AVD) section ──────────────────────────────────────
        ctk.CTkLabel(self, text="Emulator (AVD)", font=styles.FONT_SMALL,
                     text_color=styles.TEXT_SECONDARY).pack(
            anchor="w", padx=styles.PAD, pady=(0, 2))

        avd_row = ctk.CTkFrame(self, fg_color="transparent")
        avd_row.pack(fill="x", padx=styles.PAD, pady=(0, styles.PAD_SMALL))

        self._avd_var = tk.StringVar(value="No AVDs found")
        self._avd_menu = ctk.CTkOptionMenu(
            avd_row, variable=self._avd_var,
            values=["No AVDs found"],
            font=styles.FONT_SMALL,
            fg_color=styles.BG_CARD,
            button_color=styles.BG_CARD,
            button_hover_color=styles.ACCENT,
        )
        self._avd_menu.pack(side="left", fill="x", expand=True,
                             padx=(0, styles.PAD_SMALL))

        self._start_emu_btn = ctk.CTkButton(
            avd_row, text="Start", width=55, font=styles.FONT_SMALL,
            fg_color=styles.SUCCESS, hover_color="#16a34a",
            text_color="#000000",
            command=self._start_emulator,
        )
        self._start_emu_btn.pack(side="left", padx=(0, styles.PAD_SMALL))

        self._stop_emu_btn = ctk.CTkButton(
            avd_row, text="Stop", width=55, font=styles.FONT_SMALL,
            fg_color=styles.BG_CARD, hover_color=styles.ERROR,
            command=self._stop_emulator, state="disabled",
        )
        self._stop_emu_btn.pack(side="left")

        self._emu_status = ctk.CTkLabel(
            self, text="", font=styles.FONT_SMALL,
            text_color=styles.TEXT_MUTED)
        self._emu_status.pack(anchor="w", padx=styles.PAD,
                               pady=(0, styles.PAD_SMALL))

        # Divider
        ctk.CTkFrame(self, fg_color=styles.BG_CARD, height=1).pack(
            fill="x", padx=styles.PAD, pady=(0, styles.PAD_SMALL))

        # ── Download Google Play emulator ───────────────────────────────
        ctk.CTkLabel(self, text="Download Google Play Emulator",
                     font=styles.FONT_SMALL,
                     text_color=styles.TEXT_SECONDARY).pack(
            anchor="w", padx=styles.PAD, pady=(0, 4))

        # Image picker row: dropdown + Fetch button
        img_row = ctk.CTkFrame(self, fg_color="transparent")
        img_row.pack(fill="x", padx=styles.PAD, pady=(0, styles.PAD_SMALL))

        self._img_var = tk.StringVar(value="Click Fetch to load images")
        self._img_menu = ctk.CTkOptionMenu(
            img_row, variable=self._img_var,
            values=["Click Fetch to load images"],
            font=styles.FONT_SMALL,
            fg_color=styles.BG_CARD,
            button_color=styles.BG_CARD,
            button_hover_color=styles.ACCENT,
            dynamic_resizing=False,
        )
        self._img_menu.pack(side="left", fill="x", expand=True,
                             padx=(0, styles.PAD_SMALL))

        self._fetch_btn = ctk.CTkButton(
            img_row, text="Fetch", width=60, font=styles.FONT_SMALL,
            fg_color=styles.BG_CARD, hover_color=styles.ACCENT,
            command=self._fetch_images,
        )
        self._fetch_btn.pack(side="left")

        # Download button + cancel
        dl_btn_row = ctk.CTkFrame(self, fg_color="transparent")
        dl_btn_row.pack(fill="x", padx=styles.PAD, pady=(0, styles.PAD_SMALL))

        self._dl_btn = ctk.CTkButton(
            dl_btn_row, text="Download & Install", font=styles.FONT_SMALL,
            fg_color=styles.ACCENT, hover_color=styles.ACCENT_HOVER,
            command=self._start_gplay_download,
        )
        self._dl_btn.pack(side="left", padx=(0, styles.PAD_SMALL))

        self._dl_cancel_btn = ctk.CTkButton(
            dl_btn_row, text="Cancel", width=65, font=styles.FONT_SMALL,
            fg_color="#7f1d1d", hover_color="#991b1b",
            command=self._cancel_download, state="disabled",
        )
        self._dl_cancel_btn.pack(side="left")

        # Progress bar (hidden until download starts)
        self._dl_progress = ctk.CTkProgressBar(
            self, mode="indeterminate",
            fg_color=styles.BG_PRIMARY, progress_color=styles.ACCENT)

        # Status line
        self._dl_status = ctk.CTkLabel(
            self, text="", font=styles.FONT_SMALL,
            text_color=styles.TEXT_MUTED, anchor="w", wraplength=320)
        self._dl_status.pack(fill="x", padx=styles.PAD, pady=(0, styles.PAD))

        # Load AVDs in background
        threading.Thread(target=self._load_avds, daemon=True).start()

    # ------------------------------------------------------------------ #
    #  Device detection                                                    #
    # ------------------------------------------------------------------ #

    def _refresh_devices(self):
        threading.Thread(target=self._do_refresh, daemon=True).start()

    def _do_refresh(self):
        from core.adb_manager import list_adb_devices, is_adb_available
        if not is_adb_available():
            self.after(0, self._show_no_adb)
            return
        devices = list_adb_devices()
        self.after(0, lambda: self._update_devices(devices))

    def _show_no_adb(self):
        self._status_dot.configure(text_color=styles.ERROR)
        self._status_label.configure(
            text="adb not found — install Android SDK platform-tools")
        self._device_menu.configure(values=["adb not available"])

    def _update_devices(self, devices: list[dict]):
        self._devices = devices
        if not devices:
            self._status_dot.configure(text_color=styles.TEXT_MUTED)
            self._status_label.configure(text="No devices connected",
                                          text_color=styles.TEXT_SECONDARY)
            self._device_menu.configure(values=["No devices found"])
            self._device_var.set("No devices found")
            self._selected_serial = None
            if self._on_device_changed:
                self._on_device_changed(None)
            return

        labels = [f"{d['model']} ({d['serial']}) [{d['type']}]"
                  for d in devices]
        self._device_menu.configure(values=labels)
        self._device_var.set(labels[0])
        self._selected_serial = devices[0]["serial"]
        self._status_dot.configure(text_color=styles.SUCCESS)
        self._status_label.configure(
            text=f"{len(devices)} device(s) connected",
            text_color=styles.SUCCESS)
        if self._on_device_changed:
            self._on_device_changed(self._selected_serial)

    def _on_device_selected(self, label: str):
        for d in self._devices:
            if d["serial"] in label:
                self._selected_serial = d["serial"]
                if self._on_device_changed:
                    self._on_device_changed(self._selected_serial)
                return

    def _start_polling(self):
        if self._polling:
            self._refresh_devices()
            self.after(5000, self._start_polling)

    # ------------------------------------------------------------------ #
    #  AVD / emulator management                                          #
    # ------------------------------------------------------------------ #

    def _load_avds(self):
        from core.adb_manager import list_avds
        avds = list_avds()
        self.after(0, lambda: self._update_avds(avds))

    def _update_avds(self, avds: list[str]):
        self._avds = avds
        if avds:
            self._avd_menu.configure(values=avds)
            # Prefer any MADPro_GPlay_* AVD, else first
            preferred = next(
                (a for a in avds if a.startswith("MADPro_GPlay")), avds[0])
            self._avd_var.set(preferred)
        else:
            self._avd_menu.configure(values=["No AVDs found"])
            self._avd_var.set("No AVDs found")

    def _start_emulator(self):
        avd = self._avd_var.get()
        if not avd or avd == "No AVDs found":
            self._emu_status.configure(
                text="No AVD selected. Download one below or create one in Android Studio.",
                text_color=styles.WARNING)
            return

        self._emu_status.configure(text=f"Starting {avd}...",
                                    text_color=styles.INFO)
        self._start_emu_btn.configure(state="disabled")

        def worker():
            from core.adb_manager import start_emulator
            proc = start_emulator(avd, on_output=lambda l: None)
            self.after(0, lambda: self._on_emulator_started(proc, avd))

        threading.Thread(target=worker, daemon=True).start()

    def _on_emulator_started(self, proc, avd: str):
        if proc is None:
            self._emu_status.configure(
                text="Failed to start emulator — is Android SDK installed?",
                text_color=styles.ERROR)
            self._start_emu_btn.configure(state="normal")
            return

        self._emulator_proc = proc
        self._stop_emu_btn.configure(state="normal")
        self._emu_status.configure(
            text=f"{avd} starting… waiting for boot",
            text_color=styles.INFO)

        threading.Thread(target=self._wait_boot, daemon=True).start()

    def _wait_boot(self):
        from core.adb_manager import wait_for_boot, list_adb_devices
        import time
        time.sleep(5)
        devices = list_adb_devices()
        emu = next((d for d in devices if d["type"] == "emulator"), None)
        if emu:
            booted = wait_for_boot(emu["serial"])
            msg = (f"Emulator ready ({emu['serial']})" if booted
                   else "Emulator boot timed out")
            color = styles.SUCCESS if booted else styles.WARNING
        else:
            msg = "Emulator not detected by adb"
            color = styles.WARNING
        self.after(0, lambda: self._emu_status.configure(text=msg,
                                                          text_color=color))
        self.after(0, self._refresh_devices)

    def _stop_emulator(self):
        emu_device = next(
            (d for d in self._devices if d["type"] == "emulator"), None)
        if emu_device:
            from core.adb_manager import stop_emulator
            stop_emulator(emu_device["serial"])
        elif self._emulator_proc:
            self._emulator_proc.terminate()

        self._emulator_proc = None
        self._stop_emu_btn.configure(state="disabled")
        self._start_emu_btn.configure(state="normal")
        self._emu_status.configure(text="Emulator stopped.",
                                    text_color=styles.TEXT_MUTED)

    # ------------------------------------------------------------------ #
    #  Google Play emulator download                                       #
    # ------------------------------------------------------------------ #

    def _fetch_images(self):
        self._fetch_btn.configure(state="disabled", text="Loading...")
        self._dl_status.configure(text="Fetching available images from sdkmanager...",
                                   text_color=styles.INFO)

        def worker():
            from core.adb_manager import list_gplay_system_images
            images = list_gplay_system_images()
            self.after(0, lambda: self._on_images_fetched(images))

        threading.Thread(target=worker, daemon=True).start()

    def _on_images_fetched(self, images: list[dict]):
        self._fetch_btn.configure(state="normal", text="Fetch")
        self._gplay_images = images
        if not images:
            self._dl_status.configure(
                text="No Google Play images found. Ensure sdkmanager is available.",
                text_color=styles.WARNING)
            return

        labels = [img["label"] for img in images]
        self._img_menu.configure(values=labels)
        self._img_var.set(labels[0])
        self._dl_status.configure(
            text=f"{len(images)} image(s) available. Select one and click Download & Install.",
            text_color=styles.TEXT_SECONDARY)

    def _start_gplay_download(self):
        # Find selected image package
        selected_label = self._img_var.get()
        img = next((i for i in self._gplay_images
                    if i["label"] == selected_label), None)
        if img is None:
            self._dl_status.configure(
                text="No image selected. Click Fetch first.",
                text_color=styles.WARNING)
            return

        self._dl_btn.configure(state="disabled")
        self._dl_cancel_btn.configure(state="normal")
        self._dl_progress.pack(fill="x", padx=styles.PAD,
                                pady=(0, styles.PAD_SMALL),
                                before=self._dl_status)
        self._dl_progress.start()
        self._dl_status.configure(text=f"Downloading {selected_label}...",
                                   text_color=styles.INFO)

        self._dl_stop_event = threading.Event()
        system_image = img["package"]

        def worker():
            from core.adb_manager import download_gplay_emulator
            success = download_gplay_emulator(
                system_image=system_image,
                on_output=lambda msg: self.after(
                    0, lambda m=msg: self._on_dl_log(m)),
                stop_event=self._dl_stop_event,
            )
            self.after(0, lambda: self._on_gplay_done(success))

        threading.Thread(target=worker, daemon=True).start()

    def _on_dl_log(self, msg: str):
        if msg.strip():
            display = msg.strip()
            if len(display) > 70:
                display = display[:67] + "..."
            self._dl_status.configure(text=display,
                                       text_color=styles.TEXT_SECONDARY)

    def _on_gplay_done(self, success: bool):
        self._dl_progress.stop()
        self._dl_progress.pack_forget()
        self._dl_btn.configure(state="normal")
        self._dl_cancel_btn.configure(state="disabled")
        if success:
            self._dl_status.configure(
                text="Download complete. AVD added to the list above.",
                text_color=styles.SUCCESS)
            threading.Thread(target=self._load_avds, daemon=True).start()
        else:
            self._dl_status.configure(
                text="Download failed. Check that Android SDK cmdline-tools are installed.",
                text_color=styles.ERROR)

    def _cancel_download(self):
        if self._dl_stop_event:
            self._dl_stop_event.set()
        self._dl_cancel_btn.configure(state="disabled")
        self._dl_status.configure(text="Cancelling...", text_color=styles.WARNING)

    # ------------------------------------------------------------------ #
    #  Public API                                                          #
    # ------------------------------------------------------------------ #

    def get_selected_serial(self) -> str | None:
        return self._selected_serial

    def destroy(self):
        self._polling = False
        super().destroy()
