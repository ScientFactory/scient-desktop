# Scient product analytics boundary

Scient has a first-party analytics contract, outbox, worker, and privacy UI.
Recognized packaged release builds make the feature available through
`SCIENT_ANALYTICS_ENABLED=true`; development and unknown-channel builds stay
disabled. Consent still defaults to `off`, and saved choices are preserved.
Availability is not opt-in: Off creates no collection worker and sends nothing.
Native and WSL backend configuration receive the same bounded release metadata.
An explicit `SCIENT_ANALYTICS_ENABLED=false` remains an operator kill switch.
For isolated manual QA, `SCIENT_ANALYTICS_ENABLED=true` can expose the controls
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

When an owner deliberately enables the runtime, events still pass through the strict allowlist in
[`packages/scient-analytics/src/contract.ts`](../../packages/scient-analytics/src/contract.ts).
Unknown event names and properties are dropped. Consent level is enforced before queueing, delivery
uses only Scient's first-party gateway, and failures cannot block normal product behavior. The
Settings privacy surface can change consent and request deletion of the installation's analytics
data and random installation identifier.

The settings copy describes a random installation identifier, not anonymous
people or unlinked events. Its choice, confirmation and reset flow are
unchanged; persistent pseudonyms still require the consent/deletion protections
below. Final copy and layout require human review before activation.

## Contract and delivery

`contract.ts` normalizes raw call-site values. `wireContract.ts` is the strict
persisted/wire validator; the website gateway consumes its generated copy.
Revision 2 has 45 registered names, while the envelope remains schema version 1.
Legacy events may omit `contractRevision`; new events carry the bounded revision.
Unrecognized/custom model and build labels become safe categories, not raw text.

The conformance corpus contains ordinary and hostile-input cases for each
registered event. Regenerate and compare both repositories from the desktop root:

```sh
node packages/scient-analytics/src/generateConformance.ts \
  --wire=/absolute/website/workers/events/src/eventContract.ts \
  packages/scient-analytics/fixtures/contract-v2.json \
  /absolute/website/workers/events/fixtures/contract-v2.json
# Repeat with --check to verify exact source/corpus parity without writing.
```

Deploy compatible gateway validation before releasing new producers. Do not
edit the gateway copy independently or relax unknown-property rejection to make
an old deployment accept new events.

The renderer keeps per-connection consent discovery coalesced and at most 20
event requests in flight. Unknown/Off consent does not queue or replay feature
history. Positive status is lazily refreshed after 60 seconds of activity;
the server remains the authoritative consent filter. There is no status poller.
Changing consent fences deferred requests and clears surface coalescing.
Failed discovery or an uncertain consent/deletion control can retry on later
activity at most once a minute. A verified
Off response stays cached until explicit settings refresh or a new connection;
changing consent from a different client therefore does not silently wake this
renderer. No missed actions are replayed.

UI export operations require a cached, positive status with an ephemeral
`collectionContext`. The server derives that context from its current consent
epoch and a random value; consent controls, deletion and a new server/HTTP
lifetime invalidate it. The UI carries it outside event properties, and the
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
malformed, unknown, or no-longer-valid persisted events cannot bypass the
allowlist. Local raw events expire after 180 days, diagnostics after 30 days,
and dead-letter metadata after 30 days when maintenance runs. An app that is
not running cannot execute cleanup; old events are filtered before delivery.

Off makes no per-event HTTP, SQLite, or worker call. A saved invalid preference
fails closed rather than accepting a more permissive environment default.
Consent/deletion controls abort and await in-flight delivery before altering the
local queue. Parent-side draining pauses during deletion so old buffered events
cannot survive identity rotation. Consent controls queue before worker readiness;
an unacknowledged control terminates the worker rather than leaving higher
consent active. The worker schedules delivery only while eligible events remain;
diagnostic summaries do not create an endless diagnostic-only feedback loop.
Shutdown gets 300 ms for local persistence and does not await remote delivery.
These are implementation bounds, not a claim of zero CPU cost or universally
measured performance on every supported platform.

## Instrumentation and honest coverage

| Source owner                           | Observed meaning                                                                                                       | Important limit                                                                                            |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `AnalyticsService` and startup         | Server session, startup outcome, heartbeat                                                                             | A missing graceful shutdown does not prove a crash                                                         |
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
observer stores only retained/rejected flags, coalesces repeated updates, and
emits a terminal summary when the execution ends. A rejection, persistence
failure or project-collection warning makes capture failed, including partial
capture. Retained output without a capture failure completes even when the
code later fails or is interrupted. No rich output or capture failure means
skipped, regardless of the execution outcome; execution failure and cancellation
remain separately recorded as `compute-run` outcomes. Plain text and
clear-output controls alone are not artifacts.

The summary does not read transcripts, files, chart contents or warning text,
and adds no network or persistence request. At most 1,000 active executions
are correlated; overflow starts are ignored without evicting tracked work.
Consent changes clear correlation, and stale-generation, pre-consent,
restored, unattributed or post-terminal output does not create or reopen a
capture. Existing output storage and execution ownership are unchanged.
Durations include queueing/execution, not just persistence. Completion proves
technical retention, not that a chart rendered or a researcher accepted it;
a failed capture is not proof that no partial write occurred.

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

Upstream also added `client.connected` and `client.turn.requested` analytics call sites. Those names
are not registered in Scient's analytics contract and are therefore dropped at the Scient boundary.
They must not be documented as collected or used to build a dashboard unless Scient deliberately
adds a reviewed, privacy-bounded contract for them.

## Privacy invariants

Analytics must never include prompts, responses, file contents or paths, URLs, tokens, email
addresses, provider account identifiers, or user-assigned device names. Provider and model values
are normalized into bounded families; unrecognized values collapse to safe categories. New inherited
instrumentation is not automatically authorized by appearing in upstream code: it must either map to
an existing Scient event or be explicitly reviewed and added to the Scient contract.

The detailed current event schema and tests live in `packages/scient-analytics`. Historical design
and capability evidence remains in
[`docs/reports/scient-specific-capabilities.md`](../reports/scient-specific-capabilities.md).
