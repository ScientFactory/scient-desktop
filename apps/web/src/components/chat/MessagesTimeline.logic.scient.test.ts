// Scient timeline row derivation: fork markers, worktree setup, Scient tools, imported history,
// reading direction and the minimap. Upstream's own cases stay in MessagesTimeline.logic.test.ts.
import { resolveT3McpToolPresentation as resolveTimelineToolPresentation } from "@t3tools/shared/t3McpToolPresentation";
import {
  MessageId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  OrchestrationV2TurnItem,
  OrchestrationV2TurnItemJson,
  type WorktreeSetupSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { deriveTimelineEntriesFromVisibleTurnItems, type TimelineEntry } from "../../session-logic";
import { makeStreamingTimelineFixture } from "../../test-fixtures";
import {
  deriveMessagesTimelineRows,
  liveWorkEntryLabel,
  workEntryDisplayLabel,
  workEntryPathPresentation,
  workEntryReadOutput,
} from "./MessagesTimeline.logic";

const decodeBoundaryItem = Schema.decodeUnknownSync(OrchestrationV2TurnItem);
const decodeJsonBoundaryItem = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);
const encodeJsonBoundaryItem = Schema.encodeSync(OrchestrationV2TurnItemJson);

describe("work entry labels", () => {
  it("keeps context compaction visible outside folded work", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "compaction-entry",
          kind: "work",
          createdAt: "2026-01-01T00:00:00Z",
          entry: {
            id: "compaction",
            createdAt: "2026-01-01T00:00:00Z",
            label: "Compacted context 899K → 19K tokens",
            tone: "info",
            sourceActivityKind: "context-compaction",
          },
        },
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    expect(rows).toEqual([
      {
        kind: "context-compaction",
        id: "compaction-entry",
        createdAt: "2026-01-01T00:00:00Z",
        label: "Compacted context 899K → 19K tokens",
        tokenCounts: null,
        active: false,
      },
    ]);
  });
  const entry = {
    id: "tool-1",
    createdAt: "2026-09-01T12:00:00Z",
    label: "Tool call",
    tone: "tool" as const,
  };
  // Path shortening itself is covered in scient/presentation/compactPathLabel.test.ts.
  it.each([["apps/server/build.ts", "server/build.ts", "/work/project/apps/server/build.ts"]])(
    "shortens live and settled reads while retaining %s for hover and inspection",
    (filePath, label, fullPath) => {
      const read = {
        ...entry,
        itemType: "dynamic_tool" as const,
        toolTitle: "Read",
        label: "Read",
        detail: "file body with /unrelated/path.ts",
        toolData: {
          input: {
            file_path: filePath,
          },
        },
      };
      expect(workEntryDisplayLabel(read, "/work/project")).toBe(`Read ${label}`);
      expect(liveWorkEntryLabel(read, "/work/project", true)).toBe(`Read ${label}`);
      expect(workEntryReadOutput(read, "/work/project")).toBe(fullPath);
      expect(workEntryPathPresentation(read, "/work/project")).toMatchObject({
        label,
        fullPath,
        prefix: "Read ",
        suffix: "",
      });
    },
  );
  it("keeps the additional-file count beside the first shortened read path", () => {
    const read = {
      ...entry,
      toolTitle: "Read",
      itemType: "dynamic_tool" as const,
      changedFiles: ["/work/project/deep/first.ts", "/work/project/deep/second.ts"],
    };
    expect(workEntryDisplayLabel(read, "/work/project")).toBe("Read deep/first.ts +1 more");
    expect(workEntryPathPresentation(read, "/work/project")?.fullPath).toBe(
      "/work/project/deep/first.ts",
    );
    expect(workEntryReadOutput(read, "/work/project")).toBe(
      "/work/project/deep/first.ts\n/work/project/deep/second.ts",
    );
  });
  it("retains the original target for other shortened path headings without mining prose", () => {
    const edit = {
      ...entry,
      itemType: "file_change" as const,
      changedFiles: ["src/deep/view.tsx"],
    };
    expect(workEntryDisplayLabel(edit, "/work/project")).toBe("deep/view.tsx");
    expect(workEntryPathPresentation(edit, "/work/project")?.fullPath).toBe(
      "/work/project/src/deep/view.tsx",
    );
    expect(
      workEntryPathPresentation(
        {
          ...entry,
          detail: "Found errors in /unrelated/path.ts",
        },
        "/work/project",
      ),
    ).toBeUndefined();
  });
});
describe("deriveMessagesTimelineRows", () => {
  // The header, failed-setup and handoff placements are in MessagesTimeline.logic.test.ts
  // ("keeps the working header in place across worktree setup handoff").
  it("keeps a setup script that outlives the reply, or fails after the handoff, visible", () => {
    const snapshot: WorktreeSetupSnapshot = {
      threadId: ThreadId.make("thread-setup"),
      phase: "running",
      startedAt: "2026-01-01T00:00:00Z",
      endedAt: null,
      branch: "feature",
      baseRef: "main",
      worktreePath: null,
      setupScript: null,
      stages: [],
      error: null,
      sequence: 3,
    };
    const userEntry = {
      id: "user-entry",
      kind: "message",
      createdAt: "2026-01-01T00:00:00Z",
      message: {
        id: "user-1" as never,
        role: "user",
        text: "Build it",
        runId: null,
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-01T00:00:00Z",
        streaming: false,
      },
    } as const;
    const assistantEntry = {
      id: "assistant-entry",
      kind: "message",
      createdAt: "2026-01-01T00:00:30Z",
      message: {
        id: "assistant-1" as never,
        role: "assistant",
        text: "On it",
        runId: "turn-1" as never,
        createdAt: "2026-01-01T00:00:30Z",
        updatedAt: "2026-01-01T00:00:30Z",
        streaming: true,
      },
    } as const;
    // Once the agent stage is done and the turn is live, Scient keeps the
    // still-running setup script visible beneath the stable working header.
    const stage = (id: "agent" | "setup-script", status: "done" | "running") =>
      ({
        id,
        status,
        startedAt: "2026-01-01T00:00:10Z",
        endedAt: status === "done" ? "2026-01-01T00:00:11Z" : null,
        percent: null,
        detail: null,
        tail: [],
      }) as const;
    const asyncSnapshot: WorktreeSetupSnapshot = {
      ...snapshot,
      stages: [stage("setup-script", "running"), stage("agent", "done")],
    };
    const liveRun = {
      runId: "turn-1" as never,
      status: "running",
      startedAt: "2026-01-01T00:00:11Z",
      completedAt: null,
    } as const;
    // A script that outlives the reply remains visible after the assistant.
    const outlivedRows = deriveMessagesTimelineRows({
      timelineEntries: [
        userEntry,
        {
          ...assistantEntry,
          message: {
            ...assistantEntry.message,
            streaming: false,
          },
        },
      ],
      latestRun: {
        ...liveRun,
        status: "completed",
        completedAt: "2026-01-01T00:00:40Z",
      },
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
      worktreeSetup: asyncSnapshot,
    });
    expect(outlivedRows.map((row) => row.kind)).toEqual(["message", "message", "worktree-setup"]);

    // A failed script after the handoff keeps its row under the send.
    const failedRows = deriveMessagesTimelineRows({
      timelineEntries: [userEntry],
      latestRun: liveRun,
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:00Z",
      turnDiffSummaries: [],
      supportsConversationRollback: false,
      worktreeSetup: {
        ...asyncSnapshot,
        phase: "done",
        endedAt: "2026-01-01T00:00:20Z",
        stages: [
          {
            ...stage("setup-script", "done"),
            status: "failed",
          },
          stage("agent", "done"),
        ],
      },
    });
    expect(failedRows.map((row) => row.kind)).toEqual([
      "message",
      "working",
      "worktree-setup",
      "thinking",
    ]);
    expect(failedRows[2]).toMatchObject({
      kind: "worktree-setup",
      embedded: true,
    });
  });
  it("keeps source navigation available for a fork of the first user message", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [],
      hasForkBaseline: true,
      forkBaselineAssistantMessageId: null,
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    expect(rows).toEqual([
      {
        kind: "fork-marker",
        id: "conversation-fork-marker",
      },
    ]);
  });
  it("renders one Scient incoming fork boundary, inherited fork points as markers, outgoing as history", () => {
    const threadId = ThreadId.make("fork-child");
    const sourceThreadId = ThreadId.make("fork-parent");
    const event = (
      id: string,
      targetThreadId: ThreadId,
      visibility: "local" | "inherited",
    ): TimelineEntry => {
      const itemId = TurnItemId.make(id);
      return {
        kind: "event",
        id,
        createdAt: "2026-01-01T00:00:00Z",
        projectedItem: {
          position: 0,
          visibility,
          sourceThreadId: visibility === "local" ? threadId : sourceThreadId,
          sourceItemId: itemId,
          item: decodeBoundaryItem({
            id: itemId,
            type: "fork",
            threadId,
            runId: null,
            nodeId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 0,
            status: "completed",
            title: null,
            startedAt: null,
            completedAt: null,
            updatedAt: DateTime.makeUnsafe("2026-01-01T00:00:00Z"),
            // Run and message sources take the same branch (isLocalIncomingForkEvent).
            source: {
              type: "message",
              threadId: sourceThreadId,
              messageId: MessageId.make("source-message"),
              position: "before",
            },
            targetThreadId,
          }),
        },
      };
    };
    const entries = [
      event("incoming", threadId, "local"),
      event("outgoing", ThreadId.make("next-child"), "local"),
      event("ancestor", threadId, "inherited"),
    ];
    const common = {
      timelineEntries: entries,
      isWorking: false,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    };
    const rows = deriveMessagesTimelineRows({
      ...common,
      hasForkBaseline: true,
      forkBaselineAssistantMessageId: null,
    });
    // The inherited fork point reads like this fork's own marker, linking to its source.
    expect(rows.filter((row) => row.kind === "fork-marker")).toEqual([
      {
        kind: "fork-marker",
        id: "conversation-fork-marker",
      },
      {
        kind: "fork-marker",
        id: "fork-marker:ancestor",
        originThreadId: sourceThreadId,
      },
    ]);
    expect(rows.filter((row) => row.kind === "event").map((row) => row.id)).toEqual(["outgoing"]);
    const unloadedBoundary = deriveMessagesTimelineRows({
      ...common,
      hasForkBaseline: true,
      forkBaselineAssistantMessageId: MessageId.make("not-loaded-yet"),
    });
    expect(unloadedBoundary.filter((row) => row.kind === "event").map((row) => row.id)).toEqual([
      "incoming",
      "outgoing",
    ]);
  });
  it("allows a durable user message to be selected as a fork point", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-message" as never,
            role: "user",
            text: "Fork this request",
            runId: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
      ],
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    expect(rows.find((row) => row.kind === "message")?.canForkConversation).toBe(true);
  });
  it("presents project MCP calls and summarizes successful clones through the web timeline", () => {
    const fixture = makeStreamingTimelineFixture();
    const source = fixture.visibleTurnItems.find((row) => row.item.type === "dynamic_tool")!;
    if (source.item.type !== "dynamic_tool") throw new Error("Expected tool fixture");
    const items: OrchestrationV2ProjectedTurnItem["item"][] = [
      {
        ...source.item,
        type: "dynamic_tool",
        id: TurnItemId.make("list"),
        status: "completed",
        title: "Custom provider title",
        toolName: "T3-code.t3_project_list",
        input: {},
        output: {
          projects: [],
        },
      },
      {
        ...source.item,
        type: "dynamic_tool",
        id: TurnItemId.make("clone"),
        status: "completed",
        title: "Custom provider title",
        toolName: "mcp__t3_code__t3_project_clone",
        input: {},
        output: {
          cwd: "/tmp/repo",
        },
      },
      {
        ...source.item,
        type: "dynamic_tool",
        id: TurnItemId.make("failed-clone"),
        status: "completed",
        title: "Custom provider title",
        toolName: "t3_project_clone",
        input: {},
        output: {
          isError: true,
        },
      },
    ];
    const entries = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: items.map((item, position) => ({
        ...source,
        item,
        position,
        sourceItemId: item.id,
      })),
      optimisticMessages: [],
    });
    const work = entries.flatMap((entry) => (entry.kind === "work" ? [entry.entry] : []));
    expect(workEntryDisplayLabel(work[0]!, undefined)).toBe("Listed projects");
    expect(workEntryDisplayLabel(work[1]!, undefined)).toBe("Cloned a repository");
    expect(workEntryDisplayLabel(work[2]!, undefined)).toBe("Failed to clone a repository");
    expect(
      resolveTimelineToolPresentation(items[1]!.type === "dynamic_tool" ? items[1].toolName : null)
        ?.logo,
    ).toBe("scient");
    const rows = deriveMessagesTimelineRows({
      timelineEntries: entries,
      isWorking: false,
      runningRunId: fixture.runId,
      activeTurnStartedAt: fixture.time(0),
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    expect(rows.find((row) => row.kind === "work-toggle")).toMatchObject({
      summary: "Listed projects 1 time and cloned 1 repository",
      hasFailure: true,
    });
  });
  it("labels Scient Agent tool rows by the call, never by the tool's output", () => {
    const fixture = makeStreamingTimelineFixture();
    const source = fixture.visibleTurnItems.find((row) => row.item.type === "dynamic_tool")!;
    const sourceItem = source.item;
    if (sourceItem.type !== "dynamic_tool") throw new Error("Expected tool fixture");
    const skillsOutput = '{"skills":[{"name":"html-pdf-authoring","description":"Author PDFs"}]}';
    // Native session adapters title a tool row with its name and retain its output.
    const tool = (
      id: string,
      toolName: string,
      input: Record<string, unknown>,
      output: string,
    ): OrchestrationV2ProjectedTurnItem["item"] => ({
      ...sourceItem,
      type: "dynamic_tool",
      id: TurnItemId.make(id),
      status: "completed",
      title: toolName,
      toolName,
      input,
      output,
    });
    const items = [
      tool("skills", "scient_skills_list", {}, skillsOutput),
      tool(
        "load",
        "scient_skill_load",
        {
          name: "html-pdf-authoring",
        },
        "# HTML PDF authoring",
      ),
      tool(
        "search",
        "grep",
        {
          pattern: "TODO",
          path: "src",
        },
        "src/app.ts:1: TODO",
      ),
    ];
    const entries = deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: items.map((item, position) => ({
        ...source,
        item,
        position,
        sourceItemId: item.id,
      })),
      optimisticMessages: [],
    });
    const labels = entries.flatMap((entry) =>
      entry.kind === "work" ? [workEntryDisplayLabel(entry.entry, undefined)] : [],
    );
    expect(labels).toEqual([
      "Checked available skills",
      "Used Html Pdf Authoring",
      expect.stringContaining("TODO"),
    ]);
    expect(labels.join("\n")).not.toContain("src/app.ts:1");
    expect(labels.join("\n")).not.toContain('{"skills"');
  });
  it("passes the preceding user direction as the streaming assistant hint", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "user-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "user-message" as never,
            role: "user",
            text: "אנא הסבר את התוצאה",
            runId: null,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:00Z",
            streaming: false,
          },
        },
        {
          id: "assistant-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:01Z",
          message: {
            id: "assistant-message" as never,
            role: "assistant",
            text: "Scient",
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:01Z",
            updatedAt: "2026-01-01T00:00:01Z",
            streaming: true,
          },
        },
      ],
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:01Z",
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    const assistantRow = rows.find(
      (
        row,
      ): row is Extract<
        (typeof rows)[number],
        {
          kind: "message";
        }
      > => row.kind === "message" && row.message.role === "assistant",
    );
    expect(assistantRow?.assistantDirectionHint).toBe("rtl");
  });
  it("keeps the fork marker at the baseline assistant message", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "baseline-message-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:00Z",
          message: {
            id: "baseline-message" as never,
            role: "assistant",
            text: "Copied response",
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:00Z",
            updatedAt: "2026-01-01T00:00:01Z",
            streaming: false,
          },
        },
        {
          id: "continued-message-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:03Z",
          message: {
            id: "continued-message" as never,
            role: "user",
            text: "Continue from here",
            runId: "turn-2" as never,
            createdAt: "2026-01-01T00:00:03Z",
            updatedAt: "2026-01-01T00:00:03Z",
            streaming: false,
          },
        },
      ],
      hasForkBaseline: true,
      forkBaselineAssistantMessageId: "baseline-message" as never,
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:00:02Z",
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    expect(rows.map((row) => row.id)).toEqual([
      "baseline-message-entry",
      "conversation-fork-marker",
      "continued-message-entry",
      "working-indicator-row",
      "live-activity-row",
    ]);
  });
  it("gives every assistant message of a turn that turn's changed files", () => {
    const summary = {
      runId: "turn-1" as never,
      completedAt: "2026-01-01T00:00:30Z",
      assistantMessageId: "assistant-2" as never,
      checkpointTurnCount: 1,
      checkpointRef: "checkpoint-1" as never,
      status: "ready" as const,
      files: [
        {
          path: "reviews/notes.md",
          kind: "added",
          additions: 4,
          deletions: 0,
        },
      ],
    };
    const assistant = (id: string, runId: string | null, createdAt: string) => ({
      id: `${id}-entry`,
      kind: "message" as const,
      createdAt,
      message: {
        id: id as never,
        role: "assistant" as const,
        text: "See [notes](../reviews/notes.md)",
        runId: runId as never,
        createdAt,
        updatedAt: createdAt,
        streaming: false,
      },
    });
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        assistant("assistant-1", "turn-1", "2026-01-01T00:00:10Z"),
        assistant("assistant-2", "turn-1", "2026-01-01T00:00:20Z"),
        assistant("assistant-3", "turn-2", "2026-01-01T00:00:40Z"),
      ],
      // Earlier messages of a settled turn render (and so take clicks) once
      // the turn is expanded.
      expandedRunIds: new Set(["turn-1" as never]),
      isWorking: false,
      activeTurnStartedAt: null,
      turnDiffSummaries: [summary],
      supportsConversationRollback: false,
    });
    const changedFilesById = new Map(
      rows.flatMap((row) =>
        row.kind === "message" ? [[String(row.message.id), row.assistantTurnChangedFiles]] : [],
      ),
    );
    expect(changedFilesById.get("assistant-1")).toBe(summary.files);
    expect(changedFilesById.get("assistant-2")).toBe(summary.files);
    expect(changedFilesById.get("assistant-3")).toBeUndefined();
  });
  it("keeps the live activity indicator visible between active-turn events", () => {
    const rows = deriveMessagesTimelineRows({
      timelineEntries: [
        {
          id: "assistant-commentary-entry",
          kind: "message",
          createdAt: "2026-01-01T00:00:05Z",
          message: {
            id: "assistant-commentary" as never,
            role: "assistant",
            text: "I’ll inspect the project before making the change.",
            runId: "turn-1" as never,
            createdAt: "2026-01-01T00:00:05Z",
            updatedAt: "2026-01-01T00:00:06Z",
            streaming: false,
          },
        },
      ],
      latestRun: {
        runId: "turn-1" as never,
        status: "running",
        startedAt: "2026-01-01T00:00:00Z",
        completedAt: null,
      },
      isWorking: true,
      activeTurnStartedAt: "2026-01-01T00:01:00Z",
      turnDiffSummaries: [],
      supportsConversationRollback: false,
    });
    expect(rows.map((row) => row.id)).toEqual([
      "working-indicator-row",
      "assistant-commentary-entry",
      "live-activity-row",
    ]);
  });
});
describe("v2 run and attempt history", () => {
  it.each([false, true])(
    "keeps imported historical responses distinct after native run = %s",
    (hasNativeRun) => {
      const threadId = ThreadId.make("imported-thread");
      const nativeRunId = RunId.make("native-run");
      const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
      const record = (id: string, second: number, fields: Record<string, unknown>) =>
        decodeJsonBoundaryItem({
          id,
          threadId,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: second,
          status: "completed",
          title: null,
          startedAt: at(second),
          completedAt: at(second),
          updatedAt: at(second),
          ...fields,
        });
      const user = (index: number, second: number) =>
        record(`user-${index}`, second, {
          type: "user_message",
          historyTurnId: `history-${index}`,
          messageId: `prompt-${index}`,
          text: `Queued prompt ${index}`,
          attachments: [],
          inputIntent: "turn_start",
          createdBy: "user",
          creationSource: "web",
        });
      const answer = (index: number, second: number, partial: boolean) =>
        record(`answer-${index}${partial ? "-partial" : ""}`, second, {
          type: "assistant_message",
          historyTurnId: `history-${index}`,
          messageId: `answer-${index}${partial ? "-partial" : ""}`,
          text: partial ? `Inspecting ${index}` : `Completed ${index}`,
          streaming: false,
        });
      const tool = (index: number, second: number) =>
        record(`tool-${index}`, second, {
          type: "command_execution",
          historyTurnId: `history-${index}`,
          input: "pwd",
          output: "/synthetic",
          exitCode: 0,
        });
      // Admission-time users sort before their response-time historical items.
      const items = [
        user(1, 0),
        user(2, 1),
        user(3, 2),
        answer(1, 10, true),
        tool(1, 11),
        answer(1, 12, false),
        answer(2, 20, true),
        tool(2, 21),
        answer(2, 22, false),
        tool(3, 31),
        answer(3, 32, false),
        ...(hasNativeRun
          ? [
              record("native-user", 50, {
                type: "user_message",
                runId: nativeRunId,
                nodeId: "native-root",
                messageId: "native-prompt",
                text: "Continue",
                attachments: [],
                inputIntent: "turn_start",
                createdBy: "user",
                creationSource: "web",
              }),
              // A coincident historical label must never override native ownership.
              record("native-partial", 51, {
                type: "assistant_message",
                runId: nativeRunId,
                nodeId: "native-root",
                historyTurnId: "history-1",
                messageId: "native-partial",
                text: "Starting",
                streaming: false,
              }),
              record("native-final", 55, {
                type: "assistant_message",
                runId: nativeRunId,
                nodeId: "native-root",
                historyTurnId: "history-2",
                messageId: "native-final",
                text: "Native answer",
                streaming: false,
              }),
            ]
          : []),
      ];
      const projected = items.map((item, position) => ({
        position,
        visibility: "local" as const,
        sourceThreadId: threadId,
        sourceItemId: item.id,
        item,
      }));
      for (const visibleTurnItems of [
        projected,
        projected.map((row) => ({
          ...row,
          item: decodeJsonBoundaryItem(
            JSON.parse(JSON.stringify(encodeJsonBoundaryItem(row.item))),
          ),
        })),
      ]) {
        const timelineEntries = deriveTimelineEntriesFromVisibleTurnItems({
          visibleTurnItems,
          optimisticMessages: [],
        });
        const input = {
          timelineEntries,
          latestRun: hasNativeRun
            ? {
                runId: nativeRunId,
                status: "completed" as const,
                startedAt: at(50),
                completedAt: at(55),
              }
            : null,
          isWorking: false,
          turnDiffSummaries: [],
          supportsConversationRollback: false,
        };
        const rows = deriveMessagesTimelineRows(input);
        const assistantRows = rows.filter(
          (row) => row.kind === "message" && row.message.role === "assistant",
        );
        expect(assistantRows.map((row) => row.id)).toEqual([
          "answer-1",
          "answer-2",
          "answer-3",
          ...(hasNativeRun ? ["native-final"] : []),
        ]);
        expect(assistantRows.every((row) => row.kind === "message" && row.showAssistantMeta)).toBe(
          true,
        );
        expect(
          rows
            .filter((row) => row.kind === "message" && row.message.role === "user")
            .map((row) => row.id),
        ).toEqual(["prompt-1", "prompt-2", "prompt-3", ...(hasNativeRun ? ["native-prompt"] : [])]);
        const folds = rows.filter((row) => row.kind === "turn-fold");
        expect(folds.map((row) => row.label)).toEqual([
          "Worked for 12s",
          "Worked for 21s",
          "Worked for 30s",
          ...(hasNativeRun ? ["Worked for 5.0s"] : []),
        ]);
        const historyOnlyTimeline = deriveTimelineEntriesFromVisibleTurnItems({
          visibleTurnItems: visibleTurnItems.filter(({ item }) => item.runId === null),
          optimisticMessages: [],
        });
        const beforeNativeRows = deriveMessagesTimelineRows({
          ...input,
          timelineEntries: historyOnlyTimeline,
          latestRun: null,
        });
        expect(folds.slice(0, 3).map((row) => row.runId)).toEqual(
          beforeNativeRows.flatMap((row) => (row.kind === "turn-fold" ? [row.runId] : [])),
        );
        const firstFold = folds[0];
        if (!firstFold) throw new Error("Expected the first historical response fold");
        const expanded = deriveMessagesTimelineRows({
          ...input,
          expandedRunIds: new Set([firstFold.runId]),
        });
        expect(
          expanded
            .filter((row) => row.kind === "message" && row.message.role === "assistant")
            .map((row) => row.id),
        ).toEqual([
          "answer-1-partial",
          "answer-1",
          "answer-2",
          "answer-3",
          ...(hasNativeRun ? ["native-final"] : []),
        ]);
        expect(
          expanded.flatMap((row) =>
            row.kind === "work" ? row.groupedEntries.map((entry) => entry.id) : [],
          ),
        ).toEqual(["tool-1"]);
        // Folding is presentation only; historical items retain null authority.
        expect(
          visibleTurnItems
            .slice(0, 11)
            .every(
              ({ item }) =>
                item.runId === null &&
                item.nodeId === null &&
                item.providerTurnId === null &&
                item.nativeItemRef === null,
            ),
        ).toBe(true);
        expect(
          timelineEntries.filter((row) => row.kind === "message").map((row) => row.id),
        ).toEqual([
          "prompt-1",
          "prompt-2",
          "prompt-3",
          "answer-1-partial",
          "answer-1",
          "answer-2-partial",
          "answer-2",
          "answer-3",
          ...(hasNativeRun ? ["native-prompt", "native-partial", "native-final"] : []),
        ]);
      }
    },
  );
  it("keeps unmatched historical output visible without borrowing a neighboring prompt", () => {
    const threadId = ThreadId.make("unmatched-history");
    const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
    const record = (
      id: string,
      second: number,
      historyTurnId: string,
      fields: Record<string, unknown>,
    ) =>
      decodeJsonBoundaryItem({
        id,
        threadId,
        historyTurnId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: second,
        status: "completed",
        title: null,
        startedAt: at(second),
        completedAt: at(second),
        updatedAt: at(second),
        ...fields,
      });
    const items = [
      record("prompt", 0, "known", {
        type: "user_message",
        messageId: "prompt",
        text: "Known prompt",
        attachments: [],
        inputIntent: "turn_start",
        createdBy: "user",
        creationSource: "web",
      }),
      record("known-partial", 1, "known", {
        type: "assistant_message",
        messageId: "known-partial",
        text: "Checking",
        streaming: false,
      }),
      record("known-tool", 2, "known", {
        type: "command_execution",
        input: "pwd",
        output: "/synthetic",
        exitCode: 0,
      }),
      record("known-final", 3, "known", {
        type: "assistant_message",
        messageId: "known-final",
        text: "Known result",
        streaming: false,
      }),
      record("unknown-partial", 4, "missing", {
        type: "assistant_message",
        messageId: "unknown-partial",
        text: "Unmatched intermediate",
        streaming: false,
      }),
      record("unknown-tool", 5, "missing", {
        type: "command_execution",
        input: "pwd",
        output: "/synthetic",
        exitCode: 0,
      }),
      record("unknown-final", 6, "missing", {
        type: "assistant_message",
        messageId: "unknown-final",
        text: "Unmatched result",
        streaming: false,
      }),
    ];
    const projected = items.map((item, position) => ({
      position,
      visibility: "local" as const,
      sourceThreadId: threadId,
      sourceItemId: item.id,
      item,
    }));
    for (const visibleTurnItems of [
      projected,
      projected.map((row) => ({
        ...row,
        item: decodeJsonBoundaryItem(JSON.parse(JSON.stringify(encodeJsonBoundaryItem(row.item)))),
      })),
    ]) {
      const timelineEntries = deriveTimelineEntriesFromVisibleTurnItems({
        visibleTurnItems,
        optimisticMessages: [],
      });
      const input = {
        timelineEntries,
        isWorking: false,
        turnDiffSummaries: [],
        supportsConversationRollback: false,
      };
      const collapsed = deriveMessagesTimelineRows(input);
      expect(collapsed.filter((row) => row.kind === "message").map((row) => row.id)).toEqual([
        "prompt",
        "known-final",
        "unknown-partial",
        "unknown-final",
      ]);
      expect(
        collapsed.flatMap((row) =>
          row.kind === "work" ? row.groupedEntries.map((entry) => entry.id) : [],
        ),
      ).toEqual(["unknown-tool"]);
      const folds = collapsed.filter((row) => row.kind === "turn-fold");
      expect(folds.map((row) => row.label)).toEqual(["Worked for 3.0s"]);
      const first = folds[0];
      if (!first) throw new Error("Expected only the matched history fold");
      const expanded = deriveMessagesTimelineRows({
        ...input,
        expandedRunIds: new Set([first.runId]),
      });
      expect(expanded.filter((row) => row.kind === "message").map((row) => row.id)).toEqual([
        "prompt",
        "known-partial",
        "known-final",
        "unknown-partial",
        "unknown-final",
      ]);
      expect(
        expanded.flatMap((row) =>
          row.kind === "work" ? row.groupedEntries.map((entry) => entry.id) : [],
        ),
      ).toEqual(["known-tool", "unknown-tool"]);
      const unmatchedPartial = collapsed.find((row) => row.id === "unknown-partial");
      const unmatchedFinal = collapsed.find((row) => row.id === "unknown-final");
      expect(unmatchedPartial?.kind === "message" && unmatchedPartial.showAssistantMeta).toBe(
        false,
      );
      expect(unmatchedFinal?.kind === "message" && unmatchedFinal.showAssistantMeta).toBe(true);
    }
  });
  it.each([
    {
      resource: "incoming-fork",
      trailingWork: false,
      nativeRun: false,
      duration: "21s",
    },
    {
      resource: "outgoing-fork",
      trailingWork: false,
      nativeRun: false,
      duration: "21s",
    },
    // Thread creation projects actual work; keep its timing contribution.
    {
      resource: "thread-created",
      trailingWork: false,
      nativeRun: false,
      duration: "28m 47s",
    },
    {
      resource: "incoming-fork",
      trailingWork: true,
      nativeRun: false,
      duration: "25s",
    },
    {
      resource: "outgoing-fork",
      trailingWork: true,
      nativeRun: true,
      duration: "21s",
    },
  ] as const)(
    "separates $resource cards from work timing (trailing=$trailingWork, native=$nativeRun)",
    ({ resource, trailingWork, nativeRun, duration }) => {
      const threadId = ThreadId.make("fork-destination");
      const sourceThreadId = ThreadId.make("fork-source");
      const runId = nativeRun ? RunId.make("native-run") : null;
      const base = {
        threadId,
        runId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        status: "completed",
        title: null,
      };
      const at = (seconds: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
      const record = (id: string, seconds: number, fields: Record<string, unknown>) =>
        decodeJsonBoundaryItem({
          ...base,
          id,
          ordinal: seconds,
          startedAt: at(seconds),
          completedAt: at(seconds),
          updatedAt: at(seconds),
          ...fields,
        });
      const items: OrchestrationV2ProjectedTurnItem[] = [
        record("prompt", 0, {
          type: "user_message",
          messageId: "prompt-message",
          createdBy: "user",
          creationSource: "web",
          inputIntent: "turn_start",
          text: "Check the workspace",
          attachments: [],
        }),
        record("command", 5, {
          type: "command_execution",
          input: "pwd",
          output: "/workspace",
          exitCode: 0,
        }),
        record("answer", 21, {
          type: "assistant_message",
          messageId: "answer-message",
          text: "Checked",
          streaming: false,
        }),
        ...(trailingWork
          ? [
              record("trailing-command", 25, {
                type: "command_execution",
                input: "pwd",
                output: "/workspace",
                exitCode: 0,
              }),
            ]
          : []),
      ].map((item, position) => ({
        position,
        visibility: nativeRun ? "local" : "inherited",
        sourceThreadId,
        sourceItemId: item.id,
        item,
      }));
      const resourceItem = record("later-resource", 1727, {
        ...(resource === "thread-created"
          ? {
              type: "thread_created",
              targetRunId: null,
              targetProviderInstanceId: "controlled",
              targetModel: "controlled-model",
            }
          : {
              type: "fork",
              source: {
                type: "run",
                threadId: sourceThreadId,
                runId: "source-run",
              },
              providerThreadId: undefined,
            }),
        targetThreadId: resource === "incoming-fork" ? threadId : "another-destination",
        runId: nativeRun ? runId : null,
        startedAt: null,
      });
      items.push({
        position: items.length,
        visibility: "local",
        sourceThreadId: threadId,
        sourceItemId: resourceItem.id,
        item: resourceItem,
      });

      // Reload through the wire codec and ChatView's projection/folding path.
      // Inherited history has no executable run; the native case retains one.
      for (const projectedItems of [
        items,
        items.map((row) => ({
          ...row,
          item: decodeJsonBoundaryItem(
            JSON.parse(JSON.stringify(encodeJsonBoundaryItem(row.item))),
          ),
        })),
      ]) {
        const rows = deriveMessagesTimelineRows({
          timelineEntries: deriveTimelineEntriesFromVisibleTurnItems({
            visibleTurnItems: projectedItems,
            optimisticMessages: [],
          }),
          latestRun: runId
            ? {
                runId,
                status: "completed",
                startedAt: at(0),
                completedAt: at(21),
              }
            : null,
          isWorking: false,
          turnDiffSummaries: [],
          supportsConversationRollback: false,
          hasForkBaseline: !nativeRun,
          forkBaselineAssistantMessageId: MessageId.make("answer-message"),
        });
        expect(rows.filter((row) => row.kind === "turn-fold")).toMatchObject([
          {
            label: `Worked for ${duration}`,
            createdAt: at(0),
            expanded: false,
          },
        ]);
        expect(rows.filter((row) => row.kind === "fork-marker")).toHaveLength(nativeRun ? 0 : 1);
        const visibleResources = rows.filter((row) => row.kind === "event");
        expect(visibleResources.map((row) => row.id)).toEqual(
          resource === "outgoing-fork" ? ["later-resource"] : [],
        );
        expect(
          rows.find((row) => row.kind === "message" && row.message.role === "assistant"),
        ).toMatchObject({
          message: {
            id: "answer-message",
            text: "Checked",
          },
        });
      }
    },
  );
});
it("treats only the strict list end as the live edge", async () => {
  const {
    resolveTimelineIsAtEnd,
    resolveTimelineMinimapHasPersistentGutter,
    resolveTimelineMinimapCurrentIndex,
    resolveTimelineMinimapHeightStyle,
    resolveTimelineMinimapHitStripWidth,
    resolveTimelineMinimapIndexFromPointer,
    resolveTimelineMinimapInteractiveWidth,
    resolveTimelineMinimapNavigationInteractive,
    resolveTimelineMinimapTopPercent,
  } = await import("./MessagesTimeline.logic");
  expect(
    resolveTimelineIsAtEnd({
      isAtEnd: true,
    }),
  ).toBe(true);
  expect(resolveTimelineIsAtEnd(undefined)).toBeUndefined();
  // Within the pixel band above the content bottom counts as the end...
  expect(
    resolveTimelineIsAtEnd({
      isAtEnd: false,
      contentLength: 2000,
      scroll: 1170,
      scrollLength: 800,
    }),
  ).toBe(true);
  // ...but half a viewport up (LegendList's isNearEnd territory) does not.
  expect(
    resolveTimelineIsAtEnd({
      isAtEnd: false,
      contentLength: 2000,
      scroll: 900,
      scrollLength: 800,
    }),
  ).toBe(false);
  // LegendList's isAtEnd is true anywhere within the composer-height band
  // (it subtracts the inset); the last row is still hidden under the
  // composer there, so the flag must not short-circuit the geometry.
  expect(
    resolveTimelineIsAtEnd({
      isAtEnd: true,
      contentLength: 2000,
      scroll: 1100,
      scrollLength: 800,
    }),
  ).toBe(false);
  // Geometry missing (older state shape): fall back to the strict flag.
  expect(
    resolveTimelineIsAtEnd({
      isAtEnd: false,
    }),
  ).toBe(false);
  expect(resolveTimelineMinimapHeightStyle(5)).toBe("min(32px, calc(100vh - 18rem))");
  expect(resolveTimelineMinimapTopPercent(2, 5)).toBe(50);
  expect(
    resolveTimelineMinimapIndexFromPointer({
      itemCount: 101,
      railTop: 100,
      railHeight: 500,
      pointerY: 350,
    }),
  ).toBe(50);
  expect(
    resolveTimelineMinimapIndexFromPointer({
      itemCount: 101,
      railTop: 100,
      railHeight: 500,
      pointerY: 999,
    }),
  ).toBe(100);
  expect(
    resolveTimelineMinimapCurrentIndex({
      visibleStart: 1,
      visibleEnd: 2,
      rowIndices: [0, 1, 2],
    }),
  ).toBe(1);
  expect(
    resolveTimelineMinimapCurrentIndex({
      visibleStart: 3,
      visibleEnd: 3,
      rowIndices: [0, 2, 4],
    }),
  ).toBe(1);
  expect(
    resolveTimelineMinimapCurrentIndex({
      visibleStart: null,
      visibleEnd: null,
      rowIndices: [0],
    }),
  ).toBeNull();
  // Comfortable width: the column is capped at 768px.
  expect(resolveTimelineMinimapHasPersistentGutter(832, 768)).toBe(false);
  expect(resolveTimelineMinimapHasPersistentGutter(863, 768)).toBe(false);
  expect(resolveTimelineMinimapHasPersistentGutter(864, 768)).toBe(true);
  // Wider Chat width settings consume the gutter the minimap relies on.
  expect(resolveTimelineMinimapHasPersistentGutter(1400, 1152)).toBe(true);
  expect(resolveTimelineMinimapHasPersistentGutter(1200, 1152)).toBe(false);
  expect(resolveTimelineMinimapHasPersistentGutter(2560, 2560)).toBe(false);

  // No usable gutter (zoomed in / narrow pane): the strip must go inert
  // instead of overlaying the centered content column.
  expect(resolveTimelineMinimapHitStripWidth(768, 768)).toBe(0);
  expect(resolveTimelineMinimapHitStripWidth(792, 768)).toBe(0);
  // Partial gutter: strip shrinks to what fits between the viewport edge
  // and the content column.
  expect(resolveTimelineMinimapHitStripWidth(820, 768)).toBe(14);
  // Full gutter: unchanged 40px-wide strip.
  expect(resolveTimelineMinimapHitStripWidth(872, 768)).toBe(40);
  expect(resolveTimelineMinimapHitStripWidth(1400, 768)).toBe(40);
  // Full Chat width: the column spans the viewport, so the strip is inert
  // however wide the window gets.
  expect(resolveTimelineMinimapHitStripWidth(2560, 2560)).toBe(0);
  // Wide Chat width on a window just wider than the column: partial strip.
  expect(resolveTimelineMinimapHitStripWidth(1204, 1152)).toBe(14);
  expect(resolveTimelineMinimapHitStripWidth(0, 0)).toBe(0);
  expect(resolveTimelineMinimapHitStripWidth(Number.NaN, 768)).toBe(0);

  // Prev/next buttons reach 14px past the strip's left edge; a narrower
  // strip means they would sit on the content column.
  expect(resolveTimelineMinimapNavigationInteractive(40)).toBe(true);
  expect(resolveTimelineMinimapNavigationInteractive(14)).toBe(true);
  expect(resolveTimelineMinimapNavigationInteractive(8)).toBe(false);
  expect(resolveTimelineMinimapNavigationInteractive(0)).toBe(false);

  // The collapsed target stays narrow, but an open preview keeps its full
  // 20rem width plus the 2rem offset from the minimap rail interactive.
  expect(resolveTimelineMinimapInteractiveWidth(0, false)).toBe(0);
  expect(resolveTimelineMinimapInteractiveWidth(14, false)).toBe(14);
  expect(resolveTimelineMinimapInteractiveWidth(40, false)).toBe(40);
  expect(resolveTimelineMinimapInteractiveWidth(0, true)).toBe("22rem");
  expect(resolveTimelineMinimapInteractiveWidth(14, true)).toBe("22rem");
  expect(resolveTimelineMinimapInteractiveWidth(40, true)).toBe("22rem");
});
