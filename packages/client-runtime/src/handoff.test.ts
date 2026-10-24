import {
  ContextHandoffId,
  ProviderInstanceId,
  RunId,
  OrchestrationV2ContextTransfer,
  OrchestrationV2TurnItem,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  isForkInitializationHandoff,
  resolveHandoffEndpoints,
  resolvePendingHandoff,
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

describe("frozen fork initialization provenance", () => {
  const proof = {
    transferId: transfer.id,
    contextHandoffId: "fork-init-context",
    threadId: "child",
    runId: "first-child-run",
  };
  const frozen = (forkInitialization: unknown = proof) =>
    decodeItem({
      ...initialization,
      threadId: "grand",
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      inheritedFrom: {
        threadId: "child",
        itemId: initialization.id,
        runId: "first-child-run",
        status: "completed",
      },
      forkInitialization,
    });
  it("hides the proven initialization after repeated copies without ancestor transfers", () => {
    for (const threadId of ["grand", "great"]) {
      const item = decodeItem({ ...frozen(), threadId });
      expect(isForkInitializationHandoff({ ...localRow, item, visibility: "inherited" }, [])).toBe(
        true,
      );
      expect(item.runId).toBeNull();
      expect(item.nodeId).toBeNull();
      expect(item.nativeItemRef).toBeNull();
    }
  });
  it("keeps foreign handoff, thread and run proof visible", () => {
    for (const altered of [
      { ...proof, contextHandoffId: "foreign-context" },
      { ...proof, threadId: "foreign-thread" },
      { ...proof, runId: "foreign-run" },
    ])
      expect(isForkInitializationHandoff({ ...localRow, item: frozen(altered) }, [transfer])).toBe(
        false,
      );
  });
  it("keeps synthetic rows visible even when they carry copied proof", () => {
    expect(
      isForkInitializationHandoff({ ...localRow, item: frozen(), visibility: "synthetic" }, [
        transfer,
      ]),
    ).toBe(false);
  });
  it("does not guess the cause of already-copied history", () => {
    const item = decodeItem({ ...frozen(), forkInitialization: undefined });
    expect(isForkInitializationHandoff({ ...localRow, item }, [transfer])).toBe(false);
  });
});

const projection = {
  runs: [
    {
      ...run("source", 1, from, "source"),
      status: "completed",
      contextHandoffId: null,
      startedAt: "2026-10-11T00:00:00Z",
    },
  ],
  visibleTurnItems: [{ item: { type: "user_message" } }],
} as unknown as OrchestrationV2ThreadProjection;

describe("pending context handoff", () => {
  it.each([from, to])("removes the preview while the handoff to %s starts", (instanceId) => {
    const selection = { instanceId, model: "destination" };
    const providers = [
      { instanceId: from, requiresNewThreadForModelChange: true },
    ] as unknown as ServerProvider[];
    const starting = {
      ...projection,
      runs: [
        ...projection.runs,
        {
          ...projection.runs[0]!,
          ...run("target", 2, instanceId, "destination"),
          status: "starting" as const,
          startedAt: null,
          contextHandoffId: ContextHandoffId.make("handoff"),
        },
      ],
    };

    expect(resolvePendingHandoff(projection, selection, providers)).not.toBeNull();
    expect(resolvePendingHandoff(starting, selection, providers)).toBeNull();
    expect(
      resolvePendingHandoff(starting, { instanceId: from, model: "source" }, providers),
    ).toEqual({
      from: [selection],
      to: { instanceId: from, model: "source" },
    });
  });

  it.each(["preparing", "queued", "failed", "cancelled", "rolled_back"] as const)(
    "keeps the preview when an unstarted handoff run is %s",
    (status) => {
      const selection = { instanceId: to, model: "destination" };
      const unstarted = {
        ...projection,
        runs: [
          ...projection.runs,
          {
            ...projection.runs[0]!,
            ...run("target", 2, to, "destination"),
            status,
            startedAt: null,
            contextHandoffId: ContextHandoffId.make("handoff"),
          },
        ],
      };

      expect(resolvePendingHandoff(unstarted, selection, [])).toEqual({
        from: [{ instanceId: from, model: "source" }],
        to: selection,
      });
    },
  );

  it("appears on selection, updates the destination, and disappears on returning", () => {
    expect(resolvePendingHandoff(projection, { instanceId: to, model: "first" }, [])).toEqual({
      from: [{ instanceId: from, model: "source" }],
      to: { instanceId: to, model: "first" },
    });
    expect(
      resolvePendingHandoff(projection, { instanceId: to, model: "second" }, [])?.to.model,
    ).toBe("second");
    expect(resolvePendingHandoff(projection, { instanceId: from, model: "source" }, [])).toBeNull();
    expect(resolvePendingHandoff(projection, { instanceId: from, model: "other" }, [])).toBeNull();
  });
  it("stays hidden while the thread's timeline is empty", () => {
    const empty = { ...projection, visibleTurnItems: [] };
    expect(resolvePendingHandoff(empty, { instanceId: to, model: "first" }, [])).toBeNull();
    // Paging can leave a window of only tool rows after the prompt.
    const toolRowsOnly = {
      ...projection,
      visibleTurnItems: [{ item: { type: "command_execution" } }],
    } as unknown as OrchestrationV2ThreadProjection;
    expect(
      resolvePendingHandoff(toolRowsOnly, { instanceId: to, model: "first" }, [])?.to.model,
    ).toBe("first");
  });
  it("only previews a same-provider model change when it needs a fresh native thread", () => {
    const providers = [
      { instanceId: from, requiresNewThreadForModelChange: true },
    ] as unknown as ServerProvider[];
    expect(
      resolvePendingHandoff(projection, { instanceId: from, model: "other" }, providers)?.to.model,
    ).toBe("other");
  });
  it("resumes compatible account overlays without showing a handoff", () => {
    const providers = [from, to].map((instanceId) => ({
      instanceId,
      driver: "codex",
      continuation: { groupKey: "shared" },
    })) as unknown as ServerProvider[];
    expect(
      resolvePendingHandoff(projection, { instanceId: to, model: "target" }, providers),
    ).toBeNull();
  });
});
