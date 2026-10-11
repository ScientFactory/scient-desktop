import { assert, it } from "@effect/vitest";
import {
  NodeId,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
} from "@t3tools/contracts";
import type { OpenCodeClient } from "@opencode/client/effect";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { OrchestrationV2ProviderTurn } from "@t3tools/contracts";
import { makeOpenCodeTurnAcceptance } from "./turnAcceptance.ts";

const driver = ProviderDriverKind.make("opencode");
const providerThreadId = ProviderThreadId.make("provider-thread:opencode-acceptance");
const promptId = "message:selected-prompt";

const selectedTurn = (nativeId = promptId): OrchestrationV2ProviderTurn => ({
  id: ProviderTurnId.make("provider-turn:selected"),
  providerThreadId,
  nodeId: NodeId.make("node:selected"),
  runAttemptId: RunAttemptId.make("attempt:selected"),
  nativeTurnRef: { driver, nativeId, strength: "strong" },
  ordinal: 1,
  status: "completed",
  startedAt: null,
  completedAt: null,
});

const acceptance = (turn: OrchestrationV2ProviderTurn, prompts: ReadonlyArray<string>) => {
  const nativeClient = {
    message: {
      list: () =>
        Effect.succeed({
          data: prompts.map((id) => ({ id, type: "user" })),
          cursor: {},
        }),
    },
  } as unknown as OpenCodeClient;
  const turnState = { providerTurn: turn, unsent: false };
  const state = {
    sessionId: "session:opencode-acceptance",
    providerThread: { id: providerThreadId },
    providerTurns: new Map([[String(turn.id), turn]]),
    active: undefined,
  };
  return Effect.gen(function* () {
    const lock = yield* Semaphore.make(1);
    const helper = makeOpenCodeTurnAcceptance({
      driver,
      lock,
      threads: new Map([[state.sessionId, state]]),
      emitProviderTurn: () => Effect.void,
      ref: (nativeId) => ({ driver, nativeId, strength: "strong" }),
      promptOf: () => promptId,
      getClient: () => nativeClient,
    });
    return yield* helper.forkBoundaryAfter(
      state.sessionId,
      providerThreadId,
      turnState.providerTurn,
    );
  });
};

it.effect("resolves the next prompt after a completed, strong native fork boundary", () =>
  Effect.gen(function* () {
    assert.strictEqual(
      yield* acceptance(selectedTurn(), ["message:later", promptId]),
      "message:later",
    );
  }),
);

it.effect("refuses a boundary missing from native history", () =>
  Effect.gen(function* () {
    const error = yield* acceptance(selectedTurn(), ["message:later"]).pipe(Effect.flip);
    assert.instanceOf(error, ProviderAdapter.ProviderAdapterProtocolError);
  }),
);

it.effect("refuses an ambiguous duplicate boundary in native history", () =>
  Effect.gen(function* () {
    const error = yield* acceptance(selectedTurn(), [promptId, promptId]).pipe(Effect.flip);
    assert.instanceOf(error, ProviderAdapter.ProviderAdapterProtocolError);
  }),
);

it.effect("refuses a weak native reference even if its id is in history", () =>
  Effect.gen(function* () {
    const turn = {
      ...selectedTurn(),
      nativeTurnRef: { driver, nativeId: promptId, strength: "weak" as const },
    };
    const error = yield* acceptance(turn, [promptId]).pipe(Effect.flip);
    assert.instanceOf(error, ProviderAdapter.ProviderAdapterProtocolError);
  }),
);
