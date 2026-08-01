import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId, type ProviderKind, type ProviderRuntimeEvent } from "@synara/contracts";
import { Deferred, Effect, Exit, Fiber, Layer, Option, Queue, Scope, Stream } from "effect";
import * as EffectAcpErrors from "effect-acp/errors";

import { ServerConfig, type ServerConfigShape } from "../../config.ts";
import type {
  AcpSessionRuntimeShape,
  AcpSessionRuntimeStartResult,
} from "../acp/AcpSessionRuntime.ts";
import type { AcpParsedSessionEvent } from "../acp/AcpRuntimeModel.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

export type TestAcpSessionRuntimeFactory = (
  input: unknown,
) => Effect.Effect<AcpSessionRuntimeShape, EffectAcpErrors.AcpError, Scope.Scope>;

const TEST_CONFIG: ServerConfigShape = {
  mode: "web",
  port: 0,
  host: undefined,
  cwd: "/tmp",
  homeDir: "/tmp",
  chatWorkspaceRoot: "/tmp/chat",
  studioWorkspaceRoot: "/tmp/studio",
  baseDir: "/tmp/scient-provider-notification-test",
  staticDir: undefined,
  devUrl: undefined,
  noBrowser: true,
  authToken: undefined,
  autoBootstrapProjectFromCwd: false,
  logProviderEvents: false,
  logWebSocketEvents: false,
  agentGatewayEnabled: false,
  stateDir: "/tmp/scient-provider-notification-test/state",
  secretsDir: "/tmp/scient-provider-notification-test/secrets",
  dbPath: "/tmp/scient-provider-notification-test/state.sqlite",
  settingsPath: "/tmp/scient-provider-notification-test/settings.json",
  keybindingsConfigPath: "/tmp/scient-provider-notification-test/keybindings.json",
  worktreesDir: "/tmp/scient-provider-notification-test/worktrees",
  attachmentsDir: "/tmp/scient-provider-notification-test/attachments",
  logsDir: "/tmp/scient-provider-notification-test/logs",
  serverLogPath: "/tmp/scient-provider-notification-test/logs/server.log",
  serverRuntimeStatePath: "/tmp/scient-provider-notification-test/server-runtime.json",
  providerLogsDir: "/tmp/scient-provider-notification-test/logs/provider",
  providerEventLogPath: "/tmp/scient-provider-notification-test/logs/provider/events.log",
  terminalLogsDir: "/tmp/scient-provider-notification-test/logs/terminal",
  anonymousIdPath: "/tmp/scient-provider-notification-test/anonymous-id",
  environmentIdPath: "/tmp/scient-provider-notification-test/environment-id",
};

export const ProviderNotificationAdapterTestLayer = Layer.mergeAll(
  NodeServices.layer,
  Layer.succeed(ServerConfig, TEST_CONFIG),
);

interface FakeRuntimeControl {
  readonly offer: (event: AcpParsedSessionEvent) => Effect.Effect<boolean>;
  readonly scopeClosed: Deferred.Deferred<void>;
}

function makeFakeRuntimeHarness(): {
  readonly controls: Array<FakeRuntimeControl>;
  readonly factory: TestAcpSessionRuntimeFactory;
  readonly failNextStart: () => void;
} {
  const controls: Array<FakeRuntimeControl> = [];
  let failNextStart = false;

  const factory: TestAcpSessionRuntimeFactory = () =>
    Effect.gen(function* () {
      const sessionScope = yield* Scope.Scope;
      const eventQueue = yield* Queue.unbounded<AcpParsedSessionEvent>();
      const promptResult = yield* Deferred.make<{ stopReason: "end_turn" }>();
      const scopeClosed = yield* Deferred.make<void>();
      let sessionUpdatesEnqueued = 0;
      const shouldFailStart = failNextStart;
      failNextStart = false;
      const sessionId = `fake-session-${controls.length + 1}`;

      yield* Scope.addFinalizer(
        sessionScope,
        Queue.shutdown(eventQueue).pipe(
          Effect.andThen(Deferred.succeed(scopeClosed, undefined)),
          Effect.asVoid,
        ),
      );

      const control: FakeRuntimeControl = {
        offer: (event) =>
          Effect.sync(() => {
            sessionUpdatesEnqueued += 1;
          }).pipe(Effect.andThen(Queue.offer(eventQueue, event))),
        scopeClosed,
      };
      controls.push(control);

      return {
        handleRequestPermission: () => Effect.void,
        handleElicitation: () => Effect.void,
        handleReadTextFile: () => Effect.void,
        handleWriteTextFile: () => Effect.void,
        handleCreateTerminal: () => Effect.void,
        handleTerminalOutput: () => Effect.void,
        handleTerminalWaitForExit: () => Effect.void,
        handleTerminalKill: () => Effect.void,
        handleTerminalRelease: () => Effect.void,
        handleSessionUpdate: () => Effect.void,
        handleElicitationComplete: () => Effect.void,
        handleUnknownExtRequest: () => Effect.void,
        handleUnknownExtNotification: () => Effect.void,
        handleExtRequest: () => Effect.void,
        handleExtNotification: () => Effect.void,
        start: () =>
          shouldFailStart
            ? Effect.fail(EffectAcpErrors.AcpRequestError.internalError("test startup failure"))
            : Effect.succeed({
                sessionId,
                initializeResult: {},
                sessionSetupResult: {},
                modelConfigId: undefined,
                sessionSetupMethod: "new",
              } as AcpSessionRuntimeStartResult),
        getEvents: () => Stream.fromQueue(eventQueue),
        sessionUpdatesEnqueuedCount: Effect.sync(() => sessionUpdatesEnqueued),
        supportsSessionFork: Effect.succeed(false),
        getModeState: Effect.succeed(undefined),
        getConfigOptions: Effect.succeed([]),
        getAvailableCommands: Effect.succeed([]),
        prompt: () => Deferred.await(promptResult),
        cancel: Effect.void,
        setMode: () => Effect.succeed({}),
        setConfigOption: () => Effect.succeed({}),
        setModel: () => Effect.void,
        forkSession: () => Effect.succeed({ sessionId }),
        request: () => Effect.succeed({}),
        notify: () => Effect.void,
      } as unknown as AcpSessionRuntimeShape;
    });

  return {
    controls,
    factory,
    failNextStart: () => {
      failNextStart = true;
    },
  };
}

const contentDelta = (text: string): AcpParsedSessionEvent => ({
  _tag: "ContentDelta",
  itemId: `item-${text}`,
  text,
  streamKind: "assistant_text",
  rawPayload: { text },
});

const awaitContentDelta = (
  adapter: ProviderAdapterShape<unknown>,
  threadId: ThreadId,
  expectedDelta: string,
) =>
  adapter.streamEvents.pipe(
    Stream.filter(
      (event): event is Extract<ProviderRuntimeEvent, { readonly type: "content.delta" }> =>
        event.type === "content.delta" &&
        event.threadId === threadId &&
        event.payload.delta === expectedDelta,
    ),
    Stream.runHead,
  );

const completedWithin = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(Effect.timeoutOption("1 second"), Effect.map(Option.isSome));

export const observeAdapterNotificationLifecycle = <TError, E, R>(input: {
  readonly provider: ProviderKind;
  readonly makeAdapter: (
    runtimeFactory: TestAcpSessionRuntimeFactory,
  ) => Effect.Effect<ProviderAdapterShape<TError>, E, R>;
}) =>
  Effect.gen(function* () {
    const harness = makeFakeRuntimeHarness();
    const adapter = yield* input.makeAdapter(harness.factory);
    const threadId = ThreadId.makeUnsafe(`notification-${input.provider}`);

    const firstEventFiber = yield* awaitContentDelta(adapter, threadId, "late-first").pipe(
      Effect.forkChild,
    );
    yield* Effect.yieldNow;
    yield* adapter.startSession({
      threadId,
      provider: input.provider,
      cwd: "/tmp",
      runtimeMode: "approval-required",
    });
    yield* adapter.sendTurn({ threadId, input: "first turn" });
    yield* harness.controls[0]!.offer(contentDelta("late-first"));
    const firstEvent = Option.getOrUndefined(
      Option.flatten(yield* Fiber.join(firstEventFiber).pipe(Effect.timeoutOption("1 second"))),
    );

    yield* adapter.startSession({
      threadId,
      provider: input.provider,
      cwd: "/tmp",
      runtimeMode: "approval-required",
    });
    const firstScopeClosed = yield* completedWithin(
      Deferred.await(harness.controls[0]!.scopeClosed),
    );

    const replacementEventFiber = yield* awaitContentDelta(
      adapter,
      threadId,
      "late-replacement",
    ).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* adapter.sendTurn({ threadId, input: "replacement turn" });
    yield* harness.controls[1]!.offer(contentDelta("late-replacement"));
    const replacementEvent = Option.getOrUndefined(
      Option.flatten(
        yield* Fiber.join(replacementEventFiber).pipe(Effect.timeoutOption("1 second")),
      ),
    );

    yield* adapter.stopSession(threadId);
    const replacementScopeClosed = yield* completedWithin(
      Deferred.await(harness.controls[1]!.scopeClosed),
    );
    const sessionPresentAfterStop = yield* adapter.hasSession(threadId);

    harness.failNextStart();
    const failedThreadId = ThreadId.makeUnsafe(`notification-${input.provider}-failed`);
    const failedStart = yield* Effect.exit(
      adapter.startSession({
        threadId: failedThreadId,
        provider: input.provider,
        cwd: "/tmp",
        runtimeMode: "approval-required",
      }),
    );
    const failedScopeClosed = yield* completedWithin(
      Deferred.await(harness.controls[2]!.scopeClosed),
    );
    const failedSessionPresent = yield* adapter.hasSession(failedThreadId);

    return {
      firstEventProvider: firstEvent?.provider,
      firstEventDelta: firstEvent?.payload.delta,
      firstScopeClosed,
      replacementEventProvider: replacementEvent?.provider,
      replacementEventDelta: replacementEvent?.payload.delta,
      replacementScopeClosed,
      sessionPresentAfterStop,
      failedStart: Exit.isFailure(failedStart),
      failedScopeClosed,
      failedSessionPresent,
    };
  });
