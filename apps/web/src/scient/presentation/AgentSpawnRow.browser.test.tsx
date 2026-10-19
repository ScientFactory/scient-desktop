import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
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
let renderer: Root | undefined;
let container: HTMLDivElement;
function mount(node: ReactNode) {
  container = document.createElement("div");
  document.body.append(container);
  renderer = createRoot(container);
  renderer.render(node);
}
afterEach(async () => {
  await act(async () => renderer?.unmount());
  container?.remove();
  vi.unstubAllGlobals();
});

function fixture(
  members: Member[],
  expanded = false,
  missingRoster: boolean | ReadonlyArray<string> = false,
) {
  const onOpenThread = vi.fn();
  let expandedSpawnEntryIds = new Set(expanded ? ["group"] : []);
  const onToggleSpawnRow = vi.fn((id: string, open: boolean) => {
    expandedSpawnEntryIds = new Set(expandedSpawnEntryIds);
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
      mount(f.render());
    });
    expect([...container.querySelectorAll("button")]).toHaveLength(1);
    expect(container.innerHTML).not.toContain(assignment);
    await act(async () => container.querySelector("button")!.click());
    await act(async () => renderer!.render(f.render()));
    const details = [...container.querySelectorAll<HTMLElement>('[role="button"]')];
    expect(details).toHaveLength(2);
    expect(details[0]!.ariaLabel!.length).toBeLessThan(120);
    const child = [...container.querySelectorAll("button")].find((button) =>
      button.ariaLabel?.startsWith("Open "),
    )!;
    await act(async () => child.click());
    expect(f.onOpenThread).toHaveBeenCalledWith("child-one");
    expect(details[0]!.getAttribute("aria-expanded")).toBe("false");
    await act(async () =>
      details[0]!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      ),
    );
    expect(container.querySelector("pre")!.textContent).toContain(assignment);
    expect(container.querySelector("pre")!.textContent).toContain("Observed result");
    members[0] = { ...members[0]!, status: "completed", completedAt: now };
    await act(async () => renderer!.render(f.render()));
    expect([...container.querySelectorAll<HTMLElement>('[role="button"]')]).toHaveLength(2);
    expect(f.onToggleSpawnRow).toHaveBeenCalledTimes(1);
  },
);

it("renders missing Scient roster members from retained items without inventing a model", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const f = fixture([member("one")], true, true);
  await act(async () => {
    mount(f.render());
  });
  const detail = container.querySelector<HTMLElement>('[role="button"]')!;
  await act(async () => detail.click());
  expect(container.querySelector("pre")!.textContent).toContain(assignment);
  expect(f.onOpenThread).not.toHaveBeenCalled();
});

it.each([
  ["codex", "claudeAgent"],
  ["scient", "codex"],
])("preserves legacy child links for mixed/non-Scient groups %s/%s", async (first, second) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const f = fixture([member("one", first), member("two", second)]);
  await act(async () => {
    mount(f.render());
  });
  expect([
    ...container.querySelectorAll<HTMLButtonElement>('[aria-label="Open child thread"]'),
  ]).toHaveLength(2);
  expect(container.innerHTML).toContain("Open ");
  await act(async () =>
    [
      ...container.querySelectorAll<HTMLButtonElement>('[aria-label="Open child thread"]'),
    ][1]!.click(),
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
    mount(f.render());
  });
  expect(
    [...container.querySelectorAll<HTMLElement>('[role="button"]')].map(
      (row) => row.ariaLabel!.split(",")[0],
    ),
  ).toEqual(["First child", "Second child"]);
  knownIds.push("one");
  await act(async () => renderer!.render(f.render()));
  expect(
    [...container.querySelectorAll<HTMLElement>('[role="button"]')].map(
      (row) => row.ariaLabel!.split(",")[0],
    ),
  ).toEqual(["First child", "Second child"]);
});
