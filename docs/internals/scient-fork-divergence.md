# Scient conversation fork: design, provenance, and T3 divergence

This document is the maintenance contract for Scient's conversation-fork
feature. It records what the feature promises, which parts Scient owns, and the
small set of T3-owned seams that an upstream merge may touch.

## Product behavior

From the Fork action beside either a sent user message or a completed assistant
response, a user can create a new conversation at that exact point. The origin
conversation continues independently. `/fork` captures the running turn when
one is active, otherwise it selects the latest completed assistant response.

- Forking an assistant response retains the transcript through that response.
  The destination waits for the user's next message.
- Forking a user message retains only the completed transcript before that
  message. The selected text and images are restored as an unsent, persisted
  destination composer draft so the user can edit or send it deliberately.
  The server never sends the clicked message. The origin answer and all later
  history are excluded.

Every path opens one confirmation form. It proposes the server's next automatic
fork title, which the user may replace. Leaving the proposal untouched keeps
title allocation on the server, so concurrent forks still receive a
collision-safe number. The preview includes active and archived siblings in the
origin project and uses captured fork lineage to recognize generated numbering.
**New worktree** is off by default. Turning it on creates
a dedicated Git worktree at the selected historical checkpoint, or a frozen
current-file snapshot for a running-turn fork. It is available only when that
baseline can be captured safely. Leaving it off
keeps the conversation branch independent while using the origin project's
current workspace; it does not rewind local files.

The new conversation shows the retained transcript prefix. Its first provider
turn uses a native fork only when the destination's frozen proof establishes complete
source ownership and an exact provider boundary. Codex and Claude have qualified
exact-boundary proof paths; weak or incomplete evidence selects portable delivery.
Otherwise, it starts a fresh provider session and receives bounded context from
the saved transcript. The provider session tip alone does not establish a safe
historical fork boundary.

The client navigates to the new conversation only after durable provisioning
has completed. A failed fork is returned as an error instead of exposing a
half-ready conversation as successful.

The destination also inherits safe, durable right-panel intent: files, diffs,
pull requests, Agents, Sources, source PDFs, and portable Scient artifacts.
Live terminal sessions are intentionally dropped. Live browser tab identities
are replaced by one fresh browser surface rather than reusing another thread's
session. Workspace-backed or attachment-backed transient artifact surfaces are
dropped. Open attachment previews use the server's durable copy receipt to
switch to fork-owned attachment IDs; attachments outside the retained prefix,
or without a verifiable mapping from an older server, are omitted. This receipt
survives client reloads with the pending fork attempt.

PDF reading state belongs to the thread as well as the document. The fork copies
the origin's current reading state once, then the two conversations navigate
independently even in a shared workspace. For a separate worktree, the client
freezes file-PDF viewports at handoff and seeds the destination paths before
mounting their viewers. Seeding happens when the fork is created, before the
client switches to it, because a PDF viewer records its own position as soon
as it opens. If the fork's folder is not yet known then (for example after a
reload), only that fork's right panel is held until its positions are applied,
once. Other threads and later folder changes never hide or remount the panel. Repeated restoration never overwrites a destination's
newer position. Continuity is best-effort and cannot make a provisioned fork fail.

The fork lifecycle has three separate readiness milestones:

1. **Server provisioning complete:** the durable fork workflow has created and
   verified the destination thread, retained transcript, attachments, and
   requested workspace substrate.
2. **Route selected:** after the server receipt, the client opens the destination
   route. The route may still be loading its authoritative detail subscription.
3. **Thread visible:** the destination detail has reached the client store and
   the route renders the conversation.

These milestones must not be collapsed into a fixed delay or treated as
interchangeable. There is no five-second visibility deadline. An absent sidebar
entry is not evidence that a thread is missing: only an explicit deletion from
the detail subscription permits the missing-thread redirect. This also permits
opening archived originals through the lineage marker.

The clicked message ID is the public boundary. The server validates its role
and durable projection, then resolves the completed conversation boundary and
checkpoint authoritatively; the client never supplies those implementation
details. A first user message legitimately produces an empty retained prefix and becomes the
destination's unsent draft. Re-forking inherited history uses the destination's frozen items;
its workspace baseline cannot substitute for an earlier historical checkpoint. A user can fork a sent
message or the latest completed response while a newer turn is active. Git
checkpoint availability only decides whether the independent-worktree choice
is eligible; same-workspace conversation forks also work in non-Git projects.
Explicitly addressed archived origins remain readable for this decision;
deleted origins do not.

## Native V2 reliability model

The message-boundary RPC enters
[`ConversationForkService`](../../apps/server/src/orchestration-v2/scient-fork/ConversationForkService.ts).
It hydrates legacy source facts through `LegacyV1ThreadImporter`, then uses
[`ConversationForkPlan`](../../apps/server/src/orchestration-v2/scient-fork/ConversationForkPlan.ts)
to freeze the exact retained prefix. Native/MCP `thread.fork` enters `ThreadForkService` and uses
the same planner. Native run-fork and Scient's checkpoint/worktree choice are distinct policies.

1. The service checks the owning project, source message/run, actual workspace, retained
   attachments, and checkpoint eligibility. Source and destination thread locks use a stable
   order. Automatic titles are allocated on the server; a preview is not permission to use
   stale dependencies.
2. The plan allocates destination-owned messages, items, context, and attachment identities.
   Copied facts have causal lineage but no executable source run, live callback, or provider-native
   item authority. System messages and submitted question answers remain inert historical facts.
   Historical answer-file references do not themselves reattach bytes; retained projected
   attachments follow the separate verified copy and destination-ownership path.
3. `EventSink` commits the destination, copied prefix, lineage/context-transfer facts, command
   receipt, and `scient-fork.provision` outbox effect together. `conversationFork` metadata owns
   provisioning status; the old Scient lineage table/reactor is not the live authority.
4. The V2 effect worker calls `ConversationForkService.provision` to copy and verify attachment
   bytes and create/verify the requested worktree from the frozen checkpoint. Deterministic
   identities allow recovery and retry. A changed existing worktree is not adopted or erased.
5. Only verified substrates produce `ready`. Dispatch waits on persisted metadata/events before
   returning the attachment-ID map. A transient failure remains retryable with the same command;
   retry schedules provisioning again. Terminal failure records abandonment/deletion and cleanup.
   Process-loss recovery requeues safe provisioning effects; live events are wakeups, not authority.
6. Turn admission rejects an unready destination. First provider delivery lazily resolves the
   context transfer to exact native continuity or a bounded portable handoff. The frozen
   destination history remains usable if the source is later edited or deleted.

Conversation-only forks share current files without rewinding them. A new worktree requires a
verified historical checkpoint, or a frozen current-file capture for a running cut. Capturing files
and copying the transcript are separate operations while the source keeps running; neither claims
an atomic snapshot of an external provider and the filesystem. Re-forking copied history uses the
local frozen prefix rather than borrowing mutable ancestor projections. Rollback preserves that
inherited prefix.

A running local fork has no fork-time file ref or OID. Its first provider turn captures the
destination's own execution baseline after any intervening file edits. File rewind requires that
exact baseline; a missing ref never substitutes `HEAD`, and shared-workspace restore remains
subject to the V2 ownership guard. Completed forks still retain the selected historical snapshot.

Pre-admission file publication uses `scient_fork_checkpoint_ownership`, a separate internal
resource journal in the V2 database. Each attempt reserves a unique ref and persists its expected
OID before Git can publish it. Scope release and background recovery at startup consult the accepted V2 receipt and
destination metadata. An attempt that was never accepted, or whose command was accepted with
another attempt's snapshot, compare-deletes only its own unchanged ref. A changed ref, or an
accepted destination whose metadata no longer matches, keeps its Git ref while its journal row
is closed. A row stays for a later start only when its workspace is unavailable or its release
fails or times out (for example a locked ref); a live attempt is never reconciled. Journal recovery does not delete branches or worktrees. Accepted retries continue using their frozen ref and OID.
Source/destination command locks retain their stable order. Global title serialization covers
authoritative sibling reads and atomic admission, so another source's local fork can proceed
during a slow file capture.

Running native-text capture has a 90-second pre-admission deadline, matching the file-capture
bound. Expiration releases the fork token without retiring the original run. SQL facts already
committed by its consumer remain valid. Accepted provisioning continues under durable receipts;
this deadline does not reject or cancel an accepted destination.

Ordinary execution baselines, completed-turn checkpoints, and running-worktree forks share the
same bounded capture substrate. Changed paths are consumed incrementally with backpressure:
128 MiB of listing bytes, 250,000 records (including rename sources), and 1 MiB per record.
The 512 MiB per-file, 1 GiB changed-byte, and 90-second whole-capture limits remain. Diagnostic
buffer truncation is independent of enumeration completeness. Publication transfers only objects
new to the private staging repository, preserves Git's loose/packed transfer policy and object
format, and checks connectivity before publishing the ref. Private indexes and staging files are
scoped resources. These limits do not make a workspace containing tens of gigabytes eligible;
workspace ignore rules and maintenance remain separate user decisions.

### Client operation identity and eligibility

User-message forks prepare images before creating the command or destination draft. Unsupported
non-image attachments fail. Unreadable images may be omitted only with explicit user consent;
without a confirmation callback the fork refuses to proceed. The client stages the destination's
text and prepared images in the composer store and flushes draft persistence before saving and
dispatching the attempt. An uncertain outcome retains the draft; a dispatched attempt discards
it only on confirmed rejection or abandonment.

`orchestration.getForkOptions` is a read-authorized, capability-gated query
(`threadForkRecovery`). It resolves either a specified user/assistant message
or, when neither is supplied, the latest completed assistant boundary. It
checks retained attachment availability and distinguishes an existing local
workspace from a resolvable Git checkpoint. Both the preview and submission
use this query; V2 admission and the provisioning service remain the final authority
because dependencies can change after a preview.

`forkAttempt.ts` journals the exact command, environment, destination, display
title, and handoff milestones under `scient:fork-attempt:v1:` in client storage.
The key includes environment, original thread, and fork entry point. A retry
uses the saved command even if a caller supplies different options. No prompts,
file bytes, or authorized asset URLs are duplicated into this journal; drafts
remain in the existing composer store. Journal writes must succeed before
dispatch. Origin-scoped in-memory ownership survives hook remounts, with Web
Locks preventing concurrent operations in other tabs of the same profile.

Fork dispatch errors carry an optional `forkDisposition`. `rejected` means a
known command rejection; `abandoned` means terminal compensation; `failed`
means provisioning is retryable; `pending`/`provisioning` mean work exists;
`ready` proves completion. Missing evidence is `unknown`, never rejection.
Transport errors without this field preserve both the command and draft.
Once ready, retry only performs the client handoff and navigation. Optional
panel continuity cannot turn a ready fork into a failed creation.

After provisioning succeeds, the source dialog removes its subtree before the
draft handoff and navigation. A layout commit confirms that removal; navigation
does not depend on an animation-completion callback or a fixed delay. Leaving
the source or unmounting cancels the pending navigation, while a navigation
failure reopens the same retry form.

Errors and retries stay inside the existing confirmation form. Title and
workspace inputs are locked while resuming an unresolved operation. Navigating
elsewhere or unmounting the hook does not cancel accepted server work and does
not allow its completion to steal navigation. An unfinished client handoff is
resumed from the same Fork action; deliberate new forks are possible after the
previous handoff has completed.

Automatic names remain server-allocated and custom titles remain authored
command data. Renaming either thread never changes lineage identity. The
marker links by environment and original thread ID, not by title. Provider
selection remains the ordinary model-picker operation on a destination with
no provider session. The provider-switch handoff moves the ordinary draft only
when its prompt and attachment identity still match the captured SHA-256 fingerprint;
changed drafts, queued messages, queue-edit drafts, and queue order remain in
their original conversation. Forking emits no turn-start request.

### History and workspace fidelity

Retained messages and items are bounded by the selected source's durable position, including
system messages: later system facts cannot leak into an earlier fork. The V2 planner remaps
message/item/context identities and clears live native execution references. Its local frozen
prefix, rather than an ancestor lookup, owns re-fork and rollback history.

Attachment copies publish by rename only after size verification. Retries can
reuse a complete destination-owned attachment even if the original was removed
after copying. Temporary `.part` files are cleaned on ordinary completion or
failure and use the existing stale-partial sweep after a crash. A missing
attachment is never silently omitted to make a fork appear successful.

A local fork requires its actual workspace directory. If an original worktree
was removed, an explicitly selected new-worktree fork may resolve the historical
checkpoint from the owning project repository. It never falls back to another
workspace for a local request. Provider initialization remains independent of
Git availability for valid non-Git local workspaces.

## Implementation and protected seams

| Owner                                                                                                         | Current role                                                                |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `orchestration-v2/scient-fork/ConversationForkService.ts`                                                     | Message-boundary options, durable admission, provisioning, retry, readiness |
| `orchestration-v2/scient-fork/ConversationForkPlan.ts`                                                        | Exact destination-owned prefix and attachment/context remapping             |
| `orchestration-v2/scient-fork/ConversationForkNativeSource.ts`                                                | Frozen native ownership and boundary proof                                  |
| `orchestration-v2/scient-fork/ForkAttachmentCopier.ts`, `ForkCheckpointBaseline.ts`                           | Verified bytes and checkpoint/worktree substrate                            |
| `orchestration-v2/ThreadForkService.ts`, `Orchestrator.ts`                                                    | Native run-fork, lineage/context transfer, admission, merge-back            |
| `orchestration-v2/EventSink.ts`, `ProjectionStore.ts`, `EffectWorker.ts`                                      | Atomic persistence, read models, provisioning execution                     |
| `orchestration-v2/ProviderTurnStartService.ts`, `ProviderSessionManager.ts`                                   | Native clone or portable context, exact-session delivery and recovery       |
| `orchestration-v2/ContextHandoffBudget.ts`, `ContextHandoffDelivery.ts`                                       | Whole-item selection, target allowance, delivery evidence                   |
| `orchestration-v2/legacy/`, `persistence/Layers/Sqlite.ts`                                                    | Legacy hydration and immutable migration compatibility                      |
| `ws.ts`, `packages/client-runtime/src/operations/commands.ts`                                                 | Retained message-boundary wire routing and client operation                 |
| `apps/web/src/components/scient-fork/forkAttempt.ts`, fork hooks/dialog, timeline and right-panel integration | Dialog, draft journal, navigation, and safe continuity                      |

Server paths above are relative to `apps/server/src/`. Extend these live services, not V1
`forkDecider`, `OrchestrationEngine`, `ProjectionPipeline`, `ScientForkReactor`, or
`ProviderService`. Files with V2-looking names are not sufficient evidence of production reachability;
check `runtimeLayer.ts` and callers. Legacy SQL tables and Scient migration IDs remain compatibility
boundaries; their historical execution machinery is superseded.

### Extracted owners and host mounts

The separation map below describes the adopted source, not a proposed move or a qualification
receipt. Keep generic host orchestration/rendering in place and compose the named Scient policies
at narrow mounts. An owner name alone does not prove that its branch is live; follow its callers
and the deciding ownership conditions. Apply the
[extraction continuation rules](./upstream-alignment-protocol.md#keep-scient-implementation-outside-upstream-hosts)
when changing these boundaries.

#### Orchestration policies

These hosts are under `apps/server/src/orchestration-v2/`. The extracted policy owners are in
[`scient-fork/`](../../apps/server/src/orchestration-v2/scient-fork/), alongside the fork service,
repositories, independent schema/migrator and context-history helpers.

| Host mount                                                 | Extracted owners                                                                                                                                                  | Boundary to preserve                                                                                             |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `EventSink.ts`                                             | `CommitPublication.ts`, `NativeModelContextWindow.ts`, `PendingStartOwner.ts`, `sourcePlanConsumption.ts`, `committedQuestionAnswers.ts`, `runningForkSource.ts`  | Transactional current-owner checks, canonical append/projection/outbox, masked commit and both publication buses |
| `Orchestrator.ts`                                          | `RunStartDecisions.ts`, `SettingExecutionOwner.ts`, `ProviderWorkAdmission.ts`, `DroidHeldSteer.ts`, `CheckpointRollbackCompletion.ts`, `ConversationForkPlan.ts` | Thread-lock admission, captured queued modes, busy-owner preservation, held-steer and rollback ordering          |
| `ProviderTurnStartService.ts`                              | `PortableTurnStart.ts`, `PendingStartOwner.ts`, `NativeModelContextWindow.ts`                                                                                     | Stop-before-offer checks and frozen native-or-portable history delivery                                          |
| `ProviderTurnControlService.ts`                            | `PendingStartInterrupt.ts`                                                                                                                                        | Pending-start interruption uses observed native receipts, not invented turn identity                             |
| `RunExecutionService.ts`                                   | `RunExecutionFinalization.ts`, `NativeWorkflowOwnership.ts`, `PendingStartOwner.ts`, `runningForkSource.ts`                                                       | Exact root-attempt finalization, subscription lifetime and transferred workflow ownership                        |
| `ThreadForkService.ts`                                     | `ConversationForkPlan.ts`, `ConversationForkNativeSource.ts`, `ConversationForkBoundaryItem.ts`                                                                   | Destination-owned prefix and exact native boundary proof                                                         |
| `ThreadManagementService.ts`                               | `ThreadDispatchCloneGuard.ts`                                                                                                                                     | Reject unavailable clone state before hydration/native dispatch                                                  |
| `ProjectionStore.ts`, `EffectWorker.ts`                    | `RollbackAttachmentRetention.ts`, `ConversationForkService.ts`                                                                                                    | Retained attachment references and durable provisioning, not a second execution authority                        |
| `ContextHandoffBudget.ts`, `ScientContextHandoffPolicy.ts` | `context/historicalItems.ts`, `context/handoffBudget.ts`                                                                                                          | Whole-item history selection and Scient preset allowance                                                         |

`scient/orchestration/TerminalQueueHold.ts` remains the server terminal hold policy mounted by the
orchestrator. `scient/skills/ScientV2SkillTurn.ts` and `ScientSkillSession.ts` own trusted skill
preparation/session behavior at turn-start and control mounts. The retained `legacy/` readers
are import/recovery boundaries, not replacements for these execution services.

#### Provider session and adapter policies

Session and adapter policies live in
[`orchestration-v2/scient-provider/`](../../apps/server/src/orchestration-v2/scient-provider/).
The adapter still owns its native provider protocol.

| Host mount                                              | Extracted owners                                                                                                             | Boundary to preserve                                                                                  |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `ProviderSessionManager.ts`                             | `StartupSessionHold.ts`, `SessionRetirement.ts`, `SessionAuthority.ts`, `ProviderTextSnapshots.ts`, `PiSessionFileLeases.ts` | Exact runtime/generation admission, physical release/join, text-snapshot consumers and Pi file leases |
| `Adapters/CodexAdapterV2.ts`                            | `CodexNativeSession.ts`, `CodexPresentation.ts`, `ProviderTextSnapshots.ts`, `NativeTurnReceipts.ts`                         | Launch-scoped capacity/selection, offered-versus-accepted receipt and native presentation             |
| `Adapters/ClaudeAdapterV2.ts`, `OpenCode2AdapterV2.ts`  | `ClaudeWorkflowMemberPresentation.ts`, `OpenCodeTurnAcceptance.ts`                                                           | Coordinator-owned workflow observations and provider-confirmed prompt boundaries                      |
| `Adapters/PiAdapterV2.ts`                               | `PiInputCapabilities.ts`, `PiNativeSelection.ts`, `NativeTurnReceipts.ts`                                                    | Native input eligibility and confirmed selection without moving Pi protocol/FS reads                  |
| `Adapters/NativeSessionAdapterV2.ts`, `OmpAdapterV2.ts` | `NativeProducerLifecycle.ts`, `NativeTurnReceipts.ts`, `OmpProcessOwnership.ts`                                              | Retained native producers and OMP process ownership; Pi remains a separate protocol                   |

Provider-layer mounts also retain their Scient-specific owners:
[`AcpRegistrySupport.ts`](../../apps/server/src/provider/acp/AcpRegistrySupport.ts) composes
`ScientAcpRegistryOwnership.ts`; `acp/AcpSessionRuntime.ts` composes
`ScientAcpConfirmedConfigWrites.ts`. `provider/Errors.ts` exposes the live input-validation error
from `ScientProviderErrors.ts`. Native shutdown and the OMP driver/runtime remain the physical
resource owners described in [provider lifecycle](./provider-lifecycle.md) and
[providers](./providers.md); moving a policy helper does not certify their cleanup.

#### Contracts, transport and composition

| Host mount                                                           | Current Scient-owned modules                                                                                                                                                                                                       |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/orchestrationV2.ts`, `rpc.ts`, `settings.ts` | [`contracts/src/scient/`](../../packages/contracts/src/scient/): V2 fork/schema additions; scientific, skill, provider-connection, custom-model, file-opening and document-PDF RPCs; provider/compute settings and thread sections |
| `packages/contracts/src/environmentHttp.ts`, `ipc.ts`                | `scient/environmentHttpGroups.ts`, `desktopBridge.ts`, `desktopPreview.ts`, `desktopVoiceBridge.ts`; generic HTTP/IPC schemas stay in their hosts                                                                                  |
| `apps/server/src/ws.ts`                                              | `orchestration-v2/scient-fork/ConversationForkRpcHandlers.ts`; `scient/` provider-lifecycle, file-opening, document-export, scientific and compute RPC handlers; workspace entry/error and project-folder policies                 |
| Server layer/WS service composition                                  | [`ScientServerLayers.ts`](../../apps/server/src/scient/ScientServerLayers.ts), `ScientWsServices.ts`, `ScientRpcObservers.ts`, `ScientAssetUrls.ts`; individual capability HTTP modules remain under `scient/`                     |

These are mounts into the existing public contracts and composition graph, not parallel private
transport schemas. Preserve public encoding, endpoint registration and current error semantics.

#### Web and desktop surfaces

Web capability owners are under [`apps/web/src/scient/`](../../apps/web/src/scient/). Their hooks
and components compose into the existing host surface; the directories below group related owners,
not a requirement to relocate the whole host.

| Host surface                           | Current extracted owners                                                                                                                                                                                                                                                     |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ChatView.tsx`                         | `fork/chatViewFork.tsx`, `chat/` request-error/agent-panel/token-limit/revert diagnostics, `rightPanel/`, `skills/useEffectiveActiveProviderSkills.ts`, `compute/useComputeOwnedSurfaces.ts` and `chatComputeFigureFollower.tsx`, `fileSurfaces/useChatSurfaceSaveGuards.ts` |
| Composer/session queue mounts          | `threadQueue/` submission, extracted-intent send, edit session, native edit item, optimistic presentation and strip; `sessionLogic/providerOptions.ts` and `skills/` policies                                                                                                |
| Markdown/message rendering             | `images/scientMarkdownImage.tsx`, `markdown/`, `math/`, `bidi/`, `presentation/` and `clipboard/`; generic Markdown image classification/context/direct-media/workspace fallback remains in `ChatMarkdown.tsx`                                                               |
| File/editor/viewer mounts              | `fileSurfaces/` editor bindings, lazy surfaces, read recovery and viewer refresh; `fileOpening/`, `files/`, `markdownEditor/`, `pdf/` and `latex/`; upstream file/runtime helpers remain with their hosts                                                                    |
| Command palette/sidebar mounts         | `commandPalette/scientCommandPalette.tsx`, `sidebar/` and `sections/`; retain the complete await → currentness check → side-effect continuation in the owning callback                                                                                                       |
| Settings mounts                        | `settings/` navigation/visibility and feature-owned settings rows under `skills/`, `providerConnection/`, `analytics/`, `bidi/`, `keyboard/`, `typography/`, `wordExport/` and `onboarding/`                                                                                 |
| Desktop settings/backend/window mounts | [`settings/scientDesktopSettings.ts`](../../apps/desktop/src/settings/scientDesktopSettings.ts), `backend/scientAnalyticsMetadata.ts`, `backend/scientBackendLaunch.ts`, `window/scientMainWindowSizing.ts`; native launch and window lifecycle stay in their desktop hosts  |

The map is source ownership evidence only. It does not replace public-codec, SQL/rollback, provider
lifetime, packaging or manual UI acceptance evidence, and it does not turn source-text seam guards
into behavior tests.

### Live Scient migration preflight

[`Sqlite.ts`](../../apps/server/src/persistence/Layers/Sqlite.ts) still invokes the independent
[`scientMigrator.ts`](../../apps/server/src/orchestration-v2/scient-fork/scientMigrator.ts) runner.
Keep `scient_schema_migrations` separate from upstream's ledger and preserve its immutable ID/name
manifest. Before applying migrations, the runner transactionally reconciles legacy `applied_at`
ledgers into the canonical shape without losing their timestamps, applies the explicitly coded
former-import-17 compatibility repair, and validates the recorded ledger. Gaps, changed names,
and future IDs fail before migration: accepted rows must be a contiguous prefix of the manifest.
These bounded compatibility repairs do not authorize general renumbering or ledger rewriting.

## Provider context delivery

`ConversationForkNativeSource` freezes ownership proof into destination metadata. Admission and
`ProviderTurnStartService` recheck the selected instance, driver, capabilities, source root run,
accepted attempt, provider thread, and inclusive boundary. Codex requires a strong native turn.
Claude can use a canonical non-synthetic root assistant UUID only with matching recorded boundary
and retained ownership evidence. Incomplete prefixes, imported history, running cuts, provider
changes, and unsupported exact boundaries use portable context. An unavailable native clone
falls back to the destination-owned prefix rather than pretending a session tip is equivalent.

V2 persists `ContextTransfer` and `ContextHandoff` facts through `EventSink`. Transfers record
native or portable resolution; handoffs record delivery to a particular native thread. The session
manager owns live scopes and credentials. Context delivery persists `pending` before injection or
inline send and `injected`/`inline` after acceptance. Ambiguous pending delivery requires a fresh
native thread before retry. A command receipt alone is not proof of native history acceptance.

Portable delivery keeps eligible history items whole. Selection prioritizes the latest user item,
latest assistant item, and original user item, then fills from newest to oldest; selected items
are rendered in chronological order. Oversized items are omitted, never truncated into anchors.
The default allowance is 16,000 tokens with a 64,000-byte ceiling, reduced for the target model
window, current native occupancy, current input, attachments, and headroom. Cost includes encoded
wrappers and attribution and uses a conservative byte estimate. This supersedes the V1 Settings
preset/JSON-preamble/truncated-anchor algorithm. See [context handoffs](./context-handoffs.md).

The retained app prefix can include reasoning and tool facts even when portable provider delivery
cannot replay them. Historical callbacks and approvals never become active execution. The recovery
pointer names `scient_thread_read` and omitted item identities. Native session parity is an optional
proved strategy, not a promise made by a textual handoff.

### Running-turn forks

Scient's message-boundary service can capture a running cut in addition to completed boundaries.
The planner freezes the retained durable items as partial history and excludes later output.
Already-persisted image attachments are remapped and copied with the retained prefix.
The superseded V1 live-image/flush helpers are not a native execution dependency.
A new-worktree request captures
current files into a frozen ref before provisioning; retries use that captured ref. Pending tool,
approval, or question state is copied only as history. A native clone needs a completed exact root
boundary, so a running cut takes the portable path. Source execution continues independently.

## Copy cost and request recovery

`ConversationForkPlan` copies the retained durable work log as destination-owned facts in the V2
admission transaction. Do not prune tool-progress rows merely to reduce copy size: timeline
presentation depends on their ordering, titles and payload. Provider delivery may omit whole
items for context capacity without deleting app history.

The client journals the command/destination identity before dispatch. An uncertain transport
outcome retains that identity and the unsent draft; retry reads the durable command receipt and
provisioning status. Once the server is ready, retry resumes only client handoff/navigation.
Closing the dialog cannot cancel committed server work or let its completion steal navigation.

## Omitted-history recovery: `scient_thread_read`

A fork's first provider turn receives a bounded transcript, so older messages
can be omitted. The Scient MCP tool `scient_thread_read` lets the model read them
back from native V2 projections. Its shipped input fields, defaults and paging
semantics are preserved. It keeps the narrow `threads:read` grant and performs
no delegated-result acknowledgment. Orchestration's `scient_thread_inspect`
requires the separate `orchestration` grant: it includes run metadata, can read
explicitly user-attached context threads, and acknowledges a direct child's
terminal result when the complete result is read. Both tools are registered
under distinct names and retain honest side-effect annotations.

- Input: `threadId` (required), `view` (`messages` default, or `activity`),
  `afterPosition` (exclusive), `limit` (1–100, default 50), `itemId`,
  `textOffset`, `maxCharsPerItem` (1–50,000, default 20,000), and `runLimit`.
  `runLimit` is accepted for input compatibility and ignored by this reader;
  `scient_thread_inspect` supplies run history.
- Output: a V2-compatible subset. `thread` includes identity, project, title,
  V2-vocabulary `status`, model, modes, fork parent, `itemCount`, and archive
  state. `items` carry `position`, `itemId`, `type`, `status`, `title`,
  `activityKind`, `messageId`, `turnId`, windowed `text`, `textTruncated`,
  `nextTextOffset`, and timestamps. The page also returns `nextPosition` and
  `hasMore`. There is no `recentRuns` field.
- Timeline: messages of every role, proposed plans, and tool/activity items
  are paged through `ProjectionStoreV2.getTimelinePage`.
  Direct item lookup and paging do not inherit the UI's 500-activity limit.
  Internal fork hydration explicitly requests full retained activity history;
  ordinary UI reads remain bounded. Native projection positions preserve local
  and inherited timeline order in both views. The `messages` view returns user
  messages, assistant messages, and proposed plans. The `activity` view also
  returns reasoning, system messages, and activities. An activity is rendered
  as its kind and summary followed by its payload. `maxCharsPerItem` bounds
  the returned text window; `textOffset` can reach the full stored payload.
- Paging follows V2: `nextPosition` is the last returned position and is null
  only when the page is empty, and `hasMore` tells whether to continue. The
  `itemId` option ignores `view` and `afterPosition`. `textOffset` applies only
  with `itemId`. Offsets count UTF-16 code units.
- Authority: the `threads:read` session grant is issued to every
  MCP-injected provider session. The calling thread comes from the host-issued
  invocation. It may read itself or a non-deleted thread, including an archived
  one, in the same project. Other projects fail with `thread_outside_project`.
  A projectless thread can read only itself. A fork reads its own copied
  transcript even after the origin is deleted. Explicitly user-attached context
  from other projects is available only through orchestration inspection.
  Historical imports may lazily materialize the projection before reading it;
  reading never acknowledges delegated-child completion or starts work, so the
  tool is annotated read-only.

## Safety and bounded compromises

- Message-boundary forks require a durable sent user message or completed assistant response;
  the separate running-cut path captures partial history. Native run-fork also accepts
  provider-finished waiting/failed/interrupted/cancelled runs, with portable fallback. Invalid, stale, unknown, or streaming message IDs fail closed.
  A newer streaming turn is excluded from the retained prefix rather than
  blocking an older fork point.
- A new worktree fails closed if the historical Git checkpoint is unavailable
  (a running-turn fork snapshots the current files instead).
- Rollback never removes a fork's destination-owned inherited prefix; copied facts are history,
  not executable source runs.
- An untouched proposed title is recomputed by the server at commit time. Only
  an explicit non-empty user edit bypasses automatic numbering.
- Same-workspace mode is honest about sharing current files; only its
  conversation and checkpoint lineage are independent.
- A fork requires a real owning project. Legacy projectless records fail
  closed rather than inventing a workspace or project during replay.
- Every retained attachment gets a new fork-owned ID and verified file copy, so
  deletion or cleanup of the origin cannot invalidate the fork.
- Portable handoffs keep whole items within a model-window-derived budget and
  account for encoded delivery wrappers; omitted items stay readable through `scient_thread_read`.
- Provider acceptance cannot be made globally exactly-once without provider
  idempotency. Scient therefore re-delivers uncertain context on a fresh
  native thread. The prior runtime may have accepted work before the connection failed;
  the durable delivery record cannot manufacture a globally exactly-once guarantee.
- Right-panel continuity copies only safe descriptors. It never reuses a live
  terminal or browser session, never persists authorized URLs, and expires
  pending PDF remaps after seven days.
- A transiently failed durable fork remains recoverable and can be retried in
  place or after restart. A terminally impossible fork is compensated and never shown as a
  usable thread.
- Shared contracts, client runtime, and server behavior are mobile-ready. This
  change intentionally adds no mobile fork UI.

## Upstream update procedure

Before each T3 merge:

1. Fetch the current official T3 head and merge its real history normally.
2. Search the marked T3-owned seams and compare them with this manifest.
3. Resolve conflicts in favor of T3's improved generic behavior, then restore
   only the smallest still-required Scient hook.
4. Check whether T3 added native fork behavior or a generic extension point. If
   so, migrate and delete the corresponding divergence instead of duplicating it.
5. Run fork-focused contract, server, client-runtime, and web tests plus the
   affected package typechecks and a clean merge rehearsal.

The target is not zero changes to T3-owned files at any cost. The target is the
smallest explicit, well-tested change that preserves product quality without
building a parallel generic platform.

## Verification checklist

Qualify through live V2 owners, not tests of the removed V1 engine or provider service:

- `ConversationForkPlan.test.ts`, `ConversationForkService.test.ts`, and `ThreadForkService.test.ts`:
  exact first/latest/user/running boundaries, frozen prefix, identity, non-Git and workspace choices.
- `ConversationForkHistoricalTurn.integration.test.ts`, `ConversationRunForkPrefix.integration.test.ts`,
  `ConversationForkSystemAttachments.integration.test.ts`, and native answer/boundary suites:
  imported/re-forked prefixes, inert callback answers, system facts, and owned attachment bytes.
- `ConversationForkNativeSource.test.ts`, `ConversationForkNativeContinuity.integration.test.ts`,
  `ConversationForkClaudeBoundary.integration.test.ts`, and provider replay gates:
  exact native proof, target changes, unavailable cloning, portable fallback, and source deletion.
- `ContextHandoffBudget.test.ts`, `ContextHandoffService.test.ts`, `EffectWorker.test.ts`, and
  `ProviderTurnStartService.test.ts`: whole-item budgeting, uncertain delivery, provisioning recovery,
  durable receipts, and first-turn readiness.
- Client-runtime and web fork tests: single-form errors/retry, staged unsent draft, ownership through
  remount/reload, route visibility, safe panels, and independent PDF reading state.

Preserve immutable migration/import tests separately. Synthetic/replay coverage does not establish
real-provider compatibility, packaged-platform support, or the user's visual acceptance.
The prototype and hardening history remain in Git; [historical PR descriptions](./scient-fork-pr-descriptions.md)
retain the former V1 implementation narrative.
