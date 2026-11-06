#!/usr/bin/env bash
cd /e/myzcode/vigil
eval "$(node scripts/load-local-keys.mjs 2>/dev/null)"
# Depth 8-9: short enough that the reasoning tail usually fits in 16k.
# 3 cells, 16 turns, cc=1 — a pilot, not a powered arm.
node scripts/cluster.mjs \
  --models magpie-local:apigoto-api-apigoto-com/deepseek-flash \
  --family rush --reps 1 --concurrency 1 --pace-ms 1200 \
  --min-depth 8 --max-depth 9 --sample 3 --obligations off \
  --history-window 3 --max-turns 16 \
  --cap magpie-local=1 \
  --budget-usd 3 --out runs/deep-4 --resume
