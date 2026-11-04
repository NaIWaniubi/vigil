#!/usr/bin/env bash
cd /e/myzcode/vigil
eval "$(node scripts/load-channels.mjs 2>/dev/null)"
eval "$(node scripts/load-local-keys.mjs 2>/dev/null)"
# Gentle final run: 24 stratified tasks, low concurrency so the gateway keeps up.
node scripts/cluster.mjs \
  --models agent2api-local:gemini-3-flash-preview \
  --family rush --reps 1 --concurrency 4 --pace-ms 600 \
  --min-depth 8 --max-depth 18 --sample 24 \
  --cap agent2api-local=4 \
  --budget-usd 20 --out runs/rush-v14 --resume
