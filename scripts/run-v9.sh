#!/usr/bin/env bash
cd /e/myzcode/vigil
eval "$(node scripts/load-channels.mjs 2>/dev/null)"
eval "$(node scripts/load-local-keys.mjs 2>/dev/null)"
node scripts/cluster.mjs \
  --models agent2api-local:gemini-3-flash-preview,magpie-local:auto/qwen3.8-flash,magpie-local:auto/glm-5.1 \
  --family rush --reps 2 --concurrency 6 --pace-ms 400 \
  --min-depth 8 --max-depth 12 \
  --cap agent2api-local=3 --cap magpie-local=3 \
  --budget-usd 35 --out runs/rush-v9 --resume
