#!/bin/bash
# Launch the packaged macOS app (and clear Gatekeeper on first run).
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
APP="$DIR/dist/ZcodeGateway-macos.app"
if [ ! -d "$APP" ]; then echo "app not found: $APP"; exit 1; fi
xattr -cr "$APP" 2>/dev/null || true
open "$APP"
