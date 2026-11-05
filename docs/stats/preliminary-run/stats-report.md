# Statistical report — E:\myzcode\vigil\docs\preliminary-run

Generated: 2026-11-05T18:54:57.958Z

**verdict: underpowered**

## Data quality

- 12 scoreable cells out of 24 rows (12 infrastructure errors excluded, never scored as losses).
- 2 models attempted; 2 produced scoreable cells.
- Repeated cells (>=2 reps): 0.

## Per-model win rate

| model | n | wins | win rate | Wilson 95% | bootstrap 95% |
|---|---:|---:|---:|---|---|
| glm-5.3-flash | 2 | 2 | 100.0% | [34.2%, 100.0%] | [100.0%, 100.0%] |
| agent2api/auto | 10 | 8 | 80.0% | [49.0%, 94.3%] | [50.0%, 100.0%] |

## Pairwise differences

| a | b | delta | bootstrap 95% | raw p | Holm p | significant |
|---|---|---:|---|---:|---:|---|
| glm-5.3-flash | agent2api/auto | 20.0% | [0.0%, 50.0%] | 0.4884 | 0.4884 | no |

Delta is win-rate(a) - win-rate(b). Holm-adjusted over 1 comparison(s) at alpha=0.05.

## Power

A 30pp effect (0.30 vs 0.60) at alpha=0.05 and 80% power requires **42 cells per group** (normal approximation, two-sided).

This run's achieved n is **2** (weakest of 2 scoreable models; best-sampled 10). Power at that n for a 30pp effect is **0.081**.

**verdict: underpowered** — the run cannot distinguish a 30pp difference from noise.

## Notes

- 12 of 24 rows were infrastructure failures; they are excluded from win rates, not scored as losses.
- Detecting a 30pp effect at 80% power needs 42 cells per group; this run has 2. It cannot support a claim at that effect size.
- Wilson 95% CI for glm-5.3-flash spans [34.2%, 100.0%] (width 65.8%); the point estimate is weakly identified.
- Bootstrap CI for glm-5.3-flash collapsed to a point ([100.0%, 100.0%]) because every resample was identical. At n=2 this is a boundary artifact, not certainty; use the Wilson interval.
- Wilson 95% CI for agent2api/auto spans [49.0%, 94.3%] (width 45.3%); the point estimate is weakly identified.
- No pairwise difference survives Holm correction at alpha=0.05.
- This run is a sealed bundle (MANIFEST.sha256); stats-report.json/md were written outside it to E:\myzcode\vigil\docs\stats\preliminary-run so scripts/verify.mjs stays valid.
