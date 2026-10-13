import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { ScheduledTaskId } from "@t3tools/contracts";
import { useScheduledTaskLink } from "./useScheduledTaskLink";

afterEach(() => vi.unstubAllGlobals());

it("waits for tasks, opens changed or re-entered links, and ignores refreshed data", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const opened = vi.fn();
  const a = ScheduledTaskId.make("task-a");
  const b = ScheduledTaskId.make("task-b");
  function Probe({ target, available }: { target?: ScheduledTaskId; available?: ScheduledTaskId }) {
    useScheduledTaskLink(target, available, () => opened(target));
    return null;
  }
  let root: ReactTestRenderer | undefined;
  try {
    await act(async () => {
      root = create(<Probe target={a} />);
    });
    expect(opened).not.toHaveBeenCalled();
    await act(async () => root!.update(<Probe target={a} available={a} />));
    expect(opened).toHaveBeenCalledExactlyOnceWith(a);
    await act(async () => root!.update(<Probe target={a} available={a} />));
    expect(opened).toHaveBeenCalledTimes(1);
    await act(async () => root!.update(<Probe target={b} available={a} />));
    expect(opened).toHaveBeenCalledTimes(1);
    await act(async () => root!.update(<Probe target={a} available={a} />));
    expect(opened).toHaveBeenCalledTimes(2);
    await act(async () => root!.update(<Probe target={b} available={b} />));
    expect(opened).toHaveBeenLastCalledWith(b);
    await act(async () => root!.update(<Probe />));
    await act(async () => root!.update(<Probe target={b} available={b} />));
    expect(opened).toHaveBeenCalledTimes(4);
  } finally {
    await act(async () => root?.unmount());
  }
});
