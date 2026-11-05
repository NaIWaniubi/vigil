# VIGIL: A Solver-Calibrated Long-Horizon Agent Benchmark

**Deterministic failure attribution, background obligations, and a self-auditing evaluator**

v0.3.0 · 2026-11-05 · Apache-2.0

---

## Abstract

SoTALab's [Password Game study](https://sotalab.ai/blog/password-game-long-horizon-agents)
ran 8 models × 3 attempts through a game whose rules accumulate, and articulated
six commitments about what a good evaluation requires — but published no code,
data, or environment.

VIGIL implements those commitments as an executable, reproducible, open-source
benchmark. **The v0.3 change is difficulty calibration.** The earlier synthetic
family used independent slots; measured, it produced an 80.2% win rate with 11 of
16 conditions swept clean — a benchmark everything passes measures nothing.
The primary hardness family is now NP-hard sliding-block puzzles where **every
task ships a BFS-computed shortest solution and is admitted only if a greedy
baseline fails it**.

Three design choices fill a verified gap in the literature:

1. **Solver-calibrated difficulty** — not "we think it's hard", but "optimal is 16
   moves, greedy loops after 3". The closest competitors — MTAC-IFBench
   ([2609.14992](https://arxiv.org/abs/2609.14992)) and SEQUOR
   ([2605.06353](https://arxiv.org/abs/2605.06353)) — exclude interacting
   constraints at construction and publish no optimal-solution baseline.
2. **Verifier-native deterministic attribution** — every violation is located to
   `(action index, constraint id, introduction step, class, witness)` by state
   differencing, not inferred. Post-hoc attribution work (Who&When / TRAIL /
   AgentRx) tops out at 14.2% step localisation.
3. **A self-auditing evaluator whose verification is itself deterministic** —
   per-task admission checks (solvable, non-trivial, obligations binding,
   shortcut-resistant, byte-identical replay) and a quarantine verdict on any
   divergence. 586/586 configurations admitted. Repeat-stability and blind-judge
   agreement are **not** reported: no run has more than one repetition per cell,
   and the blind-comparison layer is not implemented (`stats/judge.mjs` says so
   in its own header).

---

## 1. Six commitments, six artifacts

| SoTALab's finding | What VIGIL ships | Location |
| --- | --- | --- |
| 10 of 24 runs used prohibited shortcuts | Closed action surface per family with an explicit `task.genericWrites` policy; canary tripwires; separate `raw`/`compliant` tracks. Canaries detect *echoing a token or writing a protected path* — not reading verifier state outside the action surface, which a harness that only sees actions cannot observe | `tasks/rush/world.mjs` |
| "Reached R28 … highest actually passed R27" | `reached` and `passed` are distinct counters | `engine/world.mjs` |
| Cost grew ~1.25× per rule | Environment ticks + integer micro-USD ledger + cost-growth fit (for rush this is cost **per optimal move**, since a rush task carries one rule per milestone; the per-rule reading applies to `vigil-core`) | `providers/ledger.mjs` |
| 7 of 24 died because Paul starved — including the furthest run | Obligations decay on **environment time**, accruing with action cost | `engine/clock.mjs` |
| "Sub-scores carry more information than the headline number" | Capability profile, never a bare total | `stats/aggregate.mjs` |
| "Every failure must be locatable" | Six attribution classes with witnesses | `engine/attribute.mjs` |

---

## 2. Difficulty calibration

### 2.1 Why the family changed

The original `vigil-core` gadget gave each slot its own state; solving slot 1 said
nothing about slot 2. There was no cross-slot search. Measured on deepseek-chat in a local run (96 cells, $12.34, **80.2% win rate**,
**11/16 conditions all-win**). That run predates the write-policy fix below, so
its absolute number is not reproducible from this repository; the *shape* of the
result — a benchmark everything passes — is what motivated the family change. The
quote is labelled as a historical observation, not as a published bundle.

### 2.2 Calibration pipeline

```
random board
   ↓
optimal BFS solve → unsolvable / depth < 8 → discard
   ↓
greedy baseline → greedy solves it → discard
   ↓
admit with measured optimal depth, solver state count, greedy failure mode
```

Current dataset (`tasks/rush/dataset.json`, generated once and committed):

| Metric | Value |
| --- | --- |
| seeds / admitted | 150 / **130 (87%)** |
| optimal depth | 8–20, median **9** |
| greedy defeated | **130/130 (100%)** |
| depth distribution | 8:49, 9:21, 10:23, 11:12, 12:7, 13–20:18 |

Shallow tasks dominate — a natural consequence of calibration, and the reason
runs must use **stratified sampling** (`--sample`) rather than the first N seeds.

### 2.3 What a shipped task actually contains

Each rush task ships **four constraints**, revealed over time:

1. `exit` — X must reach the exit (the goal, visible from step 0).
2. Three `pin_*` milestones — vehicles that the optimal solution has already
   parked; each must *stay* where it is. They are satisfiable by construction
   (the optimal path leaves those vehicles parked) and they accumulate: once
   revealed, they are checked on every subsequent step.

Background obligations are **binding**: the budget is derived from the oracle's
own tick count, so ignoring the obligation kills the run. The self-audit proves
this per task by replaying the oracle with every `tend` stripped.

### 2.4 Baselines

- `solve()`: BFS over slide moves, returns the shortest sequence; `maxStates` caps
  pathological boards during generation.
- `greedy()`: pushes the target toward the exit without backtracking or memory;
  a detected cycle is a failure.
- Calibration requires greedy to **fail**, otherwise the task discriminates nothing.

---

## 3. Mechanics

### 3.1 World and actions

```
World = { state, active constraints, live obligations, tick }

step(action):
  pre  := snapshot(state)
  apply(action)                  # closed whitelist, logged with args
  tick += cost(action)           # expensive thinking costs more neglect
  advance obligations by cost    # the Paul mechanism
  evaluate every active constraint
  attribute: diff(pre, state) ∩ read-set(constraint)
  reveal constraints scheduled for the next step
```

Constraints are **data** — a small validated AST — not evaluator code, so tasks are
serialisable, hashable into a manifest, and inspectable by the agent without
exposing the evaluator.

### 3.2 The action surface is the permission boundary

In Rush Hour the only legal action is `move(id, delta)`, validated against the
board. Generic mutators (`set`/`inc`/`push`/`remove`):

- are **not listed** in `observe()`;
- are rejected by `RushWorld.step` even if sent, leaving state unchanged.

This is not fastidiousness. In run v7, gemini-3-flash-preview emitted
`set pos.X.col 4` after four illegal X moves — writing the win condition
directly. The engine reported `goal_met` while X had never moved; all four of its
"wins" were exploits. See §5.

### 3.3 Background obligations

| Kind | Mechanism | Repair |
| --- | --- | --- |
| decay | loses `rate` per tick, dies at zero | tend refills |
| deadline | dies at `dueAt` | tend discharges |
| hazard | accumulates heat per unshielded tick, ignites at 1 | tend grants a shield and vents heat |

Hazard is deliberately **cumulative**: a per-tick coin flip lets any sparse
maintenance policy die of bad luck, which makes the task unprovable. Cumulative
heat plus a shield makes periodic tending a winning policy while keeping neglect
deterministically fatal.

### 3.4 Attribution classes

| Class | Meaning |
| --- | --- |
| `broke` | this action changed a cell the constraint reads |
| `collateral` | broke without its read-set being touched |
| `revealed` | rule just appeared and the state already fails it |
| `neglected` | already failing; action ignored its read-set |
| `regressed` | already failing; action touched it but did not fix it |
| `obligation_lapsed` | a background duty died while the agent worked elsewhere |

Each record carries `introducedAtStep` and `ageInSteps`, answering "which rule
from 30 steps ago did it forget".

---

## 4. Three families

| Family | Role | Size | Verification |
| --- | --- | --- | --- |
| `vigil-rush` | hardness core | 130 tasks × 3 obligation kinds | optimal BFS + greedy must fail |
| `vigil-swe` | regression coupling | 4 multi-file repos × 6 requirements × 3 obligations | whole repo run in a `--permission` child process |
| `vigil-core` | controlled ablation | 160 configurations | fill/vent pressure gadgets |

Each `vigil-swe` repo ships a **proven naive fix**: it satisfies a later
requirement and breaks an earlier one, and attribution must record
`broke`/`regressed`.

---

## 5. Real defects the self-audit caught

The audit is not decoration. Nine defect classes were caught and fixed; two would
have destroyed credibility outright.

**Reward hacking.** In v7 a model used `set pos.X.col` to fake a win (§3.2). Fix:
reject generic mutators, hide them from the action surface, add two explicit
regression tests.

**Two of three families were winnable with their own advertised actions.** After
the Rush Hour fix, an external reviewer showed that `vigil-core` could be won with
`set store.total <goal>` and `vigil-swe` with `push passed <id>` + `set ciRuns 1`,
without a single gadget action or source edit. The fix is now structural: generic
writes are denied unless a task opts in, no task may opt in for a cell its goal
reads, internal `__sync` actions are unreachable from the public `step`, and the
self-audit attacks every family with its own goal-cell write.

**Nondeterministic verification.** The gate once quarantined
`swe-todo-d5-off-s1` as `replay diverged`. The cause was not the task: running 586
audits at once starved the swe child-process checks, which timed out
nondeterministically so `passed` randomly lost an entry. That is **verification
flake misreported as task flake**. Fix: bounded concurrency (swe 3-way, rush
4-way) and a 30 s batch timeout. Result: 586/586 admitted.

The other seven — logically contradictory pseudo-conflict, slot reuse, an
unsolvable stochastic hazard, a reveal schedule outrunning its own oracle,
winning before the hard part appeared, over-loose obligation budgets, an invisible
objective, and an invisible board — are catalogued in `docs/SELF-AUDIT.md`.

**Verification must be deterministic before any number is published.** An
evaluator that cannot distinguish "the task is broken" from "the verifier is
tired" will report infrastructure jitter as model capability.

---

## 6. Protocol and reproduction

Full protocol: `docs/PROTOCOL.md`.

- Versioned prompt (`vigil-agent-v2`); SHA-256 recorded in `protocol.json`
- Temperature 0 (kimi-k3 requires 1; pinned and labelled); reasoning channels get
  their own `maxTokens`
- Main track admits `official` direct channels only; relays labelled separately
- Infrastructure failures (HTTP errors, truncation, insufficient balance) are
  **excluded**, never scored as wrong answers
- Integer micro-USD accounting, reserve→settle; unknown prices and budget
  overruns block spending

Three-check reproduction (`scripts/verify.mjs`): per-file MANIFEST SHA-256, prompt
fingerprint, and a recomputed aggregate that must match the published report
exactly. Tampering with one byte exits 1 — verified.

---

## 7. Evidence status

**Established:**

- Solvability: 586/586 configurations pass self-audit (oracle / lazy / neglect /
  determinism).
- Calibration validity: 130/130 tasks defeat greedy; optimal depths independently
  recomputed by BFS.
- Pipeline correctness: `gate.mjs` green; `verify.mjs` passes all three checks;
  tampering detected.
- Exploit defence: four generic mutators cannot fake a win (regression-tested).

**Measured, reported as preliminary:**

- Reference run `docs/reference-run` (v8): 55 cells, 13 scoreable, 42 infrastructure
  errors. gemini-3-flash-preview: 30.8% win rate [13%, 58%] over 13 cells.
- Depth gradient: depth 8–9 → **4/12 (33%)**, depth 13–16 → **0/1 (0%)**.
  Direction is right; the deep bin is too small to claim a curve.
- Baselines for the same dataset: greedy **0%**, oracle **100%**.

**Blocked by infrastructure, honestly reported:**

- Official deepseek exhausted its balance mid-run (HTTP 402).
- Several relay models time out (>120 s) on the long board prompt; per-channel
  timeouts and `maxTokens` were raised, but availability still limits sample size.
- The protocol records these as infrastructure errors, not model weakness, which
  is exactly why the scoreable count (13) is far below the cell count (55).

**No cross-model ranking is claimed.** Conclusions follow the public bundle, and
every number recomputes with one command.

---

## 8. Relation to prior work

| Work | What it has | What VIGIL adds |
| --- | --- | --- |
| MTAC-IFBench | agents + accumulating constraints (avg 91) | optimal-solution calibration + deterministic step attribution |
| SEQUOR | persist/add/replace modes | environment state, not dialogue; conflicts not filtered |
| Who&When / TRAIL / AgentRx | failure attribution | attribution as a native verifier output, not post-hoc inference |
| HAL Reliability Dashboard | agent reliability metrics | evaluator trustworthiness + admission audit + exploit defence |
| τ-bench pass^k | repeat-run stability | combined with calibration, cost curves and permission audit |

---

## 9. Limitations

- The synthetic family is a controlled instrument; the repo family has four
  authored repos, smaller than SWE-bench.
- Cross-model comparison is limited by available channels on this machine;
  official balance and relay latency both bound sample size.
- Obligation dynamics are deterministic (hazard is cumulative heat); they do not
  model real-world interruption distributions.
- Constraint interaction is currently within a gadget; cross-gadget coupling is
  future work.
- The deep bins (depth ≥ 13) are under-sampled: 18 of 130 tasks.

---

## Citation

```bibtex
@software{vigil2026,
  title  = {VIGIL: A Solver-Calibrated Long-Horizon Agent Benchmark with
            Deterministic Failure Attribution and a Self-Auditing Evaluator},
  author = {Chen Yongrun},
  year   = {2026},
  url    = {https://github.com/NaIwaniubi/vigil},
  note   = {Apache-2.0}
}
```

Methodological response to: SoTALab, *What The Password Game Reveals About the
Future of Long-Horizon Agents*, 2026-07-17.