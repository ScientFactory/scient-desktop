import * as Crypto from "effect/Crypto";
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  type ModelSelection,
  ProviderSessionId,
  ProviderTurnId,
  RunAttemptId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { type ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import * as ClaudeAdapterV2 from "./ClaudeAdapterV2.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  DEFAULT_CLAUDE_SETTINGS,
  CLAUDE_TEST_MODEL_SELECTION,
  CLAUDE_TEST_RUNTIME_POLICY,
  makeClaudeTestTurnInput,
  encodeJsonString,
} from "./ClaudeAdapterV2.fixture.ts";
import { claudeSdkFrame, awaitUntil, makeResultFrame } from "./ClaudeAdapterV2.wake.testkit.ts";

const makeCapturedStopHarness = (name: string, closeFails = false) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const attachmentsDir = yield* fs.makeTempDirectoryScoped({
      prefix: "t3-claude-captured-stop-",
    });
    const receiptDir =
      process.env.SCIENT_STOP_PROOF_ARTIFACT_DIR ??
      (yield* fs.makeTempDirectoryScoped({ prefix: "t3-stop-race-receipts-" }));
    const interruptEntered = yield* Deferred.make<void>();
    const interruptRelease = yield* Deferred.make<void>();
    const closeEntered = yield* Deferred.make<void>();
    const pauseEntered = yield* Deferred.make<void>();
    const pauseRelease = yield* Deferred.make<void>();
    let pause: "prepare" | "open" | "close" | null = null;
    const events: ProviderAdapterV2Event[] = [];
    const wire: unknown[] = [];
    const queries: Array<{
      nativeId: string;
      owner: string;
      sdkMessages: Queue.Queue<SDKMessage>;
      offers: SDKUserMessage[];
      closes: number;
      interrupts: number;
      push: (message: SDKMessage) => Effect.Effect<void>;
    }> = [];
    const awaitPause = (phase: "prepare" | "open" | "close") =>
      Effect.gen(function* () {
        if (pause !== phase) return;
        pause = null;
        wire.push({ phase: `${phase}.entered` });
        yield* Deferred.succeed(pauseEntered, undefined);
        yield* Deferred.await(pauseRelease);
        wire.push({ phase: `${phase}.released` });
      });
    let allocated = 0;
    const adapter = ClaudeAdapterV2.makeClaudeAdapterV2({
      crypto: yield* Crypto.Crypto,
      instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
      settings: DEFAULT_CLAUDE_SETTINGS,
      environment: {},
      attachmentsDir,
      fileSystem: {
        ...fs,
        readDirectory: (path) => awaitPause("prepare").pipe(Effect.andThen(fs.readDirectory(path))),
      },
      path: yield* Path.Path,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      queryRunner: {
        allocateSessionId: Effect.sync(
          () => `00000000-0000-4000-8000-${String(++allocated).padStart(12, "0")}`,
        ),
        open: (input) =>
          Effect.gen(function* () {
            yield* awaitPause("open");
            const sdkMessages = yield* Queue.unbounded<SDKMessage>();
            const processed = new WeakMap<SDKMessage, Deferred.Deferred<void>>();
            const push = Effect.fnUntraced(function* (message: SDKMessage) {
              const receipt = yield* Deferred.make<void>();
              processed.set(message, receipt);
              wire.push({ direction: "incoming", owner: input.providerSessionId, message });
              yield* Queue.offer(sdkMessages, message);
              yield* Deferred.await(receipt);
            });
            const query = {
              nativeId: input.options.sessionId ?? input.options.resume!,
              owner: String(input.providerSessionId),
              sdkMessages,
              offers: [] as SDKUserMessage[],
              closes: 0,
              interrupts: 0,
              push,
            };
            queries.push(query);
            wire.push({
              phase: "query.opened",
              owner: query.owner,
              nativeId: query.nativeId,
              options: input.options,
            });
            return {
              messages: Stream.fromQueue(sdkMessages).pipe(
                Stream.flatMap((message) =>
                  Stream.make(message).pipe(
                    Stream.concat(
                      Stream.fromEffect(
                        Effect.suspend(() => Deferred.succeed(processed.get(message)!, undefined)),
                      ).pipe(Stream.drain),
                    ),
                  ),
                ),
              ),
              offer: (message) =>
                Effect.gen(function* () {
                  query.offers.push(message);
                  wire.push({ direction: "outgoing", owner: query.owner, message });
                  yield* push(
                    claudeSdkFrame({
                      ...message,
                      session_id: query.nativeId,
                      parent_tool_use_id: null,
                      user_message_uuid: message.uuid,
                    }),
                  );
                }),
              setModel: () => Effect.die("No SDK model mutation in captured Stop race"),
              setPermissionMode: () =>
                Effect.die("No SDK permission mutation in captured Stop race"),
              interrupt: Effect.gen(function* () {
                query.interrupts++;
                wire.push({
                  phase: "interrupt.entered",
                  owner: query.owner,
                  nativeId: query.nativeId,
                  uuid: query.offers.at(-1)?.uuid,
                });
                yield* Deferred.succeed(interruptEntered, undefined);
                yield* Deferred.await(interruptRelease);
                return yield* new ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError({
                  method: "interrupt",
                  cause: "Held exact native interrupt rejected",
                });
              }),
              close: Effect.gen(function* () {
                query.closes++;
                wire.push({
                  phase: "close.entered",
                  owner: query.owner,
                  nativeId: query.nativeId,
                });
                yield* Deferred.succeed(closeEntered, undefined);
                yield* awaitPause("close");
                if (closeFails && input.threadId === ThreadId.make("captured:source"))
                  return yield* new ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError({
                    method: "close",
                    cause: "Exact live query close rejected",
                  });
                yield* Queue.shutdown(sdkMessages);
              }),
            };
          }),
        forkSession: () => Effect.die("No fork in captured Stop race"),
        subagentLaunchToolUseId: () => Effect.succeed(null),
        assertComplete: Effect.void,
      },
    });
    const open = Effect.fnUntraced(function* (owner: "source" | "peer") {
      const threadId = ThreadId.make(`captured:${owner}`);
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make(`captured:${owner}`),
        modelSelection: CLAUDE_TEST_MODEL_SELECTION,
        runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection: CLAUDE_TEST_MODEL_SELECTION,
        runtimePolicy: CLAUDE_TEST_RUNTIME_POLICY,
      });
      yield* runtime.events.pipe(
        Stream.runForEach((event) => Effect.sync(() => events.push(event))),
        Effect.forkScoped,
      );
      return { threadId, runtime, providerThread };
    });
    const source = yield* open("source");
    const peer = yield* open("peer");
    let ordinal = 0;
    const startOwned = Effect.fnUntraced(function* (
      label: string,
      selection: ModelSelection,
      owner: typeof source,
    ) {
      const input = makeClaudeTestTurnInput({
        threadId: owner.threadId,
        providerThread: owner.providerThread,
        now: yield* DateTime.now,
        attemptId: RunAttemptId.make(label),
        text: label,
        attachments: [],
        providerTurnOrdinal: ++ordinal,
        modelSelection: selection,
      });
      yield* owner.runtime.startTurn(input);
      yield* awaitUntil(
        () =>
          events.some(
            (e) =>
              e.type === "provider_turn.updated" &&
              e.providerTurn.runAttemptId === input.attemptId &&
              e.providerTurn.nativeAcceptance === "accepted",
          ),
        `accepted ${label}`,
      );
      const accepted = events.find(
        (e) =>
          e.type === "provider_turn.updated" &&
          e.providerTurn.runAttemptId === input.attemptId &&
          e.providerTurn.nativeAcceptance === "accepted",
      );
      if (accepted?.type !== "provider_turn.updated")
        return yield* Effect.die("Missing actual accepted native owner");
      const query = queries.findLast((q) => q.owner === String(owner.runtime.providerSessionId))!;
      return { input, turnId: accepted.providerTurn.id, query };
    });
    const start = (
      label: string,
      selection: ModelSelection = CLAUDE_TEST_MODEL_SELECTION,
      owner = source,
    ) => startOwned(label, selection, owner);
    let resultOrdinal = 3000;
    const settle = Effect.fnUntraced(function* (
      query: (typeof queries)[number],
      turnId: ProviderTurnId,
    ) {
      yield* query.push(
        claudeSdkFrame({
          ...makeResultFrame({
            uuid: `00000000-0000-4000-8000-${String(++resultOrdinal).padStart(12, "0")}`,
            result: "Actual correlated native result",
            userMessageUuid: query.offers.findLast((m) => m.uuid !== undefined)!.uuid!,
          }),
          session_id: query.nativeId,
        }),
      );
      yield* awaitUntil(
        () => events.some((e) => e.type === "turn.terminal" && e.providerTurnId === turnId),
        "exact native terminal delivered",
      );
    });
    const terminals = (id: ProviderTurnId) =>
      events.filter((e) => e.type === "turn.terminal" && e.providerTurnId === id);
    const save = Effect.gen(function* () {
      const dir = receiptDir;
      yield* fs.makeDirectory(`${dir}/generation-races`, { recursive: true });
      yield* fs.writeFileString(
        `${dir}/generation-races/${name}.json`,
        encodeJsonString({
          events,
          wire,
          queries: queries.map(({ nativeId, owner, offers, closes, interrupts }) => ({
            nativeId,
            owner,
            offers,
            closes,
            interrupts,
          })),
        }),
      );
    }).pipe(Effect.orDie);
    return {
      source,
      peer,
      start,
      settle,
      terminals,
      queries,
      events,
      interruptEntered,
      interruptRelease,
      closeEntered,
      pauseEntered,
      pauseRelease,
      setPause: (phase: typeof pause) => {
        pause = phase;
      },
      save,
    };
  });
export { makeCapturedStopHarness };
