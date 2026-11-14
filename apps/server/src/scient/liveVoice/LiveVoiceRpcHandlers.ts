/**
 * Voice calls with Scient Agent, in an agent of their own when the window names one (no running
 * conversation needed; each request's turn is reported back), else in the thread's own session.
 * Requests are sent as the user's message. A closed window or a lost connection hangs up.
 */
// @effect-diagnostics nodeBuiltinImport:off -- message ids are random UUIDs, as the window makes them.
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  type LiveVoiceCallEvent,
  type LiveVoiceCallInput,
  LiveVoiceError,
  MessageId,
  type ThreadId,
  WS_METHODS,
  WsWorkspaceRpcGroup,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type * as ProviderSessionManager from "../../orchestration-v2/ProviderSessionManager.ts";
import type * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import type * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import type { ProviderLiveVoiceCall } from "../../provider/ScientProviderInstanceSeams.ts";
import { makeLiveVoiceTurnReporter } from "./LiveVoiceTurnReporter.ts";
import type { ScientRpcHandlerSubset, ScientRpcObservers } from "../ScientRpcObservers.ts";

const toLiveVoiceError =
  (threadId: ThreadId) =>
  (failure: ProviderAdapter.ScientLiveVoiceFailure): LiveVoiceError =>
    new LiveVoiceError({
      threadId,
      reason: failure.reason,
      ...(failure.detail === undefined ? {} : { detail: failure.detail }),
    });

export const makeLiveVoiceRpcHandlers = ({
  observeRpcEffect,
  observeRpcStream,
  threadManagement,
  providerSessions,
  providerInstances,
}: Pick<ScientRpcObservers, "observeRpcEffect" | "observeRpcStream"> & {
  readonly threadManagement: ThreadManagementService.ThreadManagementService["Service"];
  readonly providerSessions: ProviderSessionManager.ProviderSessionManagerV2["Service"];
  readonly providerInstances: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"];
}) => {
  /** Calls running in an agent of their own, by thread, so mute finds them. */
  const ownAgentCalls = new Map<ThreadId, ProviderLiveVoiceCall>();

  /** The live voice of the thread's active, running provider session. */
  const resolve = Effect.fn("LiveVoice.resolve")(function* (threadId: ThreadId) {
    const stopped = new LiveVoiceError({ threadId, reason: "session-stopped" });
    const { thread, providerThreads } = yield* threadManagement
      .getThreadRecords(threadId, ["providerThreads"])
      .pipe(Effect.mapError(() => stopped));
    const providerThread = providerThreads.find(
      (candidate) => candidate.id === thread.activeProviderThreadId,
    );
    if (providerThread?.providerSessionId == null) return yield* stopped;
    const runtime = Option.getOrUndefined(
      yield* providerSessions
        .get(providerThread.providerSessionId)
        .pipe(Effect.mapError(() => stopped)),
    );
    if (runtime === undefined) return yield* stopped;
    if (runtime.liveVoice === undefined) {
      return yield* new LiveVoiceError({ threadId, reason: "provider-unsupported" });
    }
    return runtime.liveVoice;
  });

  const sendRequest = (threadId: ThreadId, text: string) =>
    Effect.suspend(() => {
      const id = NodeCrypto.randomUUID();
      return threadManagement.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`live-voice:${id}`),
        threadId,
        messageId: MessageId.make(id),
        text,
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("liveVoice.request-not-sent", { threadId, cause }),
      ),
    );

  const sessionCall = (input: LiveVoiceCallInput) =>
    Stream.unwrap(
      resolve(input.threadId).pipe(
        Effect.map((liveVoice) =>
          liveVoice.call(input.sdpOffer).pipe(
            Stream.mapError(toLiveVoiceError(input.threadId)),
            Stream.tap((event) =>
              event.type === "request" ? sendRequest(input.threadId, event.text) : Effect.void,
            ),
          ),
        ),
      ),
    );

  /** The call in an agent of its own, or undefined when the instance can't run one. */
  const openOwnAgentCall = Effect.fn("LiveVoice.openOwnAgentCall")(function* (
    input: LiveVoiceCallInput,
  ) {
    if (input.instanceId === undefined) return undefined;
    const instance = yield* providerInstances.getInstance(input.instanceId);
    if (!instance?.enabled || instance.liveVoiceHost === undefined) return undefined;
    return yield* instance.liveVoiceHost.openCall.pipe(
      Effect.mapError(toLiveVoiceError(input.threadId)),
    );
  });

  const ownAgentCall = (input: LiveVoiceCallInput, call: ProviderLiveVoiceCall) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const { threadId } = input;
        const reporter = makeLiveVoiceTurnReporter(call.report);
        // Taken before the call starts, so a turn that begins meanwhile is still followed.
        const afterSequence = yield* threadManagement
          .getThreadEventSequence(threadId)
          .pipe(Effect.orElseSucceed(() => 0));
        yield* Stream.mergeAll(
          (["message.updated", "run.updated"] as const).map((eventType) =>
            threadManagement.streamStoredEventsFrom({ threadId, afterSequence, eventType }),
          ),
          { concurrency: "unbounded" },
        ).pipe(
          Stream.runForEach((stored) => reporter.observe(stored.event)),
          Effect.catchCause((cause) => Effect.logWarning("liveVoice.reports-stopped", { cause })),
          Effect.forkScoped,
        );
        const threadExists = threadManagement.getThreadRecords(threadId, []).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
        // A conversation not created yet gets its first message from the window, which creates it.
        const routeRequest = (text: string) =>
          Effect.suspend(() => {
            reporter.expect(text);
            return threadExists;
          }).pipe(
            Effect.flatMap((exists): Effect.Effect<LiveVoiceCallEvent> =>
              exists
                ? sendRequest(threadId, text).pipe(Effect.as({ type: "request", text }))
                : Effect.succeed({ type: "request", text, send: true }),
            ),
          );
        yield* Effect.acquireRelease(
          Effect.sync(() => ownAgentCalls.set(threadId, call)),
          () =>
            Effect.sync(
              () => ownAgentCalls.get(threadId) === call && ownAgentCalls.delete(threadId),
            ),
        );
        return call.call(input.sdpOffer).pipe(
          Stream.mapError(toLiveVoiceError(threadId)),
          Stream.mapEffect((event) =>
            event.type === "request" ? routeRequest(event.text) : Effect.succeed(event),
          ),
        );
      }),
    );

  return {
    [WS_METHODS.liveVoiceCall]: (input) =>
      observeRpcStream(
        WS_METHODS.liveVoiceCall,
        Stream.unwrap(
          openOwnAgentCall(input).pipe(
            Effect.map((call) =>
              call === undefined ? sessionCall(input) : ownAgentCall(input, call),
            ),
          ),
        ).pipe(Stream.scoped),
        { "rpc.aggregate": "liveVoice" },
      ),
    [WS_METHODS.liveVoiceMute]: (input) =>
      observeRpcEffect(
        WS_METHODS.liveVoiceMute,
        Effect.suspend(() => {
          const own = ownAgentCalls.get(input.threadId);
          return own === undefined ? resolve(input.threadId) : Effect.succeed(own);
        }).pipe(
          Effect.flatMap((liveVoice) =>
            liveVoice.mute(input.muted).pipe(Effect.mapError(toLiveVoiceError(input.threadId))),
          ),
          Effect.map((muted) => ({ muted })),
        ),
        { "rpc.aggregate": "liveVoice" },
      ),
  } satisfies ScientRpcHandlerSubset<
    typeof WsWorkspaceRpcGroup,
    typeof WS_METHODS.liveVoiceCall | typeof WS_METHODS.liveVoiceMute
  >;
};
