#!/usr/bin/env bash
cd /e/myzcode/vigil
eval "$(node scripts/load-channels.mjs 2>/dev/null)"
eval "$(node scripts/load-local-keys.mjs 2>/dev/null)"
# Depth-stratified sample: 44 tasks spanning depth 8-20, 2 reps, high
# concurrency (remote calls, not CPU). Produces the win-rate-vs-depth curve.
node scripts/cluster.mjs \
  --models agent2api-local:gemini-3-flash-preview \
  --family rush --reps 2 --concurrency 14 --pace-ms 150 \
  --min-depth 8 --max-depth 20 --sample 44 \
  --cap agent2api-local=14 \
  --budget-usd 30 --out runs/rush-v13 --resume
