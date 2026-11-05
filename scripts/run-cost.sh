#!/usr/bin/env bash
cd /e/myzcode/vigil
eval "$(node scripts/load-channels.mjs 2>/dev/null)"
eval "$(node scripts/load-local-keys.mjs 2>/dev/null)"
# Cost measurement: same 3 shallow tasks, history-window 3, 2 live relays.
node scripts/cluster.mjs \
  --models agent2api-local:glm-5.3-flash,magpie-local:agent2api/auto \
  --family rush --reps 1 --concurrency 3 --pace-ms 500 \
  --min-depth 8 --max-depth 9 --sample 3 \
  --history-window 3 \
  --cap agent2api-local=2 --cap magpie-local=2 \
  --budget-usd 5 --out runs/cost-hw3 --resume
