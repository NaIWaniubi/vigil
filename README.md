# VIGIL

**值守** — an executable long-horizon agent benchmark.

Constraints accumulate and genuinely conflict. Background obligations decay on an
environment clock. Every failure is attributed deterministically to the action
that caused it and the step that introduced the rule. The evaluator audits itself
before it is allowed to score anything.

> Status: **S1 complete** — engine, attribution, boundary detection, 38 tests green.
> Task families, runner, leaderboard and report are in progress. Nothing here is
> a published result yet.

## Why this exists

SoTALab's [Password Game study](https://sotalab.ai/zh/blog/password-game-long-horizon-agents)
ran 8 models × 3 attempts through a game whose rules pile up, and reported six
findings that current benchmarks do not act on:

| Their finding | What VIGIL ships |
| --- | --- |
| 10 of 24 runs used prohibited shortcuts; "Benchmark 必须明确合法工具与权限边界" | Closed action surface, canary-baited verifier internals, `raw` vs `compliant` tracks |
| "到达 R28 … 实际最高通过为 R27" | `reached` and `passed` are separate counters |
| Cost grew ~1.25× per rule; time, tokens and intervention all count | Environment ticks + token ledger + wall clock, cost curve per model |
| 7 of 24 runs died because Paul starved — including the furthest run | Obligations decay on **environment time**, which accrues with action cost |
| "子项分数往往比 headline 数字更有信息量" | Capability profile, never a bare total |
| "每一次失败都要能被定位" | `(stepIndex, constraintId, introducedAtStep, class, witness)` per violation |

They published the analysis and the methodology. They did not publish the
environment. This is that environment, open source.

## The gap in the literature

Verified against arXiv and GitHub on 2026-11-04:

- **MTAC-IFBench** ([2609.14992](https://arxiv.org/abs/2609.14992)) has agents and accumulating constraints (avg 91), but explicitly excludes contradictory constraints and has no step-level attribution.
- **SEQUOR** ([2605.06353](https://arxiv.org/abs/2605.06353)) has persist/add/replace constraint modes, but is dialogue-only and filters out conflicting pairs.
- **Who&When / TRAIL / AgentRx** do failure attribution, but post-hoc with an LLM judge. Who&When's best step localisation is 14.2%.
- **HAL Reliability Dashboard** has the richest reliability metrics, but measures *agent* reliability, not *evaluator* trustworthiness.

The intersection — real conflicting constraints × verifier-native deterministic
attribution × evaluator self-audit — is empty.

## Core mechanics

```
World = { state, active constraints, live obligations, tick }

step(action):
  pre  := snapshot(state)
  apply(action)                      # closed whitelist, logged with args
  tick += cost(action)               # expensive thinking costs more neglect
  advance obligations by cost        # <-- the Paul mechanism
  evaluate every active constraint
  attribute: diff(pre, state) ∩ read-set(constraint)
  reveal constraints scheduled for the next step
```

**Real conflict, still fair.** Constraints are predicates over shared state, not
contradictory propositions. Satisfying B perturbs A, but a legal solution always
exists — the generator proves it with a solver before a task is admitted.

**Attribution without a judge.** Because we own the state, "which action broke
which rule, introduced how long ago" is computed, not inferred:

| class | meaning |
| --- | --- |
| `broke` | this action changed a cell the constraint reads |
| `collateral` | constraint broke without its read-set being touched |
| `revealed` | rule just appeared and the state already fails it |
| `neglected` | already failing, action ignored its read-set |
| `regressed` | already failing, action touched it but did not fix it |
| `obligation_lapsed` | background duty died while the agent worked elsewhere |

## Usage

```bash
node --test "test/*.test.mjs"     # 38 tests
node scripts/gate.mjs             # tests + oracle self-audit + repo hygiene
```

```js
import { World, num, ref, op } from './engine/index.mjs';

const world = new World({
  id: 'demo', maxSteps: 40,
  initialState: { tank: { level: 0 } },
  constraints: [
    { id: 'c1', revealAt: 0, text: 'tank.level >= 8',
      predicate: op('ge', ref('tank.level'), num(8)) },
  ],
  obligations: [
    { id: 'paul', kind: 'decay', revealAt: 0, initial: 10, rate: 1,
      repairAction: 'tend', repairAmount: 10 },
  ],
});

world.step({ type: 'set', args: { path: 'tank.level', value: 9 } });
world.observe();   // state + active rule TEXT + obligation urgency. No predicates.
world.profile();   // reached / passed / ticks / compliant / obligationsDead
world.records;     // every violation, with step, rule, age and witness
```

## Hypotheses under test

- **H2 (headline)** — background-obligation failure is uncorrelated with main-line progress. The strongest model may die of neglect first.
- **H1** — enabling real conflict *reverses* model rankings, i.e. existing constraint-accumulation leaderboards measure the wrong capability.
- **H3** — cost per additional constraint grows exponentially, with a model-specific multiplier.
- **H4** — what fraction of our own "hard" tasks are actually broken tasks? (Motivated by [2609.26826](https://arxiv.org/abs/2609.26826), which found 37.6% of zero-pass terminal tasks could not be certified as genuinely hard.)

No results are claimed until the runs are public and recomputable.

## Design rules

1. Tasks are **data**, never evaluator code. Predicates are a small validated AST.
2. The agent sees rule *text* and obligation *urgency* — never predicates, future rules, or answer keys.
3. A failed action is a logged failure, not a harness crash. Call failures, truncation and budget exhaustion are never scored as wrong answers.
4. Every task ships an oracle. A task whose oracle fails is quarantined and reported, not quietly dropped.
5. Determinism is a hard requirement: seeded PRNG, canonical hashing, replayable trajectories.

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE) for third-party attribution.