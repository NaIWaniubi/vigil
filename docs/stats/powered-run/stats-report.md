# Statistical report — E:\myzcode\vigil\docs\powered-run

Generated: 2026-11-06T03:18:57.788Z

**verdict: underpowered**

## Data quality

- 11 scoreable cells out of 53 rows (42 infrastructure errors excluded, never scored as losses).
- 1 models attempted; 1 produced scoreable cells.
- Repeated cells (>=2 reps): 0.

## Per-model win rate

| model | n | wins | win rate | Wilson 95% | bootstrap 95% |
|---|---:|---:|---:|---|---|
| apigoto-api-apigoto-com/deepseek-flash | 11 | 11 | 100.0% | [74.1%, 100.0%] | [100.0%, 100.0%] |

## Pairwise differences

Skipped: need at least two models with scoreable cells (found 1).

## Power

A 30pp effect (0.30 vs 0.60) at alpha=0.05 and 80% power requires **42 cells per group** (normal approximation, two-sided).

This run's achieved n is **11**. Power at that n for a 30pp effect is **0.284**.

**verdict: underpowered** — the run cannot distinguish a 30pp difference from noise.

## Notes

- 42 of 53 rows were infrastructure failures; they are excluded from win rates, not scored as losses.
- Detecting a 30pp effect at 80% power needs 42 cells per group; this run has 11. It cannot support a claim at that effect size.
- Bootstrap CI for apigoto-api-apigoto-com/deepseek-flash collapsed to a point ([100.0%, 100.0%]) because every resample was identical. At n=11 this is a boundary artifact, not certainty; use the Wilson interval.
- This run is a sealed bundle (MANIFEST.sha256); stats-report.json/md were written outside it to E:\myzcode\vigil\docs\stats\powered-run so scripts/verify.mjs stays valid.
