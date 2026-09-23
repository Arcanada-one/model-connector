# A2-209 — live DeepSeek probe (the ground truth this change rests on)

Measured 2026-09-23 from arcana-devs against `https://api.deepseek.com` with the
operator key from `config/credentials/mc-dev.env` (`DEEPSEEK_API_KEY`). The key was
sourced into the environment and never printed, logged or committed; only its length
was ever echoed.

## `GET /models` — the served catalogue

HTTP 200. Exactly two entries:

| id | name | context | max output | input modalities | effort levels |
|----|------|---------|-----------|------------------|---------------|
| `deepseek-flash` | DeepSeek-V4.1-Flash | 1 048 576 | 393 216 | text, image | low / high / **max**, default `high` |
| `deepseek-v4-pro` | DeepSeek-V4-Pro | 1 048 576 | 393 216 | text | low / high / max, default `high` |

Neither listing carries a price, which is why the curated price map (A2-201) still exists.

## Unknown id

`model: "deepseek-pro"` → HTTP 200 body with an error envelope:

```
"The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed deepseek-pro."
type=invalid_request_error  code=invalid_request_error
```

## Alias behaviour — identical prompt and `max_tokens`

Prompt `"What is 17*23? Answer with the number only."`, `max_tokens: 200`:

| requested | served (`response.model`) | `reasoning_tokens` | `reasoning_content` | in `/models` |
|-----------|---------------------------|--------------------|---------------------|--------------|
| `deepseek-chat` | `deepseek-flash` | (absent) | no | no |
| `deepseek-reasoner` | `deepseek-flash` | 17 | yes | no |
| `deepseek-v4-flash` | `deepseek-flash` | 18 | yes | no |
| `deepseek-flash` | `deepseek-flash` | 19 | yes | **yes** |
| `deepseek-v4-pro` | `deepseek-v4-pro` | 8 | yes | **yes** |

Two conclusions the code depends on:

1. **The three retired/undocumented ids all succeed**, served as `deepseek-flash`. So
   the defect was never a failure — it was an invisible substitution.
2. **They are not equivalent to each other.** `deepseek-chat` is the only one that
   yields NON-reasoning flash, and `deepseek-flash` has no `effort: off` to reproduce
   it with. This is why the connector passes retired ids through verbatim instead of
   resolving them locally: a local rewrite of `deepseek-chat` → `deepseek-flash` would
   silently convert a caller's non-reasoning request into a billed reasoning one.

## Sampling parameters

`model: "deepseek-reasoner"` plus `temperature: 0.2`, `top_p: 0.8`,
`presence_penalty: 0.1`, `frequency_penalty: 0.1` → **HTTP 200**, served by
`deepseek-flash`, reasoning intact. Same four accepted on `deepseek-flash` and
`deepseek-v4-pro` directly. The connector's suppression branch for that id was
therefore measured stale and removed.

**not_measured:** whether DeepSeek *honours* those parameters on an aliased request or
merely accepts them. Acceptance is what was measured; the rest is not claimed.

## Cost

9 chat probes, all `max_tokens` ≤ 200, on `deepseek-flash` ($0.30/$1.20 per 1M peak)
and one on `deepseek-v4-pro` — well under one US cent in total, against the card's
$0.20 ceiling. Requests were spaced with `sleep 3` so the route was not hammered.
