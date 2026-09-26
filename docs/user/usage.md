# Review usage

Open **Usage** from the sidebar or the command palette, or press `mod+u` on web and
desktop when the terminal is not focused. Customize `usage.open` in
**Settings → Keybindings**.

Use the Usage page to understand which providers and models are doing the work,
compare activity over time, and estimate the token cost of recent project work.
It is an activity view, not an invoice.

## Understand your usage

The Usage page combines Codex, Claude Code, Grok Build, OpenCode, Antigravity, and
Cursor activity from your connected environments. It reads each provider's own
history and shows API-equivalent token cost, processed tokens, cache savings,
provider shares, and model breakdowns. Subscription billing is separate from the
raw token cost shown here.

The scan happens inside each connected environment. Raw transcript records stay there; only
summarized time, provider, model, token, and cost totals—plus whether each
source could be read—are sent to the client.
This page is separate from Scient product analytics and telemetry, and it does not query a provider
billing API unless you explicitly connect one under **Provider billing**.

Cost is an estimate with explicit provenance. A saved custom price takes precedence. Otherwise,
Scient uses a cost reported in the transcript when one exists, or prices a recognized model with
the public LiteLLM model rate table. Tokens from
an unrecognized model remain in token totals but add no estimated cost. Scient refreshes the rate
table at most daily and can use its cached copy offline; without either copy, affected records are
shown as unpriced rather than guessed.

OpenCode reads its SQLite database and older JSON history. Antigravity reads local conversation
databases, including Scient-managed profiles. Set `OPENCODE_DATA_DIR` or `ANTIGRAVITY_DATA_DIR` on
the server to read a different data directory; comma-separated paths read multiple directories.

Cursor reads account usage from Cursor's dashboard API using the CLI login saved on the server.
This includes headless Scient sessions and desktop usage across machines; the same account counts
once across connected environments. Without an accessible CLI login, Scient shows a
notice instead of incomplete local totals. Scient does not estimate missing tokens from
conversation text. On macOS, Cursor account usage is enabled by default when this setting is
unset, so Scient can read the existing CLI login from Keychain when needed. macOS may ask you to
allow access on the server Mac. You can turn this off in **Settings → Providers → Usage
providers**; an existing explicit opt-out remains off.

Usage includes each configured account's history, including disabled accounts. Custom homes follow
the account's home setting or its `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, or `GROK_HOME` environment
variable. Use absolute paths or `~/` paths in the account's environment settings; relative
environment paths depend on each project's working directory and cannot be reliably discovered
by Usage. Accounts sharing a history directory count once.

On web and desktop, use the environment dropdown to filter costs, tokens, and limits. All
environments are selected by default. The dropdown shows which environments are still scanning;
results appear as each one responds.

A Grok turn appears only after the provider writes a completed usage record.
Unfinished turns may not appear.

## Review OpenRouter spend

Open **Settings → Providers → Provider billing → Connect OpenRouter** on the environment that
should hold the credential. Enter an OpenRouter management key, not an inference API key. The key
is stored in that environment's secret store, redacted from settings returned to clients, and used
by Scient only for OpenRouter's read-only key, credits, workspace, and analytics endpoints. A
management key can carry administrative privileges outside Scient, so treat it as sensitive and
prefer an expiration and regular rotation.

**Usage → Spend** shows OpenRouter's authoritative charges by API key and model for the selected
window: requests, total/prompt/completion/reasoning/cached tokens, total spend, credits and BYOK
spend, and upstream/cache/data/web cost components. It discovers personal and organization
workspaces and includes disabled keys with historical activity. OpenRouter reports billing days in
UTC. A truncated or partly failed sync is called out instead of silently presenting an incomplete
total; when a later sync fails, the last successful local ledger remains visible as cached data.

Scient continues to retain local pi transcript usage for future reconciliation, but it is not shown
in the Spend view. Its locally calculated cost is never added to OpenRouter's provider-billed total.

## Set custom model prices

On web or desktop, open the environment dropdown on **Usage**, then choose **Model prices** to add,
edit, or reset a model's estimated price. **Apply to** starts with your current Usage filter;
choose all environments or select individual destinations. Enter the exact model ID and USD
rates per million input and output tokens. You can enter any model ID, including models
without public pricing.

Cache read and cache write rates are optional and use the input rate when blank. Enter `0` for
tokens that are free. Saved prices replace automatic pricing for all of that environment's
history and are shared with clients connected to it. When environments have different prices,
cells show **Mixed**. Edit rates directly in the table, then choose **Save changes** to apply all
edited rows. Untouched cells keep each environment's rate. Select one environment to inspect its
prices. **Reset to automatic** marks a model's override for removal when you save; you can undo
it before saving.

Each destination reports whether the change saved. Offline or unavailable environments are
marked **Not saved**. Reconnect them and choose **Retry failed saves** to finish the same change
without writing again to environments that already saved. Changes are not queued after you close
the dialog.

## Check subscription limits

**Usage → Limits** pools every subscription account it can see per provider, so with several Codex
or Claude accounts across your environments and hubs you read one number per window rather than a
list. Each window card shows how much of the pool is left and a bar with one segment per account,
kept in the same column across windows. Accounts are ordered by their 5-hour reset, soonest
first, or by the first available window when no account reports a 5-hour limit. A gap means the
account does not report that window. When the provider reports reset times, the card also says
when the next reset lands and how much it hands back. The hatched
part of a segment is what that reset restores. Tap a segment or account row for the account's plan,
where it is signed in, and its reset time. On web, you can hover too. Codex and Claude accounts
with banked reset credits show a ticket count and the **Use reset** action in the account details.
Claude resets are not available when the server runs on macOS, where Claude keeps its login in the
Keychain. On narrow screens, numbered rows below
the bar show each account's quota, countdown, and credits. Tap a row to open its details.

The same account signed in on more than one environment, or reported by a hub as well, counts once.
Filter with the environment dropdown to see what a single machine has.

Opening Limits checks the selected connected environments automatically. Each client waits at
least five minutes between automatic checks of an environment, including after a failed check.
If a window still looks stale, refresh Limits to re-check every provider and hub.

Pick `/usage-limits` from the composer's command menu, or send it as a message, to check the
current model's limits without leaving the conversation. The result opens above the composer and
closes when you dismiss it or send your next message. It uses the same snapshot as **Usage → Limits**, so it does not run the agent or refresh
anything. The command is offered only for providers that appear under **Usage → Limits**.

OpenCode Go reports its session, weekly, and monthly allowance when OpenCode runs locally in
the environment. Scient cannot report limits for external OpenCode servers because their credentials
belong to the remote server. Cursor reports
its monthly allowance, including separate Auto and API usage, using the CLI login or
`CURSOR_AUTH_TOKEN`. On macOS, this includes the default Keychain login unless Cursor account
usage has been turned off. Keychain login is used for limits only with Cursor's default API
endpoint. If you configure a custom Cursor endpoint, use an explicit token or file-based CLI
login for limits.

Grok reports the remaining subscription allowance and reset time for its current billing period
after signing in with `grok login`. Explicit `XAI_API_KEY` connections and custom authentication
or endpoint configurations do not report subscription limits.

API-key accounts may not report subscription limits. This also applies to Claude connections
using a proxy through `ANTHROPIC_AUTH_TOKEN`.

## Connect a CLIProxyAPI hub

To see pooled accounts, open **Settings → Providers → Usage providers → Add hub**. Choose the
environment that will connect to the hub and enter its URL and management key.

The accounts appear under **Usage → Limits**. Codex accounts show banked reset credits; select an
account and choose **Use reset** to redeem one. No hub plugin is required.

This connection supplies usage information; configure
the provider separately to send agent requests through the hub. Remove the hub from the same
settings section when you no longer need it.

If a directly connected provider reports limits for the same provider and email, its row replaces
the hub copy and retains details such as banked reset credits. The hub remains visible when the
provider cannot report limits. Management keys stay on the server and are not returned to clients.
Account emails follow your privacy setting.

Use **Past 24h** for an hourly chart covering the exact rolling 24-hour period. The **7 days**,
**30 days**, and **90 days** ranges use daily resolution. Cost and token toggles update both the
headline and chart. Refreshing rescans every connected environment and refetches model pricing on
each of them, so a newly released model that showed $0.00 gets a price without waiting for the daily
pricing update.

## Subscription usage widget

Add **Subscription usage** from your iOS or Android widget gallery to see remaining Codex and
Claude quotas. Tap it to open **Usage → Limits**. On iOS, use **Edit Widget** to choose Session,
Weekly, or both for each provider. Reopen the retained mobile client to refresh
expired readings. The Android widget requires Android 12L or later.

## Keyboard shortcuts

On web and desktop, open Usage from the command palette. While on Usage,
press `C`, `T`, or `L` for Cost, Tokens, or Limits while not typing in a field.
Use `Ctrl+Shift+1/2/3/4` (`Cmd+Shift+1/2/3/4` on macOS) for the past
24 hours, 7 days, 30 days, or 90 days. Period shortcuts do nothing on Limits.
Press `Escape` to return to the previous page. Customize these shortcuts in
**Settings → Keybindings**.
