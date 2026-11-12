# Bring your own model

Score your own agent on VIGIL without editing a line of source.

> Why this page exists: an external tester (2026-11-13) reported that pointing
> VIGIL at a custom endpoint required editing `providers/registry.mjs` **and**
> `providers/ledger.mjs`, and that an unlisted model name was rejected outright.
> Both are fixed: channels and prices can now come from the environment.

## 1. Point it at any OpenAI- or Anthropic-compatible endpoint

```bash
export VIGIL_BASE_URL=https://my.endpoint/v1     # or http://127.0.0.1:8099/v1
export VIGIL_MODELS=my-model                     # comma-separated for several
export VIGIL_API_KEY=sk-...                      # omit with VIGIL_ALLOW_NO_KEY=1
export VIGIL_PROTOCOL=openai                     # or anthropic (default openai)
export VIGIL_MAX_TOKENS=16384                    # thinking models need headroom
export VIGIL_PRICE_IN=0.3                        # USD per 1M input tokens
export VIGIL_PRICE_OUT=0.5                       # USD per 1M output tokens
```

Then run one cell:

```bash
node runner.mjs --family rush --models custom:my-model --limit 1 --reps 1 --budget-usd 1
```

The channel id is `custom` unless you set `VIGIL_CHANNEL_ID`. A local endpoint
with no auth works with `VIGIL_ALLOW_NO_KEY=1`.

**Minimum viable fake endpoint** (useful before wiring a real model — it proves
the plumbing, and it is what the external tester used):

```js
import http from 'node:http';
http.createServer((req, res) => {
  req.on('data', () => {});
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      model: 'my-model',
      choices: [{ index: 0, message: { role: 'assistant', content: '{"action":{"type":"noop"}}' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 120, completion_tokens: 12 },
    }));
  });
}).listen(8099, '127.0.0.1');
```

Run it, then the command above with `VIGIL_BASE_URL=http://127.0.0.1:8099/v1`.
Expected: `1/1 cells · 0 errors`, and a row in `<out>/results.jsonl`.
A `noop`-only policy ends `status: "turn_cap"`, which is **scoreable** — exactly
what you want from a plumbing test.

## 2. Pricing

Cost accounting is integer micro-USD and refuses to guess: an unpriced model is
blocked before the first call. Supply prices in USD per 1M tokens.

| env | meaning |
| --- | --- |
| `VIGIL_PRICE_IN` / `VIGIL_PRICE_OUT` | one pair for this run |
| `VIGIL_PRICE_<MODEL>_IN` / `_OUT` | per model; name upper-cased, non-alphanumerics → `_` |

Built-in list rates live in `providers/ledger.mjs` (`PRICES`). Operator prices
are tagged `source: "operator"` so a cost comparison cannot silently mix list
rates with estimates.

## 3. Offline scoring (no live calls)

There is no shipped "score an action log" entry point yet. Two supported routes:

- **Module API.** Import `runCell` from `runner.mjs` and pass your own
  `channel` object plus an in-process `Ledger`. This is what the fake-endpoint
  test above uses under the hood, and it needs no source edit.
- **Row injection.** Write `results.jsonl` rows containing the engine's
  `terminal`, `profile` and `records` fields, then score them with
  `node scripts/verify.mjs <dir> --write` and `node scripts/discrimination.mjs <dir>`.

A `--replay <actions.jsonl>` mode is on the roadmap; until then, if you have a
Python agent, wrap it as an HTTP endpoint (step 1) rather than porting it.

## 4. What "scoreable" means

One **cell** = one `(task, model, repetition)`. A cell is scoreable if it ends
`completed` or `turn_cap`. Everything else — `error` (HTTP failure), `truncated`
(output cap hit), `protocol_error` (empty replies) — is an infrastructure
failure and is **excluded** from the capability profile, never counted as a
wrong answer. That is deliberate: it is the same rule SoTALab's `rst-hle`
describes, and it is why a `403`-heavy run reports few scoreable cells instead
of a low score.
