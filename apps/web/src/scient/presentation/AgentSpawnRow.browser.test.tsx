import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import { type ReactNode } from "react";

import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it, vi } from "vite-plus/test";
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

async function mount(_fixture: _Fixture, node: ReactNode) {
  _fixture.container = document.createElement("div");
  document.body.append(_fixture.container);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.container, router: false }),
  );
  await _fixture.root0.rerender(node);
}
async function _cleanupFixture0(_fixture: _Fixture) {
  await act(async () => await _fixture.root0?.unmount());
  _fixture.container?.remove();
  vi.unstubAllGlobals();
}

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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const members = [member("one"), member("two", "scient", false)].map((item) => ({
      ...item,
      origin,
    }));
    const f = fixture(members);
    await act(async () => {
      await mount(_fixture, f.render());
    });
    expect([..._fixture.container.querySelectorAll("button")]).toHaveLength(1);
    expect(_fixture.container.innerHTML).not.toContain(assignment);
    await act(async () => _fixture.container.querySelector("button")!.click());
    await act(async () => await _fixture.root0!.rerender(f.render()));
    const details = [..._fixture.container.querySelectorAll<HTMLElement>('[role="button"]')];
    expect(details).toHaveLength(2);
    expect(details[0]!.ariaLabel!.length).toBeLessThan(120);
    const child = [..._fixture.container.querySelectorAll("button")].find((button) =>
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
    expect(_fixture.container.querySelector("pre")!.textContent).toContain(assignment);
    expect(_fixture.container.querySelector("pre")!.textContent).toContain("Observed result");
    members[0] = { ...members[0]!, status: "completed", completedAt: now };
    await act(async () => await _fixture.root0!.rerender(f.render()));
    expect([..._fixture.container.querySelectorAll<HTMLElement>('[role="button"]')]).toHaveLength(
      2,
    );
    expect(f.onToggleSpawnRow).toHaveBeenCalledTimes(1);
  },
);

it("renders missing Scient roster members from retained items without inventing a model", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const f = fixture([member("one")], true, true);
  await act(async () => {
    await mount(_fixture, f.render());
  });
  const detail = _fixture.container.querySelector<HTMLElement>('[role="button"]')!;
  await act(async () => detail.click());
  expect(_fixture.container.querySelector("pre")!.textContent).toContain(assignment);
  expect(f.onOpenThread).not.toHaveBeenCalled();
});

it.each([
  ["codex", "claudeAgent"],
  ["scient", "codex"],
])("preserves legacy child links for mixed/non-Scient groups %s/%s", async (first, second) => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const f = fixture([member("one", first), member("two", second)]);
  await act(async () => {
    await mount(_fixture, f.render());
  });
  expect([
    ..._fixture.container.querySelectorAll<HTMLButtonElement>('[aria-label="Open child thread"]'),
  ]).toHaveLength(2);
  expect(_fixture.container.innerHTML).toContain("Open ");
  await act(async () =>
    [
      ..._fixture.container.querySelectorAll<HTMLButtonElement>('[aria-label="Open child thread"]'),
    ][1]!.click(),
  );
  expect(f.onOpenThread).toHaveBeenCalledWith("child-two");
});

it("keeps retained first-seen order while a partial Scient roster catches up", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const members = [
    { ...member("one"), title: "First child" },
    { ...member("two"), title: "Second child" },
  ];
  const knownIds = ["two"];
  const f = fixture(members, true, knownIds);
  await act(async () => {
    await mount(_fixture, f.render());
  });
  expect(
    [..._fixture.container.querySelectorAll<HTMLElement>('[role="button"]')].map(
      (row) => row.ariaLabel!.split(",")[0],
    ),
  ).toEqual(["First child", "Second child"]);
  knownIds.push("one");
  await act(async () => await _fixture.root0!.rerender(f.render()));
  expect(
    [..._fixture.container.querySelectorAll<HTMLElement>('[role="button"]')].map(
      (row) => row.ariaLabel!.split(",")[0],
    ),
  ).toEqual(["First child", "Second child"]);
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    container: undefined! as HTMLDivElement,
    stack,
    cleanup,
    root0: undefined! as Screen | undefined,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;
