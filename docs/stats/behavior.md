# Behavioural signature

Run: `./docs/powered-run` · 11/53 scoreable cells

| model | outcome | n | turns | legal moves | illegal | noop | waste | efficiency |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| apigoto-api-apigoto-com/deepseek-flash | wins | 11 | 15.9 | 8.8 | 0.0 | 0.0 | 0% | 1.00x |
| apigoto-api-apigoto-com/deepseek-flash | losses | 0 | — | — | — | — | — | —x |

`waste` = (noop + illegal)/turns. `efficiency` = legalMoves/optimalDepth (1.0 = shortest path).
Both are computed from the action log, not from the `neglected` label — that label is
near-tautological for a single terminal constraint and is deliberately not used here.
