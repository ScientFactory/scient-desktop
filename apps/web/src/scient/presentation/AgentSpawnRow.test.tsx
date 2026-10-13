import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { projectedSubagentsToRuntime } from "@t3tools/client-runtime/state/subagentRuntime";
import { renderSubagentRosterGroup } from "./AgentSpawnRow";

type Member = Extract<OrchestrationV2TurnItem, { type: "subagent" }>;
const assignment = "# Investigate\n" + "**A very long saved assignment** ".repeat(100);
const now = DateTime.makeUnsafe("2026-10-11T12:00:00Z");
function member(id: string, driver = "scient", child = true): Member {
  return {
    type: "subagent",
    id: TurnItemId.make(id),
    threadId: ThreadId.make("parent"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "running",
    title: assignment,
    startedAt: now,
    completedAt: null,
    updatedAt: now,
    subagentId: NodeId.make(id),
    origin: "provider_native",
    driver: ProviderDriverKind.make(driver),
    providerInstanceId: ProviderInstanceId.make(driver),
    childThreadId: child ? ThreadId.make(`child-${id}`) : null,
    prompt: assignment,
    result: "Observed result",
    progress: "Checking the changed path",
  };
}
let renderer: ReactTestRenderer | undefined;
afterEach(async () => {
  await act(async () => renderer?.unmount());
  vi.unstubAllGlobals();
});

function fixture(
  members: Member[],
  expanded = false,
  missingRoster: boolean | ReadonlyArray<string> = false,
) {
  const onOpenThread = vi.fn();
  const expandedSpawnEntryIds = new Set(expanded ? ["group"] : []);
  const onToggleSpawnRow = vi.fn((id: string, open: boolean) => {
    if (open) expandedSpawnEntryIds.add(id);
    else expandedSpawnEntryIds.delete(id);
  });
  const render = () =>
    renderSubagentRosterGroup({
      rowId: "group",
      continuesWorkLog: false,
      members,
      roster: { workflowId: null, agentTaskIds: members.map((item) => item.subagentId) },
      context: {
        expandedSpawnEntryIds,
        onToggleSpawnRow,
        onOpenThread,
        onToggleWorkEntry: vi.fn(),
        onOpenAgents: vi.fn(),
        agentPanelModel: {
          workflows: [],
          directAgents: projectedSubagentsToRuntime(
            members
              .filter((item) =>
                typeof missingRoster === "boolean"
                  ? !missingRoster
                  : missingRoster.includes(item.subagentId),
              )
              .map((item) => ({ ...item, id: item.subagentId, model: null })),
          ),
          runningCount: 0,
          waitingCount: 0,
          idleCount: 0,
          settledCount: 0,
          totalTokens: null,
          hasAgents: true,
          liveCount: 0,
        },
      },
      LiveActivityRow: ({ label }: { label: ReactNode }) => <span>{label}</span>,
      WorkingTimer: () => <span>1s</span>,
      failedToolIconClassName: "failed",
      toolCallExpandedBodyClassName: "detail",
    });
  return { render, onOpenThread, onToggleSpawnRow };
}

it.each(["provider_native", "app_owned"] as const)(
  "keeps Scient assignments and child actions behind user-controlled group disclosure for %s",
  async (origin) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const members = [member("one"), member("two", "scient", false)].map((item) => ({
      ...item,
      origin,
    }));
    const f = fixture(members);
    await act(async () => {
      renderer = create(f.render());
    });
    expect(renderer!.root.findAllByType("button")).toHaveLength(1);
    expect(JSON.stringify(renderer!.toJSON())).not.toContain(assignment);
    await act(async () => renderer!.root.findByType("button").props.onClick());
    await act(async () => renderer!.update(f.render()));
    const details = renderer!.root.findAllByProps({ role: "button" });
    expect(details).toHaveLength(2);
    expect(details[0]!.props["aria-label"].length).toBeLessThan(120);
    const child = renderer!.root
      .findAllByType("button")
      .find((button) => button.props["aria-label"]?.startsWith("Open "))!;
    await act(async () => child.props.onClick());
    expect(f.onOpenThread).toHaveBeenCalledWith("child-one");
    expect(details[0]!.props["aria-expanded"]).toBe(false);
    await act(async () =>
      details[0]!.props.onKeyDown({
        key: "Enter",
        target: details[0],
        currentTarget: details[0],
        preventDefault: vi.fn(),
      }),
    );
    expect(renderer!.root.findByType("pre").children.join("")).toContain(assignment);
    expect(renderer!.root.findByType("pre").children.join("")).toContain("Observed result");
    members[0] = { ...members[0]!, status: "completed", completedAt: now };
    await act(async () => renderer!.update(f.render()));
    expect(renderer!.root.findAllByProps({ role: "button" })).toHaveLength(2);
    expect(f.onToggleSpawnRow).toHaveBeenCalledTimes(1);
  },
);

it("renders missing Scient roster members from retained items without inventing a model", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const f = fixture([member("one")], true, true);
  await act(async () => {
    renderer = create(f.render());
  });
  const detail = renderer!.root.findByProps({ role: "button" });
  await act(async () => detail.props.onClick());
  expect(renderer!.root.findByType("pre").children.join("")).toContain(assignment);
  expect(f.onOpenThread).not.toHaveBeenCalled();
});

it.each([
  ["codex", "claudeAgent"],
  ["scient", "codex"],
])("preserves legacy child links for mixed/non-Scient groups %s/%s", async (first, second) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const f = fixture([member("one", first), member("two", second)]);
  await act(async () => {
    renderer = create(f.render());
  });
  expect(renderer!.root.findAllByProps({ "aria-label": "Open child thread" })).toHaveLength(2);
  expect(JSON.stringify(renderer!.toJSON())).toContain("Open ");
  await act(async () =>
    renderer!.root.findAllByProps({ "aria-label": "Open child thread" })[1]!.props.onClick(),
  );
  expect(f.onOpenThread).toHaveBeenCalledWith("child-two");
});

it("keeps retained first-seen order while a partial Scient roster catches up", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const members = [
    { ...member("one"), title: "First child" },
    { ...member("two"), title: "Second child" },
  ];
  const knownIds = ["two"];
  const f = fixture(members, true, knownIds);
  await act(async () => {
    renderer = create(f.render());
  });
  expect(
    renderer!.root
      .findAllByProps({ role: "button" })
      .map((row) => row.props["aria-label"].split(",")[0]),
  ).toEqual(["First child", "Second child"]);
  knownIds.push("one");
  await act(async () => renderer!.update(f.render()));
  expect(
    renderer!.root
      .findAllByProps({ role: "button" })
      .map((row) => row.props["aria-label"].split(",")[0]),
  ).toEqual(["First child", "Second child"]);
});
