"""
APK Kanban Dashboard tab.

Starts the Node.js dashboard server (apk-dashboard/server.js) as a subprocess,
then embeds the web UI inside the tab using tkinterweb.HtmlFrame.

The server is started once when the tab is first shown and shut down cleanly
when the main window closes.
"""
import os
import subprocess
import threading
import time
import socket
import webbrowser
import tkinter as tk
import customtkinter as ctk

from gui import styles

DASHBOARD_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "apk-dashboard",
)
SERVER_PORT = 3456
SERVER_URL = f"http://127.0.0.1:{SERVER_PORT}"


def _port_open(port: int, host: str = "127.0.0.1") -> bool:
    """Returns True if something is already listening on host:port."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex((host, port)) == 0


class DashboardView(ctk.CTkFrame):
    def __init__(self, master, **kwargs):
        super().__init__(master, fg_color="transparent", **kwargs)
        self._server_proc: subprocess.Popen | None = None
        self._server_started = False
        self._build_ui()
        self._start_server()

    # ------------------------------------------------------------------ #
    #  UI                                                                  #
    # ------------------------------------------------------------------ #

    def _build_ui(self):
        # ── Top control bar ──────────────────────────────────────────────
        bar = ctk.CTkFrame(self, fg_color=styles.BG_SECONDARY,
                            corner_radius=0, height=44)
        bar.pack(fill="x", side="top")
        bar.pack_propagate(False)

        ctk.CTkLabel(bar, text="APK Kanban Dashboard",
                     font=styles.FONT_HEADING,
                     text_color=styles.ACCENT).pack(side="left", padx=12, pady=8)

        self._status_label = ctk.CTkLabel(
            bar, text="Starting server…",
            font=styles.FONT_SMALL, text_color=styles.WARNING)
        self._status_label.pack(side="left", padx=(0, 16))

        ctk.CTkButton(
            bar, text="⟳  Reload", width=90, font=styles.FONT_SMALL,
            fg_color=styles.BG_CARD, hover_color=styles.ACCENT,
            command=self._reload,
        ).pack(side="right", padx=(0, 8), pady=8)

        ctk.CTkButton(
            bar, text="↗  Open in Browser", width=130, font=styles.FONT_SMALL,
            fg_color=styles.BG_CARD, hover_color=styles.ACCENT,
            command=lambda: webbrowser.open(SERVER_URL),
        ).pack(side="right", padx=(0, 4), pady=8)

        self._stop_btn = ctk.CTkButton(
            bar, text="Stop Server", width=100, font=styles.FONT_SMALL,
            fg_color="#7f1d1d", hover_color="#991b1b",
            command=self._stop_server,
        )
        self._stop_btn.pack(side="right", padx=(0, 4), pady=8)

        self._start_btn = ctk.CTkButton(
            bar, text="Start Server", width=100, font=styles.FONT_SMALL,
            fg_color=styles.BG_CARD, hover_color=styles.SUCCESS,
            command=self._start_server, state="disabled",
        )
        self._start_btn.pack(side="right", padx=(0, 4), pady=8)

        # ── Embedded browser or fallback ─────────────────────────────────
        self._browser_frame = ctk.CTkFrame(
            self, fg_color=styles.BG_PRIMARY, corner_radius=0)
        self._browser_frame.pack(fill="both", expand=True)

        self._loading_label = ctk.CTkLabel(
            self._browser_frame,
            text="Starting Node.js server…\nThe dashboard will appear here shortly.",
            font=styles.FONT_BODY, text_color=styles.TEXT_MUTED,
            justify="center",
        )
        self._loading_label.pack(expand=True)

        self._html_frame = None  # created after server is ready

    # ------------------------------------------------------------------ #
    #  Server lifecycle                                                    #
    # ------------------------------------------------------------------ #

    def _start_server(self):
        """Launch the Node.js server in a background subprocess."""
        if _port_open(SERVER_PORT):
            self._on_server_ready(already_running=True)
            return

        server_js = os.path.join(DASHBOARD_DIR, "server.js")
        if not os.path.isfile(server_js):
            self._set_status(f"server.js not found at {server_js}", styles.ERROR)
            return

        try:
            self._server_proc = subprocess.Popen(
                ["node", server_js, "--port", str(SERVER_PORT)],
                cwd=DASHBOARD_DIR,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except FileNotFoundError:
            self._set_status("node not found — install Node.js", styles.ERROR)
            return

        self._start_btn.configure(state="disabled")
        self._stop_btn.configure(state="normal")
        self._set_status("Starting server…", styles.WARNING)

        threading.Thread(target=self._wait_for_server, daemon=True).start()

    def _wait_for_server(self):
        """Poll until the server is accepting connections (max 15 s)."""
        deadline = time.time() + 15
        while time.time() < deadline:
            if _port_open(SERVER_PORT):
                self.after(0, lambda: self._on_server_ready(already_running=False))
                return
            time.sleep(0.4)
        self.after(0, lambda: self._set_status(
            "Server failed to start. Check Node.js is installed.", styles.ERROR))

    def _on_server_ready(self, already_running: bool = False):
        msg = "Server running (external)" if already_running else "Server running"
        self._set_status(msg, styles.SUCCESS)
        self._start_btn.configure(state="disabled")
        self._stop_btn.configure(state="normal")
        self._server_started = True
        self._load_html_frame()

    def _stop_server(self):
        if self._server_proc:
            self._server_proc.terminate()
            self._server_proc = None
        self._server_started = False
        self._set_status("Server stopped", styles.WARNING)
        self._start_btn.configure(state="normal")
        self._stop_btn.configure(state="disabled")
        # Remove the embedded frame and show loading label again
        if self._html_frame:
            self._html_frame.destroy()
            self._html_frame = None
        self._loading_label = ctk.CTkLabel(
            self._browser_frame,
            text="Server stopped. Click Start Server to restart.",
            font=styles.FONT_BODY, text_color=styles.TEXT_MUTED,
        )
        self._loading_label.pack(expand=True)

    def shutdown(self):
        """Called by MainWindow on close to terminate the subprocess."""
        if self._server_proc:
            try:
                self._server_proc.terminate()
            except Exception:
                pass

    # ------------------------------------------------------------------ #
    #  Embedded browser                                                    #
    # ------------------------------------------------------------------ #

    def _load_html_frame(self):
        # Remove loading label
        if self._loading_label:
            self._loading_label.destroy()
            self._loading_label = None

        # Destroy old frame if reloading
        if self._html_frame:
            self._html_frame.destroy()
            self._html_frame = None

        try:
            import tkinterweb
            frame = tkinterweb.HtmlFrame(
                self._browser_frame,
                messages_enabled=False,
                vertical_scrollbar=True,
                horizontal_scrollbar=True,
            )
            frame.load_url(SERVER_URL)
            frame.pack(fill="both", expand=True)
            self._html_frame = frame
        except ImportError:
            # tkinterweb not available — show fallback with open-in-browser button
            self._show_browser_fallback()
        except Exception as e:
            self._show_browser_fallback(str(e))

    def _show_browser_fallback(self, error: str = ""):
        msg = "tkinterweb is not available.\nThe dashboard is running — open it in your browser."
        if error:
            msg += f"\n\n({error})"
        lbl = ctk.CTkLabel(
            self._browser_frame, text=msg,
            font=styles.FONT_BODY, text_color=styles.TEXT_MUTED, justify="center")
        lbl.pack(expand=True)
        ctk.CTkButton(
            self._browser_frame,
            text=f"Open  {SERVER_URL}",
            font=styles.FONT_HEADING,
            fg_color=styles.ACCENT, hover_color=styles.ACCENT_HOVER,
            command=lambda: webbrowser.open(SERVER_URL),
        ).pack(pady=(0, 40))

    def _reload(self):
        if self._html_frame and hasattr(self._html_frame, "load_url"):
            self._html_frame.load_url(SERVER_URL)
        elif self._server_started:
            self._load_html_frame()

    # ------------------------------------------------------------------ #
    #  Helpers                                                             #
    # ------------------------------------------------------------------ #

    def _set_status(self, text: str, color: str = styles.TEXT_SECONDARY):
        self._status_label.configure(text=text, text_color=color)
