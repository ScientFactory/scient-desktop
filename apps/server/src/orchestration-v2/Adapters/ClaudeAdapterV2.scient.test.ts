// Scient's ClaudeAdapterV2 cases: native Stop fencing, workflows, account auth, MCP connectors
// and awareness, attachments. Upstream's own cases live in ClaudeAdapterV2.test.ts.
import type { McpServerStatus, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ChatAttachmentId,
  ChatFileAttachment,
  ChatImageAttachment,
  EnvironmentId,
  MessageId,
  type ModelSelection,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import {
  type ProviderAdapterV2Event,
  ProviderAdapterV2RuntimePolicy,
} from "@t3tools/provider-core/server/ProviderAdapter";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { formatClaudeResumeCompactionQuestion } from "@t3tools/shared/claudeCompaction";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { attachmentRelativePath } from "../../attachmentStore.ts";
import * as ServerConfig from "../../config.ts";
import { buildScientAwareness } from "../../provider/ScientAwareness.ts";
import type { ProviderNativeInventory } from "../../provider/ScientProviderInstanceSeams.ts";
import { CLAUDE_SCIENT_TOOL_PROJECTION } from "../../provider/ScientToolProjection.ts";
import {
  CLAUDE_TEST_MODEL_SELECTION,
  CLAUDE_TEST_RUNTIME_POLICY,
  DEFAULT_CLAUDE_SETTINGS,
  isStopInterruptError,
  isStopQueryRunnerError,
  makeClaudeTestTurnInput,
} from "./ClaudeAdapterV2.fixture.ts";
import { makeCapturedStopHarness } from "./ClaudeAdapterV2.stop.testkit.ts";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import {
  awaitUntil,
  claudeSdkFrame,
  makeAssistantTextFrame,
  makeResultFrame,
  makeSubagentNotificationFrame,
  makeWakeHarness,
  makeWakeHarnessWithOptions,
  WAKE_NATIVE_SESSION,
} from "./ClaudeAdapterV2.wake.testkit.ts";

describe("ClaudeAdapterV2 background wake turns (Admission)", () => {
  it.effect(
    "retains uncertain admission when an offered native prompt fails before acknowledgment",
    () =>
      Effect.gen(function* () {
        const h = yield* makeWakeHarness;
        yield* h.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: h.threadId,
            providerThread: h.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("uncertain-native-offer"),
            text: "Do not repeat an uncertain offer",
            attachments: [],
          }),
        );
        yield* Queue.offer(
          h.sdkMessages,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000799",
            result: "",
            subtype: "error_during_execution",
            isError: true,
            errors: ["Native response lost before acknowledgement"],
            terminalReason: "api_error",
          }),
        );
        assert.equal((yield* Queue.take(h.terminalReceipts)).status, "failed");
        const turns = h.events
          .filter((event) => event.type === "provider_turn.updated")
          .map((event) => event.providerTurn);
        assert.equal(turns[0]?.nativeAcceptance, "pending");
        assert.equal(turns.at(-1)?.nativeAcceptance, "unknown");
        assert.isTrue(turns.every((turn) => turn.acceptedAt === undefined));
        assert.lengthOf(h.offeredMessages, 1);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
        ),
      ),
  );

  it.effect.each([
    "foreign-session",
    "child-replay",
    "synthetic-model",
    "synthetic-id",
    "api-error",
    "owned-root",
  ] as const)("keeps Claude's inclusive fork cursor owned by the root query: %s", (kind) =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        yield* h.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: h.threadId,
            providerThread: h.providerThread,
            now,
            attemptId: RunAttemptId.make(`attempt-cursor-${kind}`),
            text: "Answer with native root ownership.",
            attachments: [],
            providerTurnOrdinal: 1,
          }),
        );
        const rootUuid = "00000000-0000-4000-8000-000000009001";
        const nextUuid = "00000000-0000-4000-8000-000000009002";
        yield* h.offerAndWait(makeAssistantTextFrame({ uuid: rootUuid, text: "Root answer." }));
        if (kind === "foreign-session") {
          for (const event of [
            { type: "message_start", message: { id: "foreign-thinking" } },
            {
              type: "content_block_start",
              index: 0,
              content_block: { type: "thinking", thinking: "Foreign thought." },
            },
            { type: "content_block_stop", index: 0 },
          ]) {
            yield* h.offerAndWait(
              claudeSdkFrame({
                type: "stream_event",
                event,
                parent_tool_use_id: null,
                session_id: "foreign-native-session",
                uuid: nextUuid,
              }),
            );
          }
        }
        const candidate = makeAssistantTextFrame({
          uuid: kind === "synthetic-id" ? "turn:synthetic-message" : nextUuid,
          text: "Candidate answer.",
        });
        if (candidate.type !== "assistant") assert.fail("Expected native assistant fixture.");
        yield* h.offerAndWait(
          claudeSdkFrame({
            ...candidate,
            session_id: kind === "foreign-session" ? "foreign-native-session" : WAKE_NATIVE_SESSION,
            parent_tool_use_id: kind === "child-replay" ? "cursor-child-tool" : null,
            message: {
              ...candidate.message,
              model: kind === "synthetic-model" ? "<synthetic>" : candidate.message.model,
            },
            ...(kind === "api-error" ? { error: "server_error" } : {}),
          }),
        );
        if (kind === "child-replay") {
          // Registration releases the held child frame through the real replay
          // route after the root answer. It must never move the root cursor.
          yield* h.offerAndWait(
            claudeSdkFrame({
              type: "system",
              subtype: "task_started",
              task_id: "cursor-child-task",
              tool_use_id: "cursor-child-tool",
              description: "Child answer",
              subagent_type: "general-purpose",
              is_backgrounded: true,
              task_type: "local_agent",
              prompt: "Inspect independently.",
              uuid: "00000000-0000-4000-8000-000000009003",
              session_id: WAKE_NATIVE_SESSION,
            }),
          );
        }
        yield* h.offerAndWait(
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000009004",
            result: "Done.",
          }),
        );
        yield* Queue.take(h.terminalReceipts);
        const terminalTurn = h.events.findLast(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.status === "completed",
        );
        if (terminalTurn?.type !== "provider_turn.updated")
          assert.fail("Missing persisted native turn artifact.");
        assert.equal(
          terminalTurn.providerTurn.nativeTurnRef?.nativeId,
          kind === "owned-root" ? nextUuid : rootUuid,
        );
        assert.equal(terminalTurn.providerTurn.nativeTurnRef?.strength, "weak");
        const rootItems = h.events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.threadId === h.threadId
            ? [event.turnItem]
            : [],
        );
        assert.ok(rootItems.some((item) => item.nativeItemRef?.nativeId === rootUuid));
        if (kind === "foreign-session") {
          assert.equal(
            rootItems.some((item) => item.type === "reasoning"),
            false,
          );
        }
        if (kind === "foreign-session" || kind === "child-replay") {
          assert.equal(
            rootItems.some((item) => item.nativeItemRef?.nativeId === nextUuid),
            false,
          );
          assert.equal(
            h.events.some(
              (event) =>
                event.type === "message.updated" &&
                event.message.threadId === h.threadId &&
                event.message.text === "Candidate answer.",
            ),
            false,
          );
        }
        if (kind === "child-replay") {
          yield* awaitUntil(
            () =>
              h.events.some(
                (event) =>
                  event.type === "message.updated" &&
                  event.message.threadId !== h.threadId &&
                  event.message.text === "Candidate answer.",
              ),
            "owned child replay projection",
          );
        }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
        ),
      ),
    ),
  );
});

describe("ClaudeAdapterV2 Auto-accept edits (Approvals)", () => {
  it.effect.each(
    [false, true].map((granted) => ({
      caseTitle: `asks before a command and delivers actual session awareness with grants ${granted}`,
      granted,
    })),
  )("$caseTitle", ({ granted }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-claude-accept-edits-",
        });
        let openedOptions: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions | undefined;
        const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
          crypto: yield* Crypto.Crypto,
          instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
          settings: DEFAULT_CLAUDE_SETTINGS,
          environment: {},
          attachmentsDir,
          fileSystem,
          path: yield* Path.Path,
          idAllocator,
          queryRunner: {
            allocateSessionId: Effect.succeed("native-thread-claude-accept-edits"),
            open: (input) =>
              Effect.sync(() => {
                openedOptions = input.options;
                return {
                  stopTask: () => Effect.die("Unexpected workflow task stop in this fixture."),
                  backgroundTasks: () => Effect.succeed(false),
                  setPermissionMode: () =>
                    Effect.die("Permission-mode mutation is outside this fixture."),
                  messages: Stream.never,
                  offer: () => Effect.void,
                  setModel: () => Effect.void,
                  applyFlagSettings: () => Effect.void,
                  interrupt: Effect.void,
                  close: Effect.void,
                };
              }),
            forkSession: () => Effect.die("unused"),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            assertComplete: Effect.void,
          },
        });
        const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "auto-accept-edits",
          interactionMode: "default",
          cwd: "/workspace",
        });
        const threadId = ThreadId.make("thread-claude-accept-edits");
        const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
        const capabilities = new Set([
          "documents:build",
          "compute:inventory",
          "skills:read",
        ] as const);
        if (granted) {
          yield* mcpSessions.set({
            environmentId: EnvironmentId.make("claude-native-awareness"),
            threadId,
            providerSessionId: "claude-native-awareness",
            providerInstanceId: CLAUDE_TEST_MODEL_SELECTION.instanceId,
            endpoint: "http://127.0.0.1:43123/mcp",
            authorizationHeader: "Bearer synthetic-claude",
            capabilities,
            connectors: [],
          });
          yield* Effect.addFinalizer(() => mcpSessions.clear(threadId));
        }
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-claude-accept-edits"),
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        yield* runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId,
            providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-accept-edits"),
            text: "Run node.",
            attachments: [],
            runtimePolicy,
          }),
        );
        assert.equal(openedOptions?.permissionMode, "acceptEdits");
        const systemPrompt = openedOptions?.systemPrompt;
        if (
          typeof systemPrompt !== "object" ||
          systemPrompt === null ||
          !("type" in systemPrompt) ||
          systemPrompt.type !== "preset"
        )
          return yield* Effect.die("Missing native Claude system prompt");
        assert.include(
          systemPrompt.append ?? "",
          buildScientAwareness(granted ? capabilities : undefined, CLAUDE_SCIENT_TOOL_PROJECTION),
        );
        assert.equal(
          (systemPrompt.append ?? "").includes("mcp__scient__scient_pdf_build"),
          granted,
        );
        assert.equal(
          (systemPrompt.append ?? "").includes("mcp__scient__scient_skill_load"),
          granted,
        );
        assert.notInclude(systemPrompt.append ?? "", "preview_status");
        const canUseTool = openedOptions?.canUseTool;
        assert.isFunction(canUseTool);

        const requestEvent = yield* runtime.events.pipe(
          Stream.filter((event) => event.type === "runtime_request.updated"),
          Stream.runHead,
          Effect.forkScoped,
        );
        const command = { command: "node -e 'console.log(42)'" };
        const decision = yield* Effect.promise(() =>
          canUseTool!("Bash", command, {
            signal: new AbortController().signal,
            toolUseID: "tool-bash-accept-edits",
            requestId: "request-bash-accept-edits",
          }),
        ).pipe(Effect.forkScoped);
        // Without a callback that asks, the command is allowed before any
        // request is raised.
        const first = yield* Effect.raceFirst(
          Fiber.join(requestEvent).pipe(
            Effect.map((event) => ({ type: "request", event }) as const),
          ),
          Fiber.join(decision).pipe(
            Effect.map((result) => ({ type: "decision", result }) as const),
          ),
        );
        assert.equal(first.type, "request", "the command ran without asking");
        if (first.type !== "request") return;
        const event = first.event;
        if (Option.isNone(event) || event.value.type !== "runtime_request.updated") return;
        assert.equal(event.value.runtimeRequest.kind, "command");

        yield* runtime.respondToRuntimeRequest({
          requestId: event.value.runtimeRequest.id,
          decision: "accept",
        });
        assert.equal((yield* Fiber.join(decision))?.behavior, "allow");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
        ),
      ),
    ),
  );
});

describe("ClaudeAdapterV2 attachments (Attachments)", () => {
  it.effect("forwards images and references generic files on sends and steering", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const path = yield* Path.Path;
        const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-claude-v2-attachments-",
        });
        const offeredMessages: Array<SDKUserMessage> = [];
        const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
          crypto: yield* Crypto.Crypto,
          instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
          settings: DEFAULT_CLAUDE_SETTINGS,
          environment: {},
          attachmentsDir,
          fileSystem,
          path: yield* Path.Path,
          idAllocator,
          queryRunner: {
            allocateSessionId: Effect.succeed("native-thread-claude-attachments"),
            open: () =>
              Effect.succeed({
                stopTask: () => Effect.die("Unexpected workflow task stop in this fixture."),
                backgroundTasks: () => Effect.succeed(false),
                setPermissionMode: () =>
                  Effect.die("Permission-mode mutation is outside this fixture."),
                messages: Stream.never,
                offer: (message) =>
                  Effect.sync(() => {
                    offeredMessages.push(message);
                  }),
                setModel: () => Effect.void,
                applyFlagSettings: () => Effect.void,
                interrupt: Effect.void,
                close: Effect.void,
              }),
            forkSession: () => Effect.die("unused forkSession"),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            assertComplete: Effect.void,
          },
        });
        const threadId = ThreadId.make("thread-claude-attachments");
        const providerSessionId = ProviderSessionId.make("provider-session-claude-attachments");
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId,
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        const attachment = ChatImageAttachment.make({
          type: "image",
          id: ChatAttachmentId.make(
            "thread-claude-attachments-12345678-1234-1234-1234-123456789abc",
          ),
          name: "diagram.png",
          mimeType: "image/png",
          sizeBytes: 4,
        });
        const document = ChatFileAttachment.make({
          type: "file",
          id: ChatAttachmentId.make(
            "thread-claude-attachments-abcdefab-1234-1234-1234-123456789abc",
          ),
          name: "requirements.pdf",
          mimeType: "application/pdf",
          sizeBytes: 4,
        });
        yield* fileSystem.writeFile(
          path.join(attachmentsDir, attachmentRelativePath(attachment)!),
          Uint8Array.from([1, 2, 3, 4]),
        );
        yield* fileSystem.writeFile(
          path.join(attachmentsDir, attachmentRelativePath(document)!),
          Uint8Array.from([5, 6, 7, 8]),
        );
        const attemptId = RunAttemptId.make("attempt-claude-attachments");
        const now = yield* DateTime.now;

        yield* runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId,
            providerThread,
            now,
            attemptId,
            text: "What's in this image?",
            attachments: [attachment, document],
          }),
        );

        const expectedImageBlock = {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "AQIDBA==",
          },
        } as const;
        const expectedAttachmentPath = path.join(
          attachmentsDir,
          attachmentRelativePath(attachment)!,
        );
        const expectedDocumentPath = path.join(attachmentsDir, attachmentRelativePath(document)!);
        assert.deepEqual(offeredMessages[0]?.message.content, [
          expectedImageBlock,
          {
            type: "text",
            text: `Ultrathink:\nWhat's in this image?\n\n[Attached image "diagram.png" is saved at: ${expectedAttachmentPath}]\n\n[Attached file "requirements.pdf" is saved at: ${expectedDocumentPath}]`,
          },
        ]);

        const providerTurnId = idAllocator.derive.providerTurn({
          driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
          nativeTurnId: `turn:${attemptId}`,
        });
        yield* runtime.steerTurn({
          threadId,
          runId: RunId.make("run-claude-attachments"),
          providerThread,
          providerTurnId,
          message: {
            createdBy: "user",
            creationSource: "web",
            messageId: MessageId.make("message-claude-attachments-steer"),
            text: "Focus on the diagram labels.",
            attachments: [attachment, document],
          },
        });

        assert.equal(offeredMessages[1]?.priority, "now");
        assert.deepEqual(offeredMessages[1]?.message.content, [
          expectedImageBlock,
          {
            type: "text",
            text: `Ultrathink:\nFocus on the diagram labels.\n\n[Attached image "diagram.png" is saved at: ${expectedAttachmentPath}]\n\n[Attached file "requirements.pdf" is saved at: ${expectedDocumentPath}]`,
          },
        ]);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
        ),
      ),
    ),
  );
});

describe("ClaudeAdapterV2 background wake turns (Errors)", () => {
  it.effect.each([
    "OAuth access token has been revoked",
    "OAuth session expired and could not be refreshed",
    "Failed to authenticate. API Error: 401 OAuth access token has been revoked.",
  ])("retires the exact native query after authoritative auth failure: %s", (error) =>
    Effect.gen(function* () {
      const closed = yield* Deferred.make<void>();
      let closeCount = 0;
      const harness = yield* makeWakeHarnessWithOptions({
        close: () =>
          Effect.sync(() => {
            closeCount += 1;
          }).pipe(Effect.andThen(Deferred.succeed(closed, undefined))),
      });
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("auth-revoked"),
          text: "Continue",
          attachments: [],
        }),
      );
      yield* Queue.offer(
        harness.sdkMessages,
        makeResultFrame({
          uuid: "00000000-0000-4000-8000-000000000608",
          result: "",
          subtype: "error_during_execution",
          isError: true,
          errors: [error],
          terminalReason: "api_error",
        }),
      );
      const terminal = yield* Queue.take(harness.terminalReceipts);
      assert.equal(terminal.status, "failed");
      yield* Deferred.await(closed);
      yield* awaitUntil(
        () =>
          harness.events.some(
            (event) =>
              event.type === "provider_session.updated" &&
              event.providerSession.status === "stopped",
          ),
        "retired native session",
      );
      const controls = harness.events.filter(
        (event) => event.type === "authentication.invalidated",
      );
      assert.equal(controls.length, 1);
      assert.equal(harness.terminalEvents().length, 1);
      const terminalIndex = harness.events.indexOf(terminal);
      assert.isBelow(
        terminalIndex,
        harness.events.findIndex((event) => event.type === "authentication.invalidated"),
      );
      assert.isBelow(
        harness.events.findIndex((event) => event.type === "authentication.invalidated"),
        harness.events.findIndex(
          (event) =>
            event.type === "provider_session.updated" && event.providerSession.status === "stopped",
        ),
      );
      assert.equal(closeCount, 1);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
      ),
    ),
  );

  it.effect.each([
    { subtype: "error_during_execution", error: "HTTP 401 Unauthorized" },
    { subtype: "success", error: "OAuth access token has been revoked" },
  ])(
    "does not invalidate account state for non-authoritative result $subtype/$error",
    ({ subtype, error }) =>
      Effect.gen(function* () {
        let closeCount = 0;
        const harness = yield* makeWakeHarnessWithOptions({
          close: () =>
            Effect.sync(() => {
              closeCount += 1;
            }),
        });
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("auth-nonauthoritative"),
            text: "Continue",
            attachments: [],
          }),
        );
        const submittedUuid = harness.offeredMessages.at(-1)?.uuid;
        if (submittedUuid === undefined) return yield* Effect.die("Missing native prompt identity");
        yield* harness.offerAndWait(
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000609",
            result: error,
            subtype,
            isError: subtype !== "success",
            errors: [error],
            userMessageUuid: submittedUuid,
          }),
        );
        yield* Queue.take(harness.terminalReceipts);
        assert.equal(harness.terminalEvents().length, 1);
        assert.isFalse(harness.events.some((event) => event.type === "authentication.invalidated"));
        assert.equal(closeCount, 0);
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("auth-nonauthoritative-recovery"),
            providerTurnOrdinal: 2,
            text: "Continue after the unrelated failure",
            attachments: [],
          }),
        );
        const recoveryUuid = harness.offeredMessages.at(-1)?.uuid;
        assert.notEqual(recoveryUuid, submittedUuid);
        if (recoveryUuid === undefined)
          return yield* Effect.die("Missing recovery prompt identity");
        yield* harness.offerAndWait(
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000610",
            result: "Recovered on the same query.",
            userMessageUuid: recoveryUuid,
          }),
        );
        assert.equal((yield* Queue.take(harness.terminalReceipts)).status, "completed");
        assert.equal(harness.terminalEvents().length, 2);
        assert.equal(closeCount, 0);
        assert.isFalse(harness.events.some((event) => event.type === "authentication.invalidated"));
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
        ),
      ),
  );
});

const makeMcpSession = (threadId: ThreadId): McpProviderSessionConfig => ({
  environmentId: EnvironmentId.make(`environment-${threadId}`),
  threadId,
  providerSessionId: `mcp-session-${threadId}`,
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  endpoint: "http://127.0.0.1:43123/mcp",
  authorizationHeader: "Bearer secret-claude-token",
  capabilities: new Set(["preview"]),
  connectors: [],
});

describe("ClaudeAdapterV2 MCP query overrides (Mcp)", () => {
  const T3_MCP_SERVERS = {
    scient: {
      type: "http",
      url: "http://127.0.0.1:43123/mcp",
      headers: {
        Authorization: "Bearer secret-claude-token",
      },
      timeout: ClaudeAdapterV2.CLAUDE_T3_MCP_TOOL_TIMEOUT_MS,
    },
  } as const;

  it("adds one http server per connector without pre-approving connector tools", () => {
    const threadId = ThreadId.make("thread-claude-mcp-connectors");
    const mcpSession: McpProviderSessionConfig = {
      ...makeMcpSession(threadId),
      connectors: [
        {
          connectorId: "con_linear0001",
          serverName: "linear",
          displayName: "Linear",
          url: "http://127.0.0.1:43123/mcp/connectors/con_linear0001",
        },
        {
          connectorId: "con_notion0001",
          serverName: "notion",
          displayName: "Notion",
          url: "http://127.0.0.1:43123/mcp/connectors/con_notion0001",
        },
      ],
    };
    for (const readOnlySandbox of [false, true]) {
      const overrides = ClaudeAdapterV2.claudeMcpQueryOverrides({
        mcpSession,
        readOnlySandbox,
        allowedTools: ["Read"],
      });

      assert.deepEqual(overrides.mcpServers, {
        ...T3_MCP_SERVERS,
        linear: {
          type: "http",
          url: "http://127.0.0.1:43123/mcp/connectors/con_linear0001",
          headers: { Authorization: "Bearer secret-claude-token" },
        },
        notion: {
          type: "http",
          url: "http://127.0.0.1:43123/mcp/connectors/con_notion0001",
          headers: { Authorization: "Bearer secret-claude-token" },
        },
      });
      const allowed = overrides.allowedTools ?? [];
      assert.include(allowed, "Read");
      for (const tool of allowed) {
        assert.isFalse(tool.startsWith("mcp__linear"), tool);
        assert.isFalse(tool.startsWith("mcp__notion"), tool);
      }
      assert.deepEqual(
        overrides.allowedTools,
        ClaudeAdapterV2.claudeMcpQueryOverrides({
          mcpSession: makeMcpSession(threadId),
          readOnlySandbox,
          allowedTools: ["Read"],
        }).allowedTools,
      );
    }
  });

  // The toolkit-annotation match itself is upstream's case in ClaudeAdapterV2.test.ts.
  it("never pre-approves Scient thread inspection in a read-only session", () => {
    assert.isFalse(
      ClaudeAdapterV2.CLAUDE_READ_ONLY_T3_MCP_ALLOWED_TOOLS.includes(
        "mcp__scient__scient_thread_inspect",
      ),
    );
  });
});

describe("ClaudeAdapterV2 provider-native inventory (NativeInventory)", () => {
  it.effect("updates MCP status at turn end and never reports servers Scient set", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const reports: Array<ProviderNativeInventory> = [];
        const turnEndStatus: ReadonlyArray<McpServerStatus> = [
          { name: "github", status: "connected", scope: "user", tools: [{ name: "issues" }] },
          { name: "sentry", status: "failed", scope: "project", error: "spawn ENOENT" },
          // Scient's own endpoint and a delivered connector, as Claude reports them.
          { name: "scient", status: "connected", source: "dynamic" },
          { name: "linear", status: "connected", source: "dynamic" },
        ];
        const harness = yield* makeWakeHarnessWithOptions({
          onNativeInventory: (inventory) => Effect.sync(() => void reports.push(inventory)),
          mcpServerStatus: Effect.succeed(turnEndStatus),
        });
        yield* (yield* McpProviderSessions.McpProviderSessions).set({
          environmentId: EnvironmentId.make("environment-claude-native-inventory"),
          threadId: harness.threadId,
          providerSessionId: "mcp-session-claude-native-inventory",
          providerInstanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
          endpoint: "http://127.0.0.1:43123/mcp",
          authorizationHeader: "Bearer native-inventory-token",
          capabilities: new Set(),
          connectors: [
            {
              connectorId: "connector-linear",
              serverName: "linear",
              displayName: "Linear",
              url: "http://127.0.0.1:43123/mcp/connectors/connector-linear",
            },
          ],
        });

        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-claude-native-inventory"),
            text: "List my issues.",
            attachments: [],
          }),
        );
        assert.includeMembers(Object.keys(harness.getOpenedOptions()?.mcpServers ?? {}), [
          "scient",
          "linear",
        ]);

        yield* harness.offerAndWait(
          claudeSdkFrame({
            type: "system",
            subtype: "init",
            uuid: "00000000-0000-4000-8000-000000009001",
            session_id: WAKE_NATIVE_SESSION,
            plugins: [{ name: "review-tools", path: "/plugins/review-tools" }],
            mcp_servers: [
              { name: "github", status: "pending", source: "user" },
              { name: "sentry", status: "pending", source: "project" },
              { name: "scient", status: "connected", source: "dynamic" },
              { name: "linear", status: "pending", source: "dynamic" },
            ],
          }),
        );
        assert.deepStrictEqual(reports[0]?.mcpServers, [
          { name: "github", status: "pending", scope: "user" },
          { name: "sentry", status: "pending", scope: "project" },
        ]);

        yield* harness.offerAndWait(
          makeResultFrame({ uuid: "00000000-0000-4000-8000-000000009002", result: "Done." }),
        );
        yield* awaitUntil(() => reports.length === 2, "the turn-end MCP status sample");
        assert.deepStrictEqual(reports[1], {
          mcpServers: [
            { name: "github", status: "connected", scope: "user", toolCount: 1 },
            { name: "sentry", status: "failed", scope: "project", error: "spawn ENOENT" },
          ],
        });
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
      ),
    ),
  );

  it.effect("keeps the last report when the turn-end sample fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const reports: Array<ProviderNativeInventory> = [];
        const harness = yield* makeWakeHarnessWithOptions({
          onNativeInventory: (inventory) => Effect.sync(() => void reports.push(inventory)),
          mcpServerStatus: Effect.fail(
            new ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError({
              method: "mcpServerStatus",
              cause: new Error("control request timed out"),
            }),
          ),
        });
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-claude-native-inventory-failure"),
            text: "Hello.",
            attachments: [],
          }),
        );
        yield* harness.offerAndWait(
          makeResultFrame({ uuid: "00000000-0000-4000-8000-000000009003", result: "Hi." }),
        );
        for (let attempt = 0; attempt < 100; attempt++) yield* Effect.yieldNow;
        assert.deepStrictEqual(reports, []);
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
      ),
    ),
  );
});

describe("ClaudeAdapterV2 session permissions (Policy)", () => {
  it.each([
    { decision: "decline", feedback: "  Use a dry run.  ", message: "Use a dry run." },
    { decision: "decline", feedback: "   ", message: "User declined tool execution." },
    { decision: "cancel", feedback: "Stop here.", message: "Stop here." },
  ] as const)(
    "returns $decision feedback $feedback to the requesting tool",
    ({ decision, feedback, message }) => {
      const result = ClaudeAdapterV2.permissionResultFromDecision({
        toolName: "Bash",
        decision,
        feedback,
        toolInput: { command: "rm -rf build" },
        toolUseID: "tool-3",
      });

      assert.equal(result.behavior, "deny");
      if (result.behavior !== "deny") {
        return;
      }
      assert.equal(result.message, message);
      assert.equal(result.interrupt, decision === "cancel" ? true : undefined);
    },
  );
});

describe("ClaudeAdapterV2 background wake turns (Replacements)", () => {
  it.effect("refuses a model change that would kill a running background subagent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const SUBAGENT_TASK_ID = "task-model-change-running-subagent";
        const SUBAGENT_TOOL_USE_ID = "toolu-model-change-running-subagent";
        const fileSystem = yield* FileSystem.FileSystem;
        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-claude-v2-model-change-running-subagent-",
        });
        const processQueues: Array<Queue.Queue<SDKMessage>> = [];
        const events: Array<ProviderAdapterV2Event> = [];
        const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
          crypto: yield* Crypto.Crypto,
          instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
          settings: DEFAULT_CLAUDE_SETTINGS,
          environment: {},
          attachmentsDir,
          fileSystem,
          path: yield* Path.Path,
          idAllocator,
          continuationRequests: { offer: () => Effect.void },
          queryRunner: {
            allocateSessionId: Effect.succeed(WAKE_NATIVE_SESSION),
            open: () =>
              Effect.gen(function* () {
                const sdkMessages = yield* Queue.unbounded<SDKMessage>();
                processQueues.push(sdkMessages);
                return {
                  stopTask: () => Effect.die("Unexpected workflow task stop in this fixture."),
                  backgroundTasks: () => Effect.succeed(false),
                  setPermissionMode: () =>
                    Effect.die("Permission-mode mutation is outside this fixture."),
                  messages: Stream.fromQueue(sdkMessages),
                  offer: () => Effect.void,
                  setModel: () => Effect.void,
                  applyFlagSettings: () => Effect.void,
                  interrupt: Effect.void,
                  close: Queue.shutdown(sdkMessages),
                };
              }),
            forkSession: () => Effect.die("unused forkSession"),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            assertComplete: Effect.void,
          },
        });
        const threadId = ThreadId.make("thread-claude-model-change-running-subagent");
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make(
            "provider-session-claude-model-change-running-subagent",
          ),
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        yield* runtime.events.pipe(
          Stream.runForEach((event) =>
            Effect.sync(() => {
              events.push(event);
            }),
          ),
          Effect.forkScoped,
        );
        const terminals = () => events.filter((event) => event.type === "turn.terminal");
        const now = yield* DateTime.now;

        yield* runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId,
            providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-claude-model-change-running-subagent-a"),
            text: "Spawn a background subagent and stop.",
            attachments: [],
          }),
        );
        const firstProcess = processQueues[0]!;
        yield* Queue.offer(
          firstProcess,
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: SUBAGENT_TASK_ID,
            tool_use_id: SUBAGENT_TOOL_USE_ID,
            description: "Background research",
            subagent_type: "general-purpose",
            task_type: "local_agent",
            prompt: "Research, then report.",
            uuid: "00000000-0000-4000-8000-000000000901",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        yield* Queue.offer(
          firstProcess,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000902",
            result: "Spawned the subagent in the background.",
          }),
        );
        yield* awaitUntil(() => terminals().length === 1, "first turn terminal");
        const settledTurn = terminals()[0]!;

        // The subagent runs inside the first CLI process. Another model needs
        // another process, so the turn must not start and close this one.
        const alternateModel = {
          ...CLAUDE_TEST_MODEL_SELECTION,
          model: "claude-haiku-4-5-20251001",
        } satisfies ModelSelection;
        const switchTurn = (attempt: string) =>
          runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId,
              providerThread: { ...providerThread, status: "active" },
              now,
              attemptId: RunAttemptId.make(attempt),
              text: "Switch model while the subagent runs.",
              attachments: [],
              providerTurnOrdinal: 2,
              modelSelection: alternateModel,
            }),
          );
        const refused = yield* switchTurn("attempt-claude-model-change-running-subagent-b").pipe(
          Effect.flip,
        );
        assert.equal(
          makeProviderFailure({ cause: refused, class: "provider_error" }).message,
          new ClaudeAdapterV2.ClaudeBackgroundWorkBlocksQueryReplacementError().message,
        );
        assert.lengthOf(processQueues, 1);

        // Stop ends the background work, so the switch may replace the process.
        yield* runtime.interruptTurn({
          providerThread,
          providerTurnId: settledTurn.providerTurnId,
          requestRuntimeRestart: true,
        });
        yield* switchTurn("attempt-claude-model-change-running-subagent-c");
        assert.lengthOf(processQueues, 2);

        // The stopped subagent never reports its end, so it must not block
        // later changes on the replacement process either.
        yield* Queue.offer(
          processQueues[1]!,
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000903",
            result: "Switched model.",
          }),
        );
        yield* awaitUntil(() => terminals().length === 2, "switched turn terminal");
        // Model and effort now change on the live process, so turn thinking
        // off: that launch flag still needs another process.
        yield* runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId,
            providerThread: { ...providerThread, status: "active" },
            now,
            attemptId: RunAttemptId.make("attempt-claude-model-change-running-subagent-d"),
            text: "Stop thinking.",
            attachments: [],
            providerTurnOrdinal: 3,
            modelSelection: { ...alternateModel, options: [{ id: "thinking", value: false }] },
          }),
        );
        assert.lengthOf(processQueues, 3);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
        ),
      ),
    ),
  );
});

describe("ClaudeAdapterV2 executable path (Sessions)", () => {
  it.effect("expands ~ in the configured binary path for the SDK", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const homeDirectory = yield* HostProcess.HomeDirectory;
        const executablePaths: Array<string | undefined> = [];
        const adapter = yield* ClaudeAdapterV2.createClaudeAdapterV2(
          {
            instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
            displayName: undefined,
            environment: [],
            enabled: true,
            config: { ...DEFAULT_CLAUDE_SETTINGS, binaryPath: "~/bin/claude" },
          },
          {},
        ).pipe(
          Effect.provide(
            ServerConfig.layerTest(yield* HostProcess.WorkingDirectory, {
              prefix: "t3-claude-binary-home-",
            }),
          ),
          Effect.provideService(ClaudeAdapterV2.ClaudeAgentSdkQueryRunner, {
            allocateSessionId: Effect.succeed("native-thread-claude-binary-home"),
            open: (input) =>
              Effect.sync(() => {
                executablePaths.push(input.options.pathToClaudeCodeExecutable);
                return {
                  stopTask: () => Effect.die("Unexpected workflow task stop in this fixture."),
                  backgroundTasks: () => Effect.succeed(false),
                  setPermissionMode: () =>
                    Effect.die("Permission-mode mutation is outside this fixture."),
                  messages: Stream.never,
                  offer: () => Effect.void,
                  setModel: () => Effect.void,
                  applyFlagSettings: () => Effect.void,
                  interrupt: Effect.void,
                  close: Effect.void,
                };
              }),
            forkSession: () => Effect.die("unused"),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            assertComplete: Effect.void,
          }),
        );
        const threadId = ThreadId.make("thread-claude-binary-home");
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-claude-binary-home"),
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: CLAUDE_TEST_MODEL_SELECTION,
          runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
        });
        yield* runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId,
            providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-claude-binary-home"),
            text: "hello",
            attachments: [],
          }),
        );

        assert.deepEqual(executablePaths, [path.join(homeDirectory, "bin", "claude")]);
      }),
    ).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
      ),
    ),
  );
});

describe("ClaudeAdapterV2 resume compaction (Sessions)", () => {
  // Upstream's same-named case in ClaudeAdapterV2.test.ts dropped the native-bypass ask below.
  it.effect(
    "resolves the SDK resume dialog and still asks for CLI-forwarded tools under native bypass",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const idAllocator = yield* IdAllocator.IdAllocatorV2;
          const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "t3-claude-resume-",
          });
          let openedOptions: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions | undefined;
          const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
            crypto: yield* Crypto.Crypto,
            instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
            settings: DEFAULT_CLAUDE_SETTINGS,
            environment: {},
            attachmentsDir,
            fileSystem,
            path: yield* Path.Path,
            idAllocator,
            queryRunner: {
              allocateSessionId: Effect.succeed("native-thread-claude-resume"),
              open: (input) =>
                Effect.sync(() => {
                  openedOptions = input.options;
                  return {
                    stopTask: () => Effect.die("Unexpected workflow task stop in this fixture."),
                    backgroundTasks: () => Effect.succeed(false),
                    setPermissionMode: () =>
                      Effect.die("Permission-mode mutation is outside this fixture."),
                    messages: Stream.never,
                    offer: () => Effect.void,
                    setModel: () => Effect.void,
                    applyFlagSettings: () => Effect.void,
                    interrupt: Effect.void,
                    close: Effect.void,
                  };
                }),
              forkSession: () => Effect.die("unused"),
              subagentLaunchToolUseId: () => Effect.succeed(null),
              assertComplete: Effect.void,
            },
          });
          const threadId = ThreadId.make("thread-claude-resume");
          const runtime = yield* adapter.openSession({
            threadId,
            providerSessionId: ProviderSessionId.make("provider-session-claude-resume"),
            modelSelection: CLAUDE_TEST_MODEL_SELECTION,
            runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
          });
          const providerThread = yield* runtime.ensureThread({
            threadId,
            modelSelection: CLAUDE_TEST_MODEL_SELECTION,
            runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
          });
          const now = yield* DateTime.now;
          yield* runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId,
              providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-claude-resume"),
              text: "continue",
              attachments: [],
            }),
          );
          const callback = openedOptions?.onUserDialog;
          assert.isFunction(callback);
          const canUseTool = openedOptions?.canUseTool;
          assert.isFunction(canUseTool);
          const ordinaryToolRequest = yield* runtime.events.pipe(
            Stream.filter((event) => event.type === "runtime_request.updated"),
            Stream.runHead,
            Effect.forkScoped,
          );
          const ordinaryToolResult = yield* Effect.promise(() =>
            canUseTool!(
              "Bash",
              { command: "pwd" },
              {
                signal: new AbortController().signal,
                toolUseID: "tool-bash-full-access",
                requestId: "request-bash-full-access",
              },
            ),
          ).pipe(Effect.forkScoped);
          const ordinaryRequest = yield* Fiber.join(ordinaryToolRequest);
          assert.isTrue(Option.isSome(ordinaryRequest));
          if (
            Option.isNone(ordinaryRequest) ||
            ordinaryRequest.value.type !== "runtime_request.updated"
          ) {
            return;
          }
          // CLI-forwarded asks still require a decision under native bypass.
          assert.equal(ordinaryRequest.value.runtimeRequest.kind, "command");
          yield* runtime.respondToRuntimeRequest({
            requestId: ordinaryRequest.value.runtimeRequest.id,
            decision: "accept",
          });
          assert.deepEqual(yield* Fiber.join(ordinaryToolResult), {
            behavior: "allow",
            updatedInput: { command: "pwd" },
            toolUseID: "tool-bash-full-access",
            decisionClassification: "user_temporary",
          });
          const longQuestion = `Choose a deployment target: ${"region ".repeat(80)}`;
          const questionRequestEvent = yield* runtime.events.pipe(
            Stream.filter((event) => event.type === "runtime_request.updated"),
            Stream.runHead,
            Effect.forkScoped,
          );
          const questionResult = yield* Effect.promise(() =>
            canUseTool!(
              "AskUserQuestion",
              {
                questions: [
                  {
                    header: "Target",
                    question: longQuestion,
                    options: [
                      { label: "Production", description: "Deploy to production." },
                      { label: "Staging", description: "Deploy to staging." },
                    ],
                    multiSelect: true,
                  },
                ],
              },
              {
                signal: new AbortController().signal,
                toolUseID: "tool-question-full-access",
                requestId: "request-question-full-access",
              },
            ),
          ).pipe(Effect.forkScoped);
          const questionEvent = yield* Fiber.join(questionRequestEvent);
          assert.isTrue(Option.isSome(questionEvent));
          if (
            Option.isNone(questionEvent) ||
            questionEvent.value.type !== "runtime_request.updated"
          ) {
            return;
          }
          yield* runtime.respondToRuntimeRequest({
            requestId: questionEvent.value.runtimeRequest.id,
            answers: { [longQuestion]: ["Production", "Staging"] },
          });
          assert.deepEqual(yield* Fiber.join(questionResult), {
            behavior: "allow",
            updatedInput: {
              questions: [
                {
                  header: "Target",
                  question: longQuestion,
                  options: [
                    { label: "Production", description: "Deploy to production." },
                    { label: "Staging", description: "Deploy to staging." },
                  ],
                  multiSelect: true,
                },
              ],
              answers: { [longQuestion]: "Production, Staging" },
            },
            toolUseID: "tool-question-full-access",
          });
          const longPlan = `# Deployment plan\n\n${"Validate every region before promotion.\n".repeat(120)}`;
          const proposedPlanEvent = yield* runtime.events.pipe(
            Stream.filter((event) => event.type === "plan.updated"),
            Stream.runHead,
            Effect.forkScoped,
          );
          const exitPlanResult = yield* Effect.promise(() =>
            canUseTool!(
              "ExitPlanMode",
              { plan: longPlan },
              {
                signal: new AbortController().signal,
                toolUseID: "tool-exit-plan-full-access",
                requestId: "request-exit-plan-full-access",
              },
            ),
          );
          assert.deepEqual(exitPlanResult, {
            behavior: "deny",
            message:
              "The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn.",
            toolUseID: "tool-exit-plan-full-access",
          });
          const planEvent = yield* Fiber.join(proposedPlanEvent);
          assert.isTrue(Option.isSome(planEvent));
          if (Option.isSome(planEvent) && planEvent.value.type === "plan.updated") {
            assert.equal(planEvent.value.plan.kind, "proposed_plan");
            if (planEvent.value.plan.kind === "proposed_plan") {
              assert.equal(planEvent.value.plan.markdown, longPlan.trim());
            }
          }
          const requestEvent = yield* runtime.events
            .pipe(
              Stream.filter((event) => event.type === "runtime_request.updated"),
              Stream.runHead,
            )
            .pipe(Effect.forkScoped);
          const controller = new AbortController();
          const dialog = yield* Effect.promise(() =>
            callback!(
              {
                dialogKind: "resume_return",
                payload: { sessionAgeMinutes: 90, estimatedTokens: 120000 },
              },
              { signal: controller.signal, requestId: "dialog-resume-1" },
            ),
          ).pipe(Effect.forkScoped);
          const event = yield* Fiber.join(requestEvent);
          assert.isTrue(Option.isSome(event));
          if (Option.isNone(event) || event.value.type !== "runtime_request.updated") return;
          const question = formatClaudeResumeCompactionQuestion({
            ageMinutes: 90,
            estimatedTokens: 120000,
          });
          yield* runtime.respondToRuntimeRequest({
            requestId: event.value.runtimeRequest.id,
            answers: { [question]: "Compact and continue" },
          });
          assert.deepEqual(yield* Fiber.join(dialog), { behavior: "completed", result: "compact" });

          const cancelledController = new AbortController();
          cancelledController.abort();
          assert.deepEqual(
            yield* Effect.promise(() =>
              callback!(
                {
                  dialogKind: "resume_return",
                  payload: { sessionAgeMinutes: 90, estimatedTokens: 120000 },
                },
                { signal: cancelledController.signal, requestId: "dialog-resume-2" },
              ),
            ),
            { behavior: "cancelled" },
          );
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
          ),
        ),
      ),
  );
});

describe("ClaudeAdapterV2 background wake turns (Stop)", () => {
  it.effect.each([false, true])(
    "refuses delayed native Stop rejection after a newer root settled, replacement=%s",
    (replacement) =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeCapturedStopHarness(`settled-newer-${replacement}`);
          yield* Effect.gen(function* () {
            const a = yield* h.start("captured-A");
            const peer = yield* h.start("untouched-peer", CLAUDE_TEST_MODEL_SELECTION, h.peer);
            const stop = yield* h.source.runtime
              .interruptTurn({
                providerThread: h.source.providerThread,
                providerTurnId: a.turnId,
                requestRuntimeRestart: true,
              })
              .pipe(Effect.exit, Effect.forkChild);
            yield* Deferred.await(h.interruptEntered);
            yield* h.settle(a.query, a.turnId);
            assert.lengthOf(h.terminals(a.turnId), 1);
            const selection = replacement
              ? { ...CLAUDE_TEST_MODEL_SELECTION, model: "claude-haiku-4-5-20251001" }
              : CLAUDE_TEST_MODEL_SELECTION;
            const b = yield* h.start("newer-B", selection);
            yield* h.settle(b.query, b.turnId);
            assert.lengthOf(h.terminals(b.turnId), 1);
            const beforeCloses = h.queries.map((q) => q.closes);
            yield* Deferred.succeed(h.interruptRelease, undefined);
            const outcome = yield* Fiber.join(stop);
            assert.isTrue(Exit.isFailure(outcome));
            if (Exit.isSuccess(outcome))
              return yield* Effect.die("Stale Stop unexpectedly succeeded");
            const error = Cause.squash(outcome.cause);
            if (
              !isStopInterruptError(error) ||
              !isStopQueryRunnerError(error.cause) ||
              !(error.cause.cause instanceof AggregateError)
            )
              return yield* Effect.die("Stale refusal lost the original native cause");
            assert.isTrue(
              error.cause.cause.errors.some(
                (cause: unknown) =>
                  isStopQueryRunnerError(cause) &&
                  cause.cause === "Held exact native interrupt rejected",
              ),
            );
            assert.deepEqual(
              h.queries.map((q) => q.closes),
              beforeCloses,
            );
            assert.equal(b.query.closes, 0);
            assert.isFalse(
              h.events.some((e) => e.type === "turn_item.updated" && e.turnItem.type === "error"),
            );
            const c = yield* h.start("usable-C", selection);
            assert.strictEqual(c.query, b.query);
            yield* h.settle(c.query, c.turnId);
            assert.lengthOf(h.terminals(c.turnId), 1);
            yield* h.peer.runtime.steerTurn({
              threadId: h.peer.threadId,
              runId: peer.input.runId,
              providerThread: h.peer.providerThread,
              providerTurnId: peer.turnId,
              message: {
                messageId: MessageId.make("peer-steer"),
                createdBy: "user",
                creationSource: "web",
                text: "Peer still usable",
                attachments: [],
              },
            });
            assert.equal(peer.query.offers.length, 2);
            assert.equal(peer.query.closes, 0);
            assert.equal(peer.query.interrupts, 0);
            yield* h.settle(peer.query, peer.turnId);
            assert.lengthOf(h.terminals(peer.turnId), 1);
          }).pipe(Effect.ensuring(h.save));
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
          ),
        ),
      ),
  );

  it.effect.each(["prepare", "open"] as const)(
    "refuses stale Stop while a newer native start is in flight at %s",
    (phase) =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeCapturedStopHarness(`inflight-${phase}`);
          yield* Effect.gen(function* () {
            const a = yield* h.start("inflight-A");
            const stop = yield* h.source.runtime
              .interruptTurn({ providerThread: h.source.providerThread, providerTurnId: a.turnId })
              .pipe(Effect.exit, Effect.forkChild);
            yield* Deferred.await(h.interruptEntered);
            yield* h.settle(a.query, a.turnId);
            h.setPause(phase);
            const selection =
              phase === "open"
                ? { ...CLAUDE_TEST_MODEL_SELECTION, model: "claude-haiku-4-5-20251001" }
                : CLAUDE_TEST_MODEL_SELECTION;
            const start = yield* h.start("inflight-B", selection).pipe(Effect.forkChild);
            yield* Deferred.await(h.pauseEntered);
            const closes = a.query.closes;
            const offers = a.query.offers.length;
            yield* Deferred.succeed(h.interruptRelease, undefined);
            assert.isTrue(Exit.isFailure(yield* Fiber.join(stop)));
            assert.equal(
              a.query.closes,
              closes,
              "stale Stop cannot close over pending native start",
            );
            assert.equal(a.query.offers.length, offers, "pending start has not offered");
            yield* Deferred.succeed(h.pauseRelease, undefined);
            const b = yield* Fiber.join(start);
            yield* h.settle(b.query, b.turnId);
            assert.lengthOf(h.terminals(b.turnId), 1);
            assert.equal(b.query.closes, 0);
          }).pipe(Effect.ensuring(h.save));
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
          ),
        ),
      ),
  );

  it.effect.each([false, true])(
    "fences ordinary reuse and replacement until actual captured-query EOF, closeFails=%s",
    (closeFails) =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeCapturedStopHarness(`close-fence-${closeFails}`, closeFails);
          yield* Effect.gen(function* () {
            const a = yield* h.start("fenced-A");
            if (!closeFails) h.setPause("close");
            const stop = yield* h.source.runtime
              .interruptTurn({ providerThread: h.source.providerThread, providerTurnId: a.turnId })
              .pipe(Effect.exit, Effect.forkChild);
            yield* Deferred.await(h.interruptEntered);
            yield* Deferred.succeed(h.interruptRelease, undefined);
            yield* Deferred.await(h.closeEntered);
            if (closeFails) {
              assert.isTrue(Exit.isFailure(yield* Fiber.join(stop)));
              yield* awaitUntil(
                () =>
                  h.events.some(
                    (e) =>
                      e.type === "turn_item.updated" &&
                      e.turnItem.type === "error" &&
                      e.turnItem.providerTurnId === a.turnId,
                  ),
                "truthful owned Stop failure",
              );
              assert.lengthOf(h.terminals(a.turnId), 0);
              const retry = yield* h.source.runtime
                .interruptTurn({
                  providerThread: h.source.providerThread,
                  providerTurnId: a.turnId,
                })
                .pipe(Effect.exit);
              assert.isTrue(Exit.isFailure(retry));
              assert.equal(a.query.closes, 1);
              assert.equal(a.query.interrupts, 1);
            } else yield* Deferred.await(h.pauseEntered);
            yield* h.settle(a.query, a.turnId);
            assert.lengthOf(h.terminals(a.turnId), 1, "genuine root result, not query EOF");
            const opens = h.queries.length;
            const offers = a.query.offers.length;
            for (const model of ["claude-sonnet-4-6", "claude-haiku-4-5-20251001"]) {
              const rejected = yield* h
                .start(`blocked-${model}`, { ...CLAUDE_TEST_MODEL_SELECTION, model })
                .pipe(Effect.exit);
              assert.isTrue(Exit.isFailure(rejected));
            }
            assert.equal(h.queries.length, opens);
            assert.equal(a.query.offers.length, offers);
            assert.equal(a.query.closes, 1);
            if (closeFails) yield* Queue.shutdown(a.query.sdkMessages);
            else {
              yield* Deferred.succeed(h.pauseRelease, undefined);
              assert.isTrue(Exit.isSuccess(yield* Fiber.join(stop)));
            }
            yield* awaitUntil(
              () =>
                h.events.some(
                  (e) => e.type === "provider_thread.updated" && e.providerThread.status === "idle",
                ),
              "genuine query exit settlement",
            );
            // The stream consumer's EOF receipt is observed by an ordinary start;
            // yielding lets that existing exact-query finalizer complete.
            let yields = 0;
            yield* awaitUntil(() => ++yields >= 50, "native EOF finalizer");
            const next = yield* h.start("after-real-EOF");
            assert.notStrictEqual(next.query, a.query);
            assert.equal(a.query.closes, 1);
            yield* h.settle(next.query, next.turnId);
            assert.lengthOf(h.terminals(a.turnId), 1);
            assert.lengthOf(h.terminals(next.turnId), 1);
            assert.equal(
              h.events.filter(
                (e) =>
                  e.type === "turn_item.updated" &&
                  e.turnItem.type === "error" &&
                  e.turnItem.providerTurnId === a.turnId,
              ).length,
              closeFails ? 1 : 0,
            );
          }).pipe(Effect.ensuring(h.save));
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
          ),
        ),
      ),
  );

  it.effect("lets the native SDK acknowledge Stop before closing its own query", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let closes = 0;
        let acknowledge = Effect.void;
        const harness = yield* makeWakeHarnessWithOptions({
          interrupt: Effect.suspend(() => {
            assert.equal(closes, 0);
            return acknowledge;
          }),
          close: (messages) =>
            Effect.sync(() => {
              closes++;
            }).pipe(Effect.andThen(Queue.shutdown(messages))),
        });
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("graceful-stop"),
            text: "Work until stopped",
            attachments: [],
          }),
        );
        const userMessageUuid = harness.offeredMessages.at(-1)?.uuid;
        if (userMessageUuid === undefined) return yield* Effect.die("Missing native user message");
        acknowledge = harness.offerAndWait(
          makeResultFrame({
            uuid: "00000000-0000-4000-8000-000000000620",
            result: "",
            subtype: "error_during_execution",
            errors: ["Error: Request was aborted."],
            terminalReason: "aborted_streaming",
            userMessageUuid,
          }),
        );
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "provider_turn.updated" && event.providerTurn.status === "running",
            ),
          "running native turn",
        );
        const active = harness.events.find(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.status === "running",
        );
        if (active?.type !== "provider_turn.updated")
          return yield* Effect.die("Missing running native turn");
        yield* harness.runtime.interruptTurn({
          providerThread: harness.providerThread,
          providerTurnId: active.providerTurn.id,
          requestRuntimeRestart: true,
        });
        assert.equal((yield* Queue.take(harness.terminalReceipts)).status, "interrupted");
        assert.equal(closes, 1);
        assert.lengthOf(harness.terminalEvents(), 1);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
        ),
      ),
    ),
  );

  it.effect("bounds an unacknowledged native Stop and settles its turn once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let closes = 0;
        const interruptStarted = yield* Deferred.make<void>();
        const harness = yield* makeWakeHarnessWithOptions({
          interrupt: Deferred.succeed(interruptStarted, undefined).pipe(
            Effect.andThen(Effect.never),
          ),
          close: (messages) =>
            Effect.sync(() => {
              closes++;
            }).pipe(Effect.andThen(Queue.shutdown(messages))),
        });
        yield* harness.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("unacknowledged-stop"),
            text: "Work until stopped",
            attachments: [],
          }),
        );
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "provider_turn.updated" && event.providerTurn.status === "running",
            ),
          "running native turn",
        );
        const active = harness.events.find(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.status === "running",
        );
        if (active?.type !== "provider_turn.updated")
          return yield* Effect.die("Missing running native turn");
        const stop = yield* harness.runtime
          .interruptTurn({
            providerThread: harness.providerThread,
            providerTurnId: active.providerTurn.id,
            requestRuntimeRestart: true,
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(interruptStarted);
        assert.equal(closes, 0);
        yield* TestClock.adjust("11 seconds");
        assert.isDefined(
          stop.pollUnsafe(),
          "Stop must finish despite a missing SDK acknowledgement",
        );
        yield* Fiber.join(stop);
        assert.equal((yield* Queue.take(harness.terminalReceipts)).status, "interrupted");
        assert.equal(closes, 1);
        assert.lengthOf(harness.terminalEvents(), 1);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
        ),
      ),
    ),
  );
});

describe("ClaudeAdapterV2 background wake turns (Tools)", () => {
  it.effect("retains image preview paths on Claude Read tool completion", () =>
    Effect.gen(function* () {
      const harness = yield* makeWakeHarness;
      const now = yield* DateTime.now;
      yield* harness.runtime.startTurn(
        makeClaudeTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make("attempt-read-images"),
          text: "Read the files",
          attachments: [],
        }),
      );
      const tools = [
        { id: "image", name: "Read", input: { file_path: " /workspace/reference.png " } },
        { id: "text", name: "Read", input: { file_path: "/workspace/README.md" } },
        { id: "search", name: "Grep", input: { pattern: "TODO", path: "/workspace/src" } },
        {
          id: "write",
          name: "Write",
          input: { file_path: "/workspace/output.png", content: "text" },
        },
      ];
      yield* Queue.offer(
        harness.sdkMessages,
        claudeSdkFrame({
          type: "assistant",
          uuid: "00000000-0000-4000-8000-000000000601",
          session_id: WAKE_NATIVE_SESSION,
          parent_tool_use_id: null,
          message: {
            id: "msg_image_reads",
            model: "claude-sonnet-4-6",
            type: "message",
            role: "assistant",
            content: tools.map((tool) => ({ type: "tool_use", ...tool })),
            stop_reason: "tool_use",
            stop_sequence: null,
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
        }),
      );
      yield* Queue.offer(
        harness.sdkMessages,
        claudeSdkFrame({
          type: "user",
          uuid: "00000000-0000-4000-8000-000000000602",
          session_id: WAKE_NATIVE_SESSION,
          parent_tool_use_id: null,
          message: {
            role: "user",
            content: tools.map((tool) => ({
              type: "tool_result",
              tool_use_id: tool.id,
              content: "ok",
            })),
          },
        }),
      );
      yield* Queue.offer(
        harness.sdkMessages,
        makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000603", result: "Read files" }),
      );
      yield* Queue.take(harness.terminalReceipts);
      const items = harness.events.flatMap((event) =>
        event.type === "turn_item.updated" && event.turnItem.status === "completed"
          ? [event.turnItem]
          : [],
      );
      const image = items.find((item) => item.nativeItemRef?.nativeId === "image");
      assert.equal(image?.type, "dynamic_tool");
      if (image?.type === "dynamic_tool")
        assert.equal(image.viewedImagePath, "/workspace/reference.png");
      assert.equal(image?.title, "Read /workspace/reference.png");
      assert.equal(
        items.find((item) => item.nativeItemRef?.nativeId === "text")?.title,
        "Read /workspace/README.md",
      );
      assert.equal(
        items.find((item) => item.nativeItemRef?.nativeId === "search")?.title,
        "Searched TODO in src",
      );
      for (const item of items.filter((item) => item.nativeItemRef?.nativeId !== "image"))
        assert.notProperty(item, "viewedImagePath");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer),
      ),
    ),
  );
});

describe("ClaudeAdapterV2 background wake turns (Workflows)", () => {
  it.effect("projects native workflow phases and stable inert member slots", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeWakeHarness;
        const now = yield* DateTime.now;
        yield* h.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: h.threadId,
            providerThread: h.providerThread,
            now,
            attemptId: RunAttemptId.make("workflow-presentation-attempt"),
            text: "Run a workflow",
            attachments: [],
          }),
        );
        const taskId = "workflow-verification";
        yield* Queue.offer(
          h.sdkMessages,
          claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: taskId,
            task_type: "local_workflow",
            description: "Verification",
            workflow_name: "Audit",
            subagent_type: "researcher",
            tool_use_id: "workflow-tool",
            uuid: "00000000-0000-4000-8000-000000000901",
            session_id: WAKE_NATIVE_SESSION,
          }),
        );
        const progress = claudeSdkFrame({
          type: "system",
          subtype: "task_progress",
          task_id: taskId,
          description: "Checking",
          usage: { total_tokens: 100, input_tokens: 80, tool_uses: 3 },
          last_tool_name: "Read",
          workflow_progress: [
            { type: "workflow_phase", index: 0, title: "Inspect" },
            {
              type: "workflow_agent",
              index: 0,
              state: "done",
              label: "Reader",
              phaseIndex: 0,
              phaseTitle: "Inspect",
              model: "claude/reader",
              attempt: 1,
              tokens: 40,
              toolCalls: 2,
            },
            { type: "workflow_agent", index: 1, state: "pending", label: "Auditor", phaseIndex: 0 },
          ],
          uuid: "00000000-0000-4000-8000-000000000902",
          session_id: WAKE_NATIVE_SESSION,
        });
        yield* Queue.offer(h.sdkMessages, progress);
        yield* Queue.offer(h.sdkMessages, progress);
        yield* awaitUntil(
          () =>
            h.events.filter(
              (event) =>
                event.type === "subagent.updated" &&
                event.subagent.presentation?.kind === "workflow_agent",
            ).length === 2,
          "two unique workflow members",
        );
        const native = h.events.flatMap((event) =>
          event.type === "subagent.updated" ? [event.subagent] : [],
        );
        const coordinator = native.findLast((agent) => agent.presentation?.kind === "workflow");
        assert.isDefined(coordinator);
        assert.deepEqual(coordinator?.presentation?.phases, [{ index: 0, title: "Inspect" }]);
        assert.equal(coordinator?.presentation?.usage?.totalTokens, 100);
        assert.equal(coordinator?.presentation?.role, "researcher");
        const members = native.filter((agent) => agent.presentation?.kind === "workflow_agent");
        assert.lengthOf(members, 2);
        assert.equal(members[0]?.presentation?.workflowId, coordinator?.id);
        assert.equal(members[0]?.presentation?.usage?.toolUses, 2);
        assert.equal(members[0]?.model, "claude/reader");
        assert.isTrue(
          members.every(
            (agent) =>
              agent.nativeTaskRef === null &&
              agent.runId === null &&
              agent.providerThreadId === null,
          ),
        );
        const firstTerminal = members[0]?.completedAt;
        yield* h.offerAndWait(
          claudeSdkFrame({
            ...progress,
            workflow_progress: [
              { type: "workflow_phase", index: 0, title: "Inspect" },
              {
                type: "workflow_agent",
                index: 0,
                state: "done",
                label: "Reader",
                phaseIndex: 0,
                phaseTitle: "Inspect",
                model: "claude/reader",
                attempt: 1,
                tokens: 65,
                toolCalls: 4,
              },
              {
                type: "workflow_agent",
                index: 1,
                state: "pending",
                label: "Auditor",
                phaseIndex: 0,
              },
            ],
            uuid: "00000000-0000-4000-8000-000000000905",
          }),
        );
        yield* awaitUntil(
          () =>
            h.events.some(
              (event) =>
                event.type === "subagent.updated" &&
                event.subagent.id === members[0]?.id &&
                event.subagent.presentation?.usage?.totalTokens === 65 &&
                event.subagent.presentation?.usage?.toolUses === 4,
            ),
          "rich member counter-only publication",
        );
        const usageUpdate = h.events.findLast(
          (event) => event.type === "subagent.updated" && event.subagent.id === members[0]?.id,
        );
        assert.equal(usageUpdate?.type, "subagent.updated");
        if (usageUpdate?.type !== "subagent.updated") return yield* Effect.die("Missing member.");
        assert.deepEqual(usageUpdate.subagent.presentation?.usage, {
          totalTokens: 65,
          toolUses: 4,
        });
        assert.equal(usageUpdate.subagent.childThreadId, members[0]?.childThreadId);
        assert.isNotNull(usageUpdate.subagent.childThreadId);
        assert.equal(usageUpdate.subagent.completedAt, firstTerminal);
        assert.equal(usageUpdate.subagent.startedAt, members[0]?.startedAt);
        assert.isNull(usageUpdate.subagent.runId);
        assert.isNull(usageUpdate.subagent.nativeTaskRef);
        yield* Queue.offer(
          h.sdkMessages,
          makeSubagentNotificationFrame({
            taskId,
            toolUseId: "workflow-tool",
            summary: "Verified",
            uuid: "00000000-0000-4000-8000-000000000903",
          }),
        );
        yield* Queue.offer(
          h.sdkMessages,
          makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000904", result: "Done" }),
        );
        yield* awaitUntil(() => h.terminalEvents().length === 1, "workflow root terminal");
        const final = h.events.flatMap((event) =>
          event.type === "subagent.updated" ? [event.subagent] : [],
        );
        assert.equal(
          final.findLast((agent) => agent.id === members[0]?.id)?.completedAt,
          firstTerminal,
        );
        assert.equal(final.findLast((agent) => agent.id === members[1]?.id)?.status, "completed");
        assert.equal(
          final.findLast((agent) => agent.id === coordinator?.id)?.presentation?.kind,
          "workflow",
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
        ),
      ),
    ),
  );

  it.effect("rejects late workflow members until an authoritative coordinator activation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* makeWakeHarness;
        yield* h.runtime.startTurn(
          makeClaudeTestTurnInput({
            threadId: h.threadId,
            providerThread: h.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("workflow-late-attempt"),
            text: "Workflow",
            attachments: [],
          }),
        );
        const taskId = "workflow-late";
        const started = claudeSdkFrame({
          type: "system",
          subtype: "task_started",
          task_id: taskId,
          task_type: "local_workflow",
          description: "Audit",
          tool_use_id: "late-tool",
          uuid: "00000000-0000-4000-8000-000000000911",
          session_id: WAKE_NATIVE_SESSION,
        });
        const progress = (attempt: number, index = 0) =>
          claudeSdkFrame({
            type: "system",
            subtype: "task_progress",
            task_id: taskId,
            description: "Checking",
            workflow_progress: [
              {
                type: "workflow_agent",
                index,
                state: "running",
                startedAt: "2026-10-04T00:00:00.000Z",
                attempt,
              },
            ],
            uuid: "00000000-0000-4000-8000-000000000912",
            session_id: WAKE_NATIVE_SESSION,
          });
        yield* h.offerAndWait(started);
        yield* h.offerAndWait(progress(1));
        yield* h.offerAndWait(
          claudeSdkFrame({ ...started, task_id: "unrelated-workflow", tool_use_id: "other-tool" }),
        );
        yield* h.offerAndWait(claudeSdkFrame({ ...progress(1), task_id: "unrelated-workflow" }));
        const coordinatorId = (yield* IdAllocator.IdAllocatorV2).derive.nodeFromProviderItem({
          driver: ClaudeAdapterV2.CLAUDE_PROVIDER,
          nativeItemId: `task:${taskId}`,
        });
        yield* h.offerAndWait(
          makeSubagentNotificationFrame({
            taskId,
            toolUseId: "late-tool",
            summary: "Finished",
            uuid: "00000000-0000-4000-8000-000000000913",
          }),
        );
        yield* h.offerAndWait(progress(9));
        yield* h.offerAndWait(progress(1, 1));
        yield* h.offerAndWait(
          makeAssistantTextFrame({
            uuid: "00000000-0000-4000-8000-000000000914",
            text: "workflow late-frame barrier",
          }),
        );
        yield* awaitUntil(
          () =>
            h.events.some(
              (event) =>
                event.type === "message.updated" &&
                event.message.text === "workflow late-frame barrier",
            ),
          "late progress output barrier",
        );
        const before = h.events.flatMap((event) =>
          event.type === "subagent.updated" &&
          event.subagent.presentation?.workflowId === coordinatorId
            ? [event.subagent]
            : [],
        );
        assert.deepEqual(
          before.map((member) => member.status),
          ["running", "completed"],
        );
        assert.equal(new Set(before.map((member) => member.id)).size, 1);
        assert.equal(
          h.events.findLast(
            (event) =>
              event.type === "subagent.updated" &&
              event.subagent.presentation?.kind === "workflow_agent" &&
              event.subagent.presentation?.workflowId !== coordinatorId,
          )?.type,
          "subagent.updated",
        );
        const unrelated = h.events
          .flatMap((event) =>
            event.type === "subagent.updated" &&
            event.subagent.presentation?.kind === "workflow_agent" &&
            event.subagent.presentation?.workflowId !== coordinatorId
              ? [event.subagent]
              : [],
          )
          .at(-1);
        assert.equal(unrelated?.status, "running");
        yield* h.offerAndWait(started);
        yield* h.offerAndWait(progress(1));
        yield* awaitUntil(
          () =>
            h.events.filter(
              (event) =>
                event.type === "subagent.updated" &&
                event.subagent.presentation?.workflowId === coordinatorId,
            ).length === 3,
          "authoritative workflow activation",
        );
        const reopened = h.events
          .flatMap((event) =>
            event.type === "subagent.updated" &&
            event.subagent.presentation?.workflowId === coordinatorId
              ? [event.subagent]
              : [],
          )
          .at(-1);
        assert.equal(reopened?.status, "running");
        assert.equal(reopened?.presentation?.activationCount, 2);
        assert.isNull(reopened?.completedAt);
        assert.equal(reopened?.presentation?.firstSeenAt, before[0]?.presentation?.firstSeenAt);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
        ),
      ),
    ),
  );

  it.effect(
    "preserves count-only workflow observations and progress buffered before idle activation drain",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeWakeHarness;
          const now = yield* DateTime.now;
          yield* h.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: h.threadId,
              providerThread: h.providerThread,
              now,
              attemptId: RunAttemptId.make("workflow-counts-first"),
              text: "Audit",
              attachments: [],
            }),
          );
          const started = claudeSdkFrame({
            type: "system",
            subtype: "task_started",
            task_id: "count-workflow",
            task_type: "local_workflow",
            description: "Audit",
            tool_use_id: "count-tool",
            uuid: "00000000-0000-4000-8000-000000000971",
            session_id: WAKE_NATIVE_SESSION,
          });
          const progress = (tokens: number | undefined, toolCalls: number) =>
            claudeSdkFrame({
              type: "system",
              subtype: "task_progress",
              task_id: "count-workflow",
              description: "Inspect",
              workflow_progress: [
                {
                  type: "workflow_agent",
                  index: 0,
                  state: "running",
                  attempt: 1,
                  startedAt: "2026-10-04T00:00:00.000Z",
                  ...(tokens === undefined ? {} : { tokens }),
                  toolCalls,
                },
              ],
              uuid: "00000000-0000-4000-8000-000000000972",
              session_id: WAKE_NATIVE_SESSION,
            });
          const members = () =>
            h.events.flatMap((event) =>
              event.type === "subagent.updated" &&
              event.subagent.presentation?.kind === "workflow_agent"
                ? [event.subagent]
                : [],
            );
          yield* h.offerAndWait(started);
          yield* h.offerAndWait(progress(undefined, 2));
          yield* awaitUntil(() => members().length === 1, "count-only member receipt");
          assert.deepEqual(members().at(-1)?.presentation?.usage, { toolUses: 2 });
          const firstSeen = members().at(-1)?.presentation?.firstSeenAt;
          yield* h.offerAndWait(progress(40, 2));
          yield* h.offerAndWait(progress(undefined, 5));
          yield* awaitUntil(
            () => members().at(-1)?.presentation?.usage?.toolUses === 5,
            "sparse tool count receipt",
          );
          assert.deepEqual(members().at(-1)?.presentation?.usage, { totalTokens: 40, toolUses: 5 });
          yield* h.offerAndWait(
            makeSubagentNotificationFrame({
              taskId: "count-workflow",
              toolUseId: "count-tool",
              summary: "Done",
              uuid: "00000000-0000-4000-8000-000000000973",
            }),
          );
          yield* h.offerAndWait(
            makeResultFrame({ uuid: "00000000-0000-4000-8000-000000000974", result: "Done" }),
          );
          yield* Queue.take(h.terminalReceipts);
          // The authoritative start is buffered while root is idle. Progress must
          // travel with it, rather than be consumed against the old terminal context.
          yield* h.offerAndWait(started);
          yield* h.offerAndWait(progress(60, 7));
          yield* h.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: h.threadId,
              providerThread: h.providerThread,
              now,
              attemptId: RunAttemptId.make("workflow-counts-continuation"),
              text: "Continue",
              attachments: [],
              providerTurnOrdinal: 2,
              messageCreatedBy: "agent",
              messageCreationSource: "provider",
            }),
          );
          yield* awaitUntil(
            () => members().at(-1)?.presentation?.usage?.totalTokens === 60,
            "buffered workflow progress after activation",
          );
          const reopened = members().at(-1);
          assert.equal(reopened?.status, "running");
          assert.equal(reopened?.presentation?.activationCount, 2);
          assert.equal(reopened?.presentation?.firstSeenAt, firstSeen);
          assert.deepEqual(reopened?.presentation?.usage, { totalTokens: 60, toolUses: 7 });
          assert.lengthOf(h.offeredMessages, 1);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
          ),
        ),
      ),
  );

  it.effect.each(["failed", "interrupted"] as const)(
    "settles workflow members on native query %s lifecycle",
    (status) =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeWakeHarnessWithOptions({
            close: (messages) => Queue.shutdown(messages),
          });
          yield* h.runtime.startTurn(
            makeClaudeTestTurnInput({
              threadId: h.threadId,
              providerThread: h.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make(`workflow-query-${status}`),
              text: "Workflow",
              attachments: [],
            }),
          );
          yield* h.offerAndWait(
            claudeSdkFrame({
              type: "system",
              subtype: "task_started",
              task_id: "query-workflow",
              task_type: "local_workflow",
              description: "Audit",
              uuid: "00000000-0000-4000-8000-000000000921",
              session_id: WAKE_NATIVE_SESSION,
            }),
          );
          yield* h.offerAndWait(
            claudeSdkFrame({
              type: "system",
              subtype: "task_progress",
              task_id: "query-workflow",
              description: "Checking",
              workflow_progress: [
                {
                  type: "workflow_agent",
                  index: 0,
                  state: "running",
                  startedAt: "2026-10-04T00:00:00.000Z",
                  attempt: 1,
                },
              ],
              uuid: "00000000-0000-4000-8000-000000000922",
              session_id: WAKE_NATIVE_SESSION,
            }),
          );
          if (status === "interrupted") {
            yield* awaitUntil(
              () => h.events.some((event) => event.type === "provider_turn.updated"),
              "native provider turn receipt",
            );
            const providerTurn = h.events.findLast(
              (event) => event.type === "provider_turn.updated",
            );
            assert.isTrue(providerTurn?.type === "provider_turn.updated");
            if (providerTurn?.type !== "provider_turn.updated") return;
            yield* h.runtime.interruptTurn({
              providerThread: h.providerThread,
              providerTurnId: providerTurn.providerTurn.id,
            });
          } else yield* Queue.shutdown(h.sdkMessages);
          yield* Queue.take(h.terminalReceipts);
          const members = h.events.flatMap((event) =>
            event.type === "subagent.updated" &&
            event.subagent.presentation?.kind === "workflow_agent"
              ? [event.subagent]
              : [],
          );
          assert.equal(members.at(-1)?.status, status);
          assert.isNotNull(members.at(-1)?.completedAt);
          assert.isFalse(yield* h.hasPendingBackgroundWork);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
          ),
        ),
      ),
  );
});

it.effect(
  "reserves a settled query through causal EOF cleanup before same-native replacement",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const clock = yield* Clock.Clock;
        const cleanupEntered = yield* Deferred.make<void>();
        const cleanupRelease = yield* Deferred.make<void>();
        const closeJoined = yield* Deferred.make<void>();
        let firstExit = true;
        let cleanupPending = false;
        const controlledClock = {
          ...clock,
          currentTimeMillis: Effect.suspend(() => {
            if (!cleanupPending) return clock.currentTimeMillis;
            cleanupPending = false;
            return Deferred.succeed(cleanupEntered, undefined).pipe(
              Effect.andThen(Deferred.await(cleanupRelease)),
              Effect.andThen(clock.currentTimeMillis),
            );
          }),
        };
        yield* Effect.gen(function* () {
          const h = yield* makeWakeHarnessWithOptions({
            freshQueueOnReopen: true,
            onStreamExit: Effect.sync(() => {
              if (firstExit) {
                cleanupPending = true;
                firstExit = false;
              }
            }),
            close: () => Deferred.succeed(closeJoined, undefined).pipe(Effect.asVoid),
            forkSession: () => Effect.succeed({ sessionId: "synthetic-eof-close-observer" }),
          });
          const turn = (attempt: string) =>
            makeClaudeTestTurnInput({
              threadId: h.threadId,
              providerThread: h.providerThread,
              now: DateTime.makeUnsafe("2026-10-12T00:00:00.000Z"),
              attemptId: RunAttemptId.make(attempt),
              text: "Run a workflow",
              attachments: [],
            });
          yield* h.runtime.startTurn(turn("eof-cleanup-owner"));
          yield* h.offerAndWait(
            claudeSdkFrame({
              type: "system",
              subtype: "task_started",
              task_id: "eof-legacy-workflow",
              task_type: "local_workflow",
              workflow_name: "Legacy cleanup",
              description: "Still working",
              tool_use_id: "eof-legacy-workflow-tool",
              uuid: "00000000-0000-4000-8000-000000001801",
              session_id: WAKE_NATIVE_SESSION,
            }),
          );
          const coordinator = yield* Queue.take(h.subagentReceipts);
          assert.equal(coordinator.subagent.status, "running");
          yield* h.offerAndWait(
            makeResultFrame({
              uuid: "00000000-0000-4000-8000-000000001802",
              result: "Launched.",
            }),
          );
          assert.equal((yield* Queue.take(h.terminalReceipts)).status, "completed");
          yield* Queue.shutdown(h.sdkMessages);
          // The first cleanup clock read occurs inside legacy coordinator retirement,
          // after native EOF and its queryOwnership reservation, with the root settled.
          yield* Deferred.await(cleanupEntered);
          const refused = yield* h.runtime
            .startTurn(turn("eof-cleanup-replacement"))
            .pipe(Effect.result);
          assert.equal(refused._tag, "Failure");
          assert.include(JSON.stringify(refused), "Claude captured Stop close remains unresolved.");
          assert.lengthOf(h.processQueues, 1, "cleanup must not open a replacement process");
          // Use the existing public fork close owner to join the captured query's
          // real closed receipt. Its SDK fork is synthetic and writes no native files.
          const joined = yield* h.runtime
            .forkThread({
              sourceProviderThread: h.providerThread,
              targetThreadId: ThreadId.make("synthetic-eof-close-observer"),
            })
            .pipe(Effect.forkChild);
          yield* Deferred.await(closeJoined);
          yield* Deferred.succeed(cleanupRelease, undefined);
          yield* Fiber.join(joined);
          const ended = yield* Queue.take(h.subagentReceipts);
          assert.equal(ended.subagent.id, coordinator.subagent.id);
          assert.notEqual(ended.subagent.status, "running");
          yield* h.runtime.startTurn(turn("eof-cleanup-replacement"));
          assert.lengthOf(
            h.processQueues,
            2,
            "the same native thread can start after cleanup joins",
          );
        }).pipe(Effect.provideService(Clock.Clock, controlledClock));
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, NodeServices.layer, McpProviderSessions.layer),
        ),
      ),
    ),
);
