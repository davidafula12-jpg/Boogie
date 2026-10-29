#!/bin/sh
# Mac / Linux: double-click or run ./start-library.sh
cd "$(dirname "$0")"
[ -d node_modules ] || npm install
( sleep 3; (open http://localhost:3000 || xdg-open http://localhost:3000) >/dev/null 2>&1 ) &
node server.js
