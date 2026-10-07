import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ProviderInstanceConfigMap,
  ThreadId,
  TurnId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import packageJson from "../../../package.json" with { type: "json" };
import * as ServerConfig from "../../config.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import { buildRuntimeInstructions } from "../../provider/RuntimeInstructions.ts";
import { buildScientAwareness } from "../../provider/ScientAwareness.ts";
import * as CodexAdapterV2 from "../Adapters/CodexAdapterV2.ts";
import { CodexOrchestratorReplayHarness } from "../Adapters/CodexAdapterV2.testkit.ts";
import { OrchestrationEffectWorkerV2 } from "../EffectWorker.ts";
import { EffectOutboxV2 } from "../EffectOutbox.ts";
import { CommandReceiptStoreV2 } from "../CommandReceiptStore.ts";
import { EventSinkV2 } from "../EventSink.ts";
import { EventStoreV2 } from "../EventStore.ts";
import { OrchestratorV2 } from "../Orchestrator.ts";
import { layer as allocatorLayer } from "../IdAllocator.ts";
import { makeDriverLayer } from "../ProviderAdapterRegistry.ts";
import {
  ProviderAdapterOpenSessionError,
  type ProviderTextSnapshotOwner,
  type ProviderTextSnapshotBatch,
} from "../ProviderAdapter.ts";
import { ProviderSessionManagerV2 } from "../ProviderSessionManager.ts";
import { ProjectionStoreV2, layerMemory } from "../ProjectionStore.ts";
import {
  ScientForkAttachmentCopier,
  ScientForkAttachmentCopierLive,
} from "./ForkAttachmentCopier.ts";
import { ConversationForkService } from "../scient-fork/ConversationForkService.ts";
import {
  makeOrchestratorV2ReplayLayerWithRegistry,
  makeReplayServerConfig,
} from "../testkit/ProviderReplayHarness.ts";
import { makeProviderReplayGate } from "../testkit/ProviderReplayGate.testkit.ts";
import { checkpointWorkspace } from "../testkit/ReplayFixtureWorkspace.ts";
function makeCodexReplayTurn(input: {
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
function codexReplayPreamble(input: {
  readonly nativeThreadId: string;
  readonly nativeTurnId: string;
  readonly prompt: string;
  /** Text the adapter should send, when it differs from what the user typed. */
  readonly sentPrompt?: string;
  readonly startRequestId?: number;
  readonly turnRequestId?: number;
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
          model: "gpt-5.4",
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
        id: input.turnRequestId ?? 3,
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
              value: buildRuntimeInstructions({
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
        id: input.turnRequestId ?? 3,
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
function makeCodexReplayTranscript(input: {
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
const waitFor = Effect.fnUntraced(function* (
  threadId: ThreadId,
  predicate: (projection: OrchestrationV2ThreadProjection) => boolean,
) {
  const orchestrator = yield* OrchestratorV2;
  const cursor = yield* orchestrator.getThreadEventSequence(threadId);
  const pull = yield* Stream.toPull(
    orchestrator.streamStoredEventsFrom({ threadId, afterSequence: cursor }),
  );
  const found = yield* Stream.concat(
    Stream.fromEffect(orchestrator.getThreadProjection(threadId)),
    Stream.fromPull(Effect.succeed(pull)).pipe(
      Stream.mapEffect(() => orchestrator.getThreadProjection(threadId)),
    ),
  ).pipe(Stream.filter(predicate), Stream.runHead, Effect.timeout("15 seconds"));
  assert.ok(Option.isSome(found));
  return found.value;
});
for (const scenario of [
  {
    mode: "empty",
    streaming: "turn",
    clean: false,
    control: "none",
    title: "acknowledges a genuinely empty native buffer only through the guarded SQL owner",
  },
  {
    mode: "buffer",
    streaming: "turn",
    clean: false,
    control: "none",
    title: "freezes received coalescer-held Codex text without finalizing the running source",
  },
  {
    mode: "block",
    streaming: "paragraph",
    clean: false,
    control: "none",
    title: "captures full incomplete Markdown through the native paragraph filter",
  },
  {
    mode: "clean",
    streaming: "paragraph",
    clean: true,
    control: "none",
    title: "captures clean retained native text after normal filtering truncated it",
  },
  {
    mode: "sql-retry",
    streaming: "turn",
    clean: false,
    control: "sql",
    title: "rolls back a real raw-item SQL failure and retries the same native prefix",
  },
  {
    mode: "cancel-retry",
    streaming: "turn",
    clean: false,
    control: "cancel",
    title: "cancels the capture waiter before SQL finishes without hanging or publishing a child",
  },
  {
    mode: "timeout-retry",
    streaming: "turn",
    clean: false,
    control: "timeout",
    title: "expires a stalled real text consumer without stopping the source and retries safely",
  },
  {
    mode: "cancel-ordinary",
    streaming: "paragraph",
    clean: false,
    control: "cancel-ordinary",
    title:
      "delivers the original ordinary prefix without recapture after cancel before carrier consumption",
  },
  {
    mode: "sql-ordinary",
    streaming: "paragraph",
    clean: false,
    control: "sql-ordinary",
    title: "delivers the original ordinary prefix without recapture after raw SQL failure",
  },
  {
    mode: "pooled",
    streaming: "turn",
    clean: false,
    control: "pooled",
    title:
      "captures simultaneous native roots through one pooled SDK owner without crossing consumers",
  },
  {
    mode: "before-ack-delta",
    streaming: "turn",
    clean: false,
    control: "pre-delta",
    title: "refuses newer received native text before the owning SQL acknowledgement",
  },
  {
    mode: "replaced-generation",
    streaming: "turn",
    clean: false,
    control: "close",
    title: "refuses a retired generation during planning after reopening the same session ID",
  },
  {
    mode: "eof-after-ack",
    streaming: "turn",
    clean: false,
    control: "eof-final",
    title: "refuses actual SDK termination during slow planning after raw SQL acknowledgement",
  },
  {
    mode: "detached-owner",
    streaming: "turn",
    clean: false,
    control: "detach",
    title: "settles a pending capture when the real manager detaches its native owner",
  },
  {
    mode: "eof-waiter",
    streaming: "turn",
    clean: false,
    control: "eof",
    title:
      "settles a pending native capture on actual SDK transport failure without publishing a child",
  },
  {
    mode: "stop-before-sql",
    streaming: "turn",
    clean: false,
    control: "stop",
    title: "refuses a durable Stop admitted before raw SQL capture",
  },
  {
    mode: "replacement",
    streaming: "paragraph",
    clean: false,
    control: "replacement",
    title:
      "protects captured raw text from shortened filtering and accepts genuine final replacement once",
  },
  {
    mode: "healthy-suffix",
    streaming: "paragraph",
    clean: false,
    control: "healthy",
    title: "accepts a frozen prefix while healthy native suffix reaches SQL during slow planning",
  },
  {
    mode: "workspace-control",
    streaming: "turn",
    clean: false,
    control: "workspace",
    title: "refuses a changed captured workspace branch during slow planning",
  },
  {
    mode: "workspace-resource",
    streaming: "turn",
    clean: false,
    control: "resource",
    title: "refuses an unavailable captured workspace during slow planning",
  },
  {
    mode: "completed-cutoff",
    streaming: "turn",
    clean: false,
    control: "complete",
    title: "refuses native completion during fork planning without publishing a child",
  },
  {
    mode: "sql-cutoff",
    streaming: "turn",
    clean: false,
    control: "metadata",
    title: "atomically refuses a rollback control change after native capture",
  },
  {
    mode: "foreign-owner",
    streaming: "turn",
    clean: false,
    control: "foreign",
    title: "rejects foreign native identities and preserves actual receipt replay",
  },
] as const) {
  const mode = scenario.mode;
  it.live(scenario.title, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* checkpointWorkspace(`native-fork-${mode}`);
        const privateRoot = yield* fs.makeTempDirectoryScoped({
          prefix: `scient-native-fork-${mode}-`,
        });
        const home = path.join(privateRoot, "home");
        yield* fs.makeDirectory(home);
        const config = yield* makeReplayServerConfig(`native-fork-${mode}`);
        yield* Effect.addFinalizer(() =>
          fs.remove(config.baseDir, { recursive: true }).pipe(Effect.orDie),
        );
        const database = path.join(privateRoot, "state.sqlite");
        const nativeThreadId = `native-fork-${mode}`;
        const nativeTurnId = `native-turn-${mode}`;
        const nativeItemId = "buffered-answer";
        const peerNativeThreadId = `${nativeThreadId}-peer`;
        const peerNativeTurnId = `${nativeTurnId}-peer`;
        const peerId = ThreadId.make(`${mode}-peer`);
        const peerForkId = ThreadId.make(`${mode}-peer-child`);
        const peerPrefix = "Independent peer prefix. ";
        const peerSuffix = "Peer finished.";
        const peerPrompt = "Write an independent peer answer";
        const prefix =
          mode === "empty"
            ? ""
            : ["cancel-ordinary", "sql-ordinary"].includes(scenario.control)
              ? "Ready paragraph.\n\n"
              : scenario.streaming === "paragraph"
                ? "Ready paragraph.\n\n```ts\nheld"
                : "Held in memory so far. ";
        const suffix =
          scenario.control === "healthy" ? "\n```\n\nThen the rest.\n\n" : "Then the rest.";
        const threadId = ThreadId.make(`native-fork-${mode}-source`);
        const forkId = ThreadId.make(`native-fork-${mode}-child`);
        const projectId = ProjectId.make(`native-fork-${mode}-project`);
        const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
        const prompt = "Write a partial answer";
        const nativePlan: CodexReplay.CodexAppServerReplayEntry = {
          type: "emit_inbound",
          label: "after-normal-frame",
          frame: {
            method: "turn/plan/updated",
            params: {
              threadId: nativeThreadId,
              turnId: nativeTurnId,
              explanation: "Native output continues",
              plan: [{ step: "Finish answer", status: "inProgress" }],
            },
          },
        };
        const finalText =
          scenario.control === "replacement"
            ? "A genuinely replaced native final answer."
            : prefix + suffix;
        const nativeDelta = (
          delta: string,
        ): Extract<CodexReplay.CodexAppServerReplayEntry, { readonly type: "emit_inbound" }> => ({
          type: "emit_inbound",
          label: "assistant delta",
          frame: {
            method: "item/agentMessage/delta",
            params: {
              threadId: nativeThreadId,
              turnId: nativeTurnId,
              itemId: nativeItemId,
              delta,
            },
          },
        });
        const endEntries: ReadonlyArray<CodexReplay.CodexAppServerReplayEntry> = [
          nativeDelta(suffix),
          {
            type: "emit_inbound",
            label: "turn completion",
            frame: {
              method: "turn/completed",
              params: {
                threadId: nativeThreadId,
                turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
              },
            },
          },
        ];
        const peerDelta = (
          delta: string,
        ): Extract<CodexReplay.CodexAppServerReplayEntry, { readonly type: "emit_inbound" }> => ({
          type: "emit_inbound",
          frame: {
            method: "item/agentMessage/delta",
            params: {
              threadId: peerNativeThreadId,
              turnId: peerNativeTurnId,
              itemId: "peer-buffered-answer",
              delta,
            },
          },
        });
        const detachEntries: ReadonlyArray<CodexReplay.CodexAppServerReplayEntry> = [
          { ...nativePlan, label: "after-running-fork" },
          {
            type: "expect_outbound",
            frame: {
              id: 4,
              method: "turn/interrupt",
              params: { threadId: nativeThreadId, turnId: nativeTurnId },
            },
          },
          { type: "emit_inbound", frame: { id: 4, result: {} } },
          {
            type: "emit_inbound",
            frame: {
              method: "turn/completed",
              params: {
                threadId: nativeThreadId,
                turn: makeCodexReplayTurn({ id: nativeTurnId, status: "interrupted" }),
              },
            },
          },
          {
            type: "expect_outbound",
            frame: { id: 5, method: "thread/unsubscribe", params: { threadId: nativeThreadId } },
          },
          { type: "emit_inbound", frame: { id: 5, result: { status: "unsubscribed" } } },
        ];
        const transcript = yield* CodexOrchestratorReplayHarness.decodeTranscript(
          makeCodexReplayTranscript({
            scenario: `running-fork-${mode}`,
            entries: [
              ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt, cwd }),
              ...(mode === "empty" ? [] : [nativeDelta(prefix)]),
              ...(["eof", "eof-final"].includes(scenario.control)
                ? [
                    { ...nativePlan, label: "after-running-fork" },
                    {
                      type: "runtime_exit" as const,
                      status: "error" as const,
                      error: "Controlled synthetic native EOF",
                    },
                  ]
                : scenario.control === "detach"
                  ? detachEntries
                  : scenario.control === "pooled"
                    ? [
                        { ...nativePlan, label: "after-running-fork" },
                        ...codexReplayPreamble({
                          nativeThreadId: peerNativeThreadId,
                          nativeTurnId: peerNativeTurnId,
                          prompt: peerPrompt,
                          cwd,
                          startRequestId: 4,
                          turnRequestId: 5,
                        }).slice(3),
                        peerDelta(peerPrefix),
                        {
                          ...nativePlan,
                          label: "peer-held",
                          frame: {
                            method: "turn/plan/updated",
                            params: {
                              threadId: peerNativeThreadId,
                              turnId: peerNativeTurnId,
                              explanation: "Peer continues",
                              plan: [{ step: "Finish peer", status: "inProgress" }],
                            },
                          },
                        },
                        ...endEntries,
                        peerDelta(peerSuffix),
                        {
                          type: "emit_inbound" as const,
                          frame: {
                            method: "turn/completed",
                            params: {
                              threadId: peerNativeThreadId,
                              turn: makeCodexReplayTurn({
                                id: peerNativeTurnId,
                                status: "completed",
                              }),
                            },
                          },
                        },
                      ]
                    : [
                        { ...nativeDelta(suffix), label: "after-running-fork" },
                        nativePlan,
                        ...(scenario.control === "replacement"
                          ? [
                              {
                                type: "emit_inbound" as const,
                                label: "before-completion",
                                frame: {
                                  method: "item/completed",
                                  params: {
                                    threadId: nativeThreadId,
                                    turnId: nativeTurnId,
                                    item: {
                                      type: "agentMessage",
                                      id: nativeItemId,
                                      text: finalText,
                                    },
                                  },
                                },
                              },
                            ]
                          : []),
                        ...endEntries
                          .slice(1)
                          .map((entry) =>
                            entry.type === "emit_inbound"
                              ? { ...entry, label: "before-completion" }
                              : entry,
                          ),
                      ]),
            ],
          }),
        );
        const gate = makeProviderReplayGate([
          "after-running-fork",
          "after-normal-frame",
          "before-completion",
          "peer-held",
        ]);
        yield* Effect.addFinalizer(() => Effect.sync(() => gate.releaseAll()));
        const received = yield* Deferred.make<void>();
        const carrierHeld = yield* Deferred.make<void>();
        const releaseCarrier = yield* Deferred.make<void>();
        const snapshotBatches: ProviderTextSnapshotBatch[] = [];
        const retiredTokens: symbol[] = [];
        const normalFrame = yield* Deferred.make<void>();
        const planCommitted = yield* Deferred.make<void>();
        yield* Effect.addFinalizer(() => Deferred.succeed(releaseCarrier, undefined));
        const peerReceived = yield* Deferred.make<void>();
        const nativeEnded = yield* Deferred.make<void>();
        const laterReceived = yield* Deferred.make<void>();
        const planQueued = yield* Deferred.make<void>();
        const releasePlan = yield* Deferred.make<void>();
        const cutoffRace = [
          "healthy",
          "complete",
          "metadata",
          "workspace",
          "resource",
          "close",
          "eof-final",
        ].includes(scenario.control);
        yield* Effect.addFinalizer(() => Deferred.succeed(releasePlan, undefined));
        const emissionHeld = yield* Deferred.make<void>();
        const releaseEmission = yield* Deferred.make<void>();
        const captureQueued = yield* Deferred.make<void>();
        const releaseCapture = yield* Deferred.make<void>();
        const expireCapture = yield* Deferred.make<void>();
        const captureCommitted = yield* Deferred.make<void>();
        const filteredItemCommitted = yield* Deferred.make<void>();
        let rawCaptureCount = 0;
        let rawCaptureFailure = "";
        yield* Effect.addFinalizer(() => Deferred.succeed(releaseCapture, undefined));
        yield* Effect.addFinalizer(() => Deferred.succeed(releaseEmission, undefined));
        const realClock = yield* Clock.Clock;
        const heldClock: Clock.Clock = {
          ...realClock,
          currentTimeMillisUnsafe: () => realClock.currentTimeMillisUnsafe(),
          currentTimeNanosUnsafe: () => realClock.currentTimeNanosUnsafe(),
          monotonicTimeNanosUnsafe: () => realClock.monotonicTimeNanosUnsafe(),
          sleep: (duration) =>
            Duration.toMillis(duration) === 50
              ? Deferred.succeed(emissionHeld, undefined).pipe(
                  Effect.andThen(Deferred.await(releaseEmission)),
                )
              : realClock.sleep(duration),
        };
        const receipts: Array<{
          method: string;
          payload: unknown;
        }> = [];
        const requests: Array<{
          method: string;
          params: unknown;
        }> = [];
        const driver = yield* CodexReplay.makeReplayDriver(transcript, {
          beforeEmitInbound: (entry) =>
            Effect.promise((signal) => gate.beforeEmit(entry.label, signal)),
        });
        let clientOpens = 0;
        const factoryLayer = Layer.succeed(CodexAdapterV2.CodexAppServerClientFactory, {
          open: (input) =>
            Effect.gen(function* () {
              clientOpens++;
              const selectedDriver =
                scenario.control === "close" && clientOpens > 1
                  ? yield* CodexReplay.makeReplayDriver(
                      makeCodexReplayTranscript({
                        scenario: "replacement-empty-runtime",
                        entries: [],
                      }),
                    )
                  : driver;
              const context = yield* Layer.build(
                CodexReplay.layerReplayWithDriver(selectedDriver, {
                  onTermination: (cause) =>
                    (input.onTermination?.(cause) ?? Effect.void).pipe(
                      Effect.andThen(Deferred.succeed(nativeEnded, undefined)),
                      Effect.asVoid,
                    ),
                }),
              ).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterOpenSessionError({
                      driver: CodexAdapterV2.CODEX_DRIVER_KIND,
                      providerSessionId: input.providerSessionId,
                      cause,
                    }),
                ),
              );
              const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
                Effect.provide(context),
              );
              return {
                ...client,
                request: (method, params) =>
                  Effect.sync(() => requests.push({ method, params })).pipe(
                    Effect.andThen(client.request(method, params)),
                  ),
                handleServerNotification: (method, handler) =>
                  client.handleServerNotification(method, (payload) =>
                    handler(payload).pipe(
                      Effect.provideService(
                        Clock.Clock,
                        method === "item/agentMessage/delta" ? heldClock : realClock,
                      ),
                      Effect.tap(() => Effect.sync(() => receipts.push({ method, payload }))),
                      Effect.tap(() =>
                        method === "item/agentMessage/delta"
                          ? Deferred.succeed(
                              Schema.is(Schema.Struct({ threadId: Schema.String }))(payload) &&
                                payload.threadId === peerNativeThreadId
                                ? peerReceived
                                : receipts.filter((r) => r.method === "item/agentMessage/delta")
                                      .length === 1
                                  ? received
                                  : laterReceived,
                              undefined,
                            )
                          : Effect.void,
                      ),
                    ),
                  ),
              } satisfies CodexClient.CodexAppServerClient["Service"];
            }),
        });
        const configMap = yield* Schema.decodeUnknownEffect(ProviderInstanceConfigMap)({
          codex: {
            driver: CodexAdapterV2.CODEX_DRIVER_KIND,
            config: { homePath: home },
            environment: [
              { name: "HOME", value: home },
              { name: "CODEX_HOME", value: home },
            ],
          },
        });
        const observedDriver: typeof CodexAdapterV2.CodexAdapterV2Driver = {
          ...CodexAdapterV2.CodexAdapterV2Driver,
          create: (input) =>
            CodexAdapterV2.CodexAdapterV2Driver.create(input).pipe(
              Effect.map((adapter) => ({
                ...adapter,
                openSession: (input) =>
                  adapter.openSession(input).pipe(
                    Effect.map((runtime) => ({
                      ...runtime,
                      ...(runtime.textSnapshots === undefined
                        ? {}
                        : {
                            textSnapshots: {
                              ...runtime.textSnapshots,
                              release: (token) =>
                                runtime
                                  .textSnapshots!.release(token)
                                  .pipe(
                                    Effect.tap(() => Effect.sync(() => retiredTokens.push(token))),
                                  ),
                              events: runtime.textSnapshots.events.pipe(
                                Stream.tap((event) => {
                                  if (
                                    event.type === "internal.text_snapshot" &&
                                    ["cancel-ordinary", "sql-ordinary"].includes(scenario.control)
                                  )
                                    return Effect.sync(() => snapshotBatches.push(event)).pipe(
                                      Effect.andThen(
                                        scenario.control === "cancel-ordinary"
                                          ? Deferred.succeed(carrierHeld, undefined).pipe(
                                              Effect.andThen(Deferred.await(releaseCarrier)),
                                            )
                                          : Effect.void,
                                      ),
                                    );
                                  if (
                                    event.type === "internal.text_snapshot" &&
                                    ["eof", "pre-delta", "detach"].includes(scenario.control)
                                  )
                                    return Deferred.succeed(carrierHeld, undefined).pipe(
                                      Effect.andThen(Deferred.await(releaseCarrier)),
                                    );
                                  if (
                                    event.type === "message.updated" &&
                                    event.message.streaming &&
                                    event.message.text === prefix + suffix
                                  )
                                    return Deferred.succeed(normalFrame, undefined).pipe(
                                      Effect.asVoid,
                                    );
                                  return Effect.void;
                                }),
                              ),
                            },
                          }),
                    })),
                  ),
              })),
            ),
        };
        const registry = makeDriverLayer({ drivers: [observedDriver], configMap }).pipe(
          Layer.provide(
            Layer.mergeAll(
              factoryLayer,
              Layer.succeed(ServerConfig.ServerConfig, config),
              allocatorLayer,
              NodeServices.layer,
            ),
          ),
        );
        const persistence = makeSqlitePersistenceLive(database).pipe(
          Layer.provide(NodeServices.layer),
        );
        const runtime = () =>
          Layer.merge(
            persistence,
            makeOrchestratorV2ReplayLayerWithRegistry(
              {
                name: `native-fork-${mode}`,
                runtimePolicyOverride: {
                  cwd,
                  approvalPolicy: "never",
                  sandboxPolicy: { type: "dangerFullAccess" },
                },
              },
              registry,
              {
                configureMcp: false,
                runEffectWorker: false,
                responseStreamingMode: scenario.streaming,
                forkAttachmentCopierLayer: Layer.effect(
                  ScientForkAttachmentCopier,
                  Effect.map(ScientForkAttachmentCopier, (copier) => ({
                    ...copier,
                    checkSources: (input) =>
                      copier
                        .checkSources(input)
                        .pipe(
                          Effect.tap(() =>
                            cutoffRace
                              ? Deferred.succeed(planQueued, undefined).pipe(
                                  Effect.andThen(Deferred.await(releasePlan)),
                                )
                              : Effect.void,
                          ),
                        ),
                  })),
                ).pipe(Layer.provide(ScientForkAttachmentCopierLive)),
                decorateEventSink: (sink) => ({
                  ...sink,
                  write: (input) =>
                    sink
                      .write(input)
                      .pipe(
                        Effect.tap(() =>
                          input.events.some(
                            (event) =>
                              event.threadId === threadId &&
                              event.type === "turn-item.updated" &&
                              event.payload.type === "assistant_message",
                          )
                            ? Deferred.succeed(filteredItemCommitted, undefined)
                            : input.events.some(
                                  (event) =>
                                    event.threadId === threadId && event.type === "plan.updated",
                                )
                              ? Deferred.succeed(planCommitted, undefined)
                              : Effect.void,
                        ),
                      ),
                  captureRunningForkText: Effect.fnUntraced(function* (input) {
                    {
                      rawCaptureCount++;
                      yield* Deferred.succeed(captureQueued, undefined);
                      yield* Deferred.await(releaseCapture);
                    }
                    const result = yield* sink.captureRunningForkText!(input).pipe(
                      Effect.tapCause((cause) =>
                        Effect.sync(() => {
                          rawCaptureFailure = Cause.pretty(cause);
                        }),
                      ),
                    );
                    yield* Deferred.succeed(captureCommitted, undefined);
                    return result;
                  }),
                }),
                serverConfigLayer: Layer.succeed(ServerConfig.ServerConfig, config),
                databaseLayer: persistence,
              },
            ),
          );
        const evidence: Record<string, unknown> = {
          mode,
          transcript,
          receipts,
          requests,
          privateHome: home,
        };
        const evidenceDirectory = process.env.SCIENT_NATIVE_FORK_EVIDENCE_DIR;
        const capture = Effect.fnUntraced(function* (phase: string, value: unknown) {
          evidence[phase] = value;
          if (evidenceDirectory !== undefined) {
            yield* fs.makeDirectory(evidenceDirectory, { recursive: true });
            yield* fs.writeFileString(
              path.join(evidenceDirectory, `${mode}.json`),
              yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(evidence),
            );
          }
        });
        const main = Effect.scoped(
          Effect.gen(function* () {
            const orchestrator = yield* OrchestratorV2;
            const worker = yield* OrchestrationEffectWorkerV2;
            const sink = yield* EventSinkV2;
            const now = yield* DateTime.now;
            yield* sink.commitProjectCommand({
              commandId: CommandId.make(`${mode}-project`),
              projectId,
              commandType: "project.created",
              acceptedAt: now,
              event: {
                eventId: EventId.make(`${mode}-project`),
                aggregateKind: "project",
                aggregateId: projectId,
                occurredAt: DateTime.formatIso(now),
                commandId: null,
                causationEventId: null,
                correlationId: null,
                metadata: {},
                type: "project.created",
                payload: {
                  projectId,
                  title: "Native running fork",
                  workspaceRoot: cwd,
                  defaultModelSelection: null,
                  scripts: [],
                  createdAt: DateTime.formatIso(now),
                  updatedAt: DateTime.formatIso(now),
                },
              },
            });
            yield* orchestrator.dispatch({
              type: "thread.create",
              commandId: CommandId.make(`${mode}-create`),
              threadId,
              projectId,
              title: "Native running fork",
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
              createdBy: "user",
              creationSource: "web",
            });
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`${mode}-send`),
              threadId,
              messageId: MessageId.make(`${mode}-prompt`),
              text: prompt,
              attachments: [],
              dispatchMode: { type: "start_immediately" },
              createdBy: "user",
              creationSource: "web",
            });
            const starting = yield* worker.drain(12).pipe(Effect.forkScoped);
            assert.isTrue(
              yield* Effect.promise(() => gate.waitForReached("after-running-fork")).pipe(
                Effect.timeout("15 seconds"),
              ),
            );
            if (mode !== "empty") {
              yield* Deferred.await(received).pipe(Effect.timeout("15 seconds"));
              yield* Deferred.await(emissionHeld).pipe(Effect.timeout("15 seconds"));
            }
            if (scenario.clean) {
              yield* Deferred.succeed(releaseEmission, undefined);
              yield* Deferred.await(filteredItemCommitted).pipe(Effect.timeout("15 seconds"));
            }
            const source = yield* waitFor(
              threadId,
              (p) =>
                p.runs[0]?.status === "running" &&
                p.providerTurns.some((turn) => turn.nativeAcceptance === "accepted"),
            );
            const sourceItem = source.turnItems.find(
              (item) =>
                item.type === "assistant_message" && item.nativeItemRef?.nativeId === nativeItemId,
            );
            {
              if (scenario.clean) {
                assert.ok(sourceItem?.type === "assistant_message");
                assert.equal(sourceItem.text, "Ready paragraph.\n\n");
              } else assert.isUndefined(sourceItem);
              assert.isFalse(source.messages.some((message) => message.text === prefix));
            }
            yield* capture("receivedRunning", source);
            const forkCommandId = CommandId.make(`${mode}-running-fork`);
            const forkEvents = yield* Stream.toPull(
              orchestrator.streamStoredEventsFrom({ threadId: forkId, afterSequence: 0 }),
            );
            const forks = yield* ConversationForkService;
            const command = {
              type: "thread.fork",
              commandId: forkCommandId,
              originThreadId: threadId,
              newThreadId: forkId,
              sourceRunningTurnId: TurnId.make(source.runs[0]!.id),
              workspaceMode: "local" as const,
            } as const;
            const sql = yield* SqlClient.SqlClient;
            const manager = yield* ProviderSessionManagerV2;
            if (scenario.control === "foreign") {
              const owner: ProviderTextSnapshotOwner = {
                threadId,
                runId: source.runs[0]!.id,
                activeAttemptId: source.attempts[0]!.id,
                rootNodeId: source.runs[0]!.rootNodeId!,
                runOrdinal: source.runs[0]!.ordinal,
                providerThreadId: source.providerThreads[0]!.id,
                nativeThreadId,
                providerTurnId: source.providerTurns[0]!.id,
                nativeTurnId,
                providerSessionId: source.providerThreads[0]!.providerSessionId!,
                providerInstanceId: modelSelection.instanceId,
                driver: source.providerThreads[0]!.driver,
              };
              for (const foreign of [
                { ...owner, nativeThreadId: "foreign-thread" },
                { ...owner, nativeTurnId: "foreign-turn" },
              ]) {
                const rejected = yield* manager.captureRunningForkText!(foreign).pipe(Effect.exit);
                assert.equal(rejected._tag, "Failure");
              }
              assert.deepEqual(
                (yield* orchestrator.getThreadProjection(threadId)).messages,
                source.messages,
              );
            }
            if (["sql", "sql-ordinary"].includes(scenario.control))
              yield* sql.unsafe(`CREATE TRIGGER reject_buffer_item BEFORE INSERT ON orchestration_events
              WHEN NEW.event_type = 'turn-item.updated' AND json_extract(NEW.payload_json, '$.type') = 'assistant_message'
              BEGIN SELECT RAISE(ABORT, 'controlled raw-item SQL failure'); END`);
            const timeoutClock: Clock.Clock = {
              ...realClock,
              currentTimeMillisUnsafe: () => realClock.currentTimeMillisUnsafe(),
              currentTimeNanosUnsafe: () => realClock.currentTimeNanosUnsafe(),
              monotonicTimeNanosUnsafe: () => realClock.monotonicTimeNanosUnsafe(),
              sleep: (duration) =>
                Duration.toMillis(duration) === 90_000
                  ? Deferred.await(expireCapture)
                  : realClock.sleep(duration),
            };
            let forking = yield* forks
              .dispatch(command)
              .pipe(
                Effect.provideService(
                  Clock.Clock,
                  scenario.control === "timeout" ? timeoutClock : realClock,
                ),
                Effect.forkScoped,
              );
            yield* Effect.raceFirst(
              Deferred.await(
                ["eof", "pre-delta", "detach", "cancel-ordinary"].includes(scenario.control)
                  ? carrierHeld
                  : captureQueued,
              ),
              Fiber.join(forking).pipe(
                Effect.andThen(Effect.die("Fork finished without the owning SQL capture signal")),
              ),
            ).pipe(Effect.timeout("15 seconds"));
            const missingChild = yield* (yield* ProjectionStoreV2)
              .getThread(forkId)
              .pipe(Effect.exit);
            assert.equal(missingChild._tag, "Failure");
            assert.isTrue(
              Option.isNone(yield* (yield* CommandReceiptStoreV2).getByCommandId(forkCommandId)),
            );
            assert.isEmpty(yield* (yield* EffectOutboxV2).listByCommandId(forkCommandId));
            const beforeSql = yield* orchestrator.getThreadProjection(threadId);
            assert.isFalse(beforeSql.messages.some((message) => message.text === prefix));
            assert.equal(beforeSql.runs[0]?.status, "running");
            if (["cancel-ordinary", "sql-ordinary"].includes(scenario.control)) {
              assert.lengthOf(snapshotBatches, 1);
              const batch = snapshotBatches[0]!;
              assert.equal(batch.owner.threadId, threadId);
              assert.equal(batch.owner.runId, source.runs[0]!.id);
              assert.equal(batch.owner.activeAttemptId, source.attempts[0]!.id);
              assert.equal(batch.owner.rootNodeId, source.runs[0]!.rootNodeId);
              assert.equal(batch.owner.runOrdinal, source.runs[0]!.ordinal);
              assert.equal(
                batch.owner.providerSessionId,
                source.providerThreads[0]!.providerSessionId,
              );
              assert.equal(batch.owner.providerInstanceId, modelSelection.instanceId);
              assert.equal(batch.owner.driver, CodexAdapterV2.CODEX_DRIVER_KIND);
              assert.equal(batch.owner.nativeThreadId, nativeThreadId);
              assert.equal(batch.owner.nativeTurnId, nativeTurnId);
              const capturedItem = batch.events.find((event) => event.type === "turn_item.updated");
              const capturedMessage = batch.events.find(
                (event) => event.type === "message.updated",
              );
              assert.ok(capturedItem?.type === "turn_item.updated");
              assert.ok(capturedItem.turnItem.type === "assistant_message");
              assert.ok(capturedMessage?.type === "message.updated");
              assert.equal(capturedItem.turnItem.text, prefix);
              assert.equal(capturedMessage.message.text, prefix);
              if (scenario.control === "cancel-ordinary") {
                yield* Fiber.interrupt(forking).pipe(Effect.timeout("15 seconds"));
                assert.include(retiredTokens, batch.token);
                assert.equal(rawCaptureCount, 0);
                yield* Deferred.succeed(releaseCarrier, undefined);
              } else {
                yield* Deferred.succeed(releaseCapture, undefined);
                const rejected = yield* Fiber.join(forking).pipe(
                  Effect.exit,
                  Effect.timeout("15 seconds"),
                );
                assert.equal(rejected._tag, "Failure");
                assert.equal(rawCaptureCount, 1);
                assert.include(rawCaptureFailure, "controlled raw-item SQL failure");
                yield* capture("rawSqlRefused", { rawCaptureFailure });
                const rolledBack = yield* orchestrator.getThreadProjection(threadId);
                assert.deepEqual(rolledBack.messages, source.messages);
                assert.deepEqual(rolledBack.turnItems, source.turnItems);
                yield* sql.unsafe("DROP TRIGGER reject_buffer_item");
              }
              assert.isFalse(yield* Deferred.isDone(captureCommitted));
              // Only the original scheduled flush may deliver this prefix. Native suffix,
              // terminal frames and a second snapshot remain excluded until SQL proves it.
              yield* Deferred.succeed(releaseEmission, undefined);
              const ordinary = yield* waitFor(threadId, (p) =>
                p.turnItems.some(
                  (item) =>
                    item.id === capturedItem.turnItem.id &&
                    item.type === "assistant_message" &&
                    item.text === prefix,
                ),
              ).pipe(
                Effect.onExit((exit) =>
                  capture("ordinaryWaitExit", {
                    tag: exit._tag,
                    rawCaptureCount,
                    retired: retiredTokens.includes(batch.token),
                    snapshotCount: snapshotBatches.length,
                  }).pipe(
                    Effect.andThen(
                      Effect.gen(function* () {
                        yield* capture(
                          "ordinaryWaitState",
                          yield* orchestrator.getThreadProjection(threadId),
                        );
                        yield* capture(
                          "ordinaryWaitEvents",
                          yield* (yield* EventStoreV2).read({}).pipe(Stream.runCollect),
                        );
                        yield* capture("ordinaryWaitReceipts", [...receipts]);
                      }),
                    ),
                  ),
                ),
              );
              const item = ordinary.turnItems.find((item) => item.id === capturedItem.turnItem.id);
              const message = ordinary.messages.find(
                (message) => message.id === capturedMessage.message.id,
              );
              assert.ok(item?.type === "assistant_message");
              assert.ok(message);
              assert.equal(item.messageId, message.id);
              assert.equal(item.nodeId, capturedItem.turnItem.nodeId);
              assert.equal(item.status, "running");
              assert.isTrue(item.streaming);
              assert.equal(message.text, prefix);
              assert.isTrue(message.streaming);
              assert.deepEqual(ordinary.runs, source.runs);
              assert.deepEqual(ordinary.attempts, source.attempts);
              assert.deepEqual(ordinary.providerThreads, source.providerThreads);
              assert.deepEqual(ordinary.providerTurns, source.providerTurns);
              assert.equal(item.runId, batch.owner.runId);
              assert.equal(item.providerThreadId, batch.owner.providerThreadId);
              assert.equal(item.providerTurnId, batch.owner.providerTurnId);
              assert.deepEqual(item.nativeItemRef, capturedItem.turnItem.nativeItemRef);
              assert.lengthOf(
                ordinary.messages.filter((m) => m.id === message.id),
                1,
              );
              assert.lengthOf(
                ordinary.turnItems.filter((i) => i.id === item.id),
                1,
              );
              assert.equal(rawCaptureCount, scenario.control === "cancel-ordinary" ? 0 : 1);
              assert.lengthOf(snapshotBatches, 1);
              assert.isFalse(yield* Deferred.isDone(captureCommitted));
              assert.equal(
                receipts.filter((r) => r.method === "item/agentMessage/delta").length,
                1,
              );
              assert.isFalse(
                receipts.some(
                  (r) => r.method === "item/completed" || r.method === "turn/completed",
                ),
              );
              assert.equal(
                (yield* (yield* ProjectionStoreV2).getThread(forkId).pipe(Effect.exit))._tag,
                "Failure",
              );
              assert.isTrue(
                Option.isNone(yield* (yield* CommandReceiptStoreV2).getByCommandId(forkCommandId)),
              );
              assert.isEmpty(yield* (yield* EffectOutboxV2).listByCommandId(forkCommandId));
              yield* capture("ordinaryWithoutRecapture", ordinary);
              gate.releaseAll();
              yield* Fiber.join(starting);
              yield* waitFor(threadId, (p) =>
                p.providerTurns.some((turn) => turn.status === "completed"),
              );
              yield* worker.drain(12);
              const completed = yield* waitFor(threadId, (p) => p.runs[0]?.status === "completed");
              const finalItem = completed.turnItems.find((i) => i.id === item.id);
              assert.ok(finalItem?.type === "assistant_message");
              assert.equal(finalItem.text, finalText);
              assert.equal(finalItem.status, "completed");
              assert.isFalse(finalItem.streaming);
              assert.equal(completed.messages.find((m) => m.id === message.id)?.text, finalText);
              assert.lengthOf(
                completed.messages.filter((m) => m.id === message.id),
                1,
              );
              assert.lengthOf(
                completed.turnItems.filter((i) => i.id === item.id),
                1,
              );
              const stored = yield* (yield* EventStoreV2).read({}).pipe(Stream.runCollect);
              assert.lengthOf(
                stored.filter(
                  ({ event }) =>
                    event.threadId === threadId &&
                    event.type === "turn-item.updated" &&
                    event.payload.id === item.id &&
                    event.payload.type === "assistant_message" &&
                    !event.payload.streaming,
                ),
                1,
              );
              yield* capture("completedSource", completed);
              yield* capture("storedEvents", stored);
              assert.isFalse(yield* Deferred.isDone(captureCommitted));
              assert.equal(rawCaptureCount, scenario.control === "cancel-ordinary" ? 0 : 1);
              assert.lengthOf(snapshotBatches, 1);
              yield* manager.closeInstance(modelSelection.instanceId);
              return { frozen: null, completed: yield* orchestrator.getThreadProjection(threadId) };
            }
            if (scenario.control === "pre-delta") {
              gate.release("after-running-fork");
              yield* Deferred.await(laterReceived).pipe(Effect.timeout("15 seconds"));
              yield* Deferred.succeed(releaseCarrier, undefined);
              const rejected = yield* Fiber.join(forking).pipe(
                Effect.exit,
                Effect.timeout("15 seconds"),
              );
              assert.equal(rejected._tag, "Failure");
              assert.equal(rawCaptureCount, 0);
              assert.deepEqual(
                (yield* orchestrator.getThreadProjection(threadId)).messages,
                source.messages,
              );
              assert.equal(
                (yield* (yield* ProjectionStoreV2).getThread(forkId).pipe(Effect.exit))._tag,
                "Failure",
              );
              assert.isTrue(
                Option.isNone(yield* (yield* CommandReceiptStoreV2).getByCommandId(forkCommandId)),
              );
              assert.isEmpty(yield* (yield* EffectOutboxV2).listByCommandId(forkCommandId));
              yield* Deferred.succeed(releaseEmission, undefined);
              gate.releaseAll();
              yield* Fiber.join(starting);
              yield* waitFor(threadId, (p) =>
                p.providerTurns.some((turn) => turn.status === "completed"),
              );
              yield* worker.drain(12);
              const completed = yield* waitFor(threadId, (p) => p.runs[0]?.status === "completed");
              assert.isTrue(completed.messages.some((message) => message.text === prefix + suffix));
              yield* capture("preAckRefusal", completed);
              yield* manager.closeInstance(modelSelection.instanceId);
              return { frozen: null, completed: yield* orchestrator.getThreadProjection(threadId) };
            }
            if (scenario.control === "detach") {
              gate.releaseAll();
              yield* manager
                .detach({
                  providerSessionId: source.providerThreads[0]!.providerSessionId!,
                  threadId,
                })
                .pipe(Effect.timeout("15 seconds"));
              const rejected = yield* Fiber.join(forking).pipe(
                Effect.exit,
                Effect.timeout("15 seconds"),
              );
              assert.equal(rejected._tag, "Failure");
              assert.equal(rawCaptureCount, 0);
              assert.equal(clientOpens, 1);
              assert.equal(
                requests.filter((request) => request.method === "turn/interrupt").length,
                1,
              );
              assert.equal(
                requests.filter((request) => request.method === "thread/unsubscribe").length,
                1,
              );
              assert.equal(
                (yield* (yield* ProjectionStoreV2).getThread(forkId).pipe(Effect.exit))._tag,
                "Failure",
              );
              assert.isTrue(
                Option.isNone(yield* (yield* CommandReceiptStoreV2).getByCommandId(forkCommandId)),
              );
              assert.isEmpty(yield* (yield* EffectOutboxV2).listByCommandId(forkCommandId));
              yield* capture("detachedOwner", {
                source: yield* orchestrator.getThreadProjection(threadId),
                replay: yield* Ref.get(driver.state),
              });
              yield* Deferred.succeed(releaseCarrier, undefined);
              yield* Deferred.succeed(releaseEmission, undefined);
              yield* Fiber.join(starting);
              yield* waitFor(threadId, (p) =>
                p.providerTurns.some((turn) => turn.status === "interrupted"),
              );
              yield* worker.drain(12);
              yield* manager.closeInstance(modelSelection.instanceId);
              return { frozen: null, completed: yield* orchestrator.getThreadProjection(threadId) };
            }
            if (scenario.control === "eof") {
              gate.releaseAll();
              const rejected = yield* Fiber.join(forking).pipe(
                Effect.exit,
                Effect.timeout("15 seconds"),
                Effect.onExit((exit) =>
                  Effect.gen(function* () {
                    yield* capture("eofWaitExit", {
                      waitExit: exit._tag,
                      rawCaptureCount,
                      receipts: [...receipts],
                    });
                    yield* capture("eofWaitState", {
                      replay: yield* Ref.get(driver.state),
                      source: yield* orchestrator.getThreadProjection(threadId),
                      childLookup: (yield* (yield* ProjectionStoreV2)
                        .getThread(forkId)
                        .pipe(Effect.exit))._tag,
                      receipt: yield* (yield* CommandReceiptStoreV2).getByCommandId(forkCommandId),
                      outbox: yield* (yield* EffectOutboxV2).listByCommandId(forkCommandId),
                    });
                  }),
                ),
              );
              assert.equal(rejected._tag, "Failure");
              assert.equal(rawCaptureCount, 0);
              yield* Deferred.succeed(releaseCarrier, undefined);
              assert.equal(
                (yield* (yield* ProjectionStoreV2).getThread(forkId).pipe(Effect.exit))._tag,
                "Failure",
              );
              assert.isTrue(
                Option.isNone(yield* (yield* CommandReceiptStoreV2).getByCommandId(forkCommandId)),
              );
              assert.isEmpty(yield* (yield* EffectOutboxV2).listByCommandId(forkCommandId));
              yield* capture("nativeEof", {
                source: yield* orchestrator.getThreadProjection(threadId),
                replay: yield* Ref.get(driver.state),
              });
              yield* manager.closeInstance(modelSelection.instanceId);
              return { frozen: null, completed: yield* orchestrator.getThreadProjection(threadId) };
            }
            if (scenario.control === "stop") {
              yield* orchestrator.dispatch({
                type: "run.interrupt",
                threadId,
                runId: source.runs[0]!.id,
                holdQueue: true,
                commandId: CommandId.make(`${mode}-stop`),
              });
              assert.isTrue(
                (yield* orchestrator.getThreadProjection(threadId)).turnItems.some(
                  (item) =>
                    item.runId === source.runs[0]!.id && item.type === "run_interrupt_request",
                ),
              );
            }
            if (scenario.control === "cancel" || scenario.control === "timeout") {
              yield* capture("beforeCancel", { rawCaptureCount });
              if (scenario.control === "cancel")
                yield* Fiber.interrupt(forking).pipe(Effect.timeout("15 seconds"));
              else {
                yield* Deferred.succeed(expireCapture, undefined);
                const refused = yield* Fiber.join(forking).pipe(
                  Effect.exit,
                  Effect.timeout("15 seconds"),
                );
                assert.equal(refused._tag, "Failure");
                if (refused._tag === "Failure") {
                  const error = Cause.findErrorOption(refused.cause);
                  assert.isTrue(Option.isSome(error));
                  if (Option.isSome(error))
                    assert.deepInclude(error.value, { forkDisposition: "rejected" });
                }
                assert.equal(
                  (yield* orchestrator.getThreadProjection(threadId)).runs[0]?.status,
                  "running",
                );
              }
              yield* capture("afterCancel", { rawCaptureCount });
              assert.isTrue(
                Option.isNone(yield* (yield* CommandReceiptStoreV2).getByCommandId(forkCommandId)),
              );
            }
            yield* Deferred.succeed(releaseCapture, undefined);
            if (scenario.control === "stop") {
              const rejected = yield* Fiber.join(forking).pipe(
                Effect.exit,
                Effect.timeout("15 seconds"),
              );
              assert.equal(rejected._tag, "Failure");
              const refused = yield* orchestrator.getThreadProjection(threadId);
              assert.deepEqual(refused.messages, source.messages);
              assert.isFalse(
                refused.turnItems.some(
                  (item) => item.type === "assistant_message" && item.text === prefix,
                ),
              );
              assert.equal(
                (yield* (yield* ProjectionStoreV2).getThread(forkId).pipe(Effect.exit))._tag,
                "Failure",
              );
              assert.isTrue(
                Option.isNone(yield* (yield* CommandReceiptStoreV2).getByCommandId(forkCommandId)),
              );
              assert.isEmpty(yield* (yield* EffectOutboxV2).listByCommandId(forkCommandId));
              yield* Deferred.succeed(releaseEmission, undefined);
              gate.releaseAll();
              yield* Fiber.join(starting);
              yield* waitFor(threadId, (p) =>
                p.providerTurns.some((turn) => turn.status === "completed"),
              );
              yield* worker.drain(12);
              const ended = yield* waitFor(threadId, (p) => p.runs[0]?.status === "completed");
              yield* capture("durableStopRefusal", ended);
              yield* manager.closeInstance(modelSelection.instanceId);
              return { frozen: null, completed: yield* orchestrator.getThreadProjection(threadId) };
            }
            if (scenario.control === "sql") {
              const rejected = yield* Fiber.join(forking).pipe(Effect.exit);
              assert.equal(rejected._tag, "Failure");
              const rolledBack = yield* orchestrator.getThreadProjection(threadId);
              assert.deepEqual(rolledBack.messages, source.messages);
              assert.deepEqual(rolledBack.turnItems, source.turnItems);
              assert.deepEqual(rolledBack.nodes, source.nodes);
              assert.isTrue(
                Option.isNone(yield* (yield* CommandReceiptStoreV2).getByCommandId(forkCommandId)),
              );
              assert.isEmpty(yield* (yield* EffectOutboxV2).listByCommandId(forkCommandId));
              yield* sql.unsafe("DROP TRIGGER reject_buffer_item");
              forking = yield* forks.dispatch(command).pipe(Effect.forkScoped);
            }
            if (scenario.control === "cancel" || scenario.control === "timeout") {
              yield* Deferred.await(captureCommitted).pipe(Effect.timeout("15 seconds"));
              assert.equal(
                (yield* (yield* ProjectionStoreV2).getThread(forkId).pipe(Effect.exit))._tag,
                "Failure",
              );
              forking = yield* forks.dispatch(command).pipe(Effect.forkScoped);
            }
            yield* Deferred.await(captureCommitted).pipe(Effect.timeout("15 seconds"));
            if (cutoffRace) {
              // Slow planning owns command locks, but no native/manager/coalescer fence.
              yield* Effect.raceFirst(
                Deferred.await(planQueued),
                Fiber.join(forking).pipe(
                  Effect.andThen(Effect.die("Fork finished before the controlled plan race")),
                ),
              ).pipe(Effect.timeout("15 seconds"));
              const captured = yield* orchestrator.getThreadProjection(threadId);
              assert.isTrue(captured.messages.some((message) => message.text === prefix));
              const cutoff = yield* sink.latestSequence({ threadId });
              if (scenario.control === "metadata") {
                const timestamp = yield* DateTime.now;
                yield* sink.write({
                  events: [
                    {
                      id: EventId.make(`${mode}-title`),
                      type: "thread.metadata-updated",
                      threadId,
                      occurredAt: timestamp,
                      payload: {
                        ...captured.thread,
                        rollbackRequestId: CommandId.make(`${mode}-rollback`),
                        updatedAt: timestamp,
                      },
                    },
                  ],
                });
                assert.isAbove(yield* sink.latestSequence({ threadId }), cutoff);
              } else if (scenario.control === "workspace") {
                const timestamp = yield* DateTime.now;
                yield* sink.write({
                  events: [
                    {
                      id: EventId.make(`${mode}-workspace`),
                      type: "thread.metadata-updated",
                      threadId,
                      occurredAt: timestamp,
                      payload: {
                        ...captured.thread,
                        branch: "changed-captured-workspace",
                        updatedAt: timestamp,
                      },
                    },
                  ],
                });
                assert.equal(
                  (yield* orchestrator.getThreadProjection(threadId)).thread.branch,
                  "changed-captured-workspace",
                );
              } else if (scenario.control === "close") {
                const old = yield* manager.get(source.providerThreads[0]!.providerSessionId!);
                assert.ok(Option.isSome(old));
                yield* manager.closeInstance(modelSelection.instanceId);
                const replacement = yield* manager.open({
                  threadId,
                  providerSessionId: source.providerThreads[0]!.providerSessionId!,
                  modelSelection,
                  runtimePolicy: {
                    cwd,
                    runtimeMode: "full-access",
                    interactionMode: "default",
                    approvalPolicy: "never",
                    sandboxPolicy: { type: "dangerFullAccess" },
                  },
                });
                assert.equal(replacement.providerSessionId, old.value.providerSessionId);
                assert.notStrictEqual(replacement, old.value);
                assert.equal(clientOpens, 2);
              } else if (scenario.control === "eof-final") {
                gate.release("after-running-fork");
                yield* Deferred.await(nativeEnded).pipe(Effect.timeout("15 seconds"));
                const sdkState = yield* Ref.get(driver.state);
                assert.instanceOf(
                  sdkState.failure,
                  CodexReplay.CodexAppServerReplayRuntimeExitError,
                );
                yield* capture("terminatedAfterAck", sdkState);
              } else if (scenario.control === "resource") {
                yield* fs.rename(cwd, cwd + "-retired");
              } else {
                gate.release("after-running-fork");
                yield* Deferred.await(laterReceived).pipe(Effect.timeout("15 seconds"));
                if (scenario.control === "complete") {
                  yield* Deferred.succeed(releaseEmission, undefined);
                  gate.release("after-normal-frame");
                  gate.release("before-completion");
                  yield* waitFor(threadId, (p) =>
                    p.providerTurns.some((turn) => turn.status === "completed"),
                  );
                } else {
                  yield* Deferred.succeed(releaseEmission, undefined);
                  yield* Deferred.await(normalFrame).pipe(Effect.timeout("15 seconds"));
                  gate.release("after-normal-frame");
                  yield* Deferred.await(planCommitted).pipe(Effect.timeout("15 seconds"));
                  const advanced = yield* orchestrator.getThreadProjection(threadId);
                  assert.isTrue(
                    advanced.messages.some((message) => message.text === prefix + suffix),
                  );
                  assert.isAbove(yield* sink.latestSequence({ threadId }), cutoff);
                }
              }
              yield* Deferred.succeed(releasePlan, undefined);
              if (scenario.control !== "healthy") {
                const rejected = yield* Fiber.join(forking).pipe(Effect.exit);
                assert.equal(rejected._tag, "Failure");
                if (scenario.control === "resource") yield* fs.rename(cwd + "-retired", cwd);
                assert.equal(
                  (yield* (yield* ProjectionStoreV2).getThread(forkId).pipe(Effect.exit))._tag,
                  "Failure",
                );
                assert.isTrue(
                  Option.isNone(
                    yield* (yield* CommandReceiptStoreV2).getByCommandId(forkCommandId),
                  ),
                );
                assert.isEmpty(yield* (yield* EffectOutboxV2).listByCommandId(forkCommandId));
                if (["close", "eof-final"].includes(scenario.control)) {
                  assert.isTrue(
                    (yield* orchestrator.getThreadProjection(threadId)).messages.some(
                      (message) => message.text === prefix,
                    ),
                  );
                  yield* capture(
                    "generationRefusal",
                    yield* orchestrator.getThreadProjection(threadId),
                  );
                  yield* manager.closeInstance(modelSelection.instanceId);
                  return {
                    frozen: null,
                    completed: yield* orchestrator.getThreadProjection(threadId),
                  };
                }
                yield* Deferred.succeed(releaseEmission, undefined);
                gate.releaseAll();
                yield* Fiber.join(starting);
                yield* waitFor(threadId, (p) =>
                  p.providerTurns.some((turn) => turn.status === "completed"),
                );
                yield* worker.drain(12);
                const completed = yield* waitFor(
                  threadId,
                  (p) => p.runs[0]?.status === "completed",
                );
                const answer = completed.turnItems.find(
                  (item) =>
                    item.type === "assistant_message" &&
                    item.nativeItemRef?.nativeId === nativeItemId,
                );
                assert.ok(answer?.type === "assistant_message");
                assert.equal(answer.text, finalText);
                assert.equal(answer.status, "completed");
                assert.isFalse(answer.streaming);
                assert.lengthOf(completed.runs, 1);
                assert.lengthOf(completed.providerTurns, 1);
                assert.lengthOf(
                  completed.messages.filter((message) => message.id === answer.messageId),
                  1,
                );
                const stored = yield* (yield* EventStoreV2).read({}).pipe(Stream.runCollect);
                const rebuilt = yield* Effect.gen(function* () {
                  const store = yield* ProjectionStoreV2;
                  for (const row of stored) yield* store.apply(row.event);
                  assert.equal((yield* store.getThread(forkId).pipe(Effect.exit))._tag, "Failure");
                  return yield* store.getThreadProjection(threadId);
                }).pipe(Effect.provide(layerMemory));
                assert.deepEqual(rebuilt.messages, completed.messages);
                assert.deepEqual(rebuilt.turnItems, completed.turnItems);
                yield* capture("refusedAfterCapture", { completed, stored });
                yield* manager.closeInstance(modelSelection.instanceId);
                return {
                  frozen: null,
                  completed: yield* orchestrator.getThreadProjection(threadId),
                };
              }
            }
            yield* Stream.fromPull(Effect.succeed(forkEvents)).pipe(
              Stream.filter((event) => event.event.type === "thread.created"),
              Stream.runHead,
              Effect.timeout("15 seconds"),
            );
            assert.isTrue(
              (yield* (yield* EffectOutboxV2).listByCommandId(forkCommandId)).some(
                (entry) =>
                  entry.request.type === "scient-fork.provision" && entry.status === "pending",
              ),
            );
            yield* worker.drain(12);
            yield* Fiber.join(forking);
            const frozen = yield* orchestrator.getThreadProjection(forkId);
            assert.equal(frozen.thread.conversationFork?.status, "ready");
            const capturesBeforeReplay = rawCaptureCount;
            const accepted = yield* forks.dispatch(command);
            const acceptedReceipt = yield* (yield* CommandReceiptStoreV2).getByCommandId(
              forkCommandId,
            );
            assert.ok(Option.isSome(acceptedReceipt));
            assert.equal(accepted.sequence, acceptedReceipt.value.resultSequence);
            assert.equal(rawCaptureCount, capturesBeforeReplay);
            assert.deepEqual(yield* orchestrator.getThreadProjection(forkId), frozen);
            assert.isEmpty(frozen.runs);
            assert.isEmpty(frozen.providerTurns);
            assert.isEmpty(frozen.providerThreads);
            assert.equal(frozen.thread.lineage.parentThreadId, threadId);
            const stillRunning = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(stillRunning.runs[0]?.status, "running");
            assert.equal(stillRunning.runs[0]?.id, source.runs[0]!.id);
            assert.deepEqual(
              stillRunning.providerThreads[0]?.nativeThreadRef,
              source.providerThreads[0]?.nativeThreadRef,
            );
            yield* capture("frozenChild", frozen);
            yield* capture("sourceAfterFork", stillRunning);
            if (mode !== "empty") {
              const capturedItem = stillRunning.turnItems.find(
                (item) =>
                  item.type === "assistant_message" &&
                  item.nativeItemRef?.nativeId === nativeItemId,
              );
              assert.ok(capturedItem?.type === "assistant_message");
              assert.equal(
                capturedItem.text,
                scenario.control === "healthy" ? prefix + suffix : prefix,
              );
              assert.isTrue(capturedItem.streaming);
              assert.equal(capturedItem.status, "running");
              assert.equal(capturedItem.providerTurnId, source.providerTurns[0]!.id);
              assert.equal(
                stillRunning.messages.find((message) => message.id === capturedItem.messageId)
                  ?.text,
                scenario.control === "healthy" ? prefix + suffix : prefix,
              );
              assert.equal(
                frozen.turnItems.filter(
                  (item) => item.type === "assistant_message" && item.text === prefix,
                ).length,
                1,
              );
            } else {
              assert.isFalse(
                stillRunning.turnItems.some((item) => item.type === "assistant_message"),
              );
              assert.isFalse(frozen.turnItems.some((item) => item.type === "assistant_message"));
              assert.deepEqual(
                frozen.messages.map((message) => message.text),
                [prompt],
              );
            }
            if (scenario.control === "pooled") {
              gate.release("after-running-fork");
              yield* orchestrator.dispatch({
                type: "thread.create",
                commandId: CommandId.make(`${mode}-peer-create`),
                threadId: peerId,
                projectId,
                title: "Independent peer",
                modelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: null,
                createdBy: "user",
                creationSource: "web",
              });
              yield* orchestrator.dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(`${mode}-peer-send`),
                threadId: peerId,
                messageId: MessageId.make(`${mode}-peer-prompt`),
                text: peerPrompt,
                attachments: [],
                dispatchMode: { type: "start_immediately" },
                createdBy: "user",
                creationSource: "web",
              });
              const peerStarting = yield* worker.drain(12).pipe(Effect.forkScoped);
              assert.isTrue(
                yield* Effect.promise(() => gate.waitForReached("peer-held")).pipe(
                  Effect.timeout("15 seconds"),
                ),
              );
              yield* Deferred.await(peerReceived).pipe(Effect.timeout("15 seconds"));
              const peer = yield* waitFor(
                peerId,
                (p) =>
                  p.runs[0]?.status === "running" &&
                  p.providerTurns.some((turn) => turn.nativeAcceptance === "accepted"),
              );
              assert.equal(
                peer.providerThreads[0]?.providerSessionId,
                source.providerThreads[0]?.providerSessionId,
              );
              assert.notEqual(peer.providerThreads[0]?.nativeThreadRef?.nativeId, nativeThreadId);
              assert.equal(clientOpens, 1);
              const beforePeerCapture = yield* orchestrator.getThreadProjection(threadId);
              const peerCommand = {
                type: "thread.fork",
                commandId: CommandId.make(`${mode}-peer-fork`),
                originThreadId: peerId,
                newThreadId: peerForkId,
                sourceRunningRunId: peer.runs[0]!.id,
                workspaceMode: "local",
              } as const;
              const peerEvents = yield* Stream.toPull(
                orchestrator.streamStoredEventsFrom({ threadId: peerForkId, afterSequence: 0 }),
              );
              const peerForking = yield* forks.dispatch(peerCommand).pipe(Effect.forkScoped);
              yield* Stream.fromPull(Effect.succeed(peerEvents)).pipe(
                Stream.filter((event) => event.event.type === "thread.created"),
                Stream.runHead,
                Effect.timeout("15 seconds"),
              );
              const sourceAfterPeer = yield* orchestrator.getThreadProjection(threadId);
              assert.deepEqual(sourceAfterPeer.messages, beforePeerCapture.messages);
              assert.deepEqual(sourceAfterPeer.turnItems, beforePeerCapture.turnItems);
              const peerAfterCapture = yield* orchestrator.getThreadProjection(peerId);
              assert.isTrue(
                peerAfterCapture.messages.some((message) => message.text === peerPrefix),
              );
              assert.isFalse(peerAfterCapture.messages.some((message) => message.text === prefix));
              yield* worker.drain(12);
              yield* Fiber.join(peerForking);
              const peerChild = yield* orchestrator.getThreadProjection(peerForkId);
              assert.isTrue(peerChild.messages.some((message) => message.text === peerPrefix));
              assert.isFalse(peerChild.messages.some((message) => message.text === prefix));
              assert.isFalse(frozen.messages.some((message) => message.text === peerPrefix));
              assert.deepEqual(yield* orchestrator.getThreadProjection(forkId), frozen);
              yield* capture("pooledCapture", {
                source: sourceAfterPeer,
                peer: peerAfterCapture,
                peerChild,
              });
              // Keep this root alive until both snapshots are acknowledged.
              gate.release("peer-held");
              yield* Fiber.join(peerStarting);
            }
            {
              yield* Deferred.succeed(releaseEmission, undefined);
              // Real later turn/completed, rather than a supplied final-text replacement,
              // must finish the received prefix plus subsequent native delta exactly once.
            }
            if (scenario.mode === "block" || scenario.control === "replacement") {
              const capturedItem = stillRunning.turnItems.find(
                (item) =>
                  item.type === "assistant_message" &&
                  item.nativeItemRef?.nativeId === nativeItemId,
              );
              assert.ok(capturedItem?.type === "assistant_message");
              gate.release("after-running-fork");
              yield* Deferred.await(laterReceived).pipe(Effect.timeout("15 seconds"));
              yield* Deferred.await(normalFrame).pipe(Effect.timeout("15 seconds"));
              // The next native plan is a FIFO consumer/SQL barrier after the ordinary
              // coalescer frame. It cannot acknowledge raw snapshot ingestion.
              gate.release("after-normal-frame");
              yield* Deferred.await(planCommitted).pipe(Effect.timeout("15 seconds"));
              const beforeFinal = yield* orchestrator.getThreadProjection(threadId);
              assert.equal(
                beforeFinal.turnItems.find((item) => item.id === capturedItem.id)?.type,
                "assistant_message",
              );
              const heldItem = beforeFinal.turnItems.find((item) => item.id === capturedItem.id);
              assert.ok(heldItem?.type === "assistant_message");
              assert.equal(heldItem.text, prefix);
              assert.equal(
                beforeFinal.messages.find((message) => message.id === capturedItem.messageId)?.text,
                prefix,
              );
            }
            gate.releaseAll();
            yield* waitFor(threadId, (p) =>
              p.providerTurns.some((turn) => turn.status === "completed"),
            );
            yield* Fiber.join(starting);
            yield* worker.drain(12);
            const completed = yield* waitFor(threadId, (p) => p.runs[0]?.status === "completed");
            assert.lengthOf(completed.runs, 1);
            assert.lengthOf(completed.providerTurns, 1);
            assert.equal(completed.runs[0]?.id, source.runs[0]!.id);
            assert.deepEqual(
              completed.providerTurns[0]?.nativeTurnRef,
              source.providerTurns[0]?.nativeTurnRef,
            );
            assert.deepEqual(
              completed.providerThreads[0]?.nativeThreadRef,
              source.providerThreads[0]?.nativeThreadRef,
            );
            const answer = completed.turnItems.find(
              (item) =>
                item.type === "assistant_message" && item.nativeItemRef?.nativeId === nativeItemId,
            );
            assert.ok(answer?.type === "assistant_message");
            assert.equal(answer.status, "completed");
            assert.isFalse(answer.streaming);
            assert.equal(answer.runId, source.runs[0]!.id);
            assert.lengthOf(
              completed.messages.filter((message) => message.id === answer.messageId),
              1,
            );
            {
              assert.equal(answer.text, finalText);
              assert.lengthOf(
                completed.turnItems.filter(
                  (item) =>
                    item.type === "assistant_message" &&
                    item.nativeItemRef?.nativeId === nativeItemId,
                ),
                1,
              );
            }
            if (scenario.control === "pooled") {
              const peerCompleted = yield* waitFor(
                peerId,
                (p) => p.runs[0]?.status === "completed",
              );
              assert.lengthOf(peerCompleted.runs, 1);
              assert.lengthOf(peerCompleted.providerTurns, 1);
              assert.lengthOf(
                peerCompleted.messages.filter(
                  (message) => message.text === peerPrefix + peerSuffix,
                ),
                1,
              );
              assert.equal(
                (yield* orchestrator.getThreadProjection(peerForkId)).messages.filter(
                  (message) => message.text === peerPrefix,
                ).length,
                1,
              );
              yield* capture("pooledCompletion", peerCompleted);
            }
            assert.deepEqual(yield* orchestrator.getThreadProjection(forkId), frozen);
            yield* capture("completedSource", completed);
            yield* capture("replayDriver", yield* Ref.get(driver.state));
            const stored = yield* (yield* EventStoreV2).read({}).pipe(Stream.runCollect);
            yield* capture("storedEvents", stored);
            const rebuilt = yield* Effect.gen(function* () {
              const store = yield* ProjectionStoreV2;
              for (const row of stored) yield* store.apply(row.event);
              if (scenario.control === "pooled") {
                assert.equal(
                  (yield* store.getThreadProjection(peerForkId)).messages.filter(
                    (message) => message.text === peerPrefix,
                  ).length,
                  1,
                );
                assert.equal(
                  (yield* store.getThreadProjection(peerId)).messages.filter(
                    (message) => message.text === peerPrefix + peerSuffix,
                  ).length,
                  1,
                );
              }
              return {
                source: yield* store.getThreadProjection(threadId),
                child: yield* store.getThreadProjection(forkId),
              };
            }).pipe(Effect.provide(layerMemory));
            assert.deepEqual(rebuilt.source.messages, completed.messages);
            assert.deepEqual(rebuilt.source.turnItems, completed.turnItems);
            assert.deepEqual(rebuilt.child.messages, frozen.messages);
            assert.deepEqual(rebuilt.child.turnItems, frozen.turnItems);
            yield* capture("rebuilt", rebuilt);
            yield* (yield* ProviderSessionManagerV2).closeInstance(modelSelection.instanceId);
            const closed = yield* orchestrator.getThreadProjection(threadId);
            yield* capture("closedSource", closed);
            return { frozen, completed: closed };
          }).pipe(Effect.provide(runtime())),
        );
        const finished = yield* main.pipe(Effect.exit);
        if (finished._tag === "Success") {
          yield* Effect.scoped(
            Effect.gen(function* () {
              const store = yield* ProjectionStoreV2;
              const source = yield* store.getThreadProjection(threadId);
              assert.deepEqual(source, finished.value.completed);
              if (scenario.control === "pooled") {
                assert.equal(
                  (yield* store.getThreadProjection(peerForkId)).messages.filter(
                    (message) => message.text === peerPrefix,
                  ).length,
                  1,
                );
                assert.equal(
                  (yield* store.getThreadProjection(peerId)).messages.filter(
                    (message) => message.text === peerPrefix + peerSuffix,
                  ).length,
                  1,
                );
              }
              if (finished.value.frozen !== null) {
                const child = yield* store.getThreadProjection(forkId);
                assert.deepEqual(child, finished.value.frozen);
                yield* capture("reopenedSql", { source, child });
              } else {
                assert.equal((yield* store.getThread(forkId).pipe(Effect.exit))._tag, "Failure");
                yield* capture("reopenedSql", { source, child: null });
              }
            }).pipe(Effect.provide(runtime())),
          );
        }
        yield* capture("testExit", { tag: finished._tag });
        if (evidenceDirectory !== undefined && (yield* fs.exists(database))) {
          yield* fs.copy(database, path.join(evidenceDirectory, `${mode}.sqlite`));
        }
        if (finished._tag === "Failure") return yield* Effect.failCause(finished.cause);
        if (finished.value.frozen !== null && mode !== "empty") {
          const copied = finished.value.frozen.turnItems.find(
            (item) => item.type === "assistant_message" && item.text === prefix,
          );
          assert.ok(
            copied?.type === "assistant_message",
            "Public running fork must freeze the already-received coalescer-held prefix",
          );
          assert.equal(copied.inheritedFrom?.runId, finished.value.completed.runs[0]!.id);
        }
      }).pipe(Effect.provide(NodeServices.layer)),
    ),
  );
}
