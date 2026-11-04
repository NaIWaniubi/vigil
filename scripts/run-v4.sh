#!/usr/bin/env bash
cd /e/myzcode/vigil
eval "$(node scripts/load-channels.mjs 2>/dev/null)"
source /tmp/local-keys.sh
node scripts/cluster.mjs \
  --models deepseek:deepseek-chat,opencsg-local:deepseek-v4-pro,opencsg-local:qwen3.8-max,agent2api-local:gemini-3-flash-preview \
  --family rush --reps 2 --concurrency 5 --pace-ms 700 \
  --cap opencsg-local=2 --cap agent2api-local=2 \
  --budget-usd 35 --limit 16 --out runs/rush-v4 --resume
