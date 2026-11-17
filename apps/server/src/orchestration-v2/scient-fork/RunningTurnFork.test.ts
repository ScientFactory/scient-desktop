import { assert, describe, it } from "@effect/vitest";
import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";

import { runningTurnCaptureTarget } from "./RunningTurnFork.ts";

const runId = RunId.make("run:live");
const attemptId = RunAttemptId.make("attempt:live");
const rootNodeId = NodeId.make("node:live");
const providerThreadId = ProviderThreadId.make("provider-thread:live");
const turnId = ProviderTurnId.make("provider-turn:live");
const codex = ProviderDriverKind.make("codex");

const turn = (overrides: Partial<OrchestrationV2ProviderTurn> = {}) =>
  ({
    id: turnId,
    runAttemptId: attemptId,
    nodeId: rootNodeId,
    providerThreadId,
    nativeAcceptance: "accepted",
    status: "running",
    nativeTurnRef: { driver: codex, nativeId: "native-turn", strength: "strong" },
    ...overrides,
  }) as OrchestrationV2ProviderTurn;

type Records = Parameters<typeof runningTurnCaptureTarget>[0];
const records = (overrides: {
  readonly driver?: string;
  readonly turns?: ReadonlyArray<OrchestrationV2ProviderTurn>;
  readonly providerSessionId?: ProviderSessionId | null;
  readonly attemptProviderTurnId?: ProviderTurnId | null;
}): Records =>
  ({
    thread: { id: ThreadId.make("thread:live") },
    runs: [
      {
        id: runId,
        ordinal: 4,
        activeAttemptId: attemptId,
        rootNodeId,
        providerThreadId,
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
    ],
    attempts: [{ id: attemptId, providerTurnId: overrides.attemptProviderTurnId ?? null }],
    providerThreads: [
      {
        id: providerThreadId,
        driver: ProviderDriverKind.make(overrides.driver ?? "codex"),
        providerSessionId:
          overrides.providerSessionId === undefined
            ? ProviderSessionId.make("session:live")
            : overrides.providerSessionId,
        nativeThreadRef: { driver: codex, nativeId: "native-thread", strength: "strong" },
      },
    ],
    providerTurns: overrides.turns ?? [turn()],
  }) as unknown as Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "attempts" | "providerThreads" | "providerTurns"
  >;

const boundary = { kind: "running-turn", runId } as const;

describe("which running turn a fork captures live text from", () => {
  it("captures the run's one accepted, live Codex turn", () => {
    const target = runningTurnCaptureTarget(records({}), boundary);
    assert.equal(target.type, "capture");
    if (target.type !== "capture") return;
    assert.equal(target.owner.providerTurnId, turnId);
    assert.equal(target.owner.nativeTurnId, "native-turn");
    assert.equal(target.owner.runOrdinal, 4);
  });

  it("forks saved history from a provider without native text buffering", () => {
    assert.deepEqual(runningTurnCaptureTarget(records({ driver: "claudeAgent" }), boundary), {
      type: "saved-history",
      reason: "not-codex",
    });
  });

  it("forks saved history before the native turn is accepted or after it ends", () => {
    for (const turns of [
      [turn({ nativeAcceptance: "offered" as OrchestrationV2ProviderTurn["nativeAcceptance"] })],
      [turn({ status: "completed" })],
      [],
    ])
      assert.deepEqual(runningTurnCaptureTarget(records({ turns }), boundary), {
        type: "saved-history",
        reason: "not-started",
      });
  });

  it("refuses to guess between turns or without a live session", () => {
    const second = turn({ id: ProviderTurnId.make("provider-turn:other") });
    for (const input of [
      records({ turns: [turn(), second] }),
      records({ providerSessionId: null }),
      records({ turns: [turn({ nativeTurnRef: null })] }),
    ])
      assert.equal(
        (runningTurnCaptureTarget(input, boundary) as { reason: string }).reason,
        "boundary-not-ready",
      );
  });

  it("follows the attempt's bound turn once the start receipt names it", () => {
    const second = turn({ id: ProviderTurnId.make("provider-turn:bound") });
    const target = runningTurnCaptureTarget(
      records({ turns: [turn(), second], attemptProviderTurnId: second.id }),
      boundary,
    );
    assert.equal(target.type === "capture" ? target.owner.providerTurnId : null, second.id);
  });
});
