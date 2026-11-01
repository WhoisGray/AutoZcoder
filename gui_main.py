"""Single-file desktop entry: start the gateway, open the dashboard in WebView2.

Replaces the Tkinter GUI. The gateway runs on a background thread; the window
is the served dashboard (/dash) in a native WebView2 shell via pywebview.
A single-instance mutex prevents a second exe from fighting over the port.
"""

from __future__ import annotations

import ctypes
import os
import secrets
import ssl
import sys
import threading
import time
import urllib.request
import webbrowser
from pathlib import Path

# Same name the Tkinter build used, so the old and new exe are mutually
# exclusive (they share the port). Session-local: no Local\ prefix needed.
MUTEX_NAME = "ZcodeGatewayByB3hnamR-SingleInstance"
DASH_PATH = "/dash"

_mutex_handle = None
_instance_lock = None


def _exe_dir() -> Path:
    """Folder the tool lives in (the exe's folder when frozen)."""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def _bootstrap_config() -> Path:
    """First-run config for a standalone, portable install.

    Thin wrapper over the canonical tkinter-free implementation in
    zcode_gateway.paths — kept so existing callers/imports still resolve.
    """
    from zcode_gateway.paths import bootstrap_config
    return bootstrap_config()


def _already_running() -> bool:
    """True when another copy already holds the session lock.

    Windows uses a named mutex. macOS and Linux use a per-user file lock so
    a second double-click opens the dashboard instead of binding the port.
    """
    if sys.platform == "win32":
        global _mutex_handle
        ERROR_ALREADY_EXISTS = 183
        _mutex_handle = ctypes.windll.kernel32.CreateMutexW(None, True, MUTEX_NAME)
        return ctypes.windll.kernel32.GetLastError() == ERROR_ALREADY_EXISTS
    global _instance_lock
    try:
        import errno
        import fcntl
        from zcode_gateway.paths import _per_user_dir
        lock_dir = _per_user_dir()
        lock_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        fh = open(lock_dir / "single-instance.lock", "a+")
        try:
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            fh.close()
            if exc.errno in (errno.EAGAIN, errno.EACCES, errno.EWOULDBLOCK):
                return True
            return False
    except OSError:
        return False
    _instance_lock = fh
    return False


def _notify(message: str) -> None:
    """Minimal message box without pulling in a GUI toolkit."""
    if sys.platform == "win32":
        try:
            ctypes.windll.user32.MessageBoxW(0, message, "Zcode Gateway", 0x40)
            return
        except Exception:
            pass
    elif sys.platform == "darwin":
        try:
            import subprocess
            subprocess.run(
                ["osascript", "-e", "on run argv",
                 "-e", 'display alert "Zcode Gateway" message (item 1 of argv)',
                 "-e", "end run", message],
                timeout=60, check=False)
            return
        except Exception:
            pass
    sys.stderr.write(message + "\n")


# origin of the running gateway (host:port from config); remembered so the
# window-close cleanup stops workers on CUSTOM-port installs too
_last_gateway_origin: str | None = None
_last_gateway_context: ssl.SSLContext | None = None


def _desktop_log_dir() -> str:
    if sys.platform == "win32":
        return os.path.join(os.environ.get("LOCALAPPDATA", "."), "ZcodeGateway")
    if sys.platform == "darwin":
        return os.path.join(os.path.expanduser("~/Library/Logs"), "ZcodeGateway")
    state = os.environ.get("XDG_STATE_HOME", os.path.expanduser("~/.local/state"))
    return os.path.join(state, "ZcodeGateway")


def _isatty(stream) -> bool:
    try:
        return bool(stream is not None and stream.isatty())
    except Exception:
        return False


def _fix_streams() -> None:
    """A windowed frozen app has no console; sys.stdout/err may be None.

    Terminal launches and the frozen smoke test keep their own streams.
    Set ZCODE_GATEWAY_FOREGROUND_LOG=1 to force that even when stdout is
    not a tty. A Finder-launched .app logs under ~/Library/Logs.
    """
    missing = sys.stdout is None or sys.stderr is None
    frozen_background = bool(getattr(sys, "frozen", False) and not _isatty(sys.stdout))
    keep_foreground = os.environ.get("ZCODE_GATEWAY_FOREGROUND_LOG") == "1"
    if not missing and (keep_foreground or not frozen_background):
        return
    log_dir = _desktop_log_dir()
    os.makedirs(log_dir, exist_ok=True)
    path = os.path.join(log_dir, "zcode-gateway.log")
    for name in ("stdout", "stderr"):
        try:
            f = open(path, "a", encoding="utf-8", buffering=1)
            setattr(sys, name, f)
        except OSError:
            pass


def _gateway_context(ca_file: str) -> ssl.SSLContext:
    """Trust the listener certificate only in this GUI's HTTPS requests."""
    context = ssl.create_default_context()
    if ca_file:
        context.load_verify_locations(cafile=ca_file)
    return context


def _wait_for(url: str, timeout: float = 30.0, *,
              context: ssl.SSLContext | None = None) -> bool:
    """Poll the dashboard itself; /health may be local-only on a TLS SAN origin."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2, context=context) as r:
                if r.status == 200:
                    return True
        except Exception:
            time.sleep(0.4)
    return False


def _run_server() -> None:
    import uvicorn
    from zcode_gateway.app import create_app
    from zcode_gateway.config import load_config

    # watchdog: if the gateway thread dies, rebuild and restart it (max 5
    # attempts / 10 minutes) instead of leaving a dead UI behind
    import datetime as _dt
    attempts = 0
    first_start = time.time()
    while True:
        try:
            cfg = load_config(os.environ.get("ZCODE_GATEWAY_CONFIG") or None)
            global _shutdown_admin_key
            _shutdown_admin_key = cfg.server.admin_key
            config = uvicorn.Config(
                create_app(cfg), host=cfg.server.host, port=cfg.server.port,
                log_level="info", access_log=False, log_config=None,
                **cfg.server.ssl_kwargs())
            server = uvicorn.Server(config)
            server.run()
            return  # clean shutdown
        except SystemExit as exc:
            # uvicorn's startup failure (port already in use is the common
            # one) raises SystemExit, which `except Exception` never caught —
            # the thread died silently and the UI opened a dead URL. Treat it
            # like any other crash so the watchdog retries / reports.
            print(f"[watchdog] uvicorn exited with {exc!r} "
                  f"(port in use?)", file=sys.stderr, flush=True)
        except Exception:
            pass
        attempts += 1
        now = time.time()
        print(f"[watchdog] gateway crashed ({_dt.datetime.now():%H:%M:%S}) "
              f"attempt {attempts}", file=sys.stderr, flush=True)
        if attempts >= 5 or now - first_start > 600:
            print("[watchdog] giving up", file=sys.stderr, flush=True)
            raise
        time.sleep(min(2 ** attempts, 15))


def _webview2_available() -> bool:
    """True when the WebView2 runtime this exe needs is installed.

    Checks the registry keys the WebView2 Evergreen runtime writes, plus
    the folder-based install. pywebview's edgechromium GUI hard-crashes on
    machines without it (clean Windows, Server, LTSC) — we detect it up
    front and offer the browser dashboard instead of a crash.
    """
    try:
        import winreg
    except ImportError:
        return True          # not Windows: let webview decide
    probes = (
        (winreg.HKEY_LOCAL_MACHINE,
         r"Software\WOW6432Node\Microsoft\EdgeUpdate\Clients" + "\\" +
         "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"),
        (winreg.HKEY_LOCAL_MACHINE,
         r"Software\Microsoft\EdgeUpdate\Clients" + "\\" +
         "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"),
        (winreg.HKEY_CURRENT_USER,
         r"Software\Microsoft\EdgeUpdate\Clients" + "\\" +
         "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"),
    )
    for hive, path in probes:
        try:
            with winreg.OpenKey(hive, path) as k:
                winreg.QueryValueEx(k, "pv")
                return True
        except OSError:
            continue
    # folder-based per-app install next to the exe
    try:
        if any((Path(os.environ.get("PROGRAMFILES(X86)", "")) / "Microsoft" / "EdgeWebView" / "Application").glob("*")):
            return True
    except Exception:
        pass
    return False


def _offer_webview2_or_browser(url: str) -> bool:
    """WebView2 missing: offer to install it; otherwise use the browser.

    Returns True when the caller should keep going (browser mode)."""
    rc = ctypes.windll.user32.MessageBoxW(
        0,
        "This window needs the Microsoft WebView2 runtime, which is not installed.\n\n"
        "Yes — download & install WebView2 now (recommended, ~2 MB, one time).\n"
        "No  — open the dashboard in your web browser instead.",
        "Zcode Gateway — WebView2 missing", 0x24)      # MB_ICONWARNING|YESNO
    if rc == 6:                                        # IDYES
        import subprocess
        try:
            # winget is present on Win11 / updated Win10; falls back to
            # direct download when missing
            subprocess.Popen(
                ["winget", "install", "--id", "Microsoft.EdgeWebView2Runtime",
                 "--silent", "--accept-package-agreements",
                 "--accept-source-agreements"],
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            _notify("WebView2 install started.\n\n"
                    "Once it finishes, run Zcode Gateway again for the "
                    "native window.\nFalling back to your browser now.")
        except FileNotFoundError:
            webbrowser.open("https://developer.microsoft.com/microsoft-edge/webview2/")
            _notify("Download 'Evergreen Bootstrapper' from the page that just "
                    "opened, run it, then start Zcode Gateway again.\n"
                    "Falling back to your browser now.")
    webbrowser.open(url)
    return True


def main() -> None:
    _fix_streams()
    import argparse
    parser = argparse.ArgumentParser(description='Zcode Gateway desktop or headless server')
    parser.add_argument('--headless', action='store_true')
    parser.add_argument('--config')
    args = parser.parse_args()
    if args.config:
        cfg_path = Path(args.config).resolve()
        os.environ['ZCODE_GATEWAY_CONFIG'] = str(cfg_path)
    else:
        cfg_path = _bootstrap_config()
    if args.headless:
        _run_server()
        return
    from zcode_gateway.config import load_config
    cfg = load_config(cfg_path)
    origin, ca_file = cfg.server.child_connection()
    context = _gateway_context(ca_file) if origin.startswith("https://") else None
    url = origin + DASH_PATH
    global _last_gateway_origin, _last_gateway_context
    _last_gateway_origin = origin
    _last_gateway_context = context
    if _already_running():
        # another instance holds the mutex. If it's THIS build the dashboard is
        # already live — open it in the browser. If it's the old Tkinter build
        # (no /dash route) that returns 404, so surface a clear message instead.
        try:
            with urllib.request.urlopen(url, timeout=3, context=context) as r:
                if r.status == 200:
                    webbrowser.open(url)
                    return
        except Exception:
            pass
        _notify("Zcode Gateway is already running.\n\n"
                "The running copy is an older build without the web dashboard.\n"
                "Close it first, then start this one.")
        return

    import webview

    threading.Thread(target=_run_server, daemon=True, name="gateway").start()
    browser_fallback = False
    if not _wait_for(url, context=context):
        browser_fallback = True   # serve in the browser; keep the process (and the gateway thread) alive
    elif sys.platform == "win32" and not _webview2_available():
        # native window impossible on this machine: install prompt + browser
        browser_fallback = _offer_webview2_or_browser(url)
    else:
        try:
            import webview as _webview_probe
        except Exception:
            browser_fallback = True
        else:
            if not hasattr(_webview_probe, "create_window"):
                browser_fallback = True

    if browser_fallback:
        # The gateway runs in a DAEMON thread — returning from main() kills
        # it and the browser would load a dead URL. Park the main thread
        # until the process is killed or the user closes the terminal.
        webbrowser.open(url)
        _notify("The dashboard is running in your browser.\n\n"
                "Keep this process (this window / terminal) open — closing "
                "it stops the gateway.")
        while True:
            time.sleep(3600)
        return

    webview.create_window(
        "Zcode Gateway", url,
        width=1280, height=800, min_size=(980, 620),
        background_color="#0f1115", text_select=True)
    # edgechromium is the Windows WebView2 backend. macOS uses Cocoa/WebKit.
    if sys.platform == "win32":
        webview.start(gui="edgechromium")
    else:
        webview.start()

    # The window closed. edgechromium/pythonnet leave non-daemon threads that
    # keep the interpreter — and with it the port and the single-instance
    # mutex — alive forever, so the next launch hits the "already running"
    # alert. Hard-exit: window close must mean the tool actually quit.
    # Before the hard exit, stop the generator's workers — os._exit skips
    # atexit and the FastAPI lifespan, and spawned Chromium children would
    # otherwise be orphaned on the machine.
    _shutdown_generator()
    os._exit(0)


def _shutdown_generator() -> None:
    """Best-effort: stop generator workers (kills their Chromium children)
    before the hard exit. Runs from the MAIN thread after the window closed —
    use the HTTP surface, not the gateway's event loop."""
    try:
        # same origin the window was served from (config host:port), not a
        # hardcoded 8788 — custom-port installs used to leak browsers on exit
        base = _last_gateway_origin or "http://127.0.0.1:8788"
        import urllib.request as _ur
        key = globals().get("_shutdown_admin_key", "")
        if not key:
            return
        req = _ur.Request(base + "/admin/dash/generator/shutdown",
                          data=b"{}", method="POST",
                          headers={"Authorization": "Bearer " + key,
                                   "Content-Type": "application/json"})
        with _ur.urlopen(req, timeout=90, context=_last_gateway_context) as _:
            pass
    except Exception:
        pass


if __name__ == "__main__":
    try:
        main()
    except Exception:
        import traceback
        sys.stderr.write(traceback.format_exc()[-1200:] + "\n")
