#!/usr/bin/env bash
cd /e/myzcode/vigil
eval "$(node scripts/load-local-keys.mjs 2>/dev/null)"
# Smoke test for output-budget escalation: one depth-10 cell, 6 turns.
# The model thinks 3k-22k tokens on this band; without escalation roughly a
# third of turns die truncated. With escalation, a long thought retries at a
# higher cap and the cell can still finish.
node scripts/cluster.mjs \
  --models magpie-local:apigoto-api-apigoto-com/deepseek-flash \
  --family rush --reps 1 --concurrency 1 --pace-ms 1000 \
  --min-depth 10 --max-depth 12 --sample 1 --obligations off \
  --history-window 3 --max-turns 6 \
  --cap magpie-local=1 \
  --budget-usd 3 --out runs/deep-3 --resume