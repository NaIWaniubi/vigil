#!/usr/bin/env bash
cd /e/myzcode/vigil
eval "$(node scripts/load-channels.mjs 2>/dev/null)"
eval "$(node scripts/load-local-keys.mjs 2>/dev/null)"
# Powered run on the fast relay channel (resolves to deepseek-v4.1-flash-1017).
# Target: >= 42 scoreable cells so stats-report can certify a 30pp effect,
# with >= 5 cells in every depth band so the depth curve is admissible.
node scripts/cluster.mjs \
  --models magpie-local:apigoto-api-apigoto-com/deepseek-flash \
  --family rush --reps 1 --concurrency 20 --pace-ms 80 \
  --min-depth 8 --max-depth 20 --sample 60 --obligations off \
  --history-window 3 \
  --cap magpie-local=20 \
  --budget-usd 12 --out runs/powered-1 --resume
