"""Exercise a frozen binary with dummy state inside a network-isolated sandbox."""

import os
from pathlib import Path
import socket
import subprocess
import shutil
import sys
import time

import httpx
import yaml


def main():
    root = Path.cwd()
    binary = str(root / ("ZcodeGateway.exe" if os.name == "nt" else "ZcodeGateway"))
    shutil.copy2(os.environ["AUDIT_BINARY"], binary)
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    config = root / "frozen-config.yaml"
    config.write_text(yaml.safe_dump({
        "server": {"host": "127.0.0.1", "port": port,
                   "admin_key": "dummy-frozen-admin-key",
                   "client_keys": [{"key": "dummy-frozen-client-key"}]},
        "accounts": {"dir": str(root / "accounts")},
        "store": {"sqlite_path": str(root / "gateway.db")},
        "update": {"enabled": False},
        "generator": {"enabled": True},
    }))
    log_path = root / "frozen.log"
    # The Mac build is the desktop entry (gui_main). --headless keeps this
    # sandbox on the server path. The Linux build is already a server and
    # rejects unknown arguments. Keep the child's stdout on this pipe.
    command = [binary]
    if os.name == "nt" or sys.platform == "darwin":
        command.append("--headless")
    command += ["--config", str(config)]
    child_env = os.environ.copy()
    child_env["ZCODE_GATEWAY_FOREGROUND_LOG"] = "1"
    with log_path.open("w+") as log:
        child = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, env=child_env,
                                 **({"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt" else {"start_new_session": True}))
        try:
            with httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=5,
                              trust_env=False) as client:
                # A cold onefile on macOS spends the first half-minute
                # unpacking and importing. Linux and Windows usually finish
                # inside the old 25s window; keep one deadline that covers all.
                deadline = time.monotonic() + 90
                while time.monotonic() < deadline and child.poll() is None:
                    try:
                        if client.get("/health").status_code == 200:
                            break
                    except httpx.HTTPError:
                        pass
                    time.sleep(0.1)
                else:
                    raise AssertionError("frozen gateway failed startup")
                headers = {"Authorization": "Bearer dummy-frozen-admin-key"}
                dashboard = client.get("/dash")
                assert dashboard.status_code == 200
                assert "/dash/assets/js/boot.js" in dashboard.text
                assert client.get("/dash/assets/js/views/generator/mail.js").status_code == 200
                assert client.get("/dash/assets/js/views/accounts-jwt.js").status_code == 200
                assert client.get("/admin/dash/settings", headers=headers).status_code == 200
                status = client.get("/admin/dash/generator/status", headers=headers)
                assert status.status_code == 200, status.text[:200]
                assert "error" not in status.json(), status.text[:200]
                auto = client.get("/admin/dash/generator/auto", headers=headers)
                assert auto.status_code == 200 and auto.json()["status"]["state"] == "idle"
                caps = client.get("/admin/dash/capabilities", headers=headers).json()
                assert caps["frozen"] is True
                if os.name == "nt":
                    assert client.post("/admin/dash/shutdown", headers=headers).status_code == 200
                assert client.get("/dash", headers={"Host": "rebound.invalid"}).status_code == 400
            print("PASS: frozen binary startup, bundled modular UI, generator sources, Host/auth")
        except Exception:
            log.flush()
            log.seek(0)
            print(log.read()[-16000:])
            raise
        finally:
            if child.poll() is None:
                if os.name != "nt":
                    child.terminate()
            try:
                child.wait(timeout=15)
            except subprocess.TimeoutExpired:
                if os.name == "nt":
                    subprocess.run(["taskkill", "/PID", str(child.pid), "/T", "/F"], capture_output=True, timeout=15)
                else:
                    import signal
                    os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=5)
        assert child.returncode in (0, -15), f"frozen shutdown code {child.returncode}"


if __name__ == "__main__":
    main()
