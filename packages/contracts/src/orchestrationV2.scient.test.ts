import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { ProviderCitationPresentation } from "./providerCitationPresentation.ts";
import { describe, expect, it } from "@effect/vitest";
import {
  NodeId,
  NonNegativeInt,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderSessionId,
  RunId,
  ThreadId,
  TurnItemId,
} from "./index.ts";
import {
  OrchestrationV2Command,
  OrchestrationV2DroidHeldSteer,
  OrchestrationV2Notification,
  OrchestrationV2ProviderTurn,
  OrchestrationV2ProviderTurnJson,
  OrchestrationV2TurnItem,
  OrchestrationV2TurnItemJson,
} from "./orchestrationV2.ts";

const isCitationPresentation = Schema.is(ProviderCitationPresentation);
const decodeCitationPresentation = Schema.decodeUnknownOption(ProviderCitationPresentation);
const now = DateTime.makeUnsafe("2026-04-20T00:00:00.000Z");
const oldNotice = Schema.Struct({
  type: Schema.Literal("system_notice"),
  id: TurnItemId,
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  nodeId: Schema.NullOr(NodeId),
  providerThreadId: Schema.NullOr(ProviderThreadId),
  providerTurnId: Schema.Null,
  nativeItemRef: Schema.Null,
  parentItemId: Schema.NullOr(TurnItemId),
  ordinal: NonNegativeInt,
  status: Schema.Literal("completed"),
  title: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  completedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
  updatedAt: Schema.DateTimeUtcFromString,
  message: Schema.String,
});
const decodeOldForkSnapshot = Schema.decodeUnknownSync(
  Schema.Struct({ turnItems: Schema.Array(oldNotice) }),
);
const forkTypeJsonCodec = Schema.toCodecJson(OrchestrationV2TurnItem);
const encodeForkTypeJson = Schema.encodeSync(forkTypeJsonCodec);
const decodeForkTypeJson = Schema.decodeUnknownSync(forkTypeJsonCodec);
const encodeUnknownForkTypeJson = Schema.encodeUnknownSync(forkTypeJsonCodec);
const encodeUnknownForkJson = Schema.encodeUnknownSync(OrchestrationV2TurnItemJson);
const decodeOrchestrationV2Command = Schema.decodeUnknownSync(OrchestrationV2Command);
const isOrchestrationV2Command = Schema.is(OrchestrationV2Command);
const decodeOrchestrationV2TurnItem = Schema.decodeUnknownSync(OrchestrationV2TurnItem);
const decodeOrchestrationV2TurnItemJson = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);
const encodeOrchestrationV2TurnItemJson = Schema.encodeSync(OrchestrationV2TurnItemJson);
const providerTurnCodec = Schema.toCodecJson(OrchestrationV2ProviderTurn);
const decodeEffortTurn = Schema.decodeUnknownSync(providerTurnCodec);
const encodeEffortTurn = Schema.encodeSync(providerTurnCodec);
const decodeEffortTurnJson = Schema.decodeUnknownSync(OrchestrationV2ProviderTurnJson);
const oldEffortTurn = {
  id: "observed-effort-turn",
  providerThreadId: "observed-effort-thread",
  nodeId: "observed-effort-root",
  runAttemptId: null,
  nativeTurnRef: null,
  ordinal: 1,
  status: "completed",
  startedAt: null,
  completedAt: null,
};
const decodeDroidHeldSteer = Schema.decodeUnknownSync(OrchestrationV2DroidHeldSteer);
const droidHeldSteerJson = Schema.fromJsonString(OrchestrationV2DroidHeldSteer);
const encodeDroidHeldSteerJson = Schema.encodeSync(droidHeldSteerJson);
const decodeDroidHeldSteerJson = Schema.decodeSync(droidHeldSteerJson);

describe("first-admission metadata compatibility", () => {
  it.each([undefined, false, true])("round trips optional admission provenance %s", (admitted) => {
    const item = decodeOrchestrationV2TurnItem({
      id: "admission-item",
      threadId: "admission-thread",
      type: "user_message",
      messageId: "admission-message",
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "completed",
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      createdBy: "user",
      creationSource: "web",
      inputIntent: "steer",
      ...(admitted === undefined ? {} : { inputAlreadyAdmitted: admitted }),
      text: "synthetic",
      attachments: [],
    });
    for (const encoded of [encodeOrchestrationV2TurnItemJson(item), encodeForkTypeJson(item)]) {
      expect(decodeOrchestrationV2TurnItemJson(encoded)).toEqual(item);
      expect(decodeForkTypeJson(encoded)).toEqual(item);
      expect(encoded).toMatchObject(
        admitted === undefined ? {} : { inputAlreadyAdmitted: admitted },
      );
    }
  });
});

describe("portable message fork boundary compatibility", () => {
  it.each(
    (["before", "after"] as const).map((position) => ({
      caseTitle: `preserves the ${position} message boundary through Type, JSON and old notice codecs`,
      position,
    })),
  )("$caseTitle", ({ position }) => {
    const item = decodeOrchestrationV2TurnItem({
      id: "portable-fork-boundary",
      threadId: "portable-child",
      type: "fork",
      runId: null,
      nodeId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 3,
      status: "completed",
      title: "Conversation forked here",
      startedAt: null,
      completedAt: now,
      updatedAt: now,
      source: {
        type: "message",
        threadId: "portable-source",
        messageId: "historical-message",
        position,
      },
      targetThreadId: "portable-child",
    });
    for (const encoded of [encodeOrchestrationV2TurnItemJson(item), encodeForkTypeJson(item)]) {
      expect(decodeOldForkSnapshot({ turnItems: [encoded] }).turnItems[0]).toMatchObject({
        type: "system_notice",
        message: "Conversation forked here",
        runId: null,
        nodeId: null,
      });
      const decoded = decodeOrchestrationV2TurnItemJson(encoded);
      expect(decoded).toEqual(item);
      expect(encodeOrchestrationV2TurnItemJson(decoded)).toEqual(encoded);
      expect(decodeForkTypeJson(encoded)).toEqual(item);
    }
  });
  it("rejects message boundaries carrying execution authority in Type and JSON", () => {
    const item = {
      id: "portable-fork-boundary",
      threadId: "portable-child",
      type: "fork",
      runId: null,
      nodeId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 3,
      status: "completed",
      title: null,
      startedAt: null,
      completedAt: null,
      updatedAt: now,
      source: { type: "message", threadId: "source", messageId: "answer", position: "after" },
      targetThreadId: "portable-child",
    };
    for (const ownership of [
      { runId: "live-run" },
      { nodeId: "live-node" },
      { providerThreadId: "live-provider-thread" },
      { providerThreadId: null },
      { providerTurnId: "live-provider-turn" },
      { nativeItemRef: { driver: "codex", nativeId: "live-native-item", strength: "strong" } },
    ]) {
      expect(() => decodeOrchestrationV2TurnItem({ ...item, ...ownership })).toThrow();
      expect(() => encodeUnknownForkTypeJson({ ...item, ...ownership })).toThrow();
      expect(() => encodeUnknownForkJson({ ...item, ...ownership })).toThrow();
      expect(() =>
        decodeOrchestrationV2TurnItemJson({
          ...item,
          updatedAt: DateTime.formatIso(now),
          ...ownership,
        }),
      ).toThrow();
    }
  });
  it("keeps ordinary and malformed marker notices inert", () => {
    const notice = {
      id: "malformed-fork-notice",
      threadId: "portable-child",
      type: "system_notice",
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      title: null,
      startedAt: null,
      completedAt: null,
      updatedAt: "2026-04-20T00:00:00.000Z",
      message: "Ordinary notice",
    };
    for (const extra of [
      {},
      {
        forkBoundary: {
          source: { type: "message", threadId: "source" },
          targetThreadId: "portable-child",
        },
      },
      {
        runId: "active-run",
        forkBoundary: {
          source: { type: "message", threadId: "source", messageId: "message", position: "after" },
          targetThreadId: "portable-child",
        },
      },
    ]) {
      expect(decodeOrchestrationV2TurnItemJson({ ...notice, ...extra }).type).toBe("system_notice");
    }
  });
});

it("preserves provider-initiated work identity without admitting an internal command from a client", () => {
  const notification = {
    source: {
      kind: "provider_work",
      workId: "extension-work-1",
      providerThreadId: ProviderThreadId.make("native-thread:work"),
      providerSessionId: ProviderSessionId.make("session:work"),
      modelSelection: { instanceId: ProviderInstanceId.make("pi"), model: "fixture-model" },
      runtimePolicy: {
        runtimeMode: "approval-required",
        interactionMode: "plan",
        cwd: "/synthetic/project",
      },
    },
    outcome: "updated",
    summary: "Provider started work",
  } as const;
  const codec = Schema.fromJsonString(OrchestrationV2Notification);
  const encoded = Schema.encodeSync(codec)(notification);
  expect(Schema.decodeSync(codec)(encoded)).toEqual(notification);
  expect(
    isOrchestrationV2Command({
      type: "provider-work.admit",
      commandId: "command:work",
      messageId: "message:work",
      threadId: "thread:work",
      providerThreadId: "native-thread:work",
      providerSessionId: "session:work",
      providerInstanceId: "pi",
      driver: "pi",
      workId: "extension-work-1",
      modelSelection: notification.source.modelSelection,
      runtimePolicy: notification.source.runtimePolicy,
      detail: "Provider started work",
    }),
  ).toBe(false);
});

describe("inert fork initialization handoff provenance", () => {
  const handoff = {
    id: "copied-handoff",
    threadId: "grand",
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: "Translated copy",
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    inheritedFrom: {
      threadId: "child",
      itemId: "original-handoff",
      runId: "child-run",
      status: "completed",
    },
    type: "handoff",
    contextHandoffId: "initialization-context",
    fromProviderThreadIds: [],
    toProviderThreadId: "historical-provider",
    fromProviderInstanceIds: [],
    toProviderInstanceId: "omp",
    strategy: "full_thread_summary",
  };
  const proof = {
    transferId: "fork-transfer",
    contextHandoffId: "initialization-context",
    threadId: "child",
    runId: "child-run",
  };
  it("preserves causal IDs in Type and JSON codecs without restoring live ownership", () => {
    const item = decodeOrchestrationV2TurnItem({
      ...handoff,
      forkInitialization: proof,
    });
    expect(decodeForkTypeJson(encodeForkTypeJson(item))).toEqual(item);
    const json = encodeOrchestrationV2TurnItemJson(item);
    expect(decodeOrchestrationV2TurnItemJson(json)).toEqual(item);
    expect(item.runId).toBeNull();
    expect(item.nativeItemRef).toBeNull();
    expect(json).toHaveProperty("forkInitialization", proof);
  });
  it("keeps older optional-absent handoffs readable", () => {
    const item = decodeOrchestrationV2TurnItem(handoff);
    expect(decodeForkTypeJson(encodeForkTypeJson(item))).toEqual(item);
    expect(item).not.toHaveProperty("forkInitialization");
  });
  it("rejects an incomplete causal proof instead of silently accepting it", () => {
    expect(() =>
      decodeOrchestrationV2TurnItem({
        ...handoff,
        forkInitialization: { transferId: "fork-transfer", threadId: "child", runId: "child-run" },
      }),
    ).toThrow();
    const json = {
      ...handoff,
      startedAt: DateTime.formatIso(now),
      completedAt: DateTime.formatIso(now),
      updatedAt: DateTime.formatIso(now),
    };
    expect(() =>
      decodeOrchestrationV2TurnItemJson({
        ...json,
        forkInitialization: { ...proof, runId: null },
      }),
    ).toThrow();
  });
});

describe("inert citation presentation bounds", () => {
  const valid = {
    format: "codex-private-v1",
    sources: [{ id: "s", url: "https://example.test", title: "Study" }],
  };
  it("accepts an empty recognized scope and rejects oversized or untrusted fields", () => {
    expect(isCitationPresentation(valid)).toBe(true);
    expect(isCitationPresentation({ format: "codex-private-v1", sources: [] })).toBe(true);
    for (const value of [
      { ...valid, sources: Array.from({ length: 129 }, () => valid.sources[0]) },
      { ...valid, sources: [{ ...valid.sources[0], id: "x".repeat(257) }] },
      { ...valid, sources: [{ ...valid.sources[0], url: "x".repeat(32769) }] },
      { ...valid, sources: [{ ...valid.sources[0], title: "x".repeat(1025) }] },
      { ...valid, format: "arbitrary-provider" },
      { ...valid, sources: [{ id: "s", url: { toString: () => "https://example.test" } }] },
    ])
      expect(decodeCitationPresentation(value)._tag).toBe("None");
  });
});

describe("optional observed native root effort", () => {
  it("keeps transport undefined distinct from a typed JSON clear", () => {
    expect(
      decodeEffortTurn({ ...oldEffortTurn, observedEffort: null }).observedEffort,
    ).toBeUndefined();
    expect(() => decodeEffortTurnJson({ ...oldEffortTurn, observedEffort: null })).toThrow();
  });
  it("retains old absent Type/JSON records without inventing an effort or acceptance", () => {
    const decoded = decodeEffortTurn(oldEffortTurn);
    expect(decoded).not.toHaveProperty("observedEffort");
    expect(decoded).not.toHaveProperty("nativeAcceptance");
    expect(decodeEffortTurnJson(encodeEffortTurn(decoded))).toEqual(oldEffortTurn);
  });
  it.each(
    ["off", "high"].map((observedEffort) => ({
      caseTitle: `round-trips explicit ${observedEffort} without changing execution ownership`,
      observedEffort,
    })),
  )("$caseTitle", ({ observedEffort }) => {
    const decoded = decodeEffortTurn({ ...oldEffortTurn, observedEffort });
    expect(decodeEffortTurnJson(encodeEffortTurn(decoded))).toEqual({
      ...oldEffortTurn,
      observedEffort,
    });
    expect(decoded.nodeId).toBe(oldEffortTurn.nodeId);
    expect(decoded.runAttemptId).toBeNull();
  });
  it.each(
    ["", " ", "x".repeat(65)].map((observedEffort) => ({
      caseTitle: `rejects invalid observed display metadata ${String(observedEffort).slice(0, 12)}`,
      observedEffort,
    })),
  )("$caseTitle", ({ observedEffort }) => {
    expect(() => decodeEffortTurn({ ...oldEffortTurn, observedEffort })).toThrow();
    expect(() => decodeEffortTurnJson({ ...oldEffortTurn, observedEffort })).toThrow();
  });
});

describe("Droid held admission contract", () => {
  it("round-trips captured intent without native readiness authority and keeps its command server-only", () => {
    const held = decodeDroidHeldSteer({
      revision: "revision",
      messageId: "message",
      sourceAttemptId: "attempt",
      sourceRootNodeId: "root",
      sourceProviderTurnId: "turn",
      sourceProviderSessionId: "session",
      modelSelection: { instanceId: "droid", model: "model", options: [] },
      runtimePolicy: {
        cwd: "/captured",
        runtimeMode: "full-access",
        interactionMode: "plan",
        reasoningEffort: "high",
      },
      phase: "pre_admission",
      admissionLease: "descriptive-lease",
    });
    const encoded = encodeDroidHeldSteerJson(held);
    expect(decodeDroidHeldSteerJson(encoded)).toEqual(held);
    expect(() =>
      decodeOrchestrationV2Command({
        type: "droid-steer.admission",
        commandId: "claim",
        threadId: "thread",
        runId: "run",
        revision: "revision",
        operation: "complete",
        lease: "descriptive-lease",
      }),
    ).toThrow();
  });
});
