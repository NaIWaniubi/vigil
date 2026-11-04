#!/usr/bin/env bash
cd /e/myzcode/vigil
eval "$(node scripts/load-channels.mjs 2>/dev/null)"
source /tmp/local-keys.sh
node scripts/cluster.mjs \
  --models deepseek:deepseek-chat,agent2api-local:gemini-3-flash-preview,opencsg-local:qwen3.8-max \
  --family rush --reps 3 --concurrency 4 --pace-ms 600 \
  --cap agent2api-local=2 --cap opencsg-local=2 \
  --budget-usd 40 --limit 20 --out runs/rush-v5 --resume
