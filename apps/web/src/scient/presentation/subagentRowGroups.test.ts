import {
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderTurnId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { deriveMessagesTimelineRows } from "../../components/chat/MessagesTimeline.logic";
import { deriveTimelineEntriesFromVisibleTurnItems } from "../../session-logic";
import { subagentRowGroupKey } from "./subagentRowGroups";

const runId = RunId.make("parent-run");
const threadId = ThreadId.make("parent-thread");
const providerTurnId = ProviderTurnId.make("parent-provider-turn");
const at = (second: number) =>
  DateTime.makeUnsafe(`2026-10-06T10:00:${String(second).padStart(2, "0")}Z`);
const base = (id: string, second: number, turnId: ProviderTurnId | null = providerTurnId) => ({
  id: TurnItemId.make(id),
  threadId,
  runId,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: turnId,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: second,
  title: null,
  startedAt: at(second),
  completedAt: null,
  updatedAt: at(second),
});
const projected = (item: OrchestrationV2TurnItem): OrchestrationV2ProjectedTurnItem => ({
  position: item.ordinal,
  visibility: "local",
  sourceThreadId: threadId,
  sourceItemId: item.id,
  item,
});
const child = (id: string, second: number): OrchestrationV2TurnItem => ({
  ...base(id, second),
  status: "running",
  type: "subagent",
  subagentId: NodeId.make(id),
  origin: "app_owned",
  driver: ProviderDriverKind.make("codex"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  childThreadId: ThreadId.make(`${id}-thread`),
  prompt: `Inspect ${id}`,
  result: null,
});
const command = (id: string, second: number): OrchestrationV2TurnItem => ({
  ...base(id, second),
  status: "completed",
  completedAt: at(second),
  type: "command_execution",
  input: "pwd",
  output: "/repo",
  exitCode: 0,
});

function subagentGroups(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
  subagentWorkflowIds?: ReadonlyMap<string, string>,
) {
  const rows = deriveMessagesTimelineRows({
    timelineEntries: deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: (
        [
          {
            ...base("user", 0),
            status: "completed",
            completedAt: at(0),
            type: "user_message",
            messageId: MessageId.make("user"),
            createdBy: "user",
            creationSource: "web",
            inputIntent: "turn_start",
            text: "Delegate the review",
            attachments: [],
          },
          ...items,
        ] satisfies OrchestrationV2TurnItem[]
      ).map(projected),
      optimisticMessages: [],
    }),
    latestRun: {
      runId,
      status: "running",
      startedAt: DateTime.formatIso(at(0)),
      completedAt: null,
    },
    isWorking: true,
    turnDiffSummaries: [],
    supportsConversationRollback: false,
    subagentWorkflowIds,
  });
  return rows.flatMap((row) =>
    row.kind === "event" && row.projectedItem.item.type === "subagent"
      ? [(row.subagents ?? [row.projectedItem]).map((member) => member.item.id)]
      : [],
  );
}

describe("subagent row groups", () => {
  it("joins adjacent spawns of one run and workflow", () => {
    expect(subagentGroups([child("a", 1), child("b", 2)])).toEqual([["a", "b"]]);
  });

  it("splits adjacent spawns from different agent-panel workflows", () => {
    const workflows = new Map([
      ["a", "workflow-1"],
      ["b", "workflow-1"],
      ["c", "workflow-2"],
    ]);
    expect(subagentGroups([child("a", 1), child("b", 2), child("c", 3)], workflows)).toEqual([
      ["a", "b"],
      ["c"],
    ]);
  });

  it("never joins spawns that other rows separate", () => {
    expect(subagentGroups([child("a", 1), command("cmd", 2), child("b", 3)])).toEqual([
      ["a"],
      ["b"],
    ]);
  });

  it("keys a turnless spawn by the subagent itself", () => {
    const turnless = (id: string, second: number): OrchestrationV2TurnItem => ({
      ...child(id, second),
      ...base(id, second, null),
      runId: null,
    });
    expect(
      subagentRowGroupKey(projected(turnless("a", 1)), undefined) ===
        subagentRowGroupKey(projected(turnless("b", 2)), undefined),
    ).toBe(false);
    expect(subagentRowGroupKey(projected(command("cmd", 1)), undefined)).toBeNull();
  });
});
