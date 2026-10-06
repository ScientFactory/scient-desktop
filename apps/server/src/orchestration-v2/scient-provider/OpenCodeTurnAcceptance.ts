/**
 * Scient's native acceptance for OpenCode turns: a turn is accepted when
 * OpenCode starts executing it or answers its command, a client-chosen prompt
 * boundary is confirmed only by the native prompt response, and a fork cuts
 * at the confirmed boundary resolved from complete native history.
 */
import { type OpenCodeClient, Session } from "@opencode/client/effect";
import type {
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  ProviderDriverKind,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { paginate } from "../../provider/opencode2/OpenCode2Client.ts";
import * as ProviderAdapter from "../ProviderAdapter.ts";

interface AcceptanceTurn {
  providerTurn: OrchestrationV2ProviderTurn;
  readonly unsent: boolean;
}

interface AcceptanceThread<Turn> {
  readonly sessionId: string;
  readonly providerThread: Pick<OrchestrationV2ProviderThread, "id">;
  readonly providerTurns: Map<string, OrchestrationV2ProviderTurn>;
  readonly active: Turn | undefined;
}

export const makeOpenCodeTurnAcceptance = <
  Turn extends AcceptanceTurn,
  State extends AcceptanceThread<Turn>,
  E,
  R,
>(input: {
  readonly driver: ProviderDriverKind;
  readonly lock: Semaphore.Semaphore;
  readonly threads: ReadonlyMap<string, State>;
  readonly emitProviderTurn: (
    state: State,
    turn: Turn,
    providerTurn: OrchestrationV2ProviderTurn,
  ) => Effect.Effect<void, E, R>;
  readonly ref: (nativeId: string) => NonNullable<OrchestrationV2ProviderTurn["nativeTurnRef"]>;
  readonly promptOf: (turn: OrchestrationV2ProviderTurn) => string | undefined;
  /** Read once per fork, since a reconnect replaces the session's client. */
  readonly getClient: () => OpenCodeClient;
}) => {
  const { driver, lock, threads, emitProviderTurn, ref, promptOf, getClient } = input;

  const markTurnAccepted = Effect.fnUntraced(function* (state: State, turn: Turn) {
    if (state.active !== turn || turn.unsent || turn.providerTurn.acceptedAt !== undefined) return;
    turn.providerTurn = {
      ...turn.providerTurn,
      nativeAcceptance: "accepted",
      acceptedAt: yield* DateTime.now,
    };
    yield* emitProviderTurn(state, turn, turn.providerTurn);
  });

  const confirmPromptBoundary = (
    state: State,
    turn: Turn,
    response: { readonly id: string; readonly sessionID: string },
    offeredId: string,
    turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
  ) =>
    lock.withPermit(
      Effect.gen(function* () {
        if (
          response.id !== offeredId ||
          response.sessionID !== state.sessionId ||
          threads.get(state.sessionId) !== state ||
          state.providerThread.id !== turnInput.providerThread.id ||
          (state.active !== undefined && state.active !== turn)
        )
          return;
        // Only the native response can confirm a client-chosen message boundary.
        // The ordered event feed may already have settled this exact turn.
        const latest = state.providerTurns.get(String(turn.providerTurn.id)) ?? turn.providerTurn;
        if (
          latest.runAttemptId !== turnInput.attemptId ||
          latest.nodeId !== turnInput.rootNodeId ||
          latest.providerThreadId !== turnInput.providerThread.id ||
          latest.nativeTurnRef?.nativeId !== offeredId ||
          latest.nativeTurnRef.driver !== driver
        )
          return;
        turn.providerTurn = {
          ...latest,
          nativeTurnRef: ref(response.id),
          nativeAcceptance: "accepted",
          acceptedAt: latest.acceptedAt ?? (yield* DateTime.now),
        };
        yield* emitProviderTurn(state, turn, turn.providerTurn);
      }),
    );

  // OpenCode's cut is exclusive; frozen evidence ends at the included turn.
  // Resolve the next native prompt from complete history, never from later app turns.
  const forkBoundaryAfter = Effect.fnUntraced(function* (
    sessionId: string,
    providerThreadId: OrchestrationV2ProviderThread["id"],
    selected: OrchestrationV2ProviderTurn,
  ) {
    const messageId = promptOf(selected);
    if (
      selected.providerThreadId !== providerThreadId ||
      selected.nativeTurnRef?.driver !== driver ||
      selected.nativeTurnRef.strength !== "strong" ||
      messageId === undefined ||
      selected.status !== "completed"
    ) {
      return yield* new ProviderAdapter.ProviderAdapterProtocolError({
        driver,
        detail: "This OpenCode fork has no confirmed completed native prompt boundary.",
      });
    }
    const history = yield* paginate(
      { sessionID: Session.ID.make(sessionId), order: "desc" as const, limit: 100 },
      getClient().message.list,
    ).pipe(Stream.runCollect);
    const prompts = history.flatMap((message) =>
      message.type === "user" || message.type === "synthetic" ? [String(message.id)] : [],
    );
    const index = prompts.indexOf(messageId);
    if (index < 0 || new Set(prompts).size !== prompts.length) {
      return yield* new ProviderAdapter.ProviderAdapterProtocolError({
        driver,
        detail: "The confirmed OpenCode fork boundary is absent or ambiguous in native history.",
      });
    }
    return index === 0 ? null : prompts[index - 1]!;
  });

  return { markTurnAccepted, confirmPromptBoundary, forkBoundaryAfter };
};
