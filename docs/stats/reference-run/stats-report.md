# Statistical report — E:\myzcode\vigil\docs\reference-run

Generated: 2026-11-05T19:41:17.053Z

**verdict: underpowered**

## Data quality

- 13 scoreable cells out of 55 rows (42 infrastructure errors excluded, never scored as losses).
- 3 models attempted; 1 produced scoreable cells.
- Zero scoreable cells: qwen3.8-max (20 attempts), deepseek-v4-flash (19 attempts).
- Repeated cells (>=2 reps): 0.

## Per-model win rate

| model | n | wins | win rate | Wilson 95% | bootstrap 95% |
|---|---:|---:|---:|---|---|
| gemini-3-flash-preview | 13 | 4 | 30.8% | [12.7%, 57.6%] | [7.7%, 53.8%] |

## Pairwise differences

Skipped: need at least two models with scoreable cells (found 1).

## Power

A 30pp effect (0.30 vs 0.60) at alpha=0.05 and 80% power requires **42 cells per group** (normal approximation, two-sided).

This run's achieved n is **13**. Power at that n for a 30pp effect is **0.329**.

**verdict: underpowered** — the run cannot distinguish a 30pp difference from noise.

## Notes

- 42 of 55 rows were infrastructure failures; they are excluded from win rates, not scored as losses.
- qwen3.8-max, deepseek-v4-flash produced zero scoreable cells (20, 19 attempts). No win rate can be reported for them.
- Detecting a 30pp effect at 80% power needs 42 cells per group; this run has 13. It cannot support a claim at that effect size.
- Wilson 95% CI for gemini-3-flash-preview spans [12.7%, 57.6%] (width 45.0%); the point estimate is weakly identified.
- This run is a sealed bundle (MANIFEST.sha256); stats-report.json/md were written outside it to E:\myzcode\vigil\docs\stats\reference-run so scripts/verify.mjs stays valid.
