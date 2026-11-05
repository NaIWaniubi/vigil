// JUDGE METHODOLOGY — UTILITIES ONLY. THIS LAYER IS NOT IMPLEMENTED.
//
// `kappa`, `positionBias` and `verbosityBias` are intended for a blind
// LLM-judge duel pipeline: two anonymous answers, a judge picks a winner, then
// the evaluator checks for position bias, verbosity bias and agreement between
// judges.
//
// VIGIL has no such pipeline today:
//   - no runner, cluster run, aggregate or published report calls these
//     functions;
//   - no number in docs/ or any published run is computed from them;
//   - the only caller is test/stats.test.mjs, which exercises them directly.
//
// They are exported here under an explicit namespace so they cannot be mistaken
// for part of the model-scoring path. `ari` (adjusted Rand index), mentioned in
// the methodology notes, is NOT implemented anywhere in this repo; this file
// does not pretend otherwise.
//
// Nothing here should be cited as evidence of evaluator quality until a judge
// layer actually runs and its judgments are consumed by a report.

import { kappa, positionBias, verbosityBias } from './index.mjs';

export const judgeMethodology = Object.freeze({ kappa, positionBias, verbosityBias });