#!/usr/bin/env bash
cd /e/myzcode/vigil
eval "$(node scripts/load-local-keys.mjs 2>/dev/null)"
# Small pilot on the reasoning relay, AFTER the truncation fix:
#   - maxTokens is now 16384 in the registry, the smallest cap that yields text
#   - the runner refuses truncated/empty replies instead of scoring them
# cc=1 on purpose: this channel also serves the interactive session, and the
# earlier 403s were load-triggered. 3 tasks, depth 10-13, 14 turns each.
node scripts/cluster.mjs \
  --models magpie-local:apigoto-api-apigoto-com/deepseek-flash \
  --family rush --reps 1 --concurrency 1 --pace-ms 1500 \
  --min-depth 10 --max-depth 13 --sample 3 --obligations off \
  --history-window 3 --max-turns 14 \
  --cap magpie-local=1 \
  --budget-usd 2 --out runs/deep-2 --resume