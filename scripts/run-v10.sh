#!/usr/bin/env bash
cd /e/myzcode/vigil
eval "$(node scripts/load-channels.mjs 2>/dev/null)"
eval "$(node scripts/load-local-keys.mjs 2>/dev/null)"
node scripts/cluster.mjs \
  --models agent2api-local:gemini-3-flash-preview,magpie-local:auto/qwen3.8-flash \
  --family rush --reps 3 --concurrency 6 --pace-ms 400 \
  --min-depth 8 --max-depth 14 \
  --cap agent2api-local=3 --cap magpie-local=3 \
  --budget-usd 35 --out runs/rush-v10 --resume
