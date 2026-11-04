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
