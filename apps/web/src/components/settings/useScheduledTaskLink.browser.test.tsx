import { render as _fixtureRender, type Screen, act } from "../../../test/render";

import { expect, it, vi } from "vite-plus/test";
import { ScheduledTaskId } from "@t3tools/contracts";
import { useScheduledTaskLink } from "./useScheduledTaskLink";

async function _cleanupFixture0(_fixture: _Fixture) {
  await vi.unstubAllGlobals();
}

it("waits for tasks, opens changed or re-entered links, and ignores refreshed data", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const opened = vi.fn();
  const a = ScheduledTaskId.make("task-a");
  const b = ScheduledTaskId.make("task-b");
  function Probe({ target, available }: { target?: ScheduledTaskId; available?: ScheduledTaskId }) {
    useScheduledTaskLink(target, available, () => opened(target));
    return null;
  }
  let root: Screen | undefined;
  try {
    await act(async () => {
      root = _fixture.stack.use(
        await _fixtureRender(null, { container: document.createElement("div"), router: false }),
      );
      await root.rerender(<Probe target={a} />);
    });
    expect(opened).not.toHaveBeenCalled();
    await act(async () => await root!.rerender(<Probe target={a} available={a} />));
    expect(opened).toHaveBeenCalledExactlyOnceWith(a);
    await act(async () => await root!.rerender(<Probe target={a} available={a} />));
    expect(opened).toHaveBeenCalledTimes(1);
    await act(async () => await root!.rerender(<Probe target={b} available={a} />));
    expect(opened).toHaveBeenCalledTimes(1);
    await act(async () => await root!.rerender(<Probe target={a} available={a} />));
    expect(opened).toHaveBeenCalledTimes(2);
    await act(async () => await root!.rerender(<Probe target={b} available={b} />));
    expect(opened).toHaveBeenLastCalledWith(b);
    await act(async () => await root!.rerender(<Probe />));
    await act(async () => await root!.rerender(<Probe target={b} available={b} />));
    expect(opened).toHaveBeenCalledTimes(4);
  } finally {
    await act(async () => await root?.unmount());
  }
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    stack,
    cleanup,
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
