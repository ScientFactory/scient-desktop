import {
  ProviderInstanceId,
  RunId,
  OrchestrationV2ContextTransfer,
  OrchestrationV2TurnItem,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  isForkInitializationHandoff,
  resolveHandoffEndpoints,
  type HandoffTimelineRun,
} from "./handoff.ts";

const from = ProviderInstanceId.make("codex_personal");
const to = ProviderInstanceId.make("claudeAgent");
const item = {
  runId: RunId.make("target"),
  fromProviderInstanceIds: [from],
  toProviderInstanceId: to,
};
const run = (
  id: string,
  ordinal: number,
  instanceId: ProviderInstanceId,
  model: string,
): HandoffTimelineRun => ({
  id: RunId.make(id),
  ordinal,
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model },
});

describe("handoff endpoints shared by web and mobile", () => {
  it("preserves stamped models including several models from the same provider", () => {
    const fromModelSelections = [
      { instanceId: from, model: "source-a" },
      { instanceId: from, model: "source-b" },
    ];
    expect(
      resolveHandoffEndpoints({ ...item, fromModelSelections, toModel: "destination" }, [
        run("target", 2, to, "later-model"),
      ]),
    ).toEqual({
      from: fromModelSelections,
      to: { instanceId: to, model: "destination" },
    });
  });

  it("recovers legacy models from the handoff run and latest earlier source run", () => {
    const runs = [
      run("later", 4, from, "wrong-later-model"),
      run("old", 1, from, "old-model"),
      run("target", 3, to, "destination"),
      run("source", 2, from, "source-model"),
    ];
    expect(resolveHandoffEndpoints(item, runs)).toEqual({
      from: [{ instanceId: from, model: "source-model" }],
      to: { instanceId: to, model: "destination" },
    });
  });

  it("retains provider identities when historical runs are not loaded", () => {
    expect(resolveHandoffEndpoints(item, [])).toEqual({
      from: [{ instanceId: from, model: undefined }],
      to: { instanceId: to, model: undefined },
    });
  });

  it("does not borrow a target model from another provider", () => {
    expect(
      resolveHandoffEndpoints(item, [run("target", 2, from, "wrong-model")]).to.model,
    ).toBeUndefined();
  });
});

const decodeTransfer = Schema.decodeUnknownSync(OrchestrationV2ContextTransfer);
const decodeItem = Schema.decodeUnknownSync(OrchestrationV2TurnItem);
const now = DateTime.makeUnsafe("2026-10-04T00:00:00Z");
const initialization = decodeItem({
  id: "fork-init-handoff",
  threadId: "child",
  runId: "first-child-run",
  nodeId: "root",
  providerThreadId: "destination-provider-thread",
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 3,
  status: "completed",
  title: "Unrelated translated copy",
  startedAt: now,
  completedAt: now,
  updatedAt: now,
  type: "handoff",
  contextHandoffId: "fork-init-context",
  fromProviderThreadIds: [],
  toProviderThreadId: "destination-provider-thread",
  fromProviderInstanceIds: [],
  toProviderInstanceId: "codex",
  strategy: "full_thread_summary",
});
const transfer = decodeTransfer({
  id: "fork-transfer",
  type: "fork",
  sourceThreadId: "source",
  targetThreadId: "child",
  sourcePoint: { threadId: "source" },
  basePoint: null,
  sourceProviderInstanceId: "codex",
  targetProviderInstanceId: "codex",
  targetRunId: "first-child-run",
  status: "consumed",
  resolution: { strategy: "portable_context", contextHandoffId: "fork-init-context" },
  createdBy: "user",
  error: null,
  createdAt: now,
  updatedAt: now,
  consumedAt: now,
});
const localRow = {
  item: initialization,
  visibility: "local" as const,
  position: 3,
  sourceThreadId: ThreadId.make("child"),
  sourceItemId: initialization.id,
};

describe("fork initialization presentation", () => {
  it("uses exact durable fork ownership regardless of title or provider equality", () => {
    expect(isForkInitializationHandoff(localRow, [transfer])).toBe(true);
    expect(
      isForkInitializationHandoff(localRow, [{ ...transfer, sourceProviderInstanceId: to }]),
    ).toBe(true);
  });
  it("keeps missing metadata, inherited facts and unrelated transfers visible", () => {
    expect(isForkInitializationHandoff(localRow, undefined)).toBe(false);
    expect(isForkInitializationHandoff(localRow, [])).toBe(false);
    expect(isForkInitializationHandoff({ ...localRow, visibility: "inherited" }, [transfer])).toBe(
      false,
    );
    for (const altered of [
      { ...transfer, type: "provider_handoff" as const },
      { ...transfer, type: "merge_back" as const },
      { ...transfer, targetThreadId: ThreadId.make("foreign") },
      { ...transfer, targetRunId: RunId.make("later-run") },
      { ...transfer, targetRunId: null },
      {
        ...transfer,
        resolution: {
          strategy: "portable_context" as const,
          contextHandoffId:
            initialization.type === "handoff"
              ? initialization.contextHandoffId + "foreign"
              : "foreign",
        },
      },
      { ...transfer, resolution: null },
    ]) {
      const candidate = decodeTransfer(altered);
      expect(isForkInitializationHandoff(localRow, [candidate])).toBe(false);
    }
  });
});
