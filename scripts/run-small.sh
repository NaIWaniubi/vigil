#!/usr/bin/env bash
cd /e/myzcode/vigil
eval "$(node scripts/load-channels.mjs 2>/dev/null)"
source /tmp/local-keys.sh
node scripts/cluster.mjs \
  --models deepseek:deepseek-chat,opencsg-local:qwen3.8-max,orcaterm-local:glm-5.3 \
  --family rush --reps 1 --concurrency 3 --pace-ms 800 \
  --cap opencsg-local=1 --cap orcaterm-local=1 \
  --budget-usd 25 --limit 6 --out runs/rush-small --resume
