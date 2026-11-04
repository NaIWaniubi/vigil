# VIGIL

**A solver-calibrated long-horizon agent benchmark.**

Every task ships a provably shortest solution. Every hard task is proven to defeat a greedy baseline before it is admitted. Every failure is attributed to the exact action and the rule it broke. The evaluator audits itself before it scores anything.

> Status: three task families, 586 self-audited task configurations, 100+ tests.
> Empirical runs in progress; no results are claimed ahead of the data.

## Why this exists

SoTALab's [Password Game study](https://sotalab.ai/zh/blog/password-game-long-horizon-agents)
ran 8 models × 3 attempts through a game whose rules accumulate, and reported six
findings current benchmarks do not act on. They published the analysis and the
methodology. They did not publish the environment. This is that environment.

| Their finding | What VIGIL ships |
| --- | --- |
| 10 of 24 runs used prohibited shortcuts | Closed action surface per family; generic state mutators are not even offered in Rush Hour; canaries + separate `raw` / `compliant` tracks |
| "Reached R28 … highest actually passed R27" | `reached` and `passed` are distinct counters |
| Cost grew ~1.25× per rule | Environment ticks + integer-micro-USD ledger + per-constraint cost-growth fit |
| 7 of 24 died because Paul starved — including the furthest run | Obligations decay on **environment time**, which accrues with action cost |
| "Sub-scores carry more information than the headline number" | Capability profile, never a bare total |
| "Every failure must be locatable" | Six attribution classes with witnesses |

## The three families

### `vigil-rush` — the hardness core

Rush-Hour sliding-block puzzles. The target car cannot reach the exit until
blocking vehicles are shuffled out of the way, often *backwards* first. NP-hard in
general, finite state space, and therefore **calibrated by an optimal BFS solver**:

1. Generate a random board.
2. Solve it optimally. Reject if unsolvable or depth < 8.
3. Run the greedy baseline. **Reject if greedy solves it.**
4. Admit with its measured optimal depth and proven greedy failure.

Current dataset: **130 tasks from 150 seeds (87% yield)**, optimal depth 8–20
(median 9), **all 130 defeat greedy**. Built once by
`scripts/build-rush-dataset.mjs`, committed, fingerprinted — like SWE-bench, not
regenerated per run.

This replaced an earlier synthetic family whose slots were independent: an 80%
win-rate benchmark that everything passed. Independence was the bug.

### `vigil-swe` — regression-coupled repositories

Four authored mini-repos (reactive store, event-sourced todo, URL router, query
builder), each 4 modules with real cross-module imports. The agent edits **one
file**; the verifier runs the **whole repo** in a `--permission` child process
(filesystem denied). Each repo ships a *proven naive fix* that satisfies a later
requirement and breaks an earlier one — attribution records the regression.

### `vigil-core` — the controlled ablation

Synthetic fill/vent pressure gadgets with knobs for conflict, obligation kind and
depth. Useful for causal isolation of the background-obligation mechanism
(H2); superseded as a difficulty instrument by `vigil-rush`.

## Attribution without a judge

Because we own the state, "which action broke which rule, introduced how long
ago" is computed, not inferred:

| class | meaning |
| --- | --- |
| `broke` | this action changed a cell the constraint reads |
| `collateral` | constraint broke without its read-set being touched |
| `revealed` | rule just appeared and the state already fails it |
| `neglected` | already failing; action ignored its read-set |
| `regressed` | already failing; action touched it but did not fix it |
| `obligation_lapsed` | a background duty died while the agent worked elsewhere |

Post-hoc attribution work (Who&When / TRAIL / AgentRx) tops out at 14.2% step
localisation. We do not infer; we diff.

## Evaluator self-audit

Motivation: [2609.26826](https://arxiv.org/abs/2609.26826) found 37.6% of
zero-pass terminal tasks could not be certified as genuinely hard.

Every task must pass: oracle solves it, doing nothing does not, ignoring
obligations does not (where obligations exist), and replay is byte-identical.
**586/586 configurations admitted, 0 quarantined.** Failing tasks are quarantined
and reported, never silently dropped.

The audit found real bugs, not hypothetical ones (see `docs/SELF-AUDIT.md`):
seven in the core generator, an invisible objective, an invisible board, a
**reward-hacking exploit**, and a **nondeterministic verification path**.

## Reproduce

```bash
node scripts/gate.mjs                 # tests + task self-audit + repo hygiene
node runner.mjs --dry-run --family both --tasks quick --reps 1 --limit 4
node scripts/cluster.mjs --dry-run --family rush --limit 4 --reps 1
node scripts/verify.mjs <run-dir> --write   # MANIFEST + prompt fingerprint + numbers
node scripts/verify.mjs <run-dir>            # exit 1 on any tamper
node scripts/discrimination.mjs <run-dir>    # greedy vs oracle vs model win rates
```

## Design rules

1. Tasks are **data**, never evaluator code.
2. The agent sees rule text, obligation urgency and (for Rush Hour) the board —
   never predicates, future rules, solutions, or answer keys.
3. **The action surface is the legality boundary.** A generic `set` that can
   write the win condition is not offered.
4. A failed action is a logged failure, not a harness crash. Call failures,
   truncation and budget exhaustion are never scored as wrong answers.
5. Every task ships an oracle; a task whose oracle fails is quarantined.
6. Verification is deterministic: bounded concurrency, generous timeouts, and a
   quarantine verdict if replay diverges.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).