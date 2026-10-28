#!/bin/zsh
cd "${0:A:h}"
# This launcher always opens the local workspace, regardless of cloud shell settings.
export BOARD_DATABASE_MODE=sqlite
export BOARD_COOKIE_SECURE=0
unset BOARD_ORIGIN RENDER_EXTERNAL_URL
exec python3 -B server.py --host 127.0.0.1 --port 8765 --data-dir "$PWD/data"
