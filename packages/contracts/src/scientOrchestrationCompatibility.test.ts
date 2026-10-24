import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { CommandId, ProjectId } from "./baseSchemas.ts";
import { isProviderSendTurnSupportedImageMimeType } from "./chatAttachment.ts";
import { OrchestrationGetTurnDiffInput, ThreadTurnDiff } from "./checkpointDiff.ts";
import {
  OrchestrationEvent,
  OrchestrationSession,
  ProjectCreatedPayload,
  ProjectMetaUpdatedPayload,
  ThreadCreatedPayload,
  ThreadMessageSentPayload,
  ThreadMetaUpdatedPayload,
  ThreadTurnStartRequestedPayload,
} from "./legacy/orchestrationEvent.ts";
import { ModelSelection } from "./modelSelection.ts";
import { OrchestrationDispatchCommandError } from "./orchestrationDispatch.ts";
import { OrchestrationProjectShell } from "./orchestrationProject.ts";
import {
  ProjectFaviconPath,
  ProjectIconOverride,
  ProjectUpdatePayload,
  ReceivedProjectIcon,
  StoredProjectIcon,
} from "./project.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { DEFAULT_PROVIDER_INTERACTION_MODE, DEFAULT_RUNTIME_MODE } from "./providerPolicy.ts";
import {
  OrchestrationLatestTurn,
  OrchestrationMessage,
  OrchestrationProposedPlan,
} from "./scientConversationView.ts";
import { OrchestrationThread, OrchestrationThreadShell } from "./scientOrchestrationSnapshot.ts";
import { ThreadLinkedPullRequest } from "./threadPullRequest.ts";
const decodeCommandId = Schema.decodeUnknownEffect(CommandId);
const decodeProjectFaviconPath = Schema.decodeUnknownEffect(ProjectFaviconPath);
const decodeProjectCreatedPayload = Schema.decodeUnknownEffect(ProjectCreatedPayload);
const decodeProjectMetaUpdatedPayload = Schema.decodeUnknownEffect(ProjectMetaUpdatedPayload);
const decodeOrchestrationMessage = Schema.decodeUnknownEffect(OrchestrationMessage);
const decodeThreadMessageSentPayload = Schema.decodeUnknownEffect(ThreadMessageSentPayload);
const decodeThreadTurnStartRequestedPayload = Schema.decodeUnknownEffect(
  ThreadTurnStartRequestedPayload,
);
const decodeOrchestrationLatestTurn = Schema.decodeUnknownEffect(OrchestrationLatestTurn);
const decodeOrchestrationProposedPlan = Schema.decodeUnknownEffect(OrchestrationProposedPlan);
const decodeOrchestrationSession = Schema.decodeUnknownEffect(OrchestrationSession);
const decodeOrchestrationThread = Schema.decodeUnknownEffect(OrchestrationThread);
const decodeOrchestrationThreadShell = Schema.decodeUnknownEffect(OrchestrationThreadShell);
const decodeThreadCreatedPayload = Schema.decodeUnknownEffect(ThreadCreatedPayload);
const decodeOrchestrationEvent = Schema.decodeUnknownEffect(OrchestrationEvent);
const decodeThreadMetaUpdatedPayload = Schema.decodeUnknownEffect(ThreadMetaUpdatedPayload);

it.effect("trims branded ids and retained project fields at decode boundaries", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProjectCreatedPayload({
      projectId: " project-1 ",
      title: " Project Title ",
      workspaceRoot: " /tmp/workspace ",
      defaultModelSelection: {
        provider: "codex",
        model: " gpt-5.2 ",
      },
      scripts: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(yield* decodeCommandId(" cmd-1 "), "cmd-1");
    assert.strictEqual(parsed.projectId, "project-1");
    assert.strictEqual(parsed.title, "Project Title");
    assert.strictEqual(parsed.workspaceRoot, "/tmp/workspace");
    assert.deepStrictEqual(parsed.defaultModelSelection, {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.2",
    });
  }),
);

it.effect("decodes historical project.created payloads with a default provider", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProjectCreatedPayload({
      projectId: "project-1",
      title: "Project Title",
      workspaceRoot: "/tmp/workspace",
      defaultModelSelection: {
        provider: "codex",
        model: "gpt-5.4",
      },
      scripts: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.defaultModelSelection?.instanceId, "codex");
  }),
);

it.effect("decodes project.meta-updated payloads with explicit default provider", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeProjectMetaUpdatedPayload({
      projectId: "project-1",
      defaultModelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.defaultModelSelection?.instanceId, "claudeAgent");
  }),
);

// Attachments ride on persisted events and thread streams with no client
// version negotiation. A type this build does not know must decode instead of
// failing the whole message.
it.effect("tolerates attachment types from newer builds when decoding messages", () =>
  Effect.gen(function* () {
    const futureAttachment = {
      type: "somethingnew",
      id: "thread-1-00000000-0000-4000-8000-000000000003-glb",
      name: "scene.glb",
      mimeType: "model/gltf-binary",
      sizeBytes: 12,
    };

    const message = yield* decodeOrchestrationMessage({
      id: "message-1",
      role: "user",
      text: "look at this",
      attachments: [futureAttachment],
      turnId: null,
      streaming: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(message.attachments?.length, 1);
    assert.strictEqual(message.attachments?.[0]!.type, "somethingnew");

    const payload = yield* decodeThreadMessageSentPayload({
      threadId: "thread-1",
      messageId: "message-1",
      role: "user",
      text: "look at this",
      attachments: [futureAttachment],
      turnId: null,
      streaming: false,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(payload.attachments?.[0]!.type, "somethingnew");
  }),
);

it.effect("preserves explicit provider and runtime mode in historical turn requests", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartRequestedPayload({
      threadId: "thread-1",
      messageId: "msg-2",
      modelSelection: {
        provider: "codex",
        model: "gpt-5.4",
      },
      runtimeMode: "full-access",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.modelSelection?.instanceId, "codex");
    assert.strictEqual(parsed.runtimeMode, "full-access");
    assert.strictEqual(parsed.interactionMode, DEFAULT_PROVIDER_INTERACTION_MODE);
  }),
);

it.effect("decodes thread.created runtime mode for historical events", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadCreatedPayload({
      threadId: "thread-1",
      projectId: "project-1",
      title: "Thread title",
      modelSelection: {
        provider: "codex",
        model: "gpt-5.4",
      },
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    assert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
    assert.strictEqual(parsed.modelSelection.instanceId, "codex");
  }),
);

it.effect("decodes thread.meta-updated payloads with explicit provider", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadMetaUpdatedPayload({
      threadId: "thread-1",
      regenerateTitle: true,
      previousTitle: "Previous title",
      titleRegeneration: {
        requestId: "cmd-title-regenerate",
        startedAt: "2026-01-01T00:00:00.000Z",
      },
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
      },
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.previousTitle, "Previous title");
    assert.strictEqual(parsed.titleRegeneration?.requestId, "cmd-title-regenerate");
    assert.strictEqual(parsed.modelSelection?.instanceId, "claudeAgent");
  }),
);

it.effect("defaults settled fields when decoding historical thread data", () =>
  Effect.gen(function* () {
    const common = {
      id: "thread-1",
      projectId: "project-1",
      title: "Historical thread",
      modelSelection: { provider: "codex", model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      archivedAt: null,
      session: null,
    };
    const thread = yield* decodeOrchestrationThread({
      ...common,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
    });
    const shell = yield* decodeOrchestrationThreadShell({
      ...common,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    });

    assert.strictEqual(thread.settledOverride, null);
    assert.strictEqual(thread.settledAt, null);
    assert.strictEqual(shell.settledOverride, null);
    assert.strictEqual(shell.settledAt, null);
    // Pre-link servers omit the array entirely.
    assert.deepStrictEqual(thread.pullRequests, []);
    assert.deepStrictEqual(shell.pullRequests, []);

    const legacyLink = {
      projectId: ProjectId.make("project-1"),
      repository: "acme/web",
      number: 42,
      url: "https://github.com/acme/web/pull/42",
    };
    const oldServerShell = yield* decodeOrchestrationThreadShell({
      ...common,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
      linkedPullRequest: legacyLink,
    });
    assert.deepStrictEqual(oldServerShell.pullRequests, []);
    assert.deepStrictEqual(oldServerShell.linkedPullRequest, legacyLink);

    // A decoder from before the array must still read its single-link field
    // after a new server encodes the expanded snapshot.
    const oldLinkFields = Schema.Struct({
      linkedPullRequest: Schema.optional(ThreadLinkedPullRequest),
    });
    const newServerWire = yield* Schema.encodeEffect(OrchestrationThreadShell)({
      ...oldServerShell,
      pullRequests: [
        {
          host: "github.com",
          repository: legacyLink.repository,
          number: legacyLink.number,
          url: legacyLink.url,
          source: "agent",
          linkedAt: common.createdAt,
          snapshot: null,
          stack: null,
        },
      ],
    });
    const oldClientFields = yield* Schema.decodeUnknownEffect(oldLinkFields)(newServerWire);
    assert.deepStrictEqual(oldClientFields.linkedPullRequest, legacyLink);
  }),
);

// A stored event that fails to decode stops the event store read, and with it
// server startup, so rows written before `turnId` existed must still load.
it.effect("decodes a legacy message-sent event persisted without turnId", () =>
  Effect.gen(function* () {
    const event = yield* decodeOrchestrationEvent({
      sequence: 539,
      eventId: "event-message-legacy-1",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      type: "thread.message-sent",
      occurredAt: "2026-01-01T00:00:00.000Z",
      commandId: "cmd-message-legacy-1",
      causationEventId: null,
      correlationId: "cmd-message-legacy-1",
      metadata: {},
      payload: {
        threadId: "thread-1",
        messageId: "message-1",
        role: "user",
        text: "written before turn ids were recorded",
        streaming: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    assert.strictEqual(event.type, "thread.message-sent");
    if (event.type !== "thread.message-sent") return;
    assert.strictEqual(event.payload.turnId, null);
  }),
);

it.effect("decodes thread archived and unarchived events", () =>
  Effect.gen(function* () {
    const archived = yield* decodeOrchestrationEvent({
      sequence: 1,
      eventId: "event-archive-1",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      type: "thread.archived",
      occurredAt: "2026-01-01T00:00:00.000Z",
      commandId: "cmd-archive-1",
      causationEventId: null,
      correlationId: "cmd-archive-1",
      metadata: {},
      payload: {
        threadId: "thread-1",
        archivedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    const unarchived = yield* decodeOrchestrationEvent({
      sequence: 2,
      eventId: "event-unarchive-1",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      type: "thread.unarchived",
      occurredAt: "2026-01-02T00:00:00.000Z",
      commandId: "cmd-unarchive-1",
      causationEventId: null,
      correlationId: "cmd-unarchive-1",
      metadata: {},
      payload: {
        threadId: "thread-1",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    });

    if (archived.type !== "thread.archived") {
      assert.fail(`Expected thread.archived event, received ${archived.type}.`);
    }
    assert.strictEqual(archived.payload.archivedAt, "2026-01-01T00:00:00.000Z");
    assert.strictEqual(unarchived.type, "thread.unarchived");
  }),
);

it.effect("decodes preserved Claude fork events with conservative new defaults", () =>
  Effect.gen(function* () {
    const base = {
      sequence: 1,
      eventId: "event-fork-legacy",
      aggregateKind: "thread",
      aggregateId: "fork-thread",
      occurredAt: "2026-08-08T00:00:00.000Z",
      commandId: "cmd-fork-legacy",
      causationEventId: null,
      correlationId: "cmd-fork-legacy",
      metadata: {},
    } as const;
    const forked = yield* decodeOrchestrationEvent({
      ...base,
      type: "thread.forked",
      payload: {
        originThreadId: "origin-thread",
        newThreadId: "fork-thread",
        forkAtTurnCount: 2,
        workspaceMode: "local",
        fidelityMode: "chat-only",
        createdAt: "2026-08-08T00:00:00.000Z",
      },
    });
    const completed = yield* decodeOrchestrationEvent({
      ...base,
      eventId: "event-fork-completed-legacy",
      type: "thread.fork-completed",
      payload: {
        threadId: "fork-thread",
        fidelityMode: "replay",
      },
    });

    if (forked.type !== "thread.forked" || completed.type !== "thread.fork-completed") {
      return assert.fail("Expected preserved fork events to decode.");
    }
    assert.strictEqual(forked.payload.providerMode, "transcript-bootstrap");
    assert.deepStrictEqual(forked.payload.attachmentCopies, []);
    assert.strictEqual(completed.payload.checkpointStatus, "unavailable");
    assert.strictEqual(completed.payload.workspaceStatus, "project-root");
  }),
);

it.effect("decodes thread settled and unsettled events", () =>
  Effect.gen(function* () {
    const settled = yield* decodeOrchestrationEvent({
      sequence: 1,
      eventId: "event-settle-1",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      type: "thread.settled",
      occurredAt: "2026-01-01T00:00:00.000Z",
      commandId: "cmd-settle-1",
      causationEventId: null,
      correlationId: "cmd-settle-1",
      metadata: {},
      payload: {
        threadId: "thread-1",
        settledAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    const unsettled = yield* decodeOrchestrationEvent({
      sequence: 2,
      eventId: "event-unsettle-1",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      type: "thread.unsettled",
      occurredAt: "2026-01-02T00:00:00.000Z",
      commandId: "cmd-unsettle-1",
      causationEventId: null,
      correlationId: "cmd-unsettle-1",
      metadata: {},
      payload: {
        threadId: "thread-1",
        reason: "user",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
    });

    assert.strictEqual(settled.type, "thread.settled");
    assert.strictEqual(unsettled.type, "thread.unsettled");
  }),
);

it.effect("normalizes legacy object-shaped modelSelection.options on decode", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadCreatedPayload({
      threadId: "thread-1",
      projectId: "project-1",
      title: "Legacy options thread",
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        options: {
          effort: "max",
          fastMode: true,
          // Falsy/garbage entries are dropped, matching migration 026.
          emptyStr: "   ",
          nullish: null,
          nested: { foo: 1 },
        },
      },
      branch: null,
      worktreePath: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    assert.strictEqual(parsed.modelSelection.instanceId, ProviderInstanceId.make("claudeAgent"));
    assert.deepStrictEqual(parsed.modelSelection.options, [
      { id: "effort", value: "max" },
      { id: "fastMode", value: true },
    ]);
  }),
);

it.effect("decodes active placement on existing metadata events while accepting old payloads", () =>
  Effect.gen(function* () {
    const payload = { threadId: "thread-1", updatedAt: "2026-01-01T00:00:00.000Z" };
    const oldPayload = yield* decodeThreadMetaUpdatedPayload(payload);
    assert.strictEqual(oldPayload.activeOrderKey, undefined);
    const resetPayload = yield* decodeThreadMetaUpdatedPayload({
      ...payload,
      activeOrderKey: null,
    });
    assert.strictEqual(resetPayload.activeOrderKey, null);
    const event = yield* decodeOrchestrationEvent({
      type: "thread.meta-updated",
      sequence: 1,
      eventId: "event-active-reorder",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      occurredAt: "2026-01-02T00:00:00.000Z",
      commandId: "cmd-active-reorder",
      causationEventId: null,
      correlationId: null,
      metadata: {},
      payload: { ...payload, activeOrderKey: "gm" },
    });
    assert.strictEqual(event.type, "thread.meta-updated");
    if (event.type === "thread.meta-updated") {
      assert.strictEqual(event.payload.activeOrderKey, "gm");
      assert.strictEqual(event.payload.updatedAt, payload.updatedAt);
    }
  }),
);

it.effect("decodes historical project reassignment fields on thread.meta-updated", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadMetaUpdatedPayload({
      threadId: "thread-general",
      projectId: "project-research",
      workspaceRoot: null,
      branch: null,
      worktreePath: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.projectId, "project-research");
    assert.strictEqual(parsed.workspaceRoot, null);
  }),
);

it.effect("still decodes a persisted thread.meta-updated event carrying linkedPullRequest", () =>
  Effect.gen(function* () {
    const event = yield* decodeOrchestrationEvent({
      sequence: 1,
      eventId: "event-legacy-link",
      aggregateKind: "thread",
      aggregateId: "thread-1",
      type: "thread.meta-updated",
      occurredAt: "2026-01-01T00:00:00.000Z",
      commandId: "cmd-legacy-link",
      causationEventId: null,
      correlationId: "cmd-legacy-link",
      metadata: {},
      payload: {
        threadId: "thread-1",
        linkedPullRequest: {
          projectId: "project-1",
          repository: "pingdotgg/t3code",
          number: 42,
          url: "https://github.com/pingdotgg/t3code/pull/42",
        },
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    });
    if (event.type !== "thread.meta-updated") {
      assert.fail(`Expected thread.meta-updated event, received ${event.type}.`);
    }
    assert.strictEqual(event.payload.linkedPullRequest?.number, 42);
  }),
);

it.effect(
  "decodes thread.turn-start-requested defaults for provider, runtime mode, and interaction mode",
  () =>
    Effect.gen(function* () {
      const parsed = yield* decodeThreadTurnStartRequestedPayload({
        threadId: "thread-1",
        messageId: "msg-1",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      assert.strictEqual(parsed.modelSelection, undefined);
      assert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
      assert.strictEqual(parsed.interactionMode, DEFAULT_PROVIDER_INTERACTION_MODE);
      assert.strictEqual(parsed.sourceProposedPlan, undefined);
    }),
);

it.effect("decodes thread.turn-start-requested source proposed plan metadata when present", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartRequestedPayload({
      threadId: "thread-2",
      messageId: "msg-2",
      sourceProposedPlan: {
        threadId: "thread-1",
        planId: "plan-1",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.deepStrictEqual(parsed.sourceProposedPlan, {
      threadId: "thread-1",
      planId: "plan-1",
    });
  }),
);

it.effect("decodes thread.turn-start-requested title seed when present", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeThreadTurnStartRequestedPayload({
      threadId: "thread-2",
      messageId: "msg-2",
      titleSeed: "Investigate reconnect failures",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.titleSeed, "Investigate reconnect failures");
  }),
);

it.effect("decodes latest turn source proposed plan metadata when present", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationLatestTurn({
      turnId: "turn-2",
      state: "running",
      requestedAt: "2026-01-01T00:00:00.000Z",
      startedAt: "2026-01-01T00:00:01.000Z",
      completedAt: null,
      assistantMessageId: null,
      sourceProposedPlan: {
        threadId: "thread-1",
        planId: "plan-1",
      },
    });
    assert.deepStrictEqual(parsed.sourceProposedPlan, {
      threadId: "thread-1",
      planId: "plan-1",
    });
  }),
);

it.effect("decodes orchestration session runtime mode defaults", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationSession({
      threadId: "thread-1",
      status: "idle",
      providerName: null,
      providerSessionId: null,
      providerThreadId: null,
      activeTurnId: null,
      lastError: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.runtimeMode, DEFAULT_RUNTIME_MODE);
  }),
);

it.effect("defaults proposed plan implementation metadata for historical rows", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationProposedPlan({
      id: "plan-1",
      turnId: "turn-1",
      planMarkdown: "# Plan",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    assert.strictEqual(parsed.implementedAt, null);
    assert.strictEqual(parsed.implementationThreadId, null);
  }),
);

it.effect("preserves proposed plan implementation metadata when present", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeOrchestrationProposedPlan({
      id: "plan-2",
      turnId: "turn-2",
      planMarkdown: "# Plan",
      implementedAt: "2026-01-02T00:00:00.000Z",
      implementationThreadId: "thread-2",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    assert.strictEqual(parsed.implementedAt, "2026-01-02T00:00:00.000Z");
    assert.strictEqual(parsed.implementationThreadId, "thread-2");
  }),
);

it.effect("project favicon overrides accept only supported image files", () =>
  Effect.gen(function* () {
    const valid = yield* decodeProjectFaviconPath("brand/icon.svg");
    assert.strictEqual(valid, "brand/icon.svg");
    const invalid = yield* Effect.exit(decodeProjectFaviconPath(".env"));
    assert.strictEqual(invalid._tag, "Failure");
  }),
);

// regression: 34a12bc33f fix(web): reject unsupported composer image types at attach time (#6574)
it("isProviderSendTurnSupportedImageMimeType accepts raster formats and rejects svg", () => {
  assert.strictEqual(isProviderSendTurnSupportedImageMimeType("image/png"), true);
  assert.strictEqual(isProviderSendTurnSupportedImageMimeType("IMAGE/JPEG"), true);
  assert.strictEqual(isProviderSendTurnSupportedImageMimeType("image/svg+xml"), false);
});

const decodeProjectIcon = Schema.decodeUnknownEffect(ProjectIconOverride);
const encodeProjectIcon = Schema.encodeEffect(ProjectIconOverride);
const decodeStoredProjectIcon = Schema.decodeUnknownEffect(StoredProjectIcon);
const encodeStoredProjectIcon = Schema.encodeEffect(StoredProjectIcon);
const decodeReceivedProjectIcon = Schema.decodeUnknownEffect(ReceivedProjectIcon);
const encodeReceivedProjectIcon = Schema.encodeEffect(ReceivedProjectIcon);

// Historical pre-monogram validators describe the fallback records being recovered, not current writes.
const decodeOldIcon = Schema.decodeUnknownEffect(
  Schema.Union([
    Schema.Struct({ kind: Schema.Literal("lucide"), name: Schema.String, color: Schema.String }),
    Schema.Struct({ kind: Schema.Literal("emoji"), emoji: Schema.String }),
  ]),
);
const decodeNightlyIcon = Schema.decodeUnknownEffect(
  Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("lucide"),
      name: Schema.String,
      color: Schema.String,
      // Fail if this field is ever sent; old validators must never see the new text.
      monogram: Schema.optional(Schema.Never),
    }),
    Schema.Struct({ kind: Schema.Literal("emoji"), emoji: Schema.String }),
  ]),
);

it.effect("writes canonical monograms while recovering legacy icons and project updates", () =>
  Effect.gen(function* () {
    const fallback = { kind: "lucide", name: "folder-code", color: "violet" } as const;
    for (const text of ["T3", "क्ष्म", "e\u0301"]) {
      const monogram = { kind: "monogram", text, color: "violet" } as const;
      const wire = yield* encodeProjectIcon(monogram);
      assert.deepEqual(wire, monogram);
      assert.deepEqual(yield* encodeStoredProjectIcon(monogram), monogram);
      assert.deepEqual(yield* encodeReceivedProjectIcon(monogram), monogram);
      assert.strictEqual((yield* Effect.exit(decodeOldIcon(wire)))._tag, "Failure");
      assert.strictEqual((yield* Effect.exit(decodeNightlyIcon(wire)))._tag, "Failure");
      const legacyWire = { ...fallback, monogramText: text };
      assert.deepEqual(yield* decodeOldIcon(legacyWire), fallback);
      assert.deepEqual(yield* decodeNightlyIcon(legacyWire), fallback);
      assert.deepEqual(yield* decodeProjectIcon(wire), monogram);
      assert.deepEqual(yield* decodeProjectIcon(monogram), monogram);
      for (const legacy of [legacyWire, { ...fallback, monogram: text }]) {
        assert.deepEqual(yield* decodeStoredProjectIcon(legacy), monogram);
        assert.deepEqual(yield* decodeReceivedProjectIcon(legacy), monogram);
        assert.deepEqual(
          yield* Schema.decodeUnknownEffect(ProjectUpdatePayload)({ projectIcon: legacy }),
          { projectIcon: monogram },
        );
      }
    }
    for (const icon of [
      { kind: "lucide", name: "alarm-clock", color: "blue" },
      { kind: "emoji", emoji: "🚀" },
    ] as const) {
      assert.deepEqual(yield* decodeProjectIcon(icon), icon);
      assert.deepEqual(yield* encodeProjectIcon(icon), icon);
    }
  }),
);

const encodeProjectShell = Schema.encodeEffect(OrchestrationProjectShell);
const decodeProjectShell = Schema.decodeUnknownEffect(OrchestrationProjectShell);
const decodeLegacyShell = Schema.decodeUnknownEffect(
  Schema.Struct({
    ...OrchestrationProjectShell.fields,
    projectIcon: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          kind: Schema.Literal("lucide"),
          name: Schema.String,
          color: Schema.String,
        }),
      ),
    ),
  }),
);

it.effect("recovers legacy monograms inside snapshots and writes their canonical shape", () =>
  Effect.gen(function* () {
    const projectIcon = { kind: "monogram", text: "क्ष्म", color: "violet" } as const;
    const shell = yield* encodeProjectShell({
      id: ProjectId.make("monogram"),
      title: "Monogram",
      workspaceRoot: "/tmp/monogram",
      defaultModelSelection: null,
      scripts: [],
      projectIcon,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const fallback = { kind: "lucide", name: "folder-code", color: "violet" } as const;
    assert.deepEqual(shell.projectIcon, projectIcon);
    assert.deepEqual((yield* decodeProjectShell(shell)).projectIcon, projectIcon);
    for (const legacyIcon of [
      { ...fallback, monogramText: projectIcon.text },
      { ...fallback, monogram: projectIcon.text },
    ]) {
      const legacyShell = { ...shell, projectIcon: legacyIcon };
      assert.deepEqual((yield* decodeLegacyShell(legacyShell)).projectIcon, fallback);
      const recovered = yield* decodeProjectShell(legacyShell);
      assert.deepEqual(recovered.projectIcon, projectIcon);
      assert.deepEqual(yield* encodeProjectShell(recovered), shell);
    }
  }),
);

// Upstream deleted the cases below in its Oct 20 cut (#22557). No other test
// fails when the validation or literal they cover is removed, so they stay.
const decodeDispatchCommandError = Schema.decodeUnknownEffect(OrchestrationDispatchCommandError);
const decodeTurnDiffInput = Schema.decodeUnknownEffect(OrchestrationGetTurnDiffInput);
const decodeThreadTurnDiff = Schema.decodeUnknownEffect(ThreadTurnDiff);
const decodeRoutedModelSelection = Schema.decodeUnknownEffect(ModelSelection);

// regression: 8824f8f24f fix(web): retry failed thread bootstraps with a fresh id (#7664)
it.effect("decodes a dispatch error after its bootstrap thread was deleted", () =>
  Effect.gen(function* () {
    const error = yield* decodeDispatchCommandError({
      _tag: "OrchestrationDispatchCommandError",
      message: "Failed to create worktree.",
      bootstrapThreadDisposition: "deleted",
    });

    assert.strictEqual(error.bootstrapThreadDisposition, "deleted");
  }),
);

it.effect("rejects turn diff input when fromTurnCount > toTurnCount", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeTurnDiffInput({
        threadId: "thread-1",
        fromTurnCount: 3,
        toTurnCount: 2,
      }),
    );
    assert.strictEqual(Exit.isFailure(result), true);
  }),
);

it.effect("rejects thread turn diff when fromTurnCount > toTurnCount", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeThreadTurnDiff({
        threadId: "thread-1",
        fromTurnCount: 3,
        toTurnCount: 2,
        diff: "patch",
      }),
    );
    assert.strictEqual(Exit.isFailure(result), true);
  }),
);

it.effect("ModelSelection rejects malformed instance ids", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeRoutedModelSelection({
        instanceId: "1invalid", // must start with a letter
        model: "x",
      }),
    );
    assert.strictEqual(Exit.isFailure(result), true);
  }),
);
