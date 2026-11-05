#!/usr/bin/env bash
cd /e/myzcode/vigil
eval "$(node scripts/load-channels.mjs 2>/dev/null)"
eval "$(node scripts/load-local-keys.mjs 2>/dev/null)"
# Run with the only two channels alive right now. Both are relays, so they go
# to the exploratory track; --history-window 3 keeps input (and time) down.
node scripts/cluster.mjs \
  --models agent2api-local:glm-5.3-flash,magpie-local:agent2api/auto \
  --family rush --reps 1 --concurrency 6 --pace-ms 400 \
  --min-depth 8 --max-depth 16 --sample 18 \
  --history-window 3 \
  --cap agent2api-local=3 --cap magpie-local=3 \
  --budget-usd 15 --out runs/live-mm --resume
