#!/usr/bin/env bash
# macos.sh - package Zcode Gateway for macOS.
#
#   ./scripts/build/macos.sh           build
#   ./scripts/build/macos.sh --clean   wipe .local/build/ .local/dist/ first
#
# Output (this machine's architecture; PyInstaller cannot cross-compile):
#   .local/dist/ZcodeGateway-macos       terminal binary (gui_main, --headless for a server)
#   .local/dist/ZcodeGateway.app         double-click desktop bundle of that same binary
#
# CI zips the app to ZcodeGateway-macos.zip and publishes both assets.
# Run ON macOS. release.yml job: build-macos.

set -euo pipefail
SCRIPT_PATH="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/$(basename -- "${BASH_SOURCE[0]}")"
ROOT="$(cd -- "$(dirname -- "$SCRIPT_PATH")/../.." && pwd -P)"
cd -- "$ROOT"

echo "Zcode Gateway - macOS build"

[[ "$(uname -s)" == "Darwin" ]] || { echo "macos.sh must run on macOS" >&2; exit 1; }

if [[ "${1:-}" == "--clean" ]]; then
    rm -rf .local/build .local/dist
fi

case "$(uname -m)" in
    x86_64|amd64) BUN_ARCH=x64; MACH_ARCH="$(uname -m)" ;;
    arm64|aarch64) BUN_ARCH=arm64; MACH_ARCH="$(uname -m)" ;;
    *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

# 1. Native sidecar. Never substitute a Windows .exe or a Linux ELF.
MINT_DIR="tools/captcha-mint"
if [[ -f "$MINT_DIR/mint.ts" ]]; then
    if command -v bun >/dev/null 2>&1; then
        echo "  compiling captcha-mint (bun, $(uname -m))..."
        (cd "$MINT_DIR"
         [[ -d node_modules ]] || bun install
         bun build --compile --target=bun-darwin-"$BUN_ARCH" \
            --outfile captcha-mint mint.ts)
    else
        echo "  bun not found - a prebuilt native macOS captcha-mint is required"
    fi
fi
MINT_BIN="$MINT_DIR/captcha-mint"
[[ -f "$MINT_BIN" && -x "$MINT_BIN" ]] || {
    echo "Missing executable macOS captcha-mint. Install Bun and rerun, or supply a native prebuilt at $MINT_BIN (not .exe)." >&2
    exit 1
}

assert_macho() {
    python3 - "$1" "$2" <<'PY'
import struct
import sys
from pathlib import Path

path, arch = sys.argv[1:]
blob = Path(path).read_bytes()
if len(blob) < 16:
    sys.exit(f"{path} is too small to be a Mach-O executable")
magic = struct.unpack_from("<I", blob, 0)[0]
# MH_MAGIC_64, little-endian. Fat archives and ELF/PE are rejected: this
# host can only load its own single-architecture slice.
if magic != 0xFEEDFACF:
    sys.exit(f"{path} is not a little-endian 64-bit Mach-O executable")
cputype, _subtype, filetype = struct.unpack_from("<III", blob, 4)
expected = {"x86_64": 0x01000007, "amd64": 0x01000007,
            "arm64": 0x0100000C, "aarch64": 0x0100000C}.get(arch)
if filetype != 2 or cputype != expected:
    sys.exit(f"{path} is not an executable Mach-O for {arch} (cputype={cputype:#x}, filetype={filetype})")
PY
}
assert_macho "$MINT_BIN" "$MACH_ARCH"

# 2. python + deps. The desktop shell is Cocoa via pywebview.
PY=".venv/bin/python"
if [[ ! -x "$PY" ]]; then
    python3 -m venv .venv
    "$PY" -m pip install --upgrade pip
fi
"$PY" -c "import PyInstaller" 2>/dev/null || "$PY" -m pip install pyinstaller
"$PY" -c "import yaml, httpx, fastapi, uvicorn, requests, socks, webview" 2>/dev/null \
    || "$PY" -m pip install -r requirements/macos.txt

# 3. stage generator sources (the live folder accumulates browser profiles,
# proxy ledgers and token caches; none of that ships)
GEN_STAGE="$(mktemp -d -t zcoder-generator-XXXXXX)"
MAIL_STAGE=""
ICON_STAGE=""
trap 'rm -rf "$GEN_STAGE"; if [[ -n "$MAIL_STAGE" ]]; then rm -rf "$MAIL_STAGE"; fi; if [[ -n "$ICON_STAGE" ]]; then rm -rf "$ICON_STAGE"; fi' EXIT
MAIL_STAGE="$(mktemp -d -t zcoder-mail-XXXXXX)"
cp generator/*.py "$GEN_STAGE/"
for f in README.md requirements.txt; do
    [[ -f "generator/$f" ]] && cp "generator/$f" "$GEN_STAGE/"
done

# Whitelist worker sources and generate config without reading local secrets.
"$PY" scripts/packaging/stage_mail_worker.py mail-worker "$MAIL_STAGE"

VERSION="$("$PY" -c 'from zcode_gateway import __version__; print(__version__)')"

# 4. pyinstaller onefile console. gui_main accepts --headless for the server
# and opens the dashboard when launched with no arguments.
"$PY" -m PyInstaller \
    --noconfirm --clean --onefile --console \
    --name ZcodeGateway-macos \
    --osx-bundle-identifier com.autozcoder.zcodegateway \
    --collect-submodules uvicorn \
    --hidden-import uvicorn.logging \
    --hidden-import uvicorn.loops \
    --hidden-import uvicorn.loops.auto \
    --hidden-import uvicorn.protocols \
    --hidden-import uvicorn.protocols.http \
    --hidden-import uvicorn.protocols.http.auto \
    --hidden-import uvicorn.protocols.http.h11_impl \
    --hidden-import uvicorn.protocols.websockets \
    --hidden-import uvicorn.protocols.websockets.auto \
    --hidden-import uvicorn.lifespan \
    --hidden-import uvicorn.lifespan.on \
    --hidden-import uvicorn.lifespan.off \
    --hidden-import anyio._backends._asyncio \
    --hidden-import httpcore --hidden-import h11 \
    --hidden-import requests --hidden-import urllib3 \
    --hidden-import urllib3.contrib.socks --hidden-import socks --hidden-import certifi \
    --hidden-import yaml \
    --hidden-import zcode_gateway.generator \
    --hidden-import zcode_gateway.accounts_dir_bridge \
    --hidden-import fastapi.staticfiles \
    --hidden-import webview \
    --hidden-import webview.platforms.cocoa \
    --collect-data webview \
    --collect-submodules webview.dom \
    --exclude-module webview.platforms.gtk \
    --exclude-module webview.platforms.qt \
    --exclude-module webview.platforms.cef \
    --exclude-module webview.platforms.edgechromium \
    --exclude-module webview.platforms.winforms \
    --exclude-module webview.platforms.mshtml \
    --exclude-module webview.platforms.win32 \
    --exclude-module webview.platforms.android \
    --add-data "$ROOT/config.example.yaml:." \
    --add-data "$ROOT/assets:assets" \
    --add-data "$ROOT/zcode_gateway/dashboard:zcode_gateway/dashboard" \
    --add-data "$MAIL_STAGE:mail-worker" \
    --add-data "$GEN_STAGE:generator" \
    --add-binary "$ROOT/$MINT_BIN:captcha-mint" \
    --paths "$ROOT" \
    --workpath .local/build --distpath .local/dist --specpath .local/build/specs \
    "$ROOT/gui_main.py"

BIN=".local/dist/ZcodeGateway-macos"
[[ -f "$BIN" ]] || { echo "expected output missing: $BIN" >&2; exit 1; }
chmod +x "$BIN"
assert_macho "$BIN" "$MACH_ARCH"
codesign --force --sign - "$BIN"

# 5. Finder bundle. The executable is the same onefile binary, so Terminal
# can also run ZcodeGateway.app/Contents/MacOS/ZcodeGateway --headless.
APP=".local/dist/ZcodeGateway.app"
if [[ -e "$APP" ]]; then
    rm -r "$APP"
fi
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/ZcodeGateway"
chmod +x "$APP/Contents/MacOS/ZcodeGateway"
if [[ -f "$ROOT/assets/zcode.png" ]]; then
    ICON_STAGE="$(mktemp -d -t zcoder-icon-XXXXXX)"
    ICONSET="$ICON_STAGE/AppIcon.iconset"
    mkdir -p "$ICONSET"
    sips -z 16 16 "$ROOT/assets/zcode.png" --out "$ICONSET/icon_16x16.png" >/dev/null
    sips -z 32 32 "$ROOT/assets/zcode.png" --out "$ICONSET/icon_16x16@2x.png" >/dev/null
    sips -z 32 32 "$ROOT/assets/zcode.png" --out "$ICONSET/icon_32x32.png" >/dev/null
    sips -z 64 64 "$ROOT/assets/zcode.png" --out "$ICONSET/icon_32x32@2x.png" >/dev/null
    sips -z 128 128 "$ROOT/assets/zcode.png" --out "$ICONSET/icon_128x128.png" >/dev/null
    sips -z 256 256 "$ROOT/assets/zcode.png" --out "$ICONSET/icon_128x128@2x.png" >/dev/null
    sips -z 256 256 "$ROOT/assets/zcode.png" --out "$ICONSET/icon_256x256.png" >/dev/null
    sips -z 512 512 "$ROOT/assets/zcode.png" --out "$ICONSET/icon_256x256@2x.png" >/dev/null
    sips -z 512 512 "$ROOT/assets/zcode.png" --out "$ICONSET/icon_512x512.png" >/dev/null
    sips -z 1024 1024 "$ROOT/assets/zcode.png" --out "$ICONSET/icon_512x512@2x.png" >/dev/null
    iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
fi
cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Zcode Gateway</string>
  <key>CFBundleDisplayName</key><string>Zcode Gateway</string>
  <key>CFBundleIdentifier</key><string>com.autozcoder.zcodegateway</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleExecutable</key><string>ZcodeGateway</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
  </dict>
</dict>
</plist>
EOF
codesign --force --sign - "$APP/Contents/MacOS/ZcodeGateway"
codesign --force --sign - "$APP"
mkdir -p .local/dist/captcha-mint
install -m 755 "$MINT_BIN" .local/dist/captcha-mint/captcha-mint
echo
echo "  built: $BIN"
echo "  built: $APP"
echo "  Terminal:  ./$BIN            (opens the dashboard)"
echo "             ./$BIN --headless (server only, http://127.0.0.1:8788/dash)"
echo "  Desktop:   open $APP"
echo "  First launch of a downloaded copy needs:"
echo "    xattr -dr com.apple.quarantine ZcodeGateway.app ZcodeGateway-macos"
