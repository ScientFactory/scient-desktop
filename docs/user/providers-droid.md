# Droid (Factory) in Scient

[Droid](https://factory.ai) is Factory's agent for working with project files,
code, and commands. Scient connects to the official `droid` tool and shows its
responses, tool calls, file edits, and nested Tasks in the thread.

Its provider-specific behaviors and current limitations are documented below.

For the behavior shared by all assisted providers, see [Providers in Scient](./providers.md).

## Setup and account connection

The local desktop app can install a qualified Droid runtime privately for Scient. A custom binary
path or a healthy system installation is preserved and used as-is; Scient never replaces or removes
it. Repair and removal appear only when the runtime is Scient-owned. Beside a healthy system
`droid`, Settings and Droid's **Manage** dialog offer **Use Scient-managed**, which installs
Scient's private copy and leaves the system installation in place. Droid updates itself often, so
your own `droid` is usually newer than the release Scient has qualified. The option stays available:
Scient shows both versions, says that the managed one is older, and switches only when you confirm.
With several Droid instances that use different `PATH` settings, only the instance you act on is
checked; see [Providers in Scient](./providers.md#existing-and-scient-managed-installations).

Droid supports two existing-account modes:

- **Factory account pairing** (default): choose **Sign in with Factory**. Droid opens its secure
  browser flow itself. Factory owns the browser, callback, and credential store; Scient receives no
  password or token and does not invent or parse a sign-in URL.
- **`FACTORY_API_KEY`** (advanced): when this environment variable is set, either in the environment
  Scient starts with or under **Environment** in Droid's settings, Droid uses it directly. The key
  is passed to the CLI only, and Scient's Droid screens never display it; under **Environment**,
  mark the variable as sensitive so its value is stored separately and hidden. Interactive account
  actions are hidden because they cannot manage an environment-owned key.

You can still point Scient at an existing binary under **Settings > Providers > Droid > Binary
path**. With no custom path, Scient preserves a healthy `droid` found on the app's `PATH`; otherwise
it can offer the qualified app-private runtime.

## Enabling Droid

1. Open **Settings > Providers** and enable **Droid**, or pick Droid from the composer's provider
   rail.
2. If Droid is missing, choose **Install**. The download starts right away, and Scient verifies and
   tests the release before using it.
3. Choose **Sign in with Factory**, finish the provider-opened browser flow, and wait for Scient to
   verify the connected account.
4. When Droid reports **Ready**, pick a model and start a thread.

If you signed in to Droid outside Scient, for example by running `droid` in a terminal, choose
**Check again** next to **Sign in with Factory** (in the composer or in Settings). Scient then runs
one full status check and picks up the account; it does not notice an outside sign-in on its own.

Repair downloads and verifies the latest qualified release (or the installed one, when that is
newer) before atomically replacing Scient's managed runtime, so Repair can also bring a newer
release. A newer qualified stable release is offered as Update as well. Remove deletes only that
app-private copy. None of these actions changes Factory credentials, custom paths, or system
installations. Scient asks for a decision first in two cases only: **Remove** and **Use
Scient-managed**. In Settings and in the **Manage** dialog the switch always shows both releases
first. Where a failed Droid setup offers **Use Scient-managed Droid** under its runtime diagnostics,
the install starts right away when Scient's release is the same or newer; when it is older, or when
your `droid` reports no version Scient can read (the decision then says "system version unknown"),
Scient shows it there too, with **Back** and **Use Scient-managed**. **Sign out** appears only if
the exact running Droid version advertises ACP logout. When it does not, Scient hides the action
instead of offering an unreliable terminal-automation fallback.

## Models and reasoning effort

To use your own API key or local endpoint, open **Settings > Custom models**, add the model,
and select **Droid** under **Use with**. A new model starts selected for your enabled agents;
**Connect models** in Droid setup opens the same flow with only Droid selected.
Reuse a saved connection to add another model without entering its key again. Your Factory
account connection and model-service credentials are separate.

Automatic settings use verified limits when available and otherwise leave Droid's optional limits at
its own defaults. These are not unlimited. Use manual settings for a specific endpoint capacity.
**Test** sends a small request through the agent you choose among the enabled ones the model is used
with, and says which agent answered or failed, and why (for an endpoint Scient cannot connect to,
the reason below; after 45 seconds without an answer, that it got none); API charges may apply.
Droid lists every model Scient gives it, so a model marked as not available to Droid means Droid's
list predates a change: use **Check again** to refresh it. When a connection's saved key is missing
or can no longer be used, its models say **Saved key missing — re-enter it**; **Re-enter key** opens
the connection to enter it again (Check again cannot help there). Droid cannot use a key that
contains a space, a tab or another control character: saving such a key for a model used with Droid
is refused, and a key saved earlier for Pi or Oh My Pi, which use it as it is, shows that state for
Droid only.

Removing a loaded model or replacing its key stops affected agent processes; the next message
reconnects. A reply running at that moment stops with a notice saying so. Adding a model does not
interrupt a running reply. A thread whose custom model was removed, is no longer selected for Droid
under **Use with**, or whose saved key is missing says which of these it is when you send; a Factory
model Droid no longer offers says so too. Pick another model or fix the connection. When a custom
model's service answers with a rate limit (429) or a server error, Droid retries it on its own for
up to a few minutes without showing anything, so Scient adds a notice that it is retrying. When
Scient cannot connect to the endpoint at all, the turn ends at once with the reason, for example
"Scient could not connect to localhost:11434: connection refused." for a local server that is not
running; an unknown host, an untrusted TLS certificate, a connection that is not established within
15 seconds and an endpoint that does not answer are named the same way. Scient does not modify your
personal Factory settings or import their credentials.

Scient makes the requests to your endpoint in Droid's place, with the proxy settings (`HTTP_PROXY`,
`HTTPS_PROXY`, `NO_PROXY`) and the certificate authorities of the Droid instance's **Environment**:
a company gateway signed by a private CA works once `NODE_EXTRA_CA_CERTS` (or `SSL_CERT_FILE`) names
the CA file there, as it does for Droid itself; if that file cannot be read, the certificate error
says so. Scient never switches certificate verification off for these requests, so
`NODE_TLS_REJECT_UNAUTHORIZED=0` has no effect on them; add the CA instead.

Droid uploads each conversation's messages and title to your Factory account, also when it runs your
own custom model, unless you turned that off in Droid itself. **Sync conversations to Factory** in
Droid's settings in Scient is on by default, and on means that Droid's own setting decides: Scient
changes nothing, so sync you turned off in Droid stays off. Turn the switch off to have Scient stop
Droid from syncing, whatever Droid's own setting says; conversations still resume. Droid then still
sends Factory a usage record for each custom-model request: the model ID, token counts, the session
ID and the address of Scient's local relay (not your endpoint's address or key). The switch applies
to the Droid processes Scient starts, not to Droid used elsewhere.

Scient never gives Droid the API keys you save in Scient: it passes each request on to the model
service and adds the key itself, so the key is not in Droid's settings, environment or command line,
and a command the agent runs cannot print it from there. Like any program running under your user
account, though, Droid could open the files where Scient stores keys (its Read tool needs no
permission), so this does not protect keys from an agent that goes looking for them. If the service
answers with an error that contains your key, Droid shows a Scient notice with the error's status
instead of the message. A very short key, such as a local server's placeholder, can also hide an
unrelated error message; leave the key empty if the server needs none. If a custom model keeps
stopping at its output limit and Droid keeps asking it to continue, Scient ends the turn after five
such responses in a row (or 1,000 model requests in one turn) and says so; the partial answer stays.
This stops a runaway loop of requests. It is not a spending limit: it does not bound tokens or cost,
a single request can be expensive, and Factory-hosted models are not covered at all.

At the start of each new Droid session, Droid itself makes one extra small request to title the
session in its own session list: it sends your first message and asks for a short title (32 output
tokens, plus the reasoning budget when reasoning is on). With a custom model selected this request
goes to your endpoint and may be charged; it is separate from Scient's own thread titles.

Thread titles, commit messages, PR text and branch names generated with Droid run without tools:
custom models are offered none, and Droid refuses every tool call before it runs, including reads
and your own MCP servers' tools. Droid still lists its tools to Factory-hosted models; it has no way
to withhold them in this mode. Scient also sets Droid's `normal` autonomy and declines every
permission request, which stops commands and edits. The refusal is a Droid tool hook (Scient's tool
guard). It was verified on macOS. On Windows it is unverified: if Droid does not run the hooks
there, Scient cannot confirm the guard and refuses, as below. An organization policy that allows
only managed hooks removes it, and Droid would then run a model's tool calls: its Read tool asks no
permission, so any file you can read could be read. So Droid background generation runs only when
Scient has confirmed the guard, for every model, custom or Factory-hosted. Scient checks Droid's
policy files and settings, and whether Droid ran Scient's hooks when the session started. When a
policy disables the guard, or Scient cannot rule one out, it says so and generates nothing with
Droid: choose another provider for titles and commit messages in Settings. **Test** under **Custom
models** generates a title through the agent you pick, so through Droid it is refused the same way.
Scient cannot see a policy that Factory's servers deliver slowly the first time Droid starts, or one
changed while a title is being generated.

When Droid generates these texts and you have not picked a model for them (for example, Droid is
the only provider you use), Scient picks the cheapest one: the model with the lowest Factory token
rate Droid reports (the `0.08×` label), deprecated models aside, at the lowest reasoning level
that model takes. If Droid reports no rates, its own default model and level are used. A model
you choose for these texts in Settings is always used instead, at the level you set.

Droid reports its available models and reasoning-effort choices to Scient. You can change either
within an existing thread; the change applies before the next message. Scient's default Droid model
is the one Droid itself starts a session with. A model may also show the Factory token-cost label
reported by Droid, such as `0.5×`.

Models defined in your own Factory settings (`custom:` models Scient did not add) follow the same
live-capability rule: Scient shows the reasoning-effort ladder Droid advertises for them.

A model you add under **Custom models** has a reasoning choice in Droid only when its reasoning
levels are known, from the service's model information or set in the model's advanced settings.
Droid applies no reasoning to a model without them (every choice has no effect), so Scient shows no
reasoning control for it and the model runs without reasoning parameters. When the levels are
known, Droid offers Low, Medium and High (those the model has). For OpenAI-format models it offers
one more: the model's default level, which is the one you pick under **Reasoning** in its advanced
settings, or the service's default. So Extra-high, Minimal or Max is available in those Droid
threads only as that default, and Off is not offered: Droid would only leave the setting out (the
model's own default). For Anthropic Messages models Droid decides by the model ID. For the Claude
models it knows as adaptive (Opus 4.6 to 4.8, Sonnet 4.6, Opus 5, Sonnet 5 and Fable 5) it also
offers Max, Extra-high from Opus 4.7 on, and **Off**, which turns thinking off. For any other model
ID Droid uses a thinking budget for Low, Medium and High and sends nothing for another level, so
only those three are offered. The model editor says which levels Droid offers. For a model used
only with Droid it offers only the default levels Droid applies; when the model is also used with
Pi or Oh My Pi, their levels stay available and the editor says which level Droid uses instead.
Scient sets the default level explicitly when a thread starts or switches to the model, because
Droid would otherwise keep the previous model's level; changing the default takes effect at the
next message. If a level you chose earlier is no longer offered for the model (for example, its
configured default changed), the composer falls back to the model's default level and shows it.

For an OpenAI-format model whose model ID Droid knows from its own catalog, Droid keeps its own
levels and may run another level than the default you configured (`gpt-5.2` set to Minimal or Max
runs at Low). The thread and background text generation then run at Droid's level: Scient offers
that level as the default instead of the one Droid replaced, and a thread that still asks for the
configured default says "Droid uses Low for this model instead of the configured default Minimal"
when it applies that level (at the thread's start, a model switch, or a resume). This holds for
the configured default however the thread asks for it, including when you pick that same level
yourself. Any other level you pick in the thread must be applied as asked: if Droid applies
another one, the message is not sent and the error names both.

## Autonomy modes

Scient's permission modes map onto Droid's graduated autonomy ladder:

| Scient mode       | Droid autonomy |
| ----------------- | -------------- |
| Approval required | `normal`       |
| Auto-accept edits | `auto-low`     |
| Auto              | `auto-medium`  |
| Full access       | `auto-high`    |

Before every message Scient checks the level Droid reports and sets it again when it differs, so
a changed mode takes effect on the next message. Droid itself leaves Plan (`spec`) once you approve
a plan; the next message in Plan mode returns it to `spec`. If Droid does not offer or confirm the
level, the message is not sent and Scient says why. Approving a plan is always your decision, also
in Full access.

## Behavior notes and limitations

- **Checkpoints / rollback is not supported.** Droid's ACP surface does not expose a revert
  operation, so the rollback action is unavailable in Droid threads.
- **Follow-ups during a turn** become the next prompt of the same turn. Droid's protocol has one
  way to do that: stop the current step and send the message, after which Droid sees the earlier
  request as interrupted and continues from your message. (Droid would also accept a second
  prompt without stopping the first, but then it answers both at once and mixes their output, so
  Scient does not use that.) Stopping a step also ends what it has running, so the moment depends
  on what Droid is doing. While Droid is only writing, the follow-up is delivered at once. While a
  command, another tool call or a sub-agent of the turn is still running, the follow-up waits and
  the thread says "Your message will be delivered when the current step finishes. Stop interrupts
  now." Scient delivers it as soon as that work is done, or when Droid finishes the step by
  itself, whichever comes first. A background sub-agent counts until Droid reports it finished. A
  newer follow-up takes the place of one that is waiting.
- **Stop** ends the turn and keeps what Droid had produced: Scient cancels the step, takes what
  Droid still sends for it (the answer so far and the final state of a running command; Droid
  answers within a fraction of a second and Scient waits two seconds at most), then closes that
  Droid process. A command Droid does not report on by then shows as failed rather than as still
  running. The next message resumes the conversation in a fresh one, and Droid tells the
  model that the previous request was interrupted. Stop never sends a waiting follow-up; the
  thread says that it was not delivered. A message stopped before it reached Droid starts no turn;
  a fork's or imported conversation's history is then sent with your next message.
- **Sub-agents** (Droid's Task tool) show as one row per turn, such as "Kicked off 2 subagents ·
  1 working · 1m 5s", that opens to each sub-agent with its description, type, state and how it
  ended. Droid reports a sub-agent's steps only when it finishes, so while it works the row shows
  that it is running and for how long, not what it is doing. When Droid runs a sub-agent in the
  background, the main agent's checks on it read "Checked sub-agent · …" and "Waiting for
  sub-agent · … (up to 10 min)". A background sub-agent Droid has not reported on when the turn
  ends shows as idle (stopped, in the mobile app), with that reason.
- **If Droid exits** unexpectedly, the running turn fails with Droid's error and the next message
  starts a fresh Droid process that resumes the conversation.
- **If Droid does not report a settings change** (model, reasoning effort or autonomy) within a
  few seconds, Scient no longer knows which settings Droid runs with. The message is not sent,
  Scient closes that Droid process (a running turn fails with the reason), and the next message
  resumes the conversation in a fresh one.
- **Failed turns** show Droid's reported error, such as a rate limit or a rejected key, instead of
  finishing silently. If the error, or what Droid writes about it in its answer, repeats a
  credential configured for this Droid (`FACTORY_API_KEY` or an environment value marked
  sensitive), Scient shows `[redacted]` in its place.
- **Structured questions** from Droid appear in Scient's normal user-input prompt and resume the
  turn after you answer.
- **Idle runs**: if Droid produces no activity for 10 minutes, Scient ends the turn as failed
  instead of leaving the thread running forever. Droid is silent while a sub-agent works, so the
  window is an hour while a sub-agent started in the turn is not known to have finished, and
  while the main agent waits for one without a time limit. A wait Droid announces with a time
  limit gets at least that limit plus a minute. Time spent waiting for your answer to a question
  or approval does not count.
- **Status checks**: a full check starts a Droid session, so Scient runs one only when Droid is
  enabled or its settings or binary change, when you refresh (opening **Usage → Limits** refreshes
  every provider), after sign-in, and to recover from a failed check (less often while it keeps
  failing). Choosing Droid in the composer for a project Scient has not checked yet also starts one
  session there, to list that project's skills. The periodic background check only runs
  `droid --version`: it notices a missing, broken or updated Droid, but not a sign-in, sign-out or
  key change made outside Scient, or new models and skills — refresh Droid in Settings for those,
  or choose **Check again** where Droid asks you to sign in. While Droid is signed out the same
  check keeps running and never starts a session: Scient shows the version that is installed
  now, or that Droid no longer runs.
  When Factory rejects your account during use, Droid shows as signed out until a check succeeds;
  Droid's own check accepts an invalid `FACTORY_API_KEY`, so a bad key only shows once a message
  fails.
- **If Droid can't start**: when a status check fails (Droid exits, refuses to start or does not
  answer in time), Scient shows **Droid couldn’t start** with the reason and **Try again**, which
  runs one full check. A Scient-managed runtime shows **Droid needs repair** with the same reason
  and offers **Try again** beside **Repair**, so a start that failed once does not need a
  download. A system installation with a newer release also offers **Update**. With `FACTORY_API_KEY`, a key Factory
  rejects shows as **Factory rejected the API key**: correct the key in Droid's environment and
  choose **Check again**. Scient does not suggest a subscription sign-in there, because it would
  not replace the environment's key.
- **Quota**: Droid usage draws on your Factory plan. If the CLI reports an out-of-quota or
  payment-required error, the turn fails with that message and you can retry after topping up or
  waiting for the quota window.
- **Runtime updates:** Scient can update recognized system package installations and standard
  macOS/Linux standalone installations when you choose **Update**. Other installations remain
  manual-only. Native update restrictions are respected. Repair and remove affect only Scient's
  app-private runtime.
  Native version checks use Factory's download release channel, not its changelog.
