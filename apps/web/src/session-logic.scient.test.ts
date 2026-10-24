import {
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveActiveWorkStartedAt,
  deriveTimelineEntriesFromVisibleTurnItems,
  isLatestRunSettled,
  workEntrySignalsSevereFailure,
} from "./session-logic";

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

  it.each([
    ["running", "Loading Latex Authoring"],
    ["failed", "Couldn't load Latex Authoring"],
    ["cancelled", "Didn't load Latex Authoring"],
  ] as const)("reflects the durable skill load status: %s", (status, label) => {
    const item = {
      ...base,
      type: "dynamic_tool" as const,
      toolName: "scient_skill_load",
      status,
      input: { releaseKey: "scient.latex-authoring@immutable-release" },
    } satisfies OrchestrationV2TurnItem;
    expect(entriesFor(item)[0]).toMatchObject({ kind: "work", entry: { label, toolTitle: label } });
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
