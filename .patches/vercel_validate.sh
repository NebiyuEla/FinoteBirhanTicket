#!/usr/bin/env bash
set -euo pipefail
python3 .patches/live_miniapp_availability.py
cd bot/backend
npm install --package-lock=false --no-audit --no-fund
npm test
cd ../..
node --check app.js
node --check bot/backend/src/index.js
node --check bot/backend/src/db.js
node --check bot/backend/tests/liveMiniAppAvailability.test.js
rm -rf public
mkdir -p public
cp index.html app.js styles.css logo.svg version.txt public/
cp -R assets public/
