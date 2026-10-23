import { act as _fixtureAct, render as _fixtureRender, type Screen } from "../../../test/render";
import "../../index.css";
import { createRef } from "react";

import type { LegendListRef } from "@legendapp/list/react";
import { EnvironmentId, RunId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vitest/browser";
import { TooltipScrollDismissArea } from "~/components/ui/tooltip";
import { MessagesTimeline } from "~/components/chat/MessagesTimeline";
import { workEntryPathPresentation } from "~/components/chat/MessagesTimeline.logic";
import { TracePathLabel } from "./TracePathLabel";
import { TracePathTooltipEnabled } from "./TracePathLabel.context";

const date = "2026-10-10T00:00:00.000Z";
const fullPath = "/work/project/apps/web/src/deep/view.tsx";
const entry = {
  id: "read-path",
  createdAt: date,
  itemType: "dynamic_tool" as const,
  toolTitle: "Read",
  label: "Read",
  tone: "tool" as const,
  toolLifecycleStatus: "completed" as const,
  toolData: { input: { file_path: fullPath } },
};

async function _cleanupFixture0(_fixture: _Fixture) {
  await _fixture.root0?.unmount();
  _fixture.host?.remove();
  _fixture.root0 = undefined;
  _fixture.host = undefined;
  document.documentElement.classList.remove("dark");
  document.documentElement.style.removeProperty("--popover");
}

async function mount(_fixture: _Fixture, children: React.ReactNode) {
  if (!_fixture.host) {
    _fixture.host = document.createElement("div");
    Object.assign(_fixture.host.style, { width: "360px", height: "400px" });
    document.body.append(_fixture.host);
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.host, router: false }),
    );
  }
  await _fixtureAct(async () => await _fixture.root0!.rerender(children));
}

function label(path = fullPath) {
  const presentation = workEntryPathPresentation(
    { ...entry, toolData: { input: { file_path: path } } },
    "/work/project",
  );
  return <TracePathLabel text={presentation!.text} path={presentation} />;
}

async function fixture(_fixture: _Fixture, path = fullPath, onClick = vi.fn()) {
  await mount(
    _fixture,
    <TooltipScrollDismissArea>
      <button type="button" onClick={onClick}>
        {label(path)}
      </button>
    </TooltipScrollDismissArea>,
  );
  return onClick;
}

it("shows a light, wrapping full-path card only over the shortened path", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  await fixture(_fixture, `/work/project/${"long folder/".repeat(10)}deep/view.tsx`);
  await page.getByText("deep/view.tsx", { exact: true }).hover();
  await expect.element(page.getByRole("tooltip")).toBeVisible();
  const popup = document.querySelector<HTMLElement>('[role="tooltip"]')!;
  expect(popup.textContent).toBe(`/work/project/${"long folder/".repeat(10)}deep/view.tsx`);
  expect(getComputedStyle(popup).backgroundColor).toBe("rgb(255, 255, 255)");
  expect(popup.scrollWidth).toBeLessThanOrEqual(popup.clientWidth + 1);
  await expect
    .poll(() => popup.getBoundingClientRect().width)
    .toBeLessThanOrEqual(Math.min(300, window.innerWidth));
  expect(popup.clientHeight).toBeGreaterThan(parseFloat(getComputedStyle(popup).lineHeight) * 2);
  await userEvent.keyboard("{Escape}");
  await expect.element(page.getByRole("tooltip")).not.toBeInTheDocument();
});

it("uses the dark and custom theme surfaces", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  document.documentElement.classList.add("dark");
  await fixture(_fixture);
  await page.getByText("deep/view.tsx", { exact: true }).hover();
  await expect.element(page.getByRole("tooltip")).toBeVisible();
  const popup = document.querySelector<HTMLElement>('[role="tooltip"]')!;
  expect(getComputedStyle(popup).backgroundColor).not.toBe("rgb(255, 255, 255)");
  document.documentElement.style.setProperty("--popover", "rgb(236, 245, 241)");
  expect(getComputedStyle(popup).backgroundColor).toBe("rgb(236, 245, 241)");
});

it("opens on keyboard focus and leaves the row click intact", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const clicked = await fixture(_fixture);
  await userEvent.tab();
  await userEvent.tab();
  await expect.element(page.getByRole("tooltip")).toBeVisible();
  expect(document.activeElement?.hasAttribute("data-trace-path")).toBe(true);
  await userEvent.keyboard("{Enter}");
  expect(clicked).toHaveBeenCalledTimes(1);
  await page.getByText("deep/view.tsx", { exact: true }).click();
  expect(clicked).toHaveBeenCalledTimes(2);
});

it("dismisses hovered cards when the timeline scrolls or the row changes", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  await fixture(_fixture);
  await page.getByText("deep/view.tsx", { exact: true }).hover();
  await expect.element(page.getByRole("tooltip")).toBeVisible();
  _fixture.host!.querySelector("button")!.dispatchEvent(new Event("scroll", { bubbles: true }));
  await expect.element(page.getByRole("tooltip")).not.toBeInTheDocument();
  await userEvent.unhover(page.getByRole("button"));
  await page.getByText("deep/view.tsx", { exact: true }).hover();
  await expect.element(page.getByRole("tooltip")).toBeVisible();
  await fixture(_fixture, "/another/project/deep/view.tsx");
  await expect.element(page.getByRole("tooltip")).not.toBeInTheDocument();
});

it("gives the animation copy no hover trigger or keyboard stop", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  await mount(
    _fixture,
    <>
      {label()}
      <TracePathTooltipEnabled value={false}>
        <span aria-hidden>{label()}</span>
      </TracePathTooltipEnabled>
    </>,
  );
  expect(_fixture.host!.querySelectorAll("[data-trace-path]")).toHaveLength(1);
  expect(_fixture.host!.querySelector("[aria-hidden] [tabindex]")).toBeNull();
});

it.each([false, true])(
  "integrates with the actual %s live timeline and disclosure",
  async (live) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const listRef = createRef<LegendListRef>();
    const read = {
      ...entry,
      runId: RunId.make("run-1"),
      toolLifecycleStatus: live ? ("inProgress" as const) : ("completed" as const),
    };
    await mount(
      _fixture,
      <MessagesTimeline
        emptyPlaceholderInset={0}
        listRef={listRef}
        routeThreadKey="trace-path-browser"
        timelineEntries={[{ id: "read-path", kind: "work", createdAt: date, entry: read }]}
        isWorking={live}
        activeTurnInProgress={live}
        activeTurnStartedAt={live ? date : null}
        latestRun={
          live
            ? { runId: RunId.make("run-1"), status: "running", startedAt: date, completedAt: null }
            : null
        }
        runningRunId={live ? RunId.make("run-1") : null}
        turnDiffSummaries={[]}
        onOpenTurnDiff={() => {}}
        onOpenThread={() => {}}
        onForkFromRun={() => Promise.resolve()}
        onRollbackCheckpoint={() => {}}
        supportsConversationRollback={false}
        onRevertToTurnCount={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        activeThreadEnvironmentId={EnvironmentId.make("trace-path-tests")}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot="/work/project"
        runs={[]}
        anchorMessageId={null}
        onAnchorReady={() => {}}
        onAnchorSizeChanged={() => {}}
        contentInsetEndAdjustment={100}
        onIsAtEndChange={() => {}}
        onManualNavigation={() => {}}
      />,
    );
    if (!live) await page.getByRole("button", { name: /Worked for/ }).click();
    await expect.poll(() => _fixture.host!.querySelectorAll("[data-trace-path]").length).toBe(1);
    // The live animation has the same text but never another trigger.
    const trigger = page.getByText("deep/view.tsx", { exact: true });
    await trigger.hover();
    await expect.element(page.getByRole("tooltip")).toHaveTextContent(fullPath);
    await trigger.click();
    await expect.poll(() => _fixture.host!.querySelector('[aria-expanded="true"]')).not.toBeNull();
    if (live) await page.getByRole("button", { name: "Read deep/view.tsx", exact: true }).click();
    expect(_fixture.host!.textContent).toContain(fullPath);
    expect(_fixture.host!.querySelector("button button")).toBeNull();
  },
);

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    host: undefined! as HTMLDivElement | undefined,
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
