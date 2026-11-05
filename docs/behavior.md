# Behavioural signature

Run: `./docs/reference-run` · 13/55 scoreable cells

| model | outcome | n | turns | legal moves | illegal | noop | waste | efficiency |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gemini-3-flash-preview | wins | 4 | 21.3 | 14.0 | 1.5 | 0.5 | 9% | 1.77x |
| gemini-3-flash-preview | losses | 9 | 68.2 | 33.1 | 6.7 | 22.8 | 41% | 2.63x |

`waste` = (noop + illegal)/turns. `efficiency` = legalMoves/optimalDepth (1.0 = shortest path).
Both are computed from the action log, not from the `neglected` label — that label is
near-tautological for a single terminal constraint and is deliberately not used here.
