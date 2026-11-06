#!/usr/bin/env bash
cd /e/myzcode/vigil
eval "$(node scripts/load-local-keys.mjs 2>/dev/null)"
# Where does it break? depth 8 was 3/3 at 1.00x; depth 12 overran 32k and died.
# Probe the band in between.
node scripts/cluster.mjs \
  --models magpie-local:apigoto-api-apigoto-com/deepseek-flash \
  --family rush --reps 1 --concurrency 1 --pace-ms 1200 \
  --min-depth 9 --max-depth 10 --sample 2 --obligations off \
  --history-window 3 --max-turns 18 \
  --cap magpie-local=1 \
  --budget-usd 3 --out runs/deep-5 --resume
