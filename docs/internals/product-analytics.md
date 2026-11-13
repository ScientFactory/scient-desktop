# Scient product analytics boundary

Scient has a first-party analytics contract, outbox, worker, and privacy UI.
Recognized packaged release builds make the feature available through
`SCIENT_ANALYTICS_ENABLED=true`; development and unknown-channel builds stay
disabled. When available, analytics is on for everyone at `diagnostic` (usage,
reliability and delivery counters), like T3: there is no in-app switch, and a
preference saved by an older build no longer applies.
Native and WSL backend configuration receive the same bounded release metadata.
An explicit `SCIENT_ANALYTICS_ENABLED=false` is the off switch.
For isolated manual QA, `SCIENT_ANALYTICS_ENABLED=true` can turn analytics on
in a development candidate. Pair it with `SCIENT_ANALYTICS_TEST_ENDPOINT` set
to `http://127.0.0.1:<port>/v1/events` (or literal IPv6 loopback). Other hosts,
credentials, paths and query strings are rejected. Use only synthetic state;
never send development review traffic to the production gateway. This override
does not set consent, change released defaults or enable generic T3 telemetry.

This document describes the source implementation, not deployed collection or a
privacy approval. Release/activation evidence must refer to exact desktop and
gateway revisions. The cross-repository measurement meaning and policy are
owned by Scient's product-measurement plan; this repository owns these runtime
and instrumentation guarantees.

Like T3, Scient sends every event its code records; there is no list of event or property names.
[`contract.ts`](../../packages/scient-analytics/src/contract.ts) shapes each event: a Scient
normalizer decides the fields it reads (buckets, model keys, closed values), and every other field
passes through as recorded. [`wireContract.ts`](../../packages/scient-analytics/src/wireContract.ts)
then checks shape and privacy: an event name, at most 64 properties of strings up to 256
characters, finite numbers, booleans or arrays of up to 32 of those, 16 KiB in all, and no free-text
key (`prompt`, `message`, `error`, `path`, `url`, `email` and the like) or value that looks like a
path, link or email address. Revision 11 permits a validated `email` only on
`install.account_observed`; ordinary events retain the same exclusions.
Consent level is enforced before queueing, delivery uses only Scient's first-party gateway, and
failures cannot block normal product behavior.

The Settings privacy section, with its switch and “Delete data” request, was
removed, along with the server's consent and deletion routes.

The notification is implemented but disabled by default at its component boundary
pending an approved audience and timing policy. This gate does not change analytics
availability, sharing preferences or Settings. The prepared behavior below is
covered by tests with the notification explicitly enabled; normal app mounting
does not read notification status, register its listeners or create a toast.

When enabled, a nonblocking notice appears after authenticated status confirms
sharing is on. It offers the same “What’s shared?” component as Settings and
“Review in settings”, linking directly to the privacy section. Once shown, leaving
the current screen, switching away from the window, hiding the document, explicit
dismissal or using the settings action dismisses it. Dismissal is remembered per
client profile, environment and notice version, independently of consent.
Unmount/disconnect cleanup alone is not dismissal; failed or stale status reads
never claim sharing is on. There is no polling or blocking startup.
The notice is disclosure, not a consent gate or acknowledgement
that delays collection. Clearing client storage can make it appear again.

The “What’s shared?” panel exposes the explanation for keyboard and touch users,
plus exclusions,
retention, deletion and the random installation identifier. Persistent pseudonyms
are not anonymous people or unlinked events and still require the consent/deletion
protections below. Final copy and layout require human review before activation.

## Contract and delivery

`contract.ts` normalizes raw call-site values. `wireContract.ts` is the strict
persisted/wire validator; the website gateway consumes its generated copy.
Revision 3 added product insight signals. Revision 4 makes provider installation
state explicit, so a bundled-but-missing provider cannot be mistaken for an
installed runtime. Revision 5 names every settings page in `settings.viewed`
(Scheduled Tasks, SnapShots, Documents and Storage reported as `other` before);
the desktop derives its page list from the settings sidebar, and a test fails
when a page is missing from the contract. Revision 6 adds `feature.viewed` with
`feature: latex-visual` and UI-owned `scient.operation.*` with
`operationKind: latex-visual-edit`. Revision 7 names Scient Agent (`scient`),
Oh My Pi (`omp`), Muse (`muse`) and ACP Registry (`acpRegistry`) instead of
collapsing them into `other`. Only these fixed driver kinds are added; custom
provider labels, configured instance IDs and runtime paths remain private.
Revision 8 names the Synced folders settings page with the fixed `synced-folders`
category; no folder names, paths, tokens, or project identifiers enter it.
Revision 9 adds thread and project counts to `server.boot.heartbeat`, who started
a turn to `provider.turn.usage`, and `install.owner_observed`,
`client.turn.requested`, `client.thread.started`, `feature.used`,
`mcp.tool.invoked` and `mcp.delegated_task.finished`. Feature, tool, variant and
error names use a bounded identifier pattern, so upstream's new closed names
arrive without a revision; each one still comes from server code, never user text.
Installation state is aggregated per provider driver: it is
true when at least one settled configured instance is installed. The envelope
remains schema version 1.
Revision 10 drops the lists: any event and field of a valid shape is accepted, closed values that
code passes keep their names even when no list names them yet, and model names are sent as model
ids (aliases and pinned versions still fold into one key), as in T3. Free text and custom build
labels still become `other` or `unknown`. New events and fields need no revision and no gateway
deploy, so desktop and gateway releases no longer have to ship in order.
Legacy events may omit `contractRevision`; new events carry the revision.

The conformance corpus contains ordinary and hostile-input cases for each
event with a normalizer. Each event's ordinary case supplies only the fields its normalizer uses;
`passthrough` cases show fields the server records today with no normalizer. Regenerate and compare both repositories from the desktop root:

```sh
node packages/scient-analytics/src/generateConformance.ts \
  --wire=/absolute/website/workers/events/src/eventContract.ts \
  packages/scient-analytics/fixtures/contract-v11.json \
  /absolute/website/workers/events/fixtures/contract-v11.json
# Repeat with --check to verify exact source/corpus parity without writing.
```

Do not edit the gateway copy independently. A change to the shape or privacy
rule itself must reach the gateway before a desktop release that relies on it.

Visual LaTeX views report only while Visual is displayed (including Split/Visual),
not when its retained editor is hidden in Source/PDF. Existing visibility and
collection-context fencing apply; events go to the document's execution environment.
Visual edit operations count **source-file autosave batches**, not documents,
keystrokes or whole-project transactions. Accepted edits coalesce per source owner
until a confirmed publication covers the latest accepted Visual version; later
Source-only edits cannot delay or fail that result. Acceptance into a draft alone
is not completion. Source-boundary refusals (coalesced until the next accepted
Visual edit) and persistence errors/conflicts report failed with a bounded
`unknown` failure class, never the diagnostic text. Discarded edits are cancelled;
closing a view drops pending observation without inventing a save result. A retry
after a recorded failure is not a new operation unless another Visual edit occurs.
Source-only saves, builds and reference-file saves are not visual-edit operations.
Views/starts/completions require Product consent; failures follow existing Essential
consent rules. Off sends nothing. No document text, paths, filenames, document IDs,
source revisions, selection, bibliography or error messages enter these events.
The existing duration bucket measures draft acceptance to publication/failure,
not writing time, compiler time or active editing duration.

The renderer keeps per-connection consent discovery coalesced and at most 20
event requests in flight. Unknown/Off consent does not queue or replay feature
history. Positive status is lazily refreshed after 60 seconds of activity;
the server remains the authoritative consent filter. There is no status poller.
Failed discovery can retry on later activity at most once a minute. A verified
Off response stays cached until a new connection. No missed actions are replayed.

Provider send and completion counts need not match. `provider.turn.completed`
is one provider turn, and `segment` says what started it: the run's first
attempt (`initial`), a `steering_restart`, a provider `continuation` such as a
Codex goal turn, or a `native_child` subagent. `createdBy`, `creationSource`,
`scheduled`, and `subagent` describe the run's starting message, and `childKind`
separates native subagents from T3-managed child threads. Use this event for
per-turn measurements, not for counting requests.

`provider.request.completed` is one run, recorded when the run settles in the
server process that ran it. It adds each root turn once, so continuations,
steering, and replayed provider events do not add rows. `requestKind: "user"`
counts what people asked for. Native subagent turns are summed apart from the
root (`childUsageStatus`, `childInputTokens`); T3-managed child threads report
their own requests as `t3_child`. A child still running at settlement is never
added later, and the summary sets `childrenRunning`. A server restart loses the
summary of a run in progress. A run that continues after a restart reports its
own usage with `restartContinuation` and `lifecycleObserved: false`; it cannot
recover the original request's count or kind. A run whose provider session never
opens has no summary, and a start the provider rejects reports
`providerTurns: 0`. A Stop that lands while a steering restart is starting ends
the run without a summary. Collection is best effort, with no scan or backfill of
provider history.

Counts cover the main agent. `otherInputTokens` and `otherOutputTokens` are what
a provider's own ledger recorded beyond it during the turn: Claude's per-process
`modelUsage` growth, which covers native subagents, compaction, and helper
calls. They need a baseline from the same process, so they stay absent when it
is unknown or the ledger goes backwards, and background work that ends between
turns lands in the next one. Claude subagents have no turns of their own, so
this never overlaps child turns.

`model`, `effort`, and `serviceTier` are what the run selected. `serviceTier`
is `standard`, `flex`, `fast`, or `ultrafast`, from Codex's tier option or
Claude's fast mode, and is absent when the selection does not set one. `observedModel` and
`mixedModels` appear only when the provider reported the models for the counted
work (Codex thread settings and reroutes, Claude root messages, OpenCode steps).
`mixedModels: false` without `reportVersion` was never checked. Model labels
come from the bundled model manifest and the Cursor and Grok catalogs, also for
routed ids such as `anthropic/claude-opus-5-5`, and efforts come from a closed
list. Like T3, a user-configured model name is sent when it looks like a model id.

Which providers report token counts: Claude, Codex, OpenCode, Muse, Antigravity from runtime
1.4.5, ACP Registry's GLM agent, and, through the shared native adapter, Scient Agent and Oh My Pi.
Pi and Cursor report them from their own adapters. Each counts every model request the agent
reports during the turn. Where an agent reports them, a turn also carries the per-request facts
Scient Agent's /stats shows: `requests`, `failedRequests`, `estimatedCostUsd` (the agent's own
price estimate; an unpriced request leaves the total unknown), `modelDurationMs` and
`firstTokenMs`; `provider.request.completed` sums them per run. Grok, Droid, fx and the legacy
Antigravity path do not report usage yet: Grok's counts arrive on a separate notification, and
Droid's and fx's protocols have no verified per-turn source. `OmpTurnUsage.native.live.test.ts`
proves the installed agent's report end to end (`OMP_QUALIFY_BINARY`).

Status and counters answer different questions. `usageReported: false` means
the adapter attached no usage; a harness where every row says so is unsupported,
not idle. `partial` keeps valid counts that cannot establish a whole-turn total,
such as an OpenCode step that ended without a report, an OpenCode stream
reconnect, or an interrupted segment.
Explicit zeros are sent and unknown counts stay absent. `localCommand` marks a
provider-local command such as Claude's `/compact`, whose result counters are not
model work. Reasoning tokens are a subset of output.

Charts built on these events should say "output tokens per measured provider
completion", compare matching provider, observed model, effort, interaction mode,
and terminal status, and show eligible and measured counts by harness, origin,
and status so unknown models and unsupported adapters stay in the denominator.
Divide summed totals for output/input ratios; averaging per-turn ratios lets
small-input turns dominate. Rows without `reportVersion` keep their missing
fields unknown; a missing origin is never a person.

UI export operations require a cached, positive status with an ephemeral
`collectionContext`. The server derives that context from its current consent
epoch and a random value; a new server/HTTP lifetime invalidates it. Consent is
fixed for a server's lifetime, so the epoch stays 0. The UI carries it outside event properties, and the
HTTP adapter verifies and removes it before recording. It never enters the
outbox or gateway and is not an installation identity. Old status responses
remain compatible, but without a context the new UI-operation observers stay
inactive. Existing UI events keep their previous protocol.

An operation never waits for discovery or delivery. Its one completion uses
the captured context instead of initiating a refresh when the action exceeds
60 seconds; the server still rejects stale contexts. Local controls and observed
context changes discard unfinished observations. A dropped start is not
reconstructed from a later completion; Essential participants emit only known
failures. Missing terminal events are not automatically failures.

The dedicated worker owns SQLite and remote delivery. Limits are 1,000 memory
events, two in-flight local batches, 10,000 durable events, 50 events per upload,
three-second upload deadlines, 20 delivery attempts, and 100 metadata-only dead
letters. Summary events are trimmed before core/critical events. Expired,
malformed, or no-longer-valid persisted events cannot bypass the shape and
privacy check. Local raw events expire after 180 days, diagnostics after 30 days,
and dead-letter metadata after 30 days when maintenance runs. An app that is
not running cannot execute cleanup; old events are filtered before delivery.

Off makes no per-event HTTP, SQLite, or worker call. The server sets consent once,
when the worker starts, and sends no later consent or deletion controls. The worker schedules delivery only while eligible events remain;
diagnostic summaries do not create an endless diagnostic-only feedback loop.
Shutdown gets 300 ms for local persistence and does not await remote delivery.
These are implementation bounds, not a claim of zero CPU cost or universally
measured performance on every supported platform.

## Instrumentation and honest coverage

### Product insights (revision 3)

`panel.viewed`, `settings.viewed`, `feature.viewed` and `usage.viewed` measure
visible category entries, not clicks, dwell time or successful work. Consecutive
identical categories are coalesced while mounted; reopening or returning from a
hidden document can create a new observation. A visible restored panel qualifies,
background tabs do not. Actor is deliberately not inferred. Settings paths map
to fixed sections; nested project/provider identifiers and search text never
leave the client. Global Settings/Usage observations belong to the primary
environment; panel observations belong to the panel's environment.

The view observer reads current visibility after coalesced consent discovery;
leaving before discovery does not replay the abandoned view. At most 16 view
observers are retained per connection. These events carry the existing ephemeral
collection context and are rejected after the server restarts. They use the
existing bounded transport, not a clickstream SDK, scan, poller or shutdown-only
summary. `usage.refresh.requested` is an explicit refresh request, not success;
`usage.availability` describes a settled non-Limits view's summary availability,
not completeness of all token reporting. Limits sources retain separate coverage.

`provider.turn.usage` uses V2 `ProviderEventIngestor`'s instance-aware terminal provider-turn
facts and the run's model association supplied by `RunExecutionService`. Its
`provider.turn.completed` telemetry input is mapped to usage, never a second successful outcome.
Provider terminal outcome and later checkpoint finalization remain separate. Counts are normalized main-agent
input/output, optional cache read/write and reasoning subsets, with
complete/partial/unavailable status. Each count is an integer from 0 to one
billion; invalid values are omitted rather than clamped. Unknown counts are not
zero. Cache and reasoning are already included in input/output and must not be
added again. Private or mixed model labels become `other`; absent labels remain
`unknown`. No transcript scan, raw usage object, cost estimate or subagent total
is exported. Product consent must cover the observed turn interval; epoch
changes suppress deferred totals. Missing/evicted starts emit unavailable usage
rather than attributing an unproven interval. Terminal failures/stops can consume
tokens but usage remains Product-class, separate from Essential failures.

Existing provider discovery/readiness events mean observed ready, not a current
signed-in account inventory. V2 `provider.turn.sent` measures a live,
committed run admission (including queued work) or a new accepted steering
message on an existing run, deduplicated by the local message identity. It is an accepted prompt
submission, not proof of provider delivery, an answer, or a human action.
Progress updates, queued-to-steer promotions, retries, restart continuations,
restored terminal history and legacy queue hydration do not produce new submissions. Driver attribution
uses the canonical run event or configured instance's driver, never the instance
name. Consent/identity changes clear the bounded observation state and never
backfill earlier admissions. Consent is fixed for the server's lifetime, so
the collection period set at start (epoch 0) never changes.
Steering items carry optional canonical `inputAlreadyAdmitted` provenance:
held Droid re-delivery and queue promotion are not first admissions, even after
local correlation state resets. Unknown legacy provenance is not counted.
An unavailable watermark fails closed.
The event subscription waits for the first valid watermark and can initialize
after a later successful boundary; the fail-closed sentinel never becomes a
permanent upstream stream cursor.
The observer does not read message text or
attachments; unknown input presence is omitted and attachment count stays
`unknown`, rather than claiming an empty prompt. Existing explicit input
booleans and attachment buckets from older producers remain accepted.

`provider.turn.usage` also carries who started the turn: `createdBy`,
`creationSource`, `scheduled` and `subagent`. Most turns start without a person
(provider continuations, agent sends, delegated subagents), so filter on these to
count user turns.

Scient Agent uses the existing installation observations, installed-state
changes, lifecycle operations, submissions, terminal outcomes and token usage.
Latest observed installed profiles, successful install operations, and profiles
that submitted prompts are separate measures, not unique people or all-time
installation totals. The gateway's `analytics:insights` report exposes these
per-provider measures and daily submission counts for non-development builds.
Old `other` labels and missing submission events cannot be recovered from
collected data. Deploy the revision-8 gateway before releasing this producer;
accurate coverage requires updating clients with sharing enabled.
Existing voice/import/compute/export outcomes
remain their authoritative measurements. This pass does not add generic error
capture, arbitrary preference values, precise attention tracking, or reconstruct
unreported history. Offline/retry durability starts at local outbox acceptance;
renderer disconnects, queue caps, expiry and abrupt termination can still lose
observations. Never promise lossless telemetry at the expense of product work.

The gateway report `analytics:insights` and prepared PostHog insights use
revision-3 Product participants, complete reporting days, distinct installation
profiles and event-ID deduplication. Repeated use means at least two distinct
days, not runtime sessions. The observed population is not feature eligibility
or all users. D1 is UTC; qualify the PostHog project timezone before comparing.
Deploy the generated validator before releasing these producers. No deployment,
activation, dashboard installation or platform-wide performance proof follows
from the source implementation alone.

| Source owner                           | Observed meaning                                                                                                       | Important limit                                                                                            |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `AnalyticsService` and startup         | Server session, startup outcome, heartbeat                                                                             | A missing graceful shutdown does not prove a crash                                                         |
| `ws.ts` and `FeatureUsage`             | Client turn requests, thread starts and feature use, by connecting surface                                             | A retried command records nothing again; guests have no surface                                            |
| `McpHttpServer`                        | Agent tool calls: tool, caller, targets, outcome and duration                                                          | A handoff to several threads records one event per target, so events are not calls                         |
| `DelegatedTaskAnalytics`               | Delegated tasks reaching a final status                                                                                | Counted once per process                                                                                   |
| `DesktopWindow` through host telemetry | Renderer termination reported by Electron                                                                              | Best-effort live signal only; no replay, raw crash details, or detection of a crashed desktop main process |
| `AnalyticsEventObservers`              | Canonical provider turns, fork completions, revert completions and reported failures                                   | Stop request and terminal stop are distinct; fork-failure names remain reserved                            |
| `ProviderLifecycleAnalytics`           | Observed provider discovery, readiness/source changes, runtime install/update/repair/remove, sign-in, inherited update | Initial historical terminal states are not replayed; no raw provider error parsing                         |
| `ProviderConnectionManager`            | Assisted sign-out completed/failed                                                                                     | Result includes account-state reconciliation; no account detail is collected                               |
| `ComputeSessionService`                | Durable execution outcomes and a separate retained-rich-output summary                                                 | RPC acceptance is not success; empty output is skipped; no code, outputs or local keys leave the process   |
| `AnalysisService`                      | Durable Run File admission, execution results, and separately requested artifact capture                               | Empty capture is skipped; partial capture is failed; pre-admission rejections remain outside coverage      |
| `LatexBuildService`                    | Actual build attempts and terminal results                                                                             | No paths, document text, compiler logs, or continuous progress events                                      |
| Documents MCP handler                  | Agent PDF build outcome                                                                                                | Technical publication is not scientific acceptance; partial publication remains a failure outcome          |
| Browser PDF export hook                | Coalesced render, publication and presentation/association completion                                                  | Not proof of visual fidelity; source races and errors preserve the existing failure behavior               |
| PDF Save Copy actions                  | Host save receipt through the reader and export menu                                                                   | Browser download start is unconfirmed, not a completed durable save                                        |
| Sources coordinator and MCP            | Actual per-item local PDF/Zotero and agent import attempts; saved, skipped or failed                                   | Counts source-store results, not whole batches, preflight, later bookkeeping/cleanup or human approval     |
| Scient UI adapter                      | Existing project, voice, selected surface and setting events                                                           | No arbitrary clicks or replay before consent                                                               |

`OperationAnalytics` observes these owners; it does not own work, add retries,
change failures, or write scientific state. Optional-service hosts still work
without analytics. Correlation maps are bounded and cleared at consent epochs.
Compute correlation includes current project/session/execution identity and
session generation only in memory. When workspace-binding authority lands,
include that binding in this local key; caller-chosen execution IDs are not globally
unique. None of these local keys may become event properties.

Run File and interactive compute emit `compute-run` through the same observer
but keep their existing, separate execution owners. Starts represent newly
persisted submissions; durations include queue time. Queue-position, launching,
running and other progress updates do not create starts, including after a
consent change. Terminal history/recovery without an observed start is ignored.
Run File outcomes read only receipt status/timestamps and local project/run
correlation, never source paths, code, output, runtime diagnostics or errors.
The run may succeed while artifact capture fails; neither outcome substitutes
for the other.

Run File also emits `compute-artifact` at **one requested capture workflow per
admitted run**, only when its adapter supports collection. Its start is the
persisted admission, so duration includes queueing and execution rather than
just copying figures. The saved artifact receipt determines the outcome:
successful capture with at least one artifact completes; successful empty
capture is skipped; failed or partial capture remains failed even if some
artifacts were saved. This is technical capture, not scientific acceptance or
a count of individual figures. Keep execution and capture grouped by operation
kind; summing them does not count independent user jobs. WMAI deduplicates the
participating installation, not these two events. No artifact labels, paths, hashes, contents or
failure messages enter events.

A cancellation closes unresolved capture as cancelled; a saved capture failure
remains failed even if cancellation was also requested. Failure before capture
closes it as failed. A capture that already completed is not
undone when the process fails or later run bookkeeping fails. Receipt updates
and history reads cannot double-count it, and a consent reset cannot start
tracking an old run's capture. Interactive-compute rich output has a different
publication owner and is not inferred from Run File capture events.

Interactive compute uses `ComputeOutputAnalytics` to summarize retained rich
output at **one capture workflow per newly admitted execution**. Images,
non-plain-text MIME bundles and display updates use the existing persistence
result; generated project figures use that same path after collection. The
observer stores bounded retained/rejected counts and structured coverage facts,
and emits one terminal summary when the execution ends. A known rejection or
persistence failure makes capture failed, including partial retention.
Project-scan warnings describe incomplete coverage independently: reaching a
depth, entry or time limit does not establish that an artifact was lost.
Retained output without a known rejection completes even when the
code later fails or is interrupted. No rich output or capture failure means
skipped, regardless of the execution outcome; execution failure and cancellation
remain separately recorded as `compute-run` outcomes. Plain text and
clear-output controls alone are not artifacts.

Capture schema version 2 distinguishes `retained`, `partial`, `none`, `failed`,
and `unobserved`, alongside `complete`, `partial`, or `unavailable` project-scan
coverage and a closed reason category. Empty output with incomplete coverage is
`unobserved`, not evidence that no figures existed. Counts are bounded and bucketed;
interactive counts include retained display updates, not unique files or figures.
Starts identify the schema and capture source; outcome, coverage, reason and counts
are terminal observations. Capture reasons stay separate from operation failure classes.
Run File uses its saved receipt and identifies its separate publication owner;
when that receipt does not enumerate rejected candidates, their count is unknown.
Historical events without the version marker retain their older, coarser meaning.
Do not combine them into a version-2 capture failure rate.

The summary does not read transcripts, files, chart contents or warning text,
and adds no network or persistence request. At most 1,000 active executions
are correlated; overflow starts are ignored without evicting tracked work.
Consent changes clear correlation, and stale-generation, pre-consent,
restored, unattributed or post-terminal output does not create or reopen a
capture. Existing output storage and execution ownership are unchanged.
Durations include queueing/execution, not just persistence. Completion proves
technical retention, not that a chart rendered or a researcher accepted it;
a failed capture is not proof that no partial write occurred.

Voice schema version 2 measures one committed dictation job, beginning when the
user stops recording (including the final audio flush), with exactly one local
completed, failed or cancelled outcome. Empty clips close as audio failures;
cancelling correction closes as cancelled and bypassing correction delivers the
original transcript once. Microphone/recorder failures and recording cancellation
use separate `voice.recording.*` events, outside the transcription denominator.
Total job, transcription and correction timings are separate buckets. Correction
can be disabled, corrected, fallback, bypassed or cancelled; fallback remains a
successful usable local transcript. Completion measures the delivery callback,
not proof that the user submitted or accepted the transcript.

The UI binds the job to its original connection and collection context. A
previously verified context does not expire mid-job; the server validates it on
every voice event and strips it before queueing. Unknown/Off work is never replayed,
and consent changes, deletion or a server restart invalidate old outcomes. A
server must advertise lifecycle version 2 before the UI sends these job events.
Essential permits failure metadata only; recording and successful-use events
remain Product. Audio, transcripts, correction requests, document contents and
raw error text are never analytics properties. These additive bounded properties
use the existing revision-10 gateway wire contract; no new ingestion endpoint or
gateway deployment is required.

Browser PDF export emits `pdf-export` once for the initiating coalesced render/
publication operation. Completion waits until its existing source checks,
publication and presentation/source-association calls succeed. A duplicate
request sharing the work emits no second attempt, and a later retry can emit a
new one. Failed rendering, publication or source/presentation checks remain
failures; they do not prove that no PDF was saved. Existing warnings remain
warnings, and completion is not proof that every element rendered faithfully.
The export menu labels explicit actions as `user`; other automatic update paths
retain `other` rather than guessing who initiated them.

`document-export` currently observes PDF Save Copy, including URL authorization
in the export-menu path and the reader's existing save host. Only a `saved`
receipt completes; `cancelled` and typed/raised failures stay distinct. A web
`download-started` result closes local observation without inventing a terminal
success or failure: the browser cannot confirm durable saving. Do not turn
started-minus-completed into a failure or abandonment count. PDF generation
and saving a copy are separate operations, not two independent user jobs;
neither includes document names, paths, URLs or error text in analytics.

Source imports use a small optional Promise observer at the existing
coordinator's actual item-processing seam and the agent source-add seam.
`SourceImportAnalytics` bridges to the same `AnalyticsService`; there is no
global listener, second operation store, import retry, or additional filesystem/
network request. Off bypasses outcome inspection. A consent epoch change during
an attempt suppresses its terminal event; future genuine attempts can be observed.

`source-import` has **item-attempt** grain. A successful source-store return
emits `scient.operation.completed`; duplicates/possible matches emit
`scient.operation.skipped`; material/import errors emit `failed` with an
unknown failure class. Later batch bookkeeping or staging cleanup can fail
without undoing a saved source, so it must not erase that completion. The
existing batch state, UI errors and retries remain unchanged. A retry which
finds that saved source is a skip, not a second useful completion.

Beginning a batch, polling a completed batch, and cancelling unprocessed items
emit no item attempts. A partial batch can contain successful and failed
attempts; a real retry creates a new attempt, without linking private source
or operation IDs. Durations exclude time waiting in the batch. Agent additions
remain pending human review. Preflight/PDF preparation, batch abandonment,
bookkeeping/cleanup errors and review acceptance are not covered by these
events. A returned store failure is not proof that no partial filesystem write
occurred. Skips are visible in outcome/latency reports but never qualify as
meaningful completed scientific work.

Revert failures observe only the canonical `checkpoint.revert.failed` activity
kind. Its private summary and payload are never read; the failure class remains
`unknown`. Completed/failed revert event IDs are deduplicated in bounded local
memory. This covers reported outcomes, not an unreported server crash.

Registered operation kinds without producers are not usage evidence. Non-PDF
document/figure exports, desktop updater,
migration, desktop main-process crash, and cloud/mobile coverage still require their own
authoritative seams and proof. `client.connected`/`client.turn.requested` remain
unregistered as described below. Failure categories not known from a safe typed
source remain `unknown`.

For dashboards, successes and failures need the same consent population.
Essential-only failures must not inflate a Product success-rate denominator.
Completed/stopped/failed turns must not be double-counted. Device profiles and
consenting installation pseudonyms are not unique people. Durations are buckets,
not exact percentile measurements.

## Deletion and activation gates

The desktop no longer sends deletion requests. The rest of this section describes the
analytics worker and gateway, which keep their deletion handling.

When the analytics runtime is enabled, an explicit deletion can authenticate
while consent is Off; it does not temporarily enable Essential collection.
The globally disabled runtime remains inert, including its remote controls.
Acknowledgement permits local cleanup and identity rotation, not a claim that
every downstream copy is gone.

The gateway owns atomic D1 erasure, durable anti-resurrection tombstones,
delivery leases, and downstream erasure state. Its separate
`DESKTOP_INGESTION_ENABLED` and `DESKTOP_POSTHOG_EXPORT_ENABLED` gates remain
false during preparation. Neither is enabled by building this desktop code.

The approved storage split keeps Diagnostic-class events only in Scient's
central Cloudflare D1 ledger, with 30-day pruning. Operators access aggregate
diagnostic reports through the website repository's `bun run analytics:report`;
these records are not stranded on users' devices. Essential/Product-class
events may also be exported to EU PostHog. Their downstream retention is
PostHog-managed; Scient does not promise a configurable physical-deletion
deadline that this project cannot enforce. Consent at Diagnostic level does
not change the routing of its Essential/Product-class events.

PostHog capture acknowledgement is asynchronous. Deletion stays pending until
the provider verifies its person/event erasure operation, not merely submission.
The gateway serializes export and deletion and rejects tombstoned identities;
the app rotates identifiers and never intentionally reuses a deleted identity.
Provider verification is not a synchronous transactional guarantee over every
ambiguous capture. Desktop account linking remains disabled. See the gateway
README for qualification, pending/blocked status and deployment procedures.

Useful local checks include package contract/outbox/worker tests, service/UI
consent tests, provider lifecycle and operation observer tests, the real gateway
SQLite migration/retention/deletion suite, whole-repository checks, and the
packaged analytics worker. These do not prove deployed configuration, live
PostHog queries, Windows/Linux behavior, or human privacy-UI acceptance.

The bundled analytics worker is a sibling of every emitted server module,
including lazy CLI chunks. Its location must not depend on an entry or chunk
filename. `scripts/lib/analytics-worker-packaging.test.ts` builds and relocates
that boundary, then exercises delivery, restart identity, and saved Off consent.

The website candidate also contains an opt-in cross-repository test. After
building the exact desktop candidate, run it from the website root:

```sh
SCIENT_ANALYTICS_DESKTOP_ROOT=/absolute/desktop bun run test workers/events/src/desktopPipeline.test.ts
```

It exercises the built worker through a loopback gateway, actual SQLite ledger,
mocked PostHog export, consent reduction, deletion and rejected late replay.
It is intentionally skipped in ordinary website-only CI and makes no external
request. Supplying a sibling path alone is not proof it was built from the
intended revision; record the candidate and build command with the result.

Also run that proof with the desktop's actual Electron runtime, because an
ordinary Node run does not verify Electron's native SQLite support. From the
website root, after building the desktop candidate:

```sh
SCIENT_ANALYTICS_DESKTOP_ROOT=/absolute/desktop \
ELECTRON_RUN_AS_NODE=1 \
/absolute/desktop/apps/desktop/node_modules/.bin/electron \
  node_modules/vitest/vitest.mjs run workers/events/src/desktopPipeline.test.ts --maxWorkers=1
```

`ELECTRON_RUN_AS_NODE=1` is essential: this runs the backend execution path
without creating a desktop window. Record Electron/Node versions and repeat
on each supported platform; one macOS result is not Windows/Linux proof.

## Client presentation metadata

The inherited host now sends bounded client presentation metadata during the authenticated
connection: surface, app version, broad operating-system and device class, web deployment type, and
connection method. The server validates those values and can persist the supported session fields so
connection management can describe current clients. Invalid or unknown values are ignored and never
reject a connection.

Upstream's `client.connected`, `client.turn.requested` and `feature.used` events, and any event
upstream adds later, are sent as recorded.

## Scient's own features

[`ScientFeatureUsage.ts`](../../apps/server/src/telemetry/ScientFeatureUsage.ts) records Scient's
features the way T3's `FeatureUsage` records T3's:

- **People:** Scient WebSocket requests (Compute, data tables, Run File, Accounts and papers,
  extensions, skills, custom models, PDF export) join T3's `feature.used` table, credited to the
  connecting surface. Scient's HTTP actions (Overleaf, Sources, LaTeX SyncTeX and toolchain,
  images, thread queue, conversation import/export, Word export) record `feature.used` with
  `outcome` (`ok` or `error`) and `durationMs` through one router middleware keyed on the path.
- **Agents:** Scient's working tools (`SCIENT_ACTION_TOOLS`: compute, notebooks, LaTeX, PDF,
  export, Overleaf, papers, sources, accounts, projects, skills) record `mcp.tool.invoked` on
  success too. Read, list and status tools stay failure-only, as in T3.
- **Compute language:** `compute-run` operations from interactive Compute carry `language`.

- **Messages people send:** `client.turn.requested` carries the message's length (`messageChars`,
  `messageWords`) and Scient Agent's /stats frustration signals (`yelling`, `profanity`,
  `anguish`, `negation`, `repetition`, `blame`), for every provider. They come from
  [`UserMessageSignals.ts`](../../apps/server/src/telemetry/UserMessageSignals.ts), copied from
  Scient Agent's `user-metrics.ts`; only the counts leave it, never the text. /stats's optional
  model judge is not run.

Each entry names an action someone chose, never a read, refresh or subscription. Builds, source
imports and code runs keep their existing operation events, so they are not counted twice. To
measure a new Scient feature, add its method, route or tool to that file; its test fails if a
route or tool name no longer exists.

## Whose failure, and what agents run outside Scient

A failure count mixes Scient's bugs with ordinary bad code. Failed `scient.operation.*` events and
failed `mcp.tool.invoked` calls carry `failureOwner`: `scient`, `code` (the code or document being
run), `input` (a request the caller got wrong), `environment` (a missing runtime, package or
permission), `external` (a network or remote service), `cancelled` or `unknown`.
[`FailureAttribution.ts`](../../apps/server/src/telemetry/FailureAttribution.ts) decides it where
the typed failure is still in hand, with a closed `failureCategory` beside it. A runtime-reported
error is the code's own, unless its error class names a missing package, memory or network; a
missing package in Scient-managed Python stays `unknown`, since its Toolkits are Scient's promise.
A run that never reached the kernel, an app restart or a broken bridge connection is Scient's. A
runtime that exits mid-run stays `unknown`. Error names and messages never leave the computer.
Compute runs also carry `actor` (`user` or `agent`), `entry` (`console`, `file`, `selection`,
`cell`, `run-file`) and `runtimeSource`.

## Why a turn or delegated task failed

`provider.turn.failed` keeps `failureClass` and adds the cause a provider gave, when it gave one:

- `failureCode`: one machine reason. Scient Agent reports its error classifier's kinds in
  `prompt_result.error.kinds` (scient-agent `SA-FAILURE-KIND`), and
  [`OmpTurnOutcome.ts`](../../apps/server/src/provider/omp/OmpTurnOutcome.ts) keeps the most
  specific: `cost_cap`, then `oauth-expiry`, `usage-limit`, `account-policy`, `auth-failed`,
  `content-blocked`, `payload-rejected`, `context-overflow` and so on down to `transient`, then
  `http_<status>` for an agent without kinds. The OMP host names its own outcomes:
  `process_exit`, `prompt_result_timeout`, `drain_busy`, `idle_confirmation_failed`,
  `command_rejected`, `command_timeout` and `rpc_failed`. A retry the host stops after it never
  resumed is `retry_stalled` unless the provider gave a code; an out-of-memory kill is `oom_kill`.
  Claude result subtypes and process exits, `api_error_<status>`, and Codex error variants and
  ChatGPT sharing codes come from those adapters.
  [`failureCodes.ts`](../../packages/scient-analytics/src/failureCodes.ts) lists each
  provider's known codes, ChatGPT sharing codes included by name, and the contract itself drops
  anything else, since a code that only looks like an identifier may be free text a provider sent.
- `httpStatus`: the provider's HTTP status, 100 to 599, on the failure itself
  (`OrchestrationV2ProviderFailure.httpStatus`).
- `retryAttempts`, also on `provider.turn.completed`: retry attempts the provider reported for the
  turn's root, each retry cycle counted at its highest attempt. These are reported attempts, not
  proven requests. Zero means none was reported.

The failure is the run's latest failed root error item, as `latestRootProviderFailure` picks it; a
retry that recovered or a subagent's error is not the turn's failure. These fields explain a
failure; they do not change its class or what recovery does with it.

A failed `mcp.delegated_task.finished` adds `failurePhase` (`before_provider` when the child run
failed before its provider started a turn, `provider`, or `unknown` when there is no local child
run, as for a task on another machine) and the child run's `failureClass`, `failureCode` and
`httpStatus`, read by [`DelegatedTaskFailure.ts`](../../apps/server/src/telemetry/DelegatedTaskFailure.ts)
from the run the task reported, never from its result text. A call refused before a task exists is
a failed `mcp.tool.invoked`, not a finished task.

Agents also run programs in their own terminal, which bypasses Scient's tools. At each turn's end
the native observer sends one `provider.commands.observed` per program category the turn ran, with
`commandCount`, `failedCount` and `stoppedCount`.
[`CommandCategories.ts`](../../apps/server/src/telemetry/CommandCategories.ts) reads the command
on the computer and keeps only the category (`python`, `r`, `stata`, `latex`, `hpc`,
`document-convert` and so on, or `shell-other`); the command, its arguments and output never
leave it. Codex and Claude commands arrive as `command_execution`; native providers' shell tools
as `dynamic_tool` with the command in their input. Scient's own workspace-preparation and
sign-out rows are excluded. A command counts once, when it ends; a nonzero exit or a failed
item counts as failed.

The contract reads these fields with closed lists, so free text becomes `unknown` or is dropped.
The gateway accepts them unchanged; reference queries on the ledger live in the website's
`workers/events/src/attributionPipeline.test.ts`.

## Privacy invariants

Analytics must never include prompts, responses, file contents or paths, URLs (except a public skill
source's host and path, see [personal skills](./scient-skills.md#personal-skills)), credential tokens
or user-assigned device names. Dedicated account observations
may include a provider-reported email; account/device owner IDs are hashed. As in T3, this rests on what
the code records: no call site passes free text. The wire check backs it up by dropping free-text
keys and any value that looks like a path, link or email address outside that
account-event exception. New upstream instrumentation is
sent as recorded, so review new `analytics.record` call sites during alignments.

Who an install belongs to is sent as `install.owner_observed`, at most once per
owner per process. `distinct_id` stays the random installation identifier; owners
are a separate fact so a rule can change and apply to all history. The server
reads the OpenAI `user_id` from the Codex login and the Claude `accountUuid`, then
sends only their SHA-256 hash from `hashTelemetryId`. A Codex `account_id` is a
workspace a whole Team shares, so it is not used. API-key logins have no owner.
Owner events are Product class, so they are kept for the raw-event retention period
and exported to PostHog. Client-reported owners are not wired up. Generic T3
delivery and relay tracing remain disabled.

The detailed current event schema and tests live in `packages/scient-analytics`. Historical design
and capability evidence remains in
[`docs/reports/scient-specific-capabilities.md`](../reports/scient-specific-capabilities.md).

## Account observations and activation

Revision 11 adds `install.account_observed` and `install.profile_observed`.
The gateway and generated conformance corpus must land before a desktop release
using the account-email exception. The gateway defaults
`IDENTITY_ANALYTICS_ENABLED=false`, independently of existing ingestion/export
controls. With this flag off it acknowledges but discards account/profile/device
observations and collects no new request-network observations. Activation waits
for the reviewed privacy notice; ordinary quality instrumentation remains usable.

The account observer uses authenticated provider snapshots, not credential files
or browser profiles. Codex and Claude expose email and plan labels; Grok exposes
email. Other providers contribute only fields they actually publish. Antigravity,
Cursor, Droid, Pi, OpenCode and arbitrary ACP drivers do not currently expose a
consistent account email/tier in their Desktop snapshots. Their model and tool
usage is still recorded. Scient Agent's optional RPC `emails` list supplies
active stored OAuth email metadata in newer agent builds; older builds remain
compatible. Connected service IDs identify access to a service, not a subscription
tier. API-key login options are not reported as subscription accounts.

MCP and provider-turn model dimensions accept bounded names reported by agents,
including Pi and custom models. Turn/request reports include the primary model
and distinct-model count where usage lists them. Browser calls are counted before
the tool response returns and consumed by the turn terminal observation; collection
resets clear the ledger. Download and LaTeX failures use bounded classes, never
raw diagnostic messages.

When activated, Cloudflare retains linked usage until two years after the
installation's last activity and diagnostics for 60 days. Local outbox limits
remain separate delivery-buffer limits. Account, profile, device and network
observations stay outside PostHog. Deletion covers these observations as well as
the event ledger. Permanent daily totals contain no account/installation IDs;
shared-IP/time download candidates never change canonical identity automatically.
