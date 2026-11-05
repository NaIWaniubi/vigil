#!/usr/bin/env bash
cd /e/myzcode/vigil
eval "$(node scripts/load-channels.mjs 2>/dev/null)"
eval "$(node scripts/load-local-keys.mjs 2>/dev/null)"
node scripts/cluster.mjs \
  --models agent2api-local:gemini-3-flash-preview \
  --family rush --reps 1 --concurrency 3 --pace-ms 500 \
  --min-depth 8 --max-depth 12 --sample 6 \
  --history-window 3 \
  --cap agent2api-local=3 \
  --budget-usd 5 --out runs/hw-measure --resume
