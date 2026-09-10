import { expect, it } from "@effect/vitest";
import {
  EventId,
  ProviderDriverKind,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import type { AntigravityAdapterShape } from "../Services/AntigravityAdapter.ts";
import {
  isAcpAntigravityResumeCursor,
  isLegacyAntigravityResumeCursor,
  makeAntigravityCompatibilityAdapter,
} from "./AntigravityCompatibilityAdapter.ts";

const provider = ProviderDriverKind.make("antigravity");
const stamp = "2026-09-03T00:00:00.000Z";

function makeAdapter(label: "acp" | "legacy") {
  const sessions = new Map<ThreadId, ProviderSession>();
  const calls: string[] = [];
  const adapter: AntigravityAdapterShape = {
    provider,
    capabilities: {
      sessionModelSwitch: label === "acp" ? "in-session" : "unsupported",
      supportsConversationRollback: false,
    },
    startSession: (input) =>
      Effect.sync(() => {
        calls.push(`${label}:start:${input.threadId}`);
        const session: ProviderSession = {
          provider,
          status: "ready",
          runtimeMode: input.runtimeMode,
          threadId: input.threadId,
          ...(input.resumeCursor === undefined ? {} : { resumeCursor: input.resumeCursor }),
          createdAt: stamp,
          updatedAt: stamp,
        };
        sessions.set(input.threadId, session);
        return session;
      }),
    sendTurn: (input) =>
      Effect.sync(() => {
        calls.push(`${label}:turn:${input.threadId}`);
        return { threadId: input.threadId, turnId: TurnId.make(`${label}-turn`) };
      }),
    interruptTurn: (threadId) =>
      Effect.sync(() => {
        calls.push(`${label}:interrupt:${threadId}`);
      }),
    respondToRequest: (threadId) =>
      Effect.sync(() => {
        calls.push(`${label}:approval:${threadId}`);
      }),
    respondToUserInput: (threadId) =>
      Effect.sync(() => {
        calls.push(`${label}:input:${threadId}`);
      }),
    stopSession: (threadId) =>
      Effect.sync(() => {
        calls.push(`${label}:stop:${threadId}`);
        sessions.delete(threadId);
      }),
    listSessions: () => Effect.sync(() => [...sessions.values()]),
    hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
    readThread: (threadId) => Effect.succeed({ threadId, turns: [] }),
    rollbackThread: (threadId) => Effect.succeed({ threadId, turns: [] }),
    stopAll: () =>
      Effect.sync(() => {
        calls.push(`${label}:stop-all`);
        sessions.clear();
      }),
    streamEvents: Stream.empty,
    subscribeEvents: Effect.succeed(Stream.empty),
  };
  return { adapter, calls, sessions };
}

it("recognizes only the two explicit Antigravity continuation formats", () => {
  expect(isLegacyAntigravityResumeCursor({ schemaVersion: 2, conversationId: "old" })).toBe(true);
  expect(isAcpAntigravityResumeCursor({ schemaVersion: 1, sessionId: "native" })).toBe(true);
  expect(isLegacyAntigravityResumeCursor({ schemaVersion: 1, sessionId: "native" })).toBe(false);
  expect(isAcpAntigravityResumeCursor({ schemaVersion: 2, conversationId: "old" })).toBe(false);
  expect(isLegacyAntigravityResumeCursor({ schemaVersion: "2" })).toBe(false);
});

it.effect("keeps new sessions on ACP and lazily routes only old cursors to agy", () =>
  Effect.gen(function* () {
    const acp = makeAdapter("acp");
    const legacy = makeAdapter("legacy");
    let legacyCreations = 0;
    const adapter = yield* makeAntigravityCompatibilityAdapter({
      acp: acp.adapter,
      makeLegacy: Effect.sync(() => {
        legacyCreations += 1;
        return legacy.adapter;
      }),
    });
    const newThread = ThreadId.make("new-thread");
    const nativeThread = ThreadId.make("native-thread");
    const oldThread = ThreadId.make("old-thread");

    yield* adapter.startSession({ threadId: newThread, runtimeMode: "full-access" });
    yield* adapter.startSession({
      threadId: nativeThread,
      runtimeMode: "full-access",
      resumeCursor: { schemaVersion: 1, sessionId: "native-session" },
    });
    expect(legacyCreations).toBe(0);

    yield* adapter.startSession({
      threadId: oldThread,
      runtimeMode: "full-access",
      resumeCursor: { schemaVersion: 2, conversationId: "legacy-conversation" },
    });
    yield* adapter.sendTurn({ threadId: oldThread, input: "continue" });
    yield* adapter.sendTurn({ threadId: newThread, input: "continue" });

    expect(legacyCreations).toBe(1);
    expect(acp.calls).toEqual([
      `acp:start:${newThread}`,
      `acp:start:${nativeThread}`,
      `acp:turn:${newThread}`,
    ]);
    expect(legacy.calls).toEqual([`legacy:start:${oldThread}`, `legacy:turn:${oldThread}`]);
    expect((yield* adapter.listSessions()).map((session) => session.threadId)).toEqual([
      newThread,
      nativeThread,
      oldThread,
    ]);
  }),
);

it.effect("subscribes before a lazily created legacy session can publish events", () =>
  Effect.gen(function* () {
    const acp = makeAdapter("acp");
    const legacy = makeAdapter("legacy");
    const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const threadId = ThreadId.make("legacy-resume");
    const started = {
      type: "session.started",
      eventId: EventId.make("legacy-started"),
      provider,
      threadId,
      createdAt: stamp,
      payload: {},
    } satisfies ProviderRuntimeEvent;
    const adapter = yield* makeAntigravityCompatibilityAdapter({
      acp: acp.adapter,
      makeLegacy: Effect.succeed({
        ...legacy.adapter,
        subscribeEvents: PubSub.subscribe(events).pipe(Effect.map(Stream.fromSubscription)),
        startSession: (input) =>
          legacy.adapter
            .startSession(input)
            .pipe(Effect.tap(() => PubSub.publish(events, started))),
      }),
    });
    yield* adapter.startSession({
      threadId,
      runtimeMode: "full-access",
      resumeCursor: { schemaVersion: 2, conversationId: "old" },
    });
    const received = yield* adapter.streamEvents.pipe(Stream.take(1), Stream.runCollect);
    expect(received).toEqual([started]);
    expect(acp.calls).toEqual([]);
    expect(legacy.calls).toEqual([`legacy:start:${threadId}`]);
  }),
);
