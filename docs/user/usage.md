# Review usage

The Usage page combines Codex, Claude Code, and Grok Build activity from your connected
environments. It reads the providers' local session history and shows API-equivalent token cost,
processed tokens, cache savings, provider shares, and model breakdowns. Subscription billing is
separate from the raw token cost shown here.

The scan happens inside each connected environment. Raw transcript records stay there; only
pre-aggregated time, provider, model, token, cost, and source-health buckets are sent to the client.
This page is separate from Scient product analytics and telemetry, and it does not query a provider
billing API.

Cost is an estimate with explicit provenance. Scient uses a cost reported in the transcript when one
exists. Otherwise it prices a recognized model with the public LiteLLM model rate table. Tokens from
an unrecognized model remain in token totals but add no estimated cost. Scient refreshes the rate
table at most daily and can use its cached copy offline; without either copy, affected records are
shown as unpriced rather than guessed.

Grok Build totals come from persisted session updates. Interactive turns that never wrote a
completed-turn record will not appear.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart, and refreshing rescans every connected environment.
