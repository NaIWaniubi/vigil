# TEAM BOARD — vigil-swe multi-file upgrade

## ARCH
Base engine (engine/world.mjs) is immutable. SweWorld extends World; async
candidate execution is bridged via the internal `__swe_sync` action which
carries the already-computed post-action state so the engine's before/after
diff, attribution, obligations, canaries and full-reveal goal stay unchanged.

## SPEC
vigil-swe = multi-file mini-repos (3-6 modules with real import edges).
Action surface: edit(file, source) one file at a time; run_ci discharges the
CI watchdog. Verifier runs the WHOLE repo per check batch. Requirements reveal
on a schedule derived from the oracle. Goal: all revealed requirements pass +
ciRuns >= 1 + no obligation dead + full reveal (engine-enforced).

## BUILD

SLICE U-swe: multi-file regression-coupled vigil-swe family
  files:   tasks/swe/repos.mjs (new, 4 repos + scenarios),
           tasks/swe/check-worker.mjs (new, permission-sandboxed runner),
           tasks/swe/generate.mjs (rewritten),
           tasks/swe/verify.mjs (rewritten),
           tasks/swe/world.mjs (rewritten),
           test/swe.test.mjs (rewritten, 20 tests)
  test:    node --test test/swe.test.mjs
  output:  |
    ℹ tests 20
    ℹ pass 20
    ℹ fail 0
    ℹ skipped 0
    EXIT=0
    (full per-test output: 20 ✔ lines, incl. "every repo oracle reaches
    goal_met across obligations off/deadline/decay and seeds 1,2" and
    "a naive single-file fix produces a broke/regressed attribution record
    for the earlier requirement")
  commit:  13de7fa (parent committed mid-slice; final comment-only diff on top:
           tasks/swe/repos.mjs, tasks/swe/verify.mjs — working tree)
  notes:   |
    - Red phase confirmed before implementation: test run failed with
      "does not provide an export named 'runRepo'" (1 fail, exit 1).
    - Isolation: data: URLs alone do NOT block node:fs on Node v24 (probed:
      static AND dynamic builtin imports resolve). Worker execArgv
      --permission is also ignored on v24 Windows (probed: read 662 bytes).
      Final design spawns a fresh child process per check batch with
      --permission and no --allow-* grants; fs reads fail ERR_ACCESS_DENIED
      (test-verified for static and dynamic import). Infinite loops are
      killed with the process (timeout verdict, test-verified).
    - Cost: ~1s process start per batch on Windows; the 24-config oracle
      matrix test takes ~3.5 min. Batches are independent and can run
      concurrently (self-audit already does).
    - Import linking is regex-based over string-literal relative specifiers
      (from/import/import()). Dynamic computed specifiers are not rewritten;
      they fail resolution inside the sandbox (failed check, not a crash).
      Repo import cycles are rejected at link time.
    - Rejected edit actions bypass the base #apply (external actions carry no
      effects array); SweWorld logs them and advances stepIndex directly.
      Rejected actions do not advance ticks or obligations (cost 0), matching
      the base engine's #reject semantics.
    - Dry-run note: runner --dry-run uses the core greedy policy, which does
      not understand swe rule text; swe dry cells end step_budget by design
      (pipeline smoke only). Oracle solvability is proven by the test matrix
      and self-audit, not by the dry policy.
    - moduleIndex accepted as alias for repoIndex (self-audit + harbor-export
      + runner all use moduleIndex; verified unchanged).

  verification:
    node --test "test/*.test.mjs"   (whole repo suite, no cross-family regressions)
      → "ℹ tests 98 / ℹ pass 98 / ℹ fail 0 / ℹ skipped 0"  EXIT=0
    node scripts/self-audit.mjs --quick --no-write
      → "self-audit: 44 tasks, 44 admitted, 0 quarantined"
        "SELF-AUDIT: PASS — every admitted task has a working oracle, is non-trivial, and replays exactly"  EXIT=0
    node runner.mjs --dry-run --family swe --reps 1 --out runs/swe-dry
      → "vigil run · 36 tasks x 1 models x 1 reps = 36 cells"
        "RUN: 36 cells, 0 skipped, 0 errors"  EXIT=0
    Regression attribution evidence (real record, STORE repo):
      { stepIndex: 16, constraintId: 'req-total', introducedAtStep: 0,
        ageInSteps: 16, class: 'broke', actionType: '__swe_sync',
        blamedPaths: ['passed'] }
      produced by editing src/selectors.mjs with the naive cache-forever fix
      after the oracle repo was in place (test asserts this for all 4 repos).

SLICE S1: bootstrap confidence intervals
  files:   stats/inference.mjs (new), stats/index.mjs (re-export),
           test/stats.test.mjs
  test:    node --test test/stats.test.mjs
  output:  |
    RED (before implementation):
      SyntaxError: The requested module '../stats/inference.mjs' does not
      provide an export named 'bootstrapCI'
      ℹ tests 1 / ℹ pass 0 / ℹ fail 1   EXIT=1
    GREEN:
      ✔ bootstrapCI is deterministic for a fixed seed
      ✔ bootstrapCI brackets the true mean of a known distribution
      ✔ bootstrapCI widens as alpha falls; degenerate samples collapse
      ✔ bootstrapDiffCI recovers the difference of two proportions
      ℹ tests 18 / ℹ pass 18 / ℹ fail 0 / ℹ skipped 0   EXIT=0
  commit:  1437e33 (HEAD at verification; stats changes are working-tree,
           uncommitted — the worktree is shared with other agents)
  notes:   |
    - Local mulberry32 inside stats/inference.mjs; no import from engine/ or
      tasks/ (stats stays dependency-free). Same seed -> byte-identical bounds;
      the final report is deterministic across CLI invocations (verified:
      "deterministic: true" comparing models/pairwise/power/verdict).
    - Percentile bootstrap returns the statistic on the observed sample as
      `point` (not the mean of resamples). Quantile interpolation is linear.
    - Percentile bootstrap degenerates at 0/1 boundaries (2/2 -> [1,1]); the
      report emits an explicit caveat and points at the Wilson interval instead
      of presenting that as certainty.
    - bootstrapDiffCI resamples each group independently with one PRNG stream;
      group order defines the sign of `point` (mean(a) - mean(b)).

SLICE S2: power / minimum detectable effect
  files:   stats/inference.mjs, stats/index.mjs, test/stats.test.mjs
  test:    node --test test/stats.test.mjs
  output:  |
    RED:
      SyntaxError: The requested module '../stats/inference.mjs' does not
      provide an export named 'minNForEffect'   ℹ fail 1   EXIT=1
    GREEN:
      ✔ powerTwoProportions is monotone in n and matches textbook limits
      ✔ powerTwoProportions returns alpha for a true null
      ✔ minNForEffect round-trips through powerTwoProportions
      ℹ tests 21 / ℹ pass 21 / ℹ fail 0 / ℹ skipped 0   EXIT=0
  commit:  1437e33 (HEAD; working tree)
  notes:   |
    - Two-sided normal approximation; n is PER GROUP (n2 optional for unequal
      allocation). Required n for 0.30 vs 0.60 at alpha=.05, power=.80 is 42
      per group; power at n=13 is 0.329 — the number the report publishes.
    - Normal CDF is Abramowitz-Stegun 7.1.26 (|err|<1.5e-7); inverse CDF is
      Acklam. The p1=p2=.5, n=100 case returns 0.05 within 0.005 (tested).
    - minNForEffect returns Infinity for p1 === p2 and uses a doubling +
      binary search over monotone power. Round-trip test asserts power(n)>=.8
      and power(n-1)<.8, so the boundary is pinned, not just "close".

SLICE S3: multiple comparisons
  files:   stats/inference.mjs, stats/index.mjs, test/stats.test.mjs
  test:    node --test test/stats.test.mjs
  output:  |
    RED:
      SyntaxError: The requested module '../stats/inference.mjs' does not
      provide an export named 'holmBonferroni'   ℹ fail 1   EXIT=1
    GREEN:
      ✔ holmBonferroni matches a hand-checked example
      ✔ holmBonferroni is never below the raw p-value and stays in [0,1]
      ℹ tests 23 / ℹ pass 23 / ℹ fail 0 / ℹ skipped 0   EXIT=0
  commit:  1437e33 (HEAD; working tree)
  notes:   |
    - Adjusted p-values returned in input order; monotone step-down enforced
      with a running max. Hand example [0.01,0.04,0.03] -> [0.03,0.06,0.06].
    - Holm is valid under arbitrary dependence, which is why it (not
      Bonferroni) is used for pairwise model comparisons that share control
      cells. twoProportionPValue (pooled z-test) was added for the p-inputs.

SLICE S4: scripts/stats-report.mjs
  files:   scripts/stats-report.mjs (new), test/stats.test.mjs,
           docs/reference-run/stats-report.json (generated),
           docs/reference-run/stats-report.md (generated)
  test:    node --test test/stats.test.mjs
  output:  |
    RED:
      Error: Cannot find module 'E:\myzcode\vigil\scripts\stats-report.mjs'
      ✖ stats-report CLI writes JSON+markdown ...
      ✖ stats-report CLI refuses a directory without results.jsonl
      ℹ tests 26 / ℹ pass 23 / ℹ fail 3   EXIT=1
    GREEN:
      ✔ stats-report CLI writes JSON+markdown with Wilson, bootstrap, Holm
        and verdict
      ✔ stats-report CLI refuses a directory without results.jsonl
      ℹ tests 26 / ℹ pass 26 / ℹ fail 0 / ℹ skipped 0   EXIT=0
    REFERENCE RUN (required verification):
      $ node scripts/stats-report.mjs docs/reference-run
      run: E:\myzcode\vigil\docs\reference-run
      scoreable cells: 13 / 55 (42 infrastructure errors excluded)
        gemini-3-flash-preview: 4/13 = 30.8%  Wilson [12.7%, 57.6%]  bootstrap [7.7%, 53.8%]
      pairwise: skipped (need >= 2 models with scoreable cells)
      required n per group for a 30pp effect at 80% power: 42
      achieved n: 13
      power at achieved n: 0.329
      verdict: underpowered
      note: this run cannot distinguish a 30pp difference from noise.
      wrote ...\docs\reference-run\stats-report.json
      wrote ...\docs\reference-run\stats-report.md
      EXIT=0
  commit:  1437e33 (HEAD; working tree)
  notes:   |
    - The CLI reports what the data cannot say, not just point estimates:
      42/55 rows are infra errors; qwen3.8-max (20 attempts) and
      deepseek-v4-flash (19) have ZERO scoreable cells, so no cross-model
      comparison exists in the reference run. Pairwise section says so.
    - The bootstrap seed is FNV-1a of model/pair id, so reruns reproduce the
      same bounds without a seed file. Second invocation compared equal.
    - The markdown power section states the unflattering conclusion in plain
      language; the verdict appears in JSON, markdown and stdout.
    - Smoke-tested on a real two-model run (runs/rush-v7 copied to tmp, then
      deleted): deepseek-v4-flash 2/2=100% vs gemini 4/14=28.6%,
      delta 71.4pp, raw p=0.0510, Holm=0.0510, not significant, achieved
      n=2 -> underpowered. A perfect 2/2 sample is explicitly refused.
    - Win rate excludes status error/truncated (never scored as losses), same
      rule as stats/aggregate.mjs.
    - CONFLICT (cross-slice, unresolved): docs/reference-run is a sealed
      bundle checked by scripts/verify.mjs, which fails on ANY unlisted file.
      The required sidecars make it fail:
        $ node scripts/verify.mjs docs/reference-run
        FAIL manifest
          unlisted file: stats-report.json
          unlisted file: stats-report.md
        PASS protocol / PASS numbers / VERIFY: FAIL (1 checks)
      A concurrent agent deleted the two sidecars once to restore the sealed
      bundle, and the full suite's reproduce test then failed on unrelated
      stale docs/discrimination.json instead. The CLI now prints an explicit
      warning when the target run has MANIFEST.sha256. Resolution belongs to
      the docs/bundle owner: either refresh the manifest with
      `node scripts/verify.mjs docs/reference-run --write` (note: this also
      rewrites report.json's generatedAt) or keep stats sidecars outside the
      sealed bundle (e.g. a sibling directory / --out-dir).
    - Full-suite result at verification time: 140 tests, 139 pass, 1 fail.
      The fail is scripts/reproduce.mjs (another agent's slice): manifest
      unlisted-file caused by the required sidecars, plus a pre-existing
      discrimination fixture mismatch (committed has 2 models, reference run
      re-derives 1). All 28 stats tests pass; no stats code is implicated.

SLICE S5: judge methodology namespace (overclaim containment)
  files:   stats/judge.mjs (new), stats/index.mjs (comments only),
           test/stats.test.mjs
  test:    node --test test/stats.test.mjs
  output:  |
    RED:
      Error [ERR_MODULE_NOT_FOUND]: Cannot find module
      'E:\myzcode\vigil\stats\judge.mjs' imported from ...test\stats.test.mjs
      ℹ pass 0 / ℹ fail 1   EXIT=1
    GREEN:
      ✔ judge metrics are namespaced as methodology, not scoring
      ℹ tests 27 / ℹ pass 27 / ℹ fail 0 / ℹ skipped 0   EXIT=0
  commit:  1437e33 (HEAD; working tree)
  notes:   |
    - Header states plainly: no runner/cluster/aggregate/report calls these;
      no number in docs/ is computed from them; the only caller is the test.
      They live under Object.freeze({kappa, positionBias, verbosityBias}).
    - `ari` does not exist anywhere in the repo (grep: no adjusted Rand
      index, no ari symbol outside unrelated words). judge.mjs says so instead
      of shipping a fake implementation. Nothing deleted from stats/index.mjs.
    - This does not rewrite any docs claim; it makes the code stop implying a
      judge pipeline exists. Whether docs overclaim remains a docs-owner call.

VERIFY (final):
  $ node --test test/stats.test.mjs
    ℹ tests 28 / ℹ pass 28 / ℹ fail 0 / ℹ skipped 0   EXIT=0
  $ node scripts/stats-report.mjs docs/reference-run
    verdict: underpowered                              EXIT=0
    (stats-report.json and stats-report.md written inside the run dir; this
     intentionally trips scripts/verify.mjs manifest check — see S4 conflict)
  $ node scripts/verify.mjs docs/reference-run
    FAIL manifest: unlisted file stats-report.json / stats-report.md
    PASS protocol / PASS numbers                       EXIT=1
  $ node --test "test/*.test.mjs"
    ℹ tests 140 / ℹ pass 139 / ℹ fail 1               EXIT=1
    only fail: scripts/reproduce.mjs (manifest sidecars + stale
    docs/discrimination.json); 28/28 stats tests pass
