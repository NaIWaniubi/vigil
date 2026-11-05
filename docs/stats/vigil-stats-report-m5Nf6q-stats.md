# Statistical report — C:\Users\chen\AppData\Local\Temp\vigil-stats-report-m5Nf6q

Generated: 2026-11-05T18:46:04.841Z

**verdict: underpowered**

## Data quality

- 8 scoreable cells out of 9 rows (1 infrastructure errors excluded, never scored as losses).
- 2 models attempted; 2 produced scoreable cells.
- Repeated cells (>=2 reps): 0.

## Per-model win rate

| model | n | wins | win rate | Wilson 95% | bootstrap 95% |
|---|---:|---:|---:|---|---|
| alpha | 4 | 3 | 75.0% | [30.1%, 95.4%] | [25.0%, 100.0%] |
| beta | 4 | 1 | 25.0% | [4.6%, 69.9%] | [0.0%, 75.0%] |

## Pairwise differences

| a | b | delta | bootstrap 95% | raw p | Holm p | significant |
|---|---|---:|---|---:|---:|---|
| alpha | beta | 50.0% | [0.0%, 100.0%] | 0.1573 | 0.1573 | no |

Delta is win-rate(a) - win-rate(b). Holm-adjusted over 1 comparison(s) at alpha=0.05.

## Power

A 30pp effect (0.30 vs 0.60) at alpha=0.05 and 80% power requires **42 cells per group** (normal approximation, two-sided).

This run's achieved n is **4** (weakest of 2 scoreable models; best-sampled 4). Power at that n for a 30pp effect is **0.124**.

**verdict: underpowered** — the run cannot distinguish a 30pp difference from noise.

## Notes

- 1 of 9 rows were infrastructure failures; they are excluded from win rates, not scored as losses.
- Detecting a 30pp effect at 80% power needs 42 cells per group; this run has 4. It cannot support a claim at that effect size.
- Wilson 95% CI for alpha spans [30.1%, 95.4%] (width 65.4%); the point estimate is weakly identified.
- Wilson 95% CI for beta spans [4.6%, 69.9%] (width 65.4%); the point estimate is weakly identified.
- No pairwise difference survives Holm correction at alpha=0.05.
