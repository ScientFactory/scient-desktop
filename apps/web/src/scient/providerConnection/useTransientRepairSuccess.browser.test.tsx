import { act, useLayoutEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { REPAIR_SUCCESS_NOTICE_MS, useTransientRepairSuccess } from "./useTransientRepairSuccess";

let root: Root | undefined;
let host: HTMLDivElement;
beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));

function mount(node: ReactNode) {
  if (!root) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }
  act(() => root!.render(node));
  return host;
}
afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = undefined;
  vi.unstubAllGlobals();
});

describe("useTransientRepairSuccess", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows repair success for four seconds and ignores other runtime actions", async () => {
    let notice!: ReturnType<typeof useTransientRepairSuccess>;
    function Probe() {
      const value = useTransientRepairSuccess(true);
      useLayoutEffect(() => {
        notice = value;
      });
      return null;
    }
    mount(<Probe />);

    act(() => notice.reportRuntimeActionSucceeded("remove"));

    expect(notice.repairSucceededRecently).toBe(false);

    act(() => notice.reportRuntimeActionSucceeded("repair"));

    expect(notice.repairSucceededRecently).toBe(true);

    await act(() => vi.advanceTimersByTimeAsync(REPAIR_SUCCESS_NOTICE_MS - 1));

    expect(notice.repairSucceededRecently).toBe(true);

    await act(() => vi.advanceTimersByTimeAsync(1));

    expect(notice.repairSucceededRecently).toBe(false);
  });
});
