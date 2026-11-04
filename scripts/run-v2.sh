#!/usr/bin/env bash
cd /e/myzcode/vigil
eval "$(node scripts/load-channels.mjs 2>/dev/null)"
source /tmp/local-keys.sh
node scripts/cluster.mjs \
  --models deepseek:deepseek-chat,orcaterm-local:glm-5.3,opencsg-local:qwen3.8-max \
  --family rush --reps 2 --concurrency 4 --pace-ms 700 \
  --cap orcaterm-local=2 --cap opencsg-local=2 \
  --budget-usd 30 --limit 20 --out runs/rush-v2 --resume
