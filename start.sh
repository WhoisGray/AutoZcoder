#!/bin/bash
set -e
cd "$(dirname "$0")"
exec ./.venv/bin/python gui_main.py "$@"
