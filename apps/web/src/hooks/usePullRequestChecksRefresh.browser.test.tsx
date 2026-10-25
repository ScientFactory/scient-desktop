import type { PullRequestCheck } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../test/render";
import { usePullRequestChecksRefresh } from "./usePullRequestChecksRefresh";

function ChecksRefresh(props: {
  readonly view: string;
  readonly enabled: boolean;
  readonly checks: ReadonlyArray<PullRequestCheck>;
  readonly refresh: () => void;
}) {
  usePullRequestChecksRefresh({
    refresh: props.refresh,
    enabled: props.enabled,
    key: props.view,
    checks: props.checks,
  });
  return null;
}

async function mountChecksRefresh(view: string, checks: ReadonlyArray<PullRequestCheck>) {
  await using stack = new AsyncDisposableStack();
  const refresh = vi.fn();
  // Nothing here navigates; enabling after mount puts the interval on the owned clock.
  const screen = stack.use(
    await render(<ChecksRefresh view={view} checks={checks} refresh={refresh} enabled={false} />, {
      router: false,
    }),
  );
  stack.use(fakeTimers());
  stack.use(vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible"));
  await screen.rerender(<ChecksRefresh view={view} checks={checks} refresh={refresh} enabled />);
  const environment = stack.move();
  return { refresh, [Symbol.asyncDispose]: () => environment.disposeAsync() };
}

it.each([
  ["a pending check", { status: "pending" }, 45_000],
  ["an action-required check", { status: "action-required" }, 45_000],
  ["a pending check reported as a warning", { status: "pending", outcome: "warning" }, 60_000],
  [
    "an action-required check reported as a warning",
    { status: "action-required", outcome: "warning" },
    60_000,
  ],
] as const)("re-reads %s at its active or settled cadence", async (view, check, intervalMs) => {
  await using probe = await mountChecksRefresh(view, [
    { name: "build", description: null, url: null, ...check },
  ]);
  await act(() => vi.advanceTimersByTimeAsync(intervalMs - 1));
  expect(probe.refresh).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(probe.refresh).toHaveBeenCalledOnce();
});
