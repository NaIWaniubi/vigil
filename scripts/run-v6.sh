#!/usr/bin/env bash
cd /e/myzcode/vigil
eval "$(node scripts/load-channels.mjs 2>/dev/null)"
source /tmp/local-keys.sh
node scripts/cluster.mjs \
  --models deepseek:deepseek-chat,agent2api-local:gemini-3-flash-preview \
  --family rush --reps 3 --concurrency 6 --pace-ms 400 \
  --cap agent2api-local=3 \
  --budget-usd 40 --out runs/rush-v6 --resume
