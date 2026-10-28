#!/usr/bin/env python3
"""Cross-platform build script for AutoZCoder (Windows, macOS, Linux).

Packages the desktop gateway as a standalone single-file executable.

Usage:
    python build.py [--clean] [--console] [--name NAME]
"""

from __future__ import annotations

import argparse
import hashlib
import os
import platform
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent


def get_default_binary_name() -> str:
    system = platform.system().lower()
    if system == "windows":
        return "ZcodeGateway.exe"
    elif system == "darwin":
        return "ZcodeGateway-macos"
    return "ZcodeGateway-linux"


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description="Build AutoZCoder standalone executable")
    parser.add_argument("--clean", action="store_true", help="Wipe build/ and dist/ first")
    parser.add_argument("--console", action="store_true", help="Keep console window visible")
    parser.add_argument("--name", default=None, help="Output binary name")
    args = parser.parse_args()

    binary_name = args.name or get_default_binary_name()
    dist_dir = HERE / "dist"
    build_dir = HERE / "build"

    if args.clean:
        print("[build] Cleaning previous build artifacts...")
        shutil.rmtree(dist_dir, ignore_errors=True)
        shutil.rmtree(build_dir, ignore_errors=True)

    sep = ";" if sys.platform == "win32" else ":"

    # Stage generator sources
    gen_stage = Path(tempfile.mkdtemp(prefix="zcoder-generator-"))
    try:
        gen_dir = HERE / "generator"
        if gen_dir.is_dir():
            for py_file in gen_dir.glob("*.py"):
                shutil.copy2(py_file, gen_stage)
            for extra in ("README.md", "requirements.txt"):
                src = gen_dir / extra
                if src.is_file():
                    shutil.copy2(src, gen_stage)
            print(f"[build] Staged generator ({len(list(gen_stage.glob('*')))} files)")

        # Optional captcha-mint sidecar
        mint_dir = HERE / "tools" / "captcha-mint"
        mint_ts = mint_dir / "mint.ts"
        mint_name = "captcha-mint.exe" if sys.platform == "win32" else "captcha-mint"
        mint_bin = mint_dir / mint_name

        bun = shutil.which("bun")
        if bun and mint_ts.is_file() and not mint_bin.is_file():
            print("[build] Compiling captcha-mint sidecar using bun...")
            subprocess.run([bun, "install"], cwd=mint_dir, check=False)
            subprocess.run([bun, "build", "--compile", f"--outfile={mint_name}", "mint.ts"], cwd=mint_dir, check=False)

        mint_data: list[str] = []
        for cand in (
            mint_bin,
            mint_dir / "captcha-mint.exe",
            mint_dir / "captcha-mint",
        ):
            if cand.is_file():
                mint_data = ["--add-data", f"{cand}{sep}captcha-mint"]
                print(f"[build] Bundling captcha-mint sidecar: {cand.name}")
                break

        # macOS: a windowed build produces a proper .app bundle (Dock icon,
        # no terminal window). icns only applies to the bundle; fall back to
        # the shared .ico for a bare-binary console build.
        if sys.platform == "darwin":
            mode = ["--windowed"] if not args.console else ["--console"]
        icon_args: list[str] = []
        icns_path = HERE / "assets" / "zcode.icns"
        icon_path = (icns_path if sys.platform == "darwin" and icns_path.is_file()
                     else HERE / "assets" / "zcode.ico")
        if icon_path.is_file():
            icon_args = ["--icon", str(icon_path)]

        version_args: list[str] = []
        ver_file = HERE / "tools" / "exe_version.txt"
        if sys.platform == "win32" and ver_file.is_file():
            version_args = ["--version-file", str(ver_file)]

        hidden_imports = [
            "uvicorn.logging",
            "uvicorn.loops",
            "uvicorn.loops.auto",
            "uvicorn.protocols",
            "uvicorn.protocols.http",
            "uvicorn.protocols.http.auto",
            "uvicorn.protocols.http.h11_impl",
            "uvicorn.protocols.websockets",
            "uvicorn.protocols.websockets.auto",
            "uvicorn.lifespan",
            "uvicorn.lifespan.on",
            "uvicorn.lifespan.off",
            "anyio._backends._asyncio",
            "httpcore",
            "h11",
            "yaml",
            "requests",
            "urllib3",
            "urllib3.contrib.socks",
            "certifi",
            "zcode_gateway.generator",
            "zcode_gateway.accounts_dir_bridge",
        ]

        if sys.platform == "win32":
            hidden_imports.extend(["clr", "pythonnet"])
        else:
            hidden_imports.extend(["cryptography", "cryptography.hazmat.primitives.ciphers.aead"])
            if sys.platform == "darwin":
                hidden_imports.extend(["objc", "WebKit"])

        env = dict(os.environ, PYINSTALLER_CONFIG_DIR=str(HERE / "build" / "pyi-cache"))
        cmd: list[str] = [
            sys.executable, "-m", "PyInstaller",
            "--noconfirm",
            "--clean",
            "--onefile",
            *mode,
            "--name", Path(binary_name).stem if sys.platform == "win32" else binary_name,
            "--collect-submodules", "uvicorn",
            "--collect-submodules", "webview",
        ]

        for hi in hidden_imports:
            cmd.extend(["--hidden-import", hi])

        cmd.extend([
            "--add-data", f"config.example.yaml{sep}.",
            "--add-data", f"assets{sep}assets",
            "--add-data", f"zcode_gateway/dashboard{sep}zcode_gateway/dashboard",
            "--add-data", f"mail-worker{sep}mail-worker",
            "--add-data", f"{gen_stage}{sep}generator",
            *mint_data,
            "--paths", str(HERE),
            *icon_args,
            *version_args,
            "gui_main.py",
        ])

        print(f"[build] Building {binary_name} on {platform.system()}...")
        res = subprocess.run(cmd, cwd=HERE, env=env)
        if res.returncode != 0:
            print(f"[build] PyInstaller failed with exit code {res.returncode}", file=sys.stderr)
            return res.returncode

    finally:
        shutil.rmtree(gen_stage, ignore_errors=True)

    expected_out = dist_dir / binary_name
    # macOS --windowed emits dist/<name>.app; point at the inner binary
    if sys.platform == "darwin" and not args.console:
        expected_out = dist_dir / f"{binary_name}.app" / "Contents" / "MacOS" / binary_name
    if not expected_out.is_file():
        # PyInstaller may append .exe on Windows
        if sys.platform == "win32" and not binary_name.endswith(".exe"):
            expected_out = dist_dir / f"{binary_name}.exe"

    if not expected_out.is_file():
        print(f"[build] ERROR: Expected output not found at {expected_out}", file=sys.stderr)
        return 1

    bundle = None
    if sys.platform == "darwin" and not args.console:
        bundle = expected_out.parents[1]          # the .app folder
        size_mb = sum(f.stat().st_size for f in bundle.rglob("*") if f.is_file()) / (1024 * 1024)
    else:
        size_mb = expected_out.stat().st_size / (1024 * 1024)
        bundle = expected_out

    file_hash = sha256_file(expected_out)

    checksum_file = dist_dir / "checksums.sha256"
    checksum_entry = f"{file_hash.lower()}  {expected_out.name}\n"
    with open(checksum_file, "a", encoding="utf-8") as f:
        f.write(checksum_entry)

    print(f"\n[build] SUCCESS: {bundle.name} ({size_mb:.1f} MB)")
    print(f"[build] SHA-256: {file_hash}")
    print(f"[build] Checksum appended to {checksum_file}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
