import {
  MessageId,
  ContextHandoffId,
  ProviderThreadId,
  NodeId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  OrchestrationV2TurnItemJson,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import { projectTurnItemForWire, projectDomainEventForWire } from "./WireProjection.ts";
import { threadShellFromProjection } from "@t3tools/shared/orchestrationV2ThreadShell";
import { historicalSubagentsToRuntime } from "../../../../packages/client-runtime/src/state/historicalSubagentRuntime.ts";

const decodeTurnItem = Schema.decodeUnknownSync(OrchestrationV2TurnItem);
const encodeTurnItemJson = Schema.encodeSync(OrchestrationV2TurnItemJson);
const decodeTurnItemJson = Schema.decodeUnknownSync(OrchestrationV2TurnItemJson);

const base = {
  id: TurnItemId.make("tool-1"),
  type: "dynamic_tool" as const,
  threadId: ThreadId.make("thread-1"),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed" as const,
  title: "MCP tool",
  toolName: "mcp__github__fetch_pr",
  input: { pr: 42 },
  startedAt: DateTime.makeUnsafe("2026-08-13T00:00:00.000Z"),
  completedAt: DateTime.makeUnsafe("2026-08-13T00:00:01.000Z"),
  updatedAt: DateTime.makeUnsafe("2026-08-13T00:00:01.000Z"),
};

describe("orchestration V2 wire projection", () => {
  it("presents an unresolved completed native Codex citation without changing its raw item", () => {
    const raw = "Evidence 😀 \uE200cite\uE202missing\uE201.";
    const item = decodeTurnItem({
      ...base,
      type: "assistant_message",
      messageId: MessageId.make("unresolved-citation"),
      nativeItemRef: { driver: "codex", nativeId: "unresolved", strength: "strong" },
      text: raw,
      streaming: false,
    });
    const presented = projectTurnItemForWire(item);
    expect(presented.type).toBe("assistant_message");
    if (presented.type !== "assistant_message") throw new Error("Missing assistant item");
    expect(presented.text).toBe("Evidence 😀 [citation unavailable].");
    expect(item.type === "assistant_message" && item.text).toBe(raw);
  });

  it("preserves oversized inert task completion identity, usage and bounded display through JSON", () => {
    const detail = "Evidence checked. " + "😀".repeat(20_000);
    const item = {
      ...base,
      id: TurnItemId.make("migration:v1:history:activity:completion"),
      input: {
        activityId: "completion",
        turnId: "historical-turn",
        tone: "info",
        kind: "task.completed",
        summary: "Completed review",
        sequence: 2,
        payload: {
          taskId: "reviewer",
          agentKind: "agent",
          status: "failed",
          detail,
          typedUsage: { totalTokens: 123, toolUses: 4 },
          output: { text: detail },
        },
      },
    } satisfies OrchestrationV2TurnItem;
    const projected = projectTurnItemForWire(item);
    const decoded = decodeTurnItemJson(encodeTurnItemJson(projected));
    const agents = historicalSubagentsToRuntime([decoded]);
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      id: "historical:thread-1:reviewer",
      status: "failed",
      historical: true,
      usage: { totalTokens: 123, toolUses: 4 },
    });
    expect(agents[0]?.error).toMatch(/^Evidence checked\./);
    expect(agents[0]?.error).not.toContain("\uFFFD");
    expect(JSON.stringify(projected).length).toBeLessThan(3_000);
    expect(projectTurnItemForWire(projected)).toEqual(projected);
    expect(item.input.payload.detail).toBe(detail);
    expect(item.input.payload.output.text).toBe(detail);
  });

  it("retains inherited historical workflow structure rather than replacing its activity envelope", () => {
    const item = {
      ...base,
      id: TurnItemId.make("fork:destination:item:0"),
      inheritedFrom: {
        threadId: ThreadId.make("source-thread"),
        itemId: TurnItemId.make("migration:v1:history:activity:workflow"),
        runId: null,
        status: "completed" as const,
      },
      input: {
        activityId: "workflow",
        turnId: null,
        tone: "info",
        kind: "task.completed",
        summary: "Workflow finished",
        sequence: null,
        payload: {
          taskId: "workflow",
          agentKind: "agent",
          taskType: "local_workflow",
          status: "completed",
          title: "Review",
          summary: "x".repeat(30_000),
          phases: [{ index: 0, title: "Phase " + "y".repeat(30_000) }],
          runHandles: { runId: "historical-display", scriptPath: "/old/review.ts" },
          typedUsage: { toolUses: 3 },
        },
      },
    } satisfies OrchestrationV2TurnItem;
    const projected = projectTurnItemForWire(item);
    const agents = historicalSubagentsToRuntime([projected, projected]);
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      id: "historical:source-thread:workflow",
      historical: true,
      kind: "workflow",
      status: "completed",
      usage: { toolUses: 3 },
      runHandles: { runId: "historical-display", scriptPath: "/old/review.ts" },
    });
    expect(agents[0]?.usage?.totalTokens).toBeUndefined();
    expect(agents[0]?.phases[0]?.title).toMatch(/^Phase /);
    expect(agents[0]?.phases[0]?.title.length).toBeLessThan(1_100);
  });

  it.each(["provider-id", "native-owner", "malformed-envelope"])(
    "does not exempt unproven task-shaped tool input from compaction: %s",
    (reason) => {
      const input = {
        activityId: "pretend",
        turnId: null,
        tone: "info",
        kind: "task.completed",
        summary: "Pretend",
        sequence: null,
        payload: reason === "malformed-envelope" ? null : { detail: "x".repeat(30_000) },
        extra: "x".repeat(30_000),
      };
      const projected = projectTurnItemForWire({
        ...base,
        id: TurnItemId.make(
          reason === "provider-id" ? "provider-id" : "migration:v1:history:activity:pretend",
        ),
        ...(reason === "native-owner" ? { nodeId: NodeId.make("native-node") } : {}),
        input,
      });
      expect(projected.type === "dynamic_tool" ? projected.input : null).toMatchObject({
        truncated: true,
      });
      expect(historicalSubagentsToRuntime([projected])).toEqual([]);
    },
  );

  it("keeps copied handoff transcripts out of activity items and live events", () => {
    const item = {
      ...base,
      type: "handoff" as const,
      contextHandoffId: ContextHandoffId.make("handoff:wire"),
      fromProviderThreadIds: [],
      toProviderThreadId: ProviderThreadId.make("target"),
      fromProviderInstanceIds: [],
      toProviderInstanceId: ProviderInstanceId.make("codex"),
      strategy: "full_thread_summary" as const,
      summary: "PRIVATE_HANDOFF_TRANSCRIPT",
    };
    const projected = projectTurnItemForWire(item);
    expect(projected).not.toHaveProperty("summary");
    expect(decodeTurnItem(projected)).toMatchObject({ contextHandoffId: item.contextHandoffId });
    const event = {
      id: EventId.make("handoff:wire"),
      type: "turn-item.updated" as const,
      threadId: base.threadId,
      occurredAt: base.updatedAt,
      payload: item,
    };
    expect(JSON.stringify(projectDomainEventForWire(event))).not.toContain(item.summary);
    expect(item.summary).toBe("PRIVATE_HANDOFF_TRANSCRIPT");
  });

  it("preserves image metadata through wire and JSON contracts while redacting output", () => {
    const imagePath = `/workspace/${"nested folder/".repeat(16)}reference image.webp`;
    const item = {
      ...base,
      nodeId: NodeId.make("child-tool-owner"),
      parentItemId: TurnItemId.make("parent-tool"),
      toolName: "Read",
      input: { file_path: imagePath },
      viewedImagePath: imagePath,
      output: { data: "private-image-data" },
    } satisfies OrchestrationV2TurnItem;
    const projected = projectTurnItemForWire(item);
    const live = decodeTurnItem(projected);
    const encoded = encodeTurnItemJson(live);
    const json = decodeTurnItemJson(encoded);
    const decoded = decodeTurnItem(json);
    expect(decoded).toMatchObject({
      viewedImagePath: imagePath,
      nodeId: item.nodeId,
      parentItemId: item.parentItemId,
    });
    expect(projectTurnItemForWire(decoded)).toEqual(decoded);
    expect(decoded).not.toHaveProperty("output");
    expect(item.output.data).toBe("private-image-data");
  });

  it("preserves provider notices in bounded items and live events", () => {
    const item = {
      ...base,
      type: "system_notice" as const,
      message: "Safeguards flagged this message. Switched to Opus 4.8.",
    };
    expect(projectTurnItemForWire(item)).toEqual(item);
    const event = {
      id: EventId.make("notice-wire-event"),
      type: "turn-item.updated" as const,
      threadId: item.threadId,
      occurredAt: item.updatedAt,
      payload: item,
    };
    expect(projectDomainEventForWire(event)).toEqual(event);
  });

  it("keeps transcript bodies out of shell rows", () => {
    const now = DateTime.makeUnsafe("2026-08-13T00:00:00.000Z");
    const threadId = ThreadId.make("thread-shell-budget");
    const projection = {
      thread: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make("project-shell-budget"),
        title: "Shell payload budget",
        providerInstanceId: ProviderInstanceId.make("codex"),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: threadId,
        },
        forkedFrom: null,
        activeProviderThreadId: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
      runs: [],
      attempts: [],
      nodes: [],
      subagents: [],
      providerTurns: [],
      checkpointScopes: [],
      checkpoints: [],
      contextHandoffs: [],
      contextTransfers: [],
      runtimeRequests: [],
      messages: [
        {
          id: MessageId.make("message-shell-budget"),
          threadId,
          runId: null,
          nodeId: null,
          createdBy: "agent",
          creationSource: "provider",
          role: "assistant",
          text: "x".repeat(1_000_000),
          streaming: false,
          attachments: [],
          createdAt: now,
          updatedAt: now,
        },
      ],
      providerSessions: [],
      providerThreads: [],
      turnItems: [],
      visibleTurnItems: [],
      plans: [],
      updatedAt: now,
    } satisfies OrchestrationV2ThreadProjection;

    const shell = threadShellFromProjection(projection);

    expect(shell.latestVisibleMessage).toBeNull();
    expect(JSON.stringify(shell).length).toBeLessThan(2_000);
  });

  it("omits oversized dynamic tool results without mutating persistence data", () => {
    const output = { content: [{ type: "text", text: "first line\n" + "x".repeat(100_000) }] };
    const item = { ...base, output } satisfies OrchestrationV2TurnItem;
    const projected = projectTurnItemForWire(item);

    expect(item.output).toBe(output);
    expect(projected).not.toBe(item);
    expect(JSON.stringify(projected).length).toBeLessThan(2_000);
    expect(projected).not.toHaveProperty("output");
  });

  it("omits even small dynamic tool results while retaining input", () => {
    const item = { ...base, output: { ok: true } } satisfies OrchestrationV2TurnItem;
    expect(projectTurnItemForWire(item)).toEqual(base);
    expect(item.output).toEqual({ ok: true });
  });

  it("keeps undefined dynamic input intact", () => {
    const item = { ...base, input: undefined } satisfies OrchestrationV2TurnItem;
    expect(projectTurnItemForWire(item)).toEqual(item);
  });

  it.each([
    [" \t\r\n\n  first\t line  \r\n" + "x\n".repeat(10_000), "first line"],
    [" \n".repeat(10_000), "Large tool output"],
    ["a".repeat(160) + "\n" + "x".repeat(20_000), "a".repeat(160)],
    ["a".repeat(161) + "\n" + "x".repeat(20_000), "a".repeat(159) + "…"],
    ["a".repeat(159) + "\t b" + "x".repeat(20_000), "a".repeat(159) + "…"],
    ["  café\u00a0\u2003😀 \t\r\n" + "x".repeat(20_000), "café 😀"],
  ])("preserves bounded input summary normalization for case %#", (input, summary) => {
    const projected = projectTurnItemForWire({ ...base, input });
    expect(projected.type === "dynamic_tool" ? projected.input : null).toEqual({
      summary,
      truncated: true,
    });
  });

  it("uses encoded JSON bytes for strings near the dynamic-value limit", () => {
    const small = '"'.repeat(8_191);
    const large = '"'.repeat(8_192);
    const smallItem = { ...base, input: small };
    expect(projectTurnItemForWire(smallItem)).toEqual(smallItem);
    const projected = projectTurnItemForWire({ ...base, input: large });
    expect(projected.type === "dynamic_tool" ? projected.input : null).toEqual({
      summary: '"'.repeat(159) + "…",
      truncated: true,
    });
  });

  it("serializes an oversized structured input only once for its summary", () => {
    let serializations = 0;
    const input = {
      toJSON() {
        serializations += 1;
        return { text: "x".repeat(100_000) };
      },
    };
    const projected = projectTurnItemForWire({ ...base, input });
    expect(serializations).toBe(1);
    expect(projected.type === "dynamic_tool" ? projected.input : null).toMatchObject({
      truncated: true,
    });
  });

  it("truncates detail at a UTF-8 boundary without changing the source", () => {
    const progress = "a".repeat(32_767) + "😀" + "x".repeat(100_000);
    const item = {
      ...base,
      type: "subagent" as const,
      subagentId: NodeId.make("child-agent"),
      origin: "app_owned" as const,
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      childThreadId: null,
      prompt: "Inspect code",
      result: null,
      progress,
    };
    const projected = projectTurnItemForWire(item);
    expect(projected.type === "subagent" ? projected.progress : null).toBe(
      "a".repeat(32_767) + "\n… output truncated for transport",
    );
    expect(item.progress).toBe(progress);
  });

  it.each(["", "small output", "x".repeat(1_048_576)])(
    "omits command output of every size, case %#",
    (output) => {
      const item = { ...base, type: "command_execution" as const, input: "test", output };
      const projected = projectTurnItemForWire(item);
      expect(projected).not.toHaveProperty("output");
      expect(projected).toMatchObject({ input: "test", status: "completed" });
      expect(item.output).toBe(output);
    },
  );

  it("keeps failure evidence without retaining command output", () => {
    const item = {
      ...base,
      type: "command_execution" as const,
      input: "cat missing-file",
      output: "cat: missing-file: No such file or directory",
    };
    const projected = projectTurnItemForWire(item);
    expect(projected).not.toHaveProperty("output");
    expect(projected).toMatchObject({ outputIndicatesFailure: true });
    expect(projectTurnItemForWire(projected)).toEqual(projected);
    expect(projectTurnItemForWire({ ...item, output: "", exitCode: 2 })).toMatchObject({
      outputIndicatesFailure: true,
      exitCode: 2,
    });
  });

  it("omits inline file bodies but preserves file identity and change counts", () => {
    const item = {
      ...base,
      type: "file_change" as const,
      fileName: "src/main.ts",
      additions: 3,
      deletions: 1,
      diffStr: "+new code",
      oldStr: "old code",
      newStr: "new code",
    };
    const projected = projectTurnItemForWire(item);
    expect(projected).not.toHaveProperty("diffStr");
    expect(projected).not.toHaveProperty("oldStr");
    expect(projected).not.toHaveProperty("newStr");
    expect(projected).toMatchObject({ fileName: "src/main.ts", additions: 3, deletions: 1 });
    expect(item.diffStr).toBe("+new code");
  });

  it("retains only result identities and failure metadata in live tool events", () => {
    const output = {
      isError: true,
      structuredContent: { threadId: "child-thread", messageId: "message", text: "PRIVATE_BODY" },
      content: [{ type: "text", text: "PRIVATE_BODY" }],
    };
    const event = {
      id: EventId.make("result-event"),
      type: "turn-item.updated" as const,
      threadId: base.threadId,
      occurredAt: base.updatedAt,
      payload: { ...base, output },
    };
    const projected = projectDomainEventForWire(event);
    expect(projected.payload).toMatchObject({
      output: { isError: true, threadId: "child-thread", messageId: "message" },
    });
    expect(JSON.stringify(projected)).not.toContain("PRIVATE_BODY");
    expect(event.payload.output).toBe(output);
    expect(projectDomainEventForWire(projected)).toEqual(projected);
  });

  it("does not serialize raw dynamic output to discard it", () => {
    const output = {
      toJSON: () => {
        throw new Error("Raw output must not be serialized");
      },
    };
    expect(projectTurnItemForWire({ ...base, output })).not.toHaveProperty("output");
  });
});
