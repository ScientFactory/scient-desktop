import {
  RunId,
  ProviderThreadId,
  ProviderDriverKind,
  ProviderInstanceId,
  MessageId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveActiveWorkStartedAt,
  createMessageAttachmentPreviewProjector,
  deriveTimelineEntriesFromVisibleTurnItems,
  isLatestRunSettled,
  selectComposerTasksPlan,
  workEntrySignalsSevereFailure,
} from "./session-logic";

import { makeThreadProjectionFixture } from "./test-fixtures";

const timestamp = DateTime.makeUnsafe("2026-09-04T12:00:00.000Z");
const base = {
  id: TurnItemId.make("native-item"),
  threadId: ThreadId.make("native-thread"),
  runId: RunId.make("native-run"),
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "completed" as const,
  title: null,
  startedAt: timestamp,
  completedAt: timestamp,
  updatedAt: timestamp,
};
const visible = (item: OrchestrationV2TurnItem): OrchestrationV2ProjectedTurnItem => ({
  position: 0,
  visibility: "local",
  sourceThreadId: item.threadId,
  sourceItemId: item.id,
  item,
});
const entriesFor = (...items: OrchestrationV2TurnItem[]) =>
  deriveTimelineEntriesFromVisibleTurnItems({
    visibleTurnItems: items.map((item, position) => ({ ...visible(item), position })),
    optimisticMessages: [],
  });

describe("Scient skill loads in the v2 work log", () => {
  it.each(["scient_skill_load", "mcp__scient__scient_skill_load"])(
    "labels a completed native skill load from its input: %s",
    (toolName) => {
      const item = {
        ...base,
        type: "dynamic_tool" as const,
        toolName,
        title: "Generic provider title",
        input: { name: "latex-authoring" },
        output: { content: "Skill instructions" },
      } satisfies OrchestrationV2TurnItem;
      expect(entriesFor(item)[0]).toMatchObject({
        kind: "work",
        entry: {
          label: "Used Latex Authoring",
          toolTitle: "Used Latex Authoring",
          toolLifecycleStatus: "completed",
          toolData: { input: item.input, output: item.output },
        },
      });
    },
  );

  // regression: 794ff29ed2 merge: complete orchestration v2 alignment with Scient main
  it.each([
    ["running", "Loading Latex Authoring"],
    ["pending", "Loading Latex Authoring"],
    ["waiting", "Loading Latex Authoring"],
    ["failed", "Couldn't load Latex Authoring"],
    ["cancelled", "Didn't load Latex Authoring"],
    ["interrupted", "Didn't load Latex Authoring"],
  ] as const)("reflects the durable skill load status: %s", (status, label) => {
    const item = {
      ...base,
      type: "dynamic_tool" as const,
      toolName: "scient_skill_load",
      status,
      input: { releaseKey: "scient.latex-authoring@immutable-release" },
    } satisfies OrchestrationV2TurnItem;
    const [entry] = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [visible(item)],
      optimisticMessages: [],
    });
    expect(entry).toMatchObject({ kind: "work", entry: { label, toolTitle: label } });
  });

  it.each(["mcp__foreign__scient_skill_load", "scient_skill_load_extra"])(
    "keeps a different tool's native label: %s",
    (toolName) => {
      const item = {
        ...base,
        type: "dynamic_tool" as const,
        toolName,
        input: { name: "latex-authoring" },
      } satisfies OrchestrationV2TurnItem;
      expect(entriesFor(item)[0]).toMatchObject({ kind: "work", entry: { label: toolName } });
    },
  );
});

describe("Scient work-log entries", () => {
  it("keeps context compaction as a normal work-log entry", () => {
    const entries = entriesFor({ ...base, type: "compaction" as const, driver: null });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "work", entry: { label: "Context compacted" } });
  });

  it("shows a concise, severe provider failure and leaves the technical detail inspectable", () => {
    const [failureEntry, noticeEntry] = entriesFor(
      {
        ...base,
        status: "failed" as const,
        type: "error" as const,
        failure: {
          class: "provider_error" as const,
          message: "technical detail",
          code: "turn_start_failed",
          retryable: false,
        },
      },
      {
        ...base,
        id: TurnItemId.make("native-notice"),
        type: "system_notice" as const,
        message: "Provider reported a warning",
      },
    );
    if (failureEntry?.kind !== "work" || noticeEntry?.kind !== "work") {
      throw new Error("Expected work entries");
    }

    expect(failureEntry.entry.detail).toBe("technical detail");
    expect(failureEntry.entry.label).not.toBe("technical detail");
    expect(workEntrySignalsSevereFailure(failureEntry.entry)).toBe(true);
    expect(workEntrySignalsSevereFailure(noticeEntry.entry)).toBe(false);
  });

  // regression: 5b6c34265c fix(fork): keep inherited readers and windows consistent
  it("reads a fork's shared MCP app through the fork that shows it", () => {
    const call = {
      ...base,
      id: TurnItemId.make("render"),
      threadId: ThreadId.make("render-thread"),
      type: "dynamic_tool" as const,
      toolName: "weather.get_weather",
      input: { title: "Chart", height: 420 },
      output: {
        t3McpApp: {
          attachmentId: "render-thread-app-html",
          server: "weather",
          tool: "get_weather",
          resourceUri: "ui://weather/dashboard",
        },
        result: { content: [] },
      },
    } satisfies OrchestrationV2TurnItem;
    const forkId = ThreadId.make("fork-showing-app");
    const entries = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [
        {
          position: 0,
          visibility: "inherited",
          sourceThreadId: call.threadId,
          sourceItemId: call.id,
          item: { ...call, threadId: forkId },
        },
      ],
      optimisticMessages: [],
    });
    expect(entries.find((entry) => entry.kind === "mcp-app")).toMatchObject({
      sourceThreadId: forkId,
      itemId: call.id,
    });
  });
});

// Rows that mutating isLatestRunSettled, deriveActiveWorkStartedAt and resolveThreadWorkingStartedAt
// showed no other test guards; the remaining branches fail upstream session-logic and Sidebar.logic tests.
describe("isLatestRunSettled", () => {
  const latestRun = {
    runId: RunId.make("run-1"),
    status: "completed",
    startedAt: "2026-02-27T21:10:00.000Z",
    completedAt: "2026-02-27T21:10:06.000Z",
  } as const;

  // regression: b8fbae4ffa merge(upstream): compose orchestration v2 through ca7df394ed
  it("returns true once the session is idle and no run is active", () => {
    expect(
      isLatestRunSettled(latestRun, {
        status: "idle",
        activeRunId: null,
      }),
    ).toBe(true);
  });

  // regression: b8fbae4ffa merge(upstream): compose orchestration v2 through ca7df394ed
  it("returns true once the runtime owns a different run than the latest settled one", () => {
    expect(
      isLatestRunSettled(latestRun, {
        status: "running",
        activeRunId: RunId.make("run-2"),
      }),
    ).toBe(true);
  });

  it("returns false while the same run is still active in a running session", () => {
    expect(
      isLatestRunSettled(latestRun, {
        status: "running",
        activeRunId: RunId.make("run-1"),
      }),
    ).toBe(false);
  });

  it("returns false when the latest run is still in flight by status", () => {
    expect(
      isLatestRunSettled(
        {
          runId: RunId.make("run-1"),
          status: "running",
          startedAt: "2026-02-27T21:10:00.000Z",
          completedAt: null,
        },
        null,
      ),
    ).toBe(false);
  });

  it("settles on run status alone, ignoring timestamp completeness", () => {
    expect(
      isLatestRunSettled(
        {
          runId: RunId.make("run-1"),
          status: "completed",
          startedAt: null,
          completedAt: "2026-02-27T21:10:06.000Z",
        },
        null,
      ),
    ).toBe(true);
  });

  it("returns false when there is no latest run at all", () => {
    expect(isLatestRunSettled(null, null)).toBe(false);
  });
});

describe("deriveActiveWorkStartedAt", () => {
  const completedRun = {
    runId: RunId.make("run-1"),
    status: "completed",
    requestedAt: "2026-02-27T21:09:00.000Z",
    startedAt: "2026-02-27T21:10:00.000Z",
    completedAt: "2026-02-27T21:10:06.000Z",
  } as const;

  // regression: b8fbae4ffa merge(upstream): compose orchestration v2 through ca7df394ed
  it("suppresses the local send clock once the runtime owns an active run", () => {
    expect(
      deriveActiveWorkStartedAt(
        completedRun,
        {
          status: "running",
          activeRunId: RunId.make("run-2"),
        },
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBeNull();
  });

  // regression: b8fbae4ffa merge(upstream): compose orchestration v2 through ca7df394ed
  it("prefers the runtime activity clock over any run timestamp", () => {
    expect(
      deriveActiveWorkStartedAt(
        completedRun,
        {
          status: "running",
          activeRunId: RunId.make("run-2"),
          activityStartedAt: "2026-02-27T21:12:00.000Z",
        },
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:12:00.000Z");
  });

  it("prefers the in-flight run start while the runtime still owns that run", () => {
    expect(
      deriveActiveWorkStartedAt(
        {
          runId: RunId.make("run-1"),
          status: "running",
          requestedAt: "2026-02-27T21:09:00.000Z",
          startedAt: "2026-02-27T21:10:00.000Z",
          completedAt: null,
        },
        {
          status: "running",
          activeRunId: RunId.make("run-1"),
        },
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:10:00.000Z");
  });

  it("falls back to the request time when an owned run never reported a start", () => {
    expect(
      deriveActiveWorkStartedAt(
        {
          runId: RunId.make("run-1"),
          status: "preparing",
          requestedAt: "2026-02-27T21:09:00.000Z",
          startedAt: null,
          completedAt: null,
        },
        {
          status: "preparing",
          activeRunId: RunId.make("run-1"),
        },
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:09:00.000Z");
  });

  it("uses sendStartedAt once no run is active", () => {
    expect(
      deriveActiveWorkStartedAt(
        completedRun,
        {
          status: "idle",
          activeRunId: null,
        },
        "2026-02-27T21:11:00.000Z",
      ),
    ).toBe("2026-02-27T21:11:00.000Z");
  });

  it("uses sendStartedAt for a fresh send when the thread has no run history", () => {
    expect(deriveActiveWorkStartedAt(null, null, "2026-02-27T21:11:00.000Z")).toBe(
      "2026-02-27T21:11:00.000Z",
    );
  });
});

describe("message attachment previews", () => {
  const streamingMessage = {
    id: MessageId.make("streaming-message"),
    role: "assistant" as const,
    text: "",
    runId: RunId.make("streaming-run"),
    createdAt: "2026-02-23T00:00:03.000Z",
    updatedAt: "2026-02-23T00:00:03.000Z",
    streaming: true,
  };

  // regression: 19c1710a88 perf(web): reuse timeline rows while text streams (#9725)
  it("reuses preview objects while preserving URL and attachment metadata changes", () => {
    const image = {
      type: "image" as const,
      id: "image",
      name: "image.png",
      mimeType: "image/png",
      sizeBytes: 42,
    };
    const file = {
      type: "file" as const,
      id: "file",
      name: "file.txt",
      mimeType: "text/plain",
      sizeBytes: 8,
    };
    const message = { ...streamingMessage, attachments: Object.freeze([image, file]) };
    const project = createMessageAttachmentPreviewProjector();
    const urls = new Map([[image.id, "https://first.test/image"]]);
    const first = project(message, (attachment) => urls.get(attachment.id));
    Object.freeze(first.attachments);
    expect(project(message, (attachment) => new Map(urls).get(attachment.id))).toBe(first);
    const streamed = project({ ...message, text: "Next" }, (attachment) => urls.get(attachment.id));
    expect(streamed.attachments).toBe(first.attachments);
    expect(streamed.text).toBe("Next");
    expect(first.text).toBe("");
    expect(first.attachments?.[1]).toBe(file);

    urls.set(image.id, "https://second.test/image");
    const renewed = project(message, (attachment) => urls.get(attachment.id));
    expect(renewed.attachments?.[0]).toMatchObject({ previewUrl: "https://second.test/image" });
    expect(first.attachments?.[0]).toMatchObject({ previewUrl: "https://first.test/image" });
    const renamed = project(
      { ...message, attachments: [{ ...image, name: "renamed.png" }, file] },
      (attachment) => urls.get(attachment.id),
    );
    expect(renamed.attachments?.[0]).toMatchObject({
      name: "renamed.png",
      previewUrl: "https://second.test/image",
    });
    expect(project(message, () => undefined)).toBe(message);
  });

  // regression: 19c1710a88 perf(web): reuse timeline rows while text streams (#9725)
  it("keeps pending preview handoffs stable and restores the current server URL", () => {
    const message = {
      ...streamingMessage,
      role: "user" as const,
      streaming: false,
      attachments: [
        {
          type: "image" as const,
          id: "image",
          name: "image.png",
          mimeType: "image/png",
          sizeBytes: 42,
        },
      ],
    };
    const server = createMessageAttachmentPreviewProjector();
    const handoff = createMessageAttachmentPreviewProjector();
    const first = handoff(
      server(message, () => undefined),
      () => "blob:handoff",
    );
    expect(
      handoff(
        server(message, () => undefined),
        () => "blob:handoff",
      ),
    ).toBe(first);
    const ready = server(message, () => "https://server.test/image");
    expect(handoff(ready, () => "blob:handoff").attachments?.[0]).toMatchObject({
      previewUrl: "blob:handoff",
    });
    expect(handoff(ready, () => undefined)).toBe(ready);
    expect(ready.attachments?.[0]).toMatchObject({ previewUrl: "https://server.test/image" });
    expect(first.attachments?.[0]).toMatchObject({ previewUrl: "blob:handoff" });
  });
});

describe("OMP composer tasks", () => {
  it.each(["omp", "scient"])(
    "retains unfinished %s tasks after settlement and into the next run",
    (driver) => {
      const projection = makeThreadProjectionFixture();
      const providerThreadId = ProviderThreadId.make("omp-session");
      const firstRun = {
        id: RunId.make("first-run"),
        threadId: projection.thread.id,
        ordinal: 1,
        providerInstanceId: projection.thread.providerInstanceId,
        modelSelection: projection.thread.modelSelection,
        providerThreadId,
        userMessageId: MessageId.make("first-message"),
        rootNodeId: null,
        activeAttemptId: null,
        status: "completed" as const,
        requestedAt: timestamp,
        startedAt: timestamp,
        completedAt: timestamp,
        checkpointId: null,
        contextHandoffId: null,
      };
      const settled = {
        ...projection,
        runs: [firstRun],
        providerThreads: [
          {
            id: providerThreadId,
            driver: ProviderDriverKind.make(driver),
            providerInstanceId: ProviderInstanceId.make(driver),
            providerSessionId: null,
            appThreadId: projection.thread.id,
            ownerNodeId: null,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "idle" as const,
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ],
      };
      const plan = {
        createdAt: DateTime.formatIso(timestamp),
        runId: firstRun.id,
        steps: [{ step: "Restored task", status: "pending" as const }],
      };
      expect(selectComposerTasksPlan(settled, plan, firstRun.id, true)).toBe(plan);
      const nextRun = {
        ...firstRun,
        id: RunId.make("next-run"),
        ordinal: 2,
        status: "running" as const,
        completedAt: null,
      };
      const later = { ...settled, runs: [firstRun, nextRun] };
      expect(selectComposerTasksPlan(later, plan, nextRun.id, false)).toBe(plan);
      expect(
        selectComposerTasksPlan(
          later,
          { ...plan, steps: [{ step: "Done", status: "completed" }] },
          nextRun.id,
          false,
        ),
      ).toBeNull();
      expect(
        selectComposerTasksPlan(
          {
            ...later,
            runs: [
              firstRun,
              { ...nextRun, providerThreadId: ProviderThreadId.make("another-session") },
            ],
          },
          plan,
          nextRun.id,
          false,
        ),
      ).toBeNull();
    },
  );
});
