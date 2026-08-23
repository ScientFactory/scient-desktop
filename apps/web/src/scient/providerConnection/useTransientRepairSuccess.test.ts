import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useEffect: (effect: () => void | (() => void)) => {
      effect();
    },
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

import { REPAIR_SUCCESS_NOTICE_MS, useTransientRepairSuccess } from "./useTransientRepairSuccess";

describe("useTransientRepairSuccess", () => {
  beforeEach(() => {
    hooks.reset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows repair success for four seconds and ignores other runtime actions", async () => {
    hooks.beginRender();
    let notice = useTransientRepairSuccess(true);

    notice.reportRuntimeActionSucceeded("remove");
    hooks.beginRender();
    notice = useTransientRepairSuccess(true);
    expect(notice.repairSucceededRecently).toBe(false);

    notice.reportRuntimeActionSucceeded("repair");
    hooks.beginRender();
    notice = useTransientRepairSuccess(true);
    expect(notice.repairSucceededRecently).toBe(true);

    await vi.advanceTimersByTimeAsync(REPAIR_SUCCESS_NOTICE_MS - 1);
    hooks.beginRender();
    notice = useTransientRepairSuccess(true);
    expect(notice.repairSucceededRecently).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    hooks.beginRender();
    notice = useTransientRepairSuccess(true);
    expect(notice.repairSucceededRecently).toBe(false);
  });
});
