# Review usage

Use the Usage page to understand which providers and models are doing the work,
compare activity over time, and estimate the token cost of recent project work.
It is an activity view, not an invoice.

The Usage page combines Codex, Claude Code, and Grok Build activity from your connected
environments. It reads the providers' local session history and shows API-equivalent token cost,
processed tokens, cache savings, provider shares, and model breakdowns. Subscription billing is
separate from the raw token cost shown here.

The scan happens inside each connected environment. Raw transcript records stay there; only
summarized time, provider, model, token, and cost totals—plus whether each
source could be read—are sent to the client.
This page is separate from Scient product analytics and telemetry, and it does not query a provider
billing API.

Cost is an estimate with explicit provenance. Scient uses a cost reported in the transcript when one
exists. Otherwise it prices a recognized model with the public LiteLLM model rate table. Tokens from
an unrecognized model remain in token totals but add no estimated cost. Scient refreshes the rate
table at most daily and can use its cached copy offline; without either copy, affected records are
shown as unpriced rather than guessed.

A Grok turn appears only after the provider writes a completed usage record.
Unfinished turns may not appear.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart, and refreshing rescans every connected environment.
