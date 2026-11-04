#!/usr/bin/env bash
cd /e/myzcode/vigil
eval "$(node scripts/load-channels.mjs 2>/dev/null)"
eval "$(node scripts/load-local-keys.mjs 2>/dev/null)"
node scripts/cluster.mjs \
  --models agent2api-local:gemini-3-flash-preview \
  --family rush --reps 1 --concurrency 10 --pace-ms 200 \
  --min-depth 8 --max-depth 12 \
  --cap agent2api-local=10 \
  --budget-usd 25 --out runs/rush-v12 --resume
