#!/usr/bin/env bash
cd /e/myzcode/vigil
eval "$(node scripts/load-channels.mjs 2>/dev/null)"
eval "$(node scripts/load-local-keys.mjs 2>/dev/null)"
# The session channel (apigoto free tier) returns 403 for API use, so drive the
# matrix with the relay that actually permits it. 45 stratified tasks, one
# obligation kind, 32-turn cap recorded in protocol.json.
node scripts/cluster.mjs \
  --models magpie-local:agent2api/auto \
  --family rush --reps 1 --concurrency 5 --pace-ms 400 \
  --min-depth 8 --max-depth 20 --sample 45 --obligations off \
  --history-window 3 --max-turns 32 \
  --cap magpie-local=5 \
  --budget-usd 12 --out runs/powered-2 --resume
