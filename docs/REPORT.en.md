# VIGIL: An Executable Long-Horizon Agent Benchmark

**Conflicting constraints, background obligations, deterministic failure attribution**

v0.1.0 · 2026-11-04 · Apache-2.0

---

## Abstract

SoTALab's [Password Game study](https://sotalab.ai/blog/password-game-long-horizon-agents)
(2026-07-17) ran 8 models × 3 attempts through a game whose rules accumulate,
spending $473.26 and 758M tokens. It articulated six commitments about what a
good evaluation requires — but published no code, data, or environment. Its
planned SoTA-LH benchmark family has not yet released a first instance.

VIGIL turns those six commitments into an executable, reproducible, open-source
environment. Three design choices fill a verified gap in the literature:

1. **Genuinely conflicting accumulating constraints.** Constraints perturb each
   other through shared state, yet a joint solution always exists and is proven
   by a shipped oracle. The closest competitors — MTAC-IFBench
   ([2609.14992](https://arxiv.org/abs/2609.14992)) and SEQUOR
   ([2605.06353](https://arxiv.org/abs/2605.06353)) — both exclude contradictory
   constraints at construction time.
2. **Verifier-native deterministic attribution.** Every violation is located to
   `(action index, constraint id, introduction step, class, witness)` by state
   differencing — not inferred by an LLM reading a transcript. Post-hoc
   attribution work (Who&When / TRAIL / AgentRx) achieves at best 14.2% step
   localisation.
3. **A self-auditing evaluator.** Every task ships an oracle and must pass four
   admission checks before it can score anything. Repeat consistency, position
   bias, prompt fingerprints and per-file SHA-256 manifests are published
   alongside the scores. HAL's Reliability Dashboard measures *agent*
   reliability, not *evaluator* trustworthiness.

---

## 1. Six commitments, six artifacts

| SoTALab's finding | What VIGIL ships | Location |
| --- | --- | --- |
| 10 of 24 runs used prohibited shortcuts; "a benchmark must define legal tools and permission boundaries" | Closed action whitelist, canary-baited internals, separate `raw` / `compliant` tracks | `engine/world.mjs` |
| "Reached R28 … highest actually passed was R27" | `reached` and `passed` are distinct counters | `engine/world.mjs` |
| Cost grew ~1.25× per rule; time, tokens and intervention all count | Environment ticks + token ledger + per-constraint cost multiplier fit | `providers/ledger.mjs`, `stats/index.mjs` |
| 7 of 24 runs died because Paul starved — including the furthest run | Obligations decay on **environment time**, which accrues with action cost | `engine/clock.mjs` |
| "Sub-scores carry more information than the headline number" | Capability profile, never a bare total | `stats/aggregate.mjs` |
| "Every failure must be locatable" | Six attribution classes with witnesses | `engine/attribute.mjs` |

---

## 2. Mechanics

### 2.1 World and actions

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

Constraints are **data** — a small validated AST — not evaluator code. Tasks are
therefore serialisable, hashable into a manifest, and inspectable by the agent
without exposing the evaluator.

### 2.2 Real conflict, still fair

The coupled gadget in `vigil-core`:

- `fill_<slot>(amount)` raises `level` **and** `pressure` together
- early constraint: `level >= needA`
- later constraint: valve open **and** `pressure <= needA - 1`

A naive fill necessarily violates the later constraint. The only escape is
`vent_<slot>`, which lowers pressure without touching level. A joint solution
exists and the oracle proves it. This measures coupled-state search and repair —
a different capability from remembering N independent rules.

The `none` control matches the rule count but reads **disjoint** cells, so the
only difference between modes is interaction.

### 2.3 Background obligations

| Kind | Mechanism | Repair |
| --- | --- | --- |
| decay | loses `rate` per tick; dies at zero | tend refills |
| deadline | dies at `dueAt` | tend discharges |
| hazard | accumulates heat per unshielded tick; ignites at 1 | tend grants a shield and vents heat |

Hazard is deliberately **cumulative**, not a per-tick Bernoulli: a random coin
means any sparse maintenance policy can die of bad luck, making the task
unprovable. Cumulative heat plus a shield makes periodic tending a winning
policy while neglect remains deterministically fatal.

### 2.4 Attribution classes

| Class | Meaning |
| --- | --- |
| `broke` | this action changed a cell the constraint reads |
| `collateral` | constraint broke without its read-set being touched |
| `revealed` | rule just appeared and the state already fails it |
| `neglected` | already failing; action ignored its read-set |
| `regressed` | already failing; action touched it but did not fix it |
| `obligation_lapsed` | a background duty died while the agent worked elsewhere |

Each record carries `introducedAtStep` and `ageInSteps`, answering "which rule
from 30 steps ago did it forget".

---

## 3. Evaluator self-audit

Motivation: [2609.26826](https://arxiv.org/abs/2609.26826) audited 125 zero-pass
terminal tasks and found **37.6% could not be certified as genuinely hard**.

Every task must pass four checks before admission: the oracle solves it, doing
nothing does not, ignoring obligations does not, and replay is byte-identical.
Failing tasks are **quarantined and reported**, never silently dropped.

Current status: **187/187 admitted** (160 core + 27 swe), 0 quarantined.

The audit caught seven real defect classes during development (see
`docs/SELF-AUDIT.md`), including a logically contradictory pseudo-conflict, slot
reuse, an unsolvable stochastic hazard, a reveal schedule outrunning its own
oracle, winning before the hard part appeared, over-loose obligation budgets,
and an invisible objective that measured prompt ambiguity rather than capability.

The last was found empirically: same task, same model — 35 steps to `step_budget`
before the objective was shown, 14 steps to `goal_met` after.

---

## 4. Protocol and reproduction

Full protocol: `docs/PROTOCOL.md`. Highlights:

- Versioned prompt; SHA-256 recorded in each run's `protocol.json`
- Temperature 0 (kimi-k3 requires 1; pinned and labelled)
- Main track admits `official` direct channels only; relays labelled separately
- Infrastructure failures (HTTP errors, truncation) are **excluded**, never
  scored as wrong answers
- Integer micro-USD accounting, reserve→settle; unknown prices and budget
  overruns block spending

Three-check reproduction (`scripts/verify.mjs`):

1. **MANIFEST** — per-file SHA-256, no unlisted files
2. **PROTOCOL** — prompt fingerprint matches a fresh hash
3. **NUMBERS** — recomputed aggregate equals the published report exactly

Tampering with any byte exits 1. Verified empirically.

---

## 5. Hypotheses and evidence status

| Hypothesis | Claim | Status |
| --- | --- | --- |
| H1 | Enabling real conflict reverses model rankings | Pipeline verified on one model; multi-model runs in progress |
| H2 | Obligation failure is uncorrelated with main-line progress | `maxProgressButDied` counter implemented; awaiting sample |
| H3 | Cost per constraint grows exponentially, model-specific multiplier | `costGrowth` validated against a known 1.25× synthetic series |
| H4 | What fraction of our own tasks are broken? | 187/187 admitted; 7 defect classes fixed during development |

**No conclusion is claimed ahead of the data.** All hypothesis tests are
published as run bundles; every number recomputes with one command.

---

## 6. Relation to prior work

| Work | What it has | What VIGIL adds |
| --- | --- | --- |
| MTAC-IFBench | agents + accumulating constraints (avg 91) | real conflict + deterministic step-level attribution |
| SEQUOR | persist/add/replace modes | environment state, not dialogue; conflicts not filtered out |
| Who&When / TRAIL / AgentRx | failure attribution | attribution as a native verifier output, not post-hoc LLM inference |
| HAL Reliability Dashboard | agent reliability metrics | evaluator trustworthiness + task admission audit |
| τ-bench pass^k | repeat-run stability | combined with conflict ablation, cost curves and permission audit |

---

## 7. Limitations

- The synthetic family is a controlled instrument, not a real workload; the
  repository family currently has three authored modules.
- No official direct channel for Claude-family models; the main track does not
  yet cover them.
- Obligation dynamics are deterministic (hazard is cumulative heat); they do not
  model real-world stochastic interruption distributions.
- Constraint interaction is currently within a gadget; cross-gadget coupling is
  future work.

---

## Citation

```bibtex
@software{vigil2026,
  title  = {VIGIL: An Executable Long-Horizon Agent Benchmark with
            Conflicting Constraints, Background Obligations, and
            Deterministic Failure Attribution},
  author = {Chen Yongrun},
  year   = {2026},
  url    = {https://github.com/NaIWaniubi/vigil},
  note   = {Apache-2.0}
}
```

Methodological response to: SoTALab, *What The Password Game Reveals About the
Future of Long-Horizon Agents*, 2026-07-17.