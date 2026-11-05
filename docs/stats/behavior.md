# Behavioural signature

Run: `./docs/preliminary-run` · 12/24 scoreable cells

| model | outcome | n | turns | legal moves | illegal | noop | waste | efficiency |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| agent2api/auto | wins | 8 | 13.4 | 9.6 | 0.0 | 0.0 | 0% | 1.13x |
| agent2api/auto | losses | 2 | 32.0 | 5.0 | 0.0 | 0.0 | 0% | 0.51x |
| glm-5.3-flash | wins | 2 | 13.5 | 11.0 | 0.0 | 0.0 | 0% | 1.20x |
| glm-5.3-flash | losses | 0 | — | — | — | — | — | —x |

`waste` = (noop + illegal)/turns. `efficiency` = legalMoves/optimalDepth (1.0 = shortest path).
Both are computed from the action log, not from the `neglected` label — that label is
near-tautological for a single terminal constraint and is deliberately not used here.
