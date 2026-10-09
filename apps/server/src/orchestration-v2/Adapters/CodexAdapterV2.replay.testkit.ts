import * as Crypto from "effect/Crypto";
import {
  CodexSettings,
  type ModelSelection,
  ThreadId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2AppThread,
  ProjectId,
  RunAttemptId,
  RunId,
  NodeId,
  MessageId,
  ProviderSessionId,
} from "@t3tools/contracts";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import packageJson from "../../../package.json" with { type: "json" };
import { buildScientRuntimeInstructions } from "../../provider/ScientRuntimeInstructions.ts";
import { buildScientAwareness } from "../../provider/ScientAwareness.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2TurnInput,
  type ProviderAdapterV2Event,
  ProviderAdapterOpenSessionError,
} from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProviderContinuationRequest } from "@t3tools/provider-core/server/continuationRequests";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import { makeReplayServerConfig, withCodexReplayChildMetadata } from "./CodexAdapterV2.testkit.ts";

export const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

export const DEFAULT_CODEX_SETTINGS = Schema.decodeSync(CodexSettings)({});

export const CODEX_TEST_MODEL_SELECTION = {
  instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
  model: "gpt-5.4",
} satisfies ModelSelection;

export const CODEX_TEST_RUNTIME_POLICY = ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace",
});

function makeCodexTestAppThread(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
}): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: input.threadId,
    projectId: ProjectId.make(`project-${input.threadId}`),
    title: "Codex continuation test",
    providerInstanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
    modelSelection: CODEX_TEST_MODEL_SELECTION,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: input.providerThread.id,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: input.threadId,
    },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

export function makeCodexTestTurnInput(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
  readonly attemptId: RunAttemptId;
  readonly text: string;
}): ProviderAdapterV2TurnInput {
  return {
    appThread: makeCodexTestAppThread(input),
    threadId: input.threadId,
    runId: RunId.make(`run-${input.attemptId}`),
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId: input.attemptId,
    rootNodeId: NodeId.make(`node-${input.attemptId}`),
    providerThread: input.providerThread,
    message: {
      createdBy: "user",
      creationSource: "web",
      messageId: MessageId.make(`message-${input.attemptId}`),
      text: input.text,
      attachments: [],
    },
    modelSelection: CODEX_TEST_MODEL_SELECTION,
    runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
  };
}

export function makeCodexReplayTurn(input: {
  readonly id: string;
  readonly status: "inProgress" | "completed" | "interrupted" | "failed";
}): Record<string, unknown> {
  const terminal =
    input.status === "completed" || input.status === "interrupted" || input.status === "failed";
  return {
    id: input.id,
    items: [],
    itemsView: "notLoaded",
    status: input.status,
    error: null,
    startedAt: 1782622440,
    completedAt: terminal ? 1782622450 : null,
    durationMs: null,
  };
}

export function codexReplayPreamble(input: {
  readonly nativeThreadId: string;
  readonly nativeTurnId: string;
  readonly prompt: string;
  /** Text the adapter should send, when it differs from what the user typed. */
  readonly sentPrompt?: string;
  readonly startRequestId?: number;
  readonly cwd?: string;
}): Array<CodexReplay.CodexAppServerReplayEntry> {
  return [
    {
      type: "expect_outbound",
      label: "initialize",
      // Synthetic request expectation uses Scient's shared client identity;
      // native response/event frames retain their recorded protocol shapes.
      frame: {
        id: 1,
        method: "initialize",
        params: {
          clientInfo: {
            name: "t3code_desktop",
            title: "Scient Desktop",
            version: packageJson.version,
          },
          capabilities: {
            experimentalApi: true,
            extensions: {
              "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
            },
            optOutNotificationMethods: ["turn/diff/updated"],
          },
        },
      },
    },
    {
      type: "emit_inbound",
      label: "initialize",
      frame: {
        id: 1,
        result: {
          userAgent: "T3 Code/0.156.1",
          codexHome: "/tmp/codex-home",
          platformFamily: "unix",
          platformOs: "macos",
        },
      },
    },
    { type: "expect_outbound", label: "initialized", frame: { method: "initialized" } },
    {
      type: "expect_outbound",
      label: "thread/start",
      frame: {
        id: input.startRequestId ?? 2,
        method: "thread/start",
        params: {
          config: CodexAdapterV2.CODEX_THREAD_CONFIG,
          ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
        },
      },
    },
    {
      type: "emit_inbound",
      label: "thread/start",
      frame: {
        id: input.startRequestId ?? 2,
        result: {
          thread: {
            id: input.nativeThreadId,
            sessionId: input.nativeThreadId,
            forkedFromId: null,
            preview: "",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: 1782622440,
            updatedAt: 1782622440,
            status: { type: "idle" },
            path: `/tmp/${input.nativeThreadId}.jsonl`,
            cwd: input.cwd ?? "/workspace",
            cliVersion: "0.144.0",
            source: "vscode",
            threadSource: null,
            agentNickname: null,
            agentRole: null,
            gitInfo: null,
            name: null,
            turns: [],
          },
          model: "gpt-5.4",
          modelProvider: "openai",
          serviceTier: null,
          cwd: input.cwd ?? "/workspace",
          instructionSources: [],
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
          reasoningEffort: "medium",
        },
      },
    },
    {
      type: "expect_outbound",
      label: "turn/start",
      frame: {
        id: 3,
        method: "turn/start",
        params: {
          threadId: input.nativeThreadId,
          input: [{ type: "text", text: input.sentPrompt ?? input.prompt }],
          cwd: input.cwd ?? "/workspace",
          model: "gpt-5.4",
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandboxPolicy: { type: "dangerFullAccess" },
          summary: "detailed",
          additionalContext: {
            t3_code_runtime: {
              kind: "application",
              value: buildScientRuntimeInstructions({
                harness: "Codex",
                model: "gpt-5.4",
                reasoningEffort: "medium",
              }),
            },
            scient_awareness: { kind: "application", value: buildScientAwareness() },
          },
        },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/start",
      frame: {
        id: 3,
        result: { turn: makeCodexReplayTurn({ id: input.nativeTurnId, status: "inProgress" }) },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/started",
      frame: {
        method: "turn/started",
        params: {
          threadId: input.nativeThreadId,
          turn: makeCodexReplayTurn({ id: input.nativeTurnId, status: "inProgress" }),
        },
      },
    },
  ];
}

export function makeCodexReplayTranscript(input: {
  readonly scenario: string;
  readonly entries: ReadonlyArray<CodexReplay.CodexAppServerReplayEntry>;
}): CodexReplay.CodexAppServerReplayTranscript {
  return {
    provider: "codex",
    protocol: "codex.app-server",
    version: "0.144.0",
    scenario: input.scenario,
    entries: input.entries,
  };
}

export const awaitUntil = (predicate: () => boolean, label: string): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 5000; attempt++) {
      if (predicate()) {
        return;
      }
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(`Timed out waiting for ${label}.`);
  });

export const makeCodexReplayHarness = (
  transcript: CodexReplay.CodexAppServerReplayTranscript,
  onEvent: (event: ProviderAdapterV2Event) => Effect.Effect<unknown> = () => Effect.void,
  onRequest: (method: string, params: unknown) => Effect.Effect<void> = () => Effect.void,
  readChildMetadata?: (threadId: string) => Effect.Effect<unknown>,
  configureMcp?: boolean,
  settings?: CodexSettings,
  options: {
    readonly additionalSessions?: ReadonlyArray<CodexReplay.CodexAppServerReplayTranscript>;
    readonly resolveRuntime?: CodexAdapterV2.CodexAdapterV2Options["resolveRuntime"];
    readonly replayDriver?: CodexReplay.CodexAppServerReplayDriver;
    readonly onSessionClose?: () => Effect.Effect<void>;
  } = {},
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const serverConfig = yield* makeReplayServerConfig(transcript.scenario).pipe(Effect.orDie);
    const continuationRequests: Array<ProviderContinuationRequest> = [];
    const transcripts = [transcript, ...(options.additionalSessions ?? [])];
    let sessionOrdinal = 0;
    const clientFactory: CodexAdapterV2.CodexAppServerClientFactoryShape = {
      open: (openInput) => {
        const sessionTranscript = transcripts[sessionOrdinal++];
        if (!sessionTranscript) return Effect.die("Unexpected native Codex session open");
        const replayLayer = options.replayDriver
          ? CodexReplay.layerReplayWithDriver(options.replayDriver)
          : CodexReplay.layerReplay(sessionTranscript);
        return Layer.build(replayLayer).pipe(
          Effect.tap(() =>
            options.onSessionClose ? Effect.addFinalizer(options.onSessionClose) : Effect.void,
          ),
          Effect.mapError(
            (cause) =>
              new ProviderAdapterOpenSessionError({
                driver: CodexAdapterV2.CODEX_DRIVER_KIND,
                providerSessionId: openInput.providerSessionId,
                cause,
              }),
          ),
          Effect.flatMap((context) =>
            Effect.service(CodexClient.CodexAppServerClient).pipe(
              Effect.map((client) =>
                withCodexReplayChildMetadata(client, sessionTranscript, readChildMetadata),
              ),
              Effect.map(
                (client) =>
                  ({
                    ...client,
                    request: (method, params) =>
                      onRequest(method, params).pipe(
                        Effect.andThen(client.request(method, params)),
                      ),
                  }) satisfies CodexClient.CodexAppServerClient["Service"],
              ),
              Effect.provide(context),
            ),
          ),
        );
      },
    };
    const adapter = CodexAdapterV2.makeCodexAdapterV2({
      crypto: yield* Crypto.Crypto,
      instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
      settings: settings ?? DEFAULT_CODEX_SETTINGS,
      environment: {},
      clientFactory,
      fileSystem,
      path: yield* Path.Path,
      idAllocator,
      serverConfig,
      ...(options.resolveRuntime ? { resolveRuntime: options.resolveRuntime } : {}),
      continuationRequests: {
        offer: (request) =>
          Effect.sync(() => {
            continuationRequests.push(request);
          }),
      },
    });
    const threadId = ThreadId.make(`thread-${transcript.scenario}`);
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make(`provider-session-${transcript.scenario}`),
      ...(configureMcp === undefined ? {} : { configureMcp }),
      modelSelection: CODEX_TEST_MODEL_SELECTION,
      runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
    });
    const providerThread = yield* runtime.ensureThread({
      threadId,
      modelSelection: CODEX_TEST_MODEL_SELECTION,
      runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
    });
    const events: Array<ProviderAdapterV2Event> = [];
    const firstTerminal = yield* Deferred.make<void>();
    yield* runtime.events.pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          events.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.terminal"
              ? Deferred.succeed(firstTerminal, undefined)
              : Effect.void,
          ),
          Effect.andThen(onEvent(event)),
        ),
      ),
      Effect.forkScoped,
    );
    if (runtime.hasPendingBackgroundWork === undefined) {
      return yield* Effect.die("Codex adapter runtime must expose hasPendingBackgroundWork.");
    }
    const hasPendingBackgroundWork = runtime.hasPendingBackgroundWork;
    const terminalEvents = () =>
      events.filter(
        (event): event is Extract<ProviderAdapterV2Event, { type: "turn.terminal" }> =>
          event.type === "turn.terminal",
      );
    const subagentUpdates = () =>
      events.filter(
        (event): event is Extract<ProviderAdapterV2Event, { type: "subagent.updated" }> =>
          event.type === "subagent.updated",
      );
    return {
      adapter,
      runtime,
      providerThread,
      threadId,
      events,
      continuationRequests,
      terminalEvents,
      subagentUpdates,
      hasPendingBackgroundWork,
      firstTerminal: Deferred.await(firstTerminal),
      serverConfig,
    };
  });

export const assistantMessages = (events: ReadonlyArray<ProviderAdapterV2Event>) =>
  events.filter(
    (event): event is Extract<ProviderAdapterV2Event, { type: "message.updated" }> =>
      event.type === "message.updated" && event.message.role === "assistant",
  );

export const INTERRUPT_NATIVE_THREAD = "native-codex-interrupt-thread";

export const INTERRUPT_NATIVE_TURN = "native-codex-interrupt-turn";

const INTERRUPT_COMMAND_ITEM = "exec-codex-interrupt-command";

export const INTERRUPT_COMMAND = "bash -c 'sleep 30; echo SHOULD_NOT_FINISH_CMD_INTERRUPT_FIXTURE'";

export const INTERRUPT_PROMPT = "Run a long foreground command and wait until interrupted.";

export const interruptCommandItem = (
  status: "inProgress" | "completed",
): Record<string, unknown> => ({
  type: "commandExecution",
  id: INTERRUPT_COMMAND_ITEM,
  command: INTERRUPT_COMMAND,
  cwd: "/workspace",
  processId: "57680",
  source: "unifiedExecStartup",
  status,
  commandActions: [{ type: "unknown", command: INTERRUPT_COMMAND }],
  aggregatedOutput: status === "completed" ? "SHOULD_NOT_FINISH_CMD_INTERRUPT_FIXTURE\n" : null,
  exitCode: status === "completed" ? 0 : null,
  durationMs: status === "completed" ? 30_000 : null,
});
