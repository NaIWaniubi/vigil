#!/usr/bin/env bash
cd /e/myzcode/vigil
eval "$(node scripts/load-channels.mjs 2>/dev/null)"
eval "$(node scripts/load-local-keys.sh 2>/dev/null || node scripts/load-local-keys.mjs 2>/dev/null)"
# Low concurrency on the session channel: the earlier 403s appeared at cc=20.
# Target the depth band the powered run never reached (10-16).
node scripts/cluster.mjs \
  --models magpie-local:apigoto-api-apigoto-com/deepseek-flash \
  --family rush --reps 1 --concurrency 3 --pace-ms 600 \
  --min-depth 10 --max-depth 16 --sample 9 --obligations off \
  --history-window 3 --max-turns 26 \
  --cap magpie-local=3 \
  --budget-usd 6 --out runs/deep-1 --resume
