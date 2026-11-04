#!/usr/bin/env bash
cd /e/myzcode/vigil
eval "$(node scripts/load-channels.mjs 2>/dev/null)"
source /tmp/local-keys.sh
exec node scripts/cluster.mjs --models deepseek:deepseek-chat,opencsg-local:qwen3.8-max,orcaterm-local:glm-5.3,agent2api-local:gemini-3-flash-preview --family rush --reps 2 --concurrency 6 --pace-ms 500 --cap opencsg-local=2 --cap orcaterm-local=2 --cap agent2api-local=2 --budget-usd 20 --limit 30 --out runs/rush-mm --resume
