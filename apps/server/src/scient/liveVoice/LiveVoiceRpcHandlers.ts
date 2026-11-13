/**
 * Voice calls reach the thread's running Scient Agent session. The call lasts as long as the
 * window's subscription: a closed window or a lost connection hangs up. Each spoken request is
 * sent as the user's message, so it runs, queues and stops like a typed one.
 */
// @effect-diagnostics nodeBuiltinImport:off -- message ids are random UUIDs, as the window makes them.
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
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
}: Pick<ScientRpcObservers, "observeRpcEffect" | "observeRpcStream"> & {
  readonly threadManagement: ThreadManagementService.ThreadManagementService["Service"];
  readonly providerSessions: ProviderSessionManager.ProviderSessionManagerV2["Service"];
}) => {
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

  return {
    [WS_METHODS.liveVoiceCall]: (input) =>
      observeRpcStream(
        WS_METHODS.liveVoiceCall,
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
        ),
        { "rpc.aggregate": "liveVoice" },
      ),
    [WS_METHODS.liveVoiceMute]: (input) =>
      observeRpcEffect(
        WS_METHODS.liveVoiceMute,
        resolve(input.threadId).pipe(
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
