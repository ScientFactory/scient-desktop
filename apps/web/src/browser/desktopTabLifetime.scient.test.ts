import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { closeTab, createTab } = vi.hoisted(() => ({
  closeTab: vi.fn<(tabId: string) => Promise<void>>(async () => undefined),
  createTab: vi.fn<(tabId: string) => Promise<void>>(async () => undefined),
}));

vi.mock("~/components/preview/previewBridge", () => ({
  previewBridge: { closeTab, createTab },
}));

vi.mock("./browserRecording", () => ({
  stopBrowserRecording: async () => null,
}));

import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { acquireDesktopTab, withDesktopTab } from "./desktopTabLifetime";

const leaseLock = (tabId: string) => `scient-preview-tab-lease:${tabId}`;

/** Another app window's hold on the tab; Node's lock manager stands in for the shared one. */
function holdInOtherWindow(tabId: string, mode: LockMode) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let granted!: () => void;
  const ready = new Promise<void>((resolve) => {
    granted = resolve;
  });
  const settled = navigator.locks.request(leaseLock(tabId), { mode }, () => {
    granted();
    return held;
  });
  return {
    ready,
    release: () => {
      release();
      return settled;
    },
  };
}

/** Resolves after every desktop tab operation queued so far, including a release's close. */
const desktopTabSettled = (tabId: string) =>
  new Promise<void>((resolve) => withDesktopTab(tabId, async () => resolve()));

async function releaseAndSettle(tabId: string, release: () => void) {
  release();
  await vi.advanceTimersByTimeAsync(0);
  await desktopTabSettled(tabId);
}

describe("desktopTabLifetime across app windows", () => {
  beforeEach(() => {
    __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
    closeTab.mockClear();
    createTab.mockClear();
    vi.stubGlobal("window", globalThis);
    vi.stubGlobal("desktopBridge", { preview: {} });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps the desktop tab open while another app window still uses it", async () => {
    const other = holdInOtherWindow("tab_shared", "shared");
    await other.ready;
    const lease = acquireDesktopTab("tab_shared");
    await lease.ready;

    await releaseAndSettle("tab_shared", lease.release);

    expect(closeTab).not.toHaveBeenCalled();
    await other.release();
  });

  it("closes the desktop tab when no other app window uses it", async () => {
    const lease = acquireDesktopTab("tab_last_window");
    await lease.ready;

    await releaseAndSettle("tab_last_window", lease.release);

    expect(closeTab).toHaveBeenCalledWith("tab_last_window");
  });

  it("creates the desktop tab only after another app window finishes closing it", async () => {
    const closing = holdInOtherWindow("tab_closing", "exclusive");
    await closing.ready;

    const lease = acquireDesktopTab("tab_closing");
    await vi.waitFor(async () => {
      const { pending = [] } = await navigator.locks.query();
      expect(pending.map((lock) => lock.name)).toContain(leaseLock("tab_closing"));
    });
    expect(createTab).not.toHaveBeenCalled();

    await closing.release();
    await lease.ready;
    expect(createTab).toHaveBeenCalledWith("tab_closing", expect.anything());

    await releaseAndSettle("tab_closing", lease.release);
  });
});
