#!/usr/bin/env bash
cd /e/myzcode/vigil
eval "$(node scripts/load-channels.mjs 2>/dev/null)"
eval "$(node scripts/load-local-keys.mjs 2>/dev/null)"
# Time-bounded cross-model run. Both models get the SAME 32-turn budget, which is
# recorded in protocol.json so the comparison stays honest and reproducible.
node scripts/cluster.mjs \
  --models agent2api-local:glm-5.3-flash,magpie-local:agent2api/auto \
  --family rush --reps 1 --concurrency 6 --pace-ms 300 \
  --min-depth 8 --max-depth 20 --sample 14 \
  --history-window 3 --max-turns 32 \
  --cap agent2api-local=3 --cap magpie-local=3 \
  --budget-usd 12 --out runs/live-mm2 --resume
