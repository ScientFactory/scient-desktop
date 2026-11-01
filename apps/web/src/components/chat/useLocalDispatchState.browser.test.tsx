import { useLayoutEffect } from "react";
import { expect, it, vi } from "vite-plus/test";
import { render } from "../../../test/render";
import { useLocalDispatchState } from "./useLocalDispatchState";

it("keeps dispatch state and late callbacks scoped to their environment and thread", async () => {
  let latest: ReturnType<typeof useLocalDispatchState> | undefined;
  function Owner({ threadKey }: { threadKey: string }) {
    const state = useLocalDispatchState({
      routeThreadKey: threadKey,
      activeThread: undefined,
      activeLatestRun: null,
      latestUserMessageId: null,
      phase: "ready",
      activePendingApproval: null,
      activePendingUserInput: null,
      threadError: null,
    });
    useLayoutEffect(() => {
      latest = state;
    }, [state]);
    return null;
  }
  const read = () => {
    if (!latest) throw new Error("The local dispatch owner did not mount");
    return latest;
  };
  // Route identity is an explicit input; this owner does not consume router context.
  await using screen = await render(<Owner threadKey="environment-a:same-thread" />, {
    router: false,
  });
  const oldBegin = read().beginLocalDispatch;
  const oldReset = read().resetLocalDispatch;
  oldBegin();
  await vi.waitFor(() => expect(read().isSendBusy).toBe(true));

  await screen.rerender(<Owner threadKey="environment-b:same-thread" />);
  expect(read().isSendBusy).toBe(false);
  read().beginLocalDispatch({ preparingWorktree: true });
  await vi.waitFor(() => expect(read().isPreparingWorktree).toBe(true));

  oldReset();
  await screen.rerender(<Owner threadKey="environment-b:same-thread" />);
  expect(read().isSendBusy).toBe(true);
  expect(read().isPreparingWorktree).toBe(true);
  oldBegin();
  await screen.rerender(<Owner threadKey="environment-b:same-thread" />);
  expect(read().isSendBusy).toBe(true);
  expect(read().isPreparingWorktree).toBe(true);
});
