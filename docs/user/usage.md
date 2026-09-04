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

The **Limits** view shows how much of each subscription window you have used on Codex and Claude
Code, per connected environment: the session and weekly windows, plus a per-model weekly window
such as Fable when your plan has one. Each window is a bar from the moment it opened to its reset,
filled by the share of quota spent; a thin line marks how far into the window you are, which is
also where even spending would have put the fill, and the icon beside the label says whether you
are ahead of, on, or under that pace. Hover a bar for the exact reset time. Limits refresh on the
provider health-check interval and update live while a turn runs. API-key accounts have no
subscription windows and say so; that includes a Claude Code that reaches Anthropic through a proxy
via `ANTHROPIC_AUTH_TOKEN`, since the CLI then treats itself as an API-key client.

If you pool accounts behind a CLIProxyAPI hub, open **Settings → Providers → Usage providers**
and choose **Add hub**. Select the device that should connect to the hub; its accounts appear on
the Limits view. Remove hubs from the same settings section. Each limits row shows its provider
and instance name, or a small _CLI Proxy_ label for
hub accounts. When a connected provider reports limits for the same provider and email, its row
replaces the hub copy, keeping details such as banked reset credits. The hub copy remains visible
if the connected provider cannot report limits. Enter the hub's URL and management key; the key
is stored on the server and never sent back to a client. Emails are blurred until clicked, as in
provider settings.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart. Refreshing rescans every connected environment and refetches model pricing on
each of them, so a newly released model that showed $0.00 gets a price without waiting for the daily
pricing update.
