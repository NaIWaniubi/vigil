#!/usr/bin/env bash
cd /e/myzcode/vigil
eval "$(node scripts/load-channels.mjs 2>/dev/null)"
eval "$(node scripts/load-local-keys.mjs 2>/dev/null)"
# Single fast model, depth-stratified, high concurrency: produces the
# win-rate-vs-optimal-depth curve against the solver/greedy baselines.
node scripts/cluster.mjs \
  --models agent2api-local:gemini-3-flash-preview \
  --family rush --reps 3 --concurrency 10 --pace-ms 200 \
  --min-depth 8 --max-depth 16 \
  --cap agent2api-local=10 \
  --budget-usd 30 --out runs/rush-v11 --resume
