#!/usr/bin/env bash
cd /e/myzcode/vigil
eval "$(node scripts/load-channels.mjs 2>/dev/null)"
source /tmp/local-keys.sh
node scripts/cluster.mjs \
  --models agent2api-local:gemini-3-flash-preview,opencsg-local:qwen3.8-max,opencsg-local:deepseek-v4-flash \
  --family rush --reps 3 --concurrency 6 --pace-ms 500 \
  --cap agent2api-local=3 --cap opencsg-local=3 \
  --budget-usd 40 --out runs/rush-v7 --resume
