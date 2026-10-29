import { act, fakeTimers, render as _fixtureRender, type Screen } from "../../../test/render";
import "../../index.css";

import type { DesktopUpdateActionResult, DesktopUpdateState } from "@t3tools/contracts";

import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vitest/browser";

const updateStore = vi.hoisted(() => {
  let state: DesktopUpdateState | null = null;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set: (next: DesktopUpdateState | null) => {
      state = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});

vi.mock("../../env", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  isElectron: true,
}));
vi.mock("../../state/desktopUpdate", async (importOriginal) => {
  const { useSyncExternalStore } = await import("react");
  return {
    ...(await importOriginal<object>()),
    useDesktopUpdateState: () => useSyncExternalStore(updateStore.subscribe, updateStore.get),
  };
});
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useParams: () => null,
}));

import { SidebarUpdatePill } from "../../components/sidebar/SidebarUpdatePill";
import { AnchoredToastProvider, ToastProvider } from "../../components/ui/toast";
import { SCIENT_UPDATE_READY_NOTICE_TIMEOUT_MS } from "./updateReadyNotice";

function updateState(overrides: Partial<DesktopUpdateState> = {}): DesktopUpdateState {
  return {
    enabled: true,
    status: "available",
    channel: "latest",
    currentVersion: "0.6.18",
    hostArch: "arm64",
    appArch: "arm64",
    runningUnderArm64Translation: false,
    availableVersion: "0.6.19",
    downloadedVersion: null,
    releaseNotes: [],
    omittedReleaseCount: 0,
    downloadPercent: null,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: true,
    ...overrides,
  };
}

const downloaded = () =>
  updateState({ status: "downloaded", downloadedVersion: "0.6.19", downloadPercent: 100 });

function result(state: DesktopUpdateState, completed = true): DesktopUpdateActionResult {
  return { accepted: true, completed, state };
}

const bridge = {
  downloadUpdate: vi.fn(async () => {
    updateStore.set(downloaded());
    return result(downloaded());
  }),
  installUpdate: vi.fn(async () => result(downloaded())),
  checkForUpdate: vi.fn(),
  openExternal: vi.fn(async () => true),
};

async function mount(
  _fixture: _Fixture,
  footerStyle = "position:fixed;left:24px;bottom:24px;width:240px",
) {
  _fixture.host = document.createElement("div");
  _fixture.host.setAttribute("style", footerStyle);
  document.body.append(_fixture.host);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.host, router: false }),
  );
  await _fixture.root0.rerender(tree(true));
}

function tree(showFooterControl: boolean) {
  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <ul>{showFooterControl ? <SidebarUpdatePill /> : null}</ul>
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

function footerButton(_fixture: _Fixture): HTMLButtonElement {
  const button = _fixture.host.querySelector("button");
  if (!button) throw new Error("update button is not rendered");
  return button;
}

const anchoredNotice = () =>
  document.querySelector<HTMLElement>(
    '[data-slot="toast-viewport-anchored"] [data-slot="toast-popup"]',
  );
// Corner toasts carry no popup slot; a non-empty corner viewport means a notice is up.
const cornerNotice = () => {
  const viewport = document.querySelector<HTMLElement>('[data-slot="toast-viewport"]');
  return viewport && viewport.textContent !== "" ? viewport : null;
};
const restartNow = (notice: HTMLElement) =>
  [...notice.querySelectorAll("button")].find((button) => button.textContent === "Restart now");

async function downloadThroughFooter(_fixture: _Fixture) {
  await vi.waitFor(() => expect(footerButton(_fixture).textContent).toContain("Update"));
  footerButton(_fixture).click();
  await vi.waitFor(() => expect(anchoredNotice() ?? cornerNotice()).not.toBeNull());
}

async function _setupFixture0(_fixture: _Fixture) {
  Object.assign(window, { desktopBridge: bridge });
  updateStore.set(updateState());
  bridge.downloadUpdate.mockClear();
  bridge.installUpdate.mockClear();
}

async function _cleanupFixture1(_fixture: _Fixture) {
  await _fixture.root0.unmount();
  _fixture.host.remove();
  delete (window as { desktopBridge?: unknown }).desktopBridge;
  vi.restoreAllMocks();
}

describe("update restart flow", () => {
  it("footer Restart installs immediately, with no confirmation", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const confirm = vi.spyOn(window, "confirm");
    updateStore.set(downloaded());
    await mount(_fixture);

    await vi.waitFor(() => expect(footerButton(_fixture).textContent).toBe("Restart"));
    footerButton(_fixture).click();

    await vi.waitFor(() => expect(bridge.installUpdate).toHaveBeenCalledTimes(1));
    expect(confirm).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it("a finished download shows Restart now above the button, and it installs", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture);
    await downloadThroughFooter(_fixture);

    const notice = anchoredNotice();
    expect(notice).not.toBeNull();
    expect(cornerNotice()).toBeNull();
    expect(notice?.textContent).toContain("Update 0.6.19 is ready");

    await vi.waitFor(() => {
      const noticeBox = anchoredNotice()!.getBoundingClientRect();
      const buttonBox = footerButton(_fixture).getBoundingClientRect();
      expect(noticeBox.bottom).toBeLessThanOrEqual(buttonBox.top + 1);
      expect(buttonBox.top - noticeBox.bottom).toBeLessThan(40);
      expect(noticeBox.right).toBeGreaterThan(buttonBox.left);
      expect(noticeBox.left).toBeLessThan(buttonBox.right);
    });

    restartNow(notice!)?.click();
    await vi.waitFor(() => expect(bridge.installUpdate).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(anchoredNotice()).toBeNull());
  });

  it("the notice steps aside after 5 seconds, leaving Restart in the footer", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture);
    using _clock = fakeTimers();
    await downloadThroughFooter(_fixture);
    expect(anchoredNotice()).not.toBeNull();

    await act(() => vi.advanceTimersByTimeAsync(SCIENT_UPDATE_READY_NOTICE_TIMEOUT_MS));
    await vi.waitFor(() => expect(anchoredNotice()).toBeNull());
    expect(footerButton(_fixture).textContent).toBe("Restart");
    expect(bridge.installUpdate).not.toHaveBeenCalled();
  });

  it("closing the notice leaves Restart in the footer without installing", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture);
    await downloadThroughFooter(_fixture);

    anchoredNotice()!.querySelector<HTMLButtonElement>('[data-slot="toast-close"]')!.click();

    await vi.waitFor(() => expect(anchoredNotice()).toBeNull());
    expect(footerButton(_fixture).textContent).toBe("Restart");
    expect(bridge.installUpdate).not.toHaveBeenCalled();
  });

  it("a failed install releases the footer so Restart can be tried again", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    bridge.installUpdate.mockImplementationOnce(async () => {
      throw new Error("IPC closed");
    });
    updateStore.set(downloaded());
    await mount(_fixture);

    await vi.waitFor(() => expect(footerButton(_fixture).textContent).toBe("Restart"));
    footerButton(_fixture).click();
    await vi.waitFor(() => expect(cornerNotice()?.textContent).toContain("IPC closed"));
    await vi.waitFor(() => expect(footerButton(_fixture).getAttribute("aria-disabled")).toBeNull());

    footerButton(_fixture).click();
    await vi.waitFor(() => expect(bridge.installUpdate).toHaveBeenCalledTimes(2));
  });

  it("Restart now holds the footer pending, so a second click sends nothing", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    let finishInstall: (value: DesktopUpdateActionResult) => void = () => {};
    bridge.installUpdate.mockImplementationOnce(
      () => new Promise<DesktopUpdateActionResult>((resolve) => (finishInstall = resolve)),
    );
    await mount(_fixture);
    await downloadThroughFooter(_fixture);
    await vi.waitFor(() => expect(footerButton(_fixture).getAttribute("aria-disabled")).toBeNull());

    restartNow(anchoredNotice()!)?.click();
    await vi.waitFor(() =>
      expect(footerButton(_fixture).getAttribute("aria-disabled")).toBe("true"),
    );
    footerButton(_fixture).click();
    expect(bridge.installUpdate).toHaveBeenCalledTimes(1);

    finishInstall(result(downloaded()));
    await vi.waitFor(() => expect(footerButton(_fixture).getAttribute("aria-disabled")).toBeNull());
    expect(bridge.installUpdate).toHaveBeenCalledTimes(1);
  });

  it("closes the nightly release-notes popover so it cannot cover the notice", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const nightly = { channel: "nightly" as const, availableVersion: "0.6.19-nightly.2" };
    const notes = [{ version: "0.6.19-nightly.2", items: ["Newest change"], totalItems: 1 }];
    updateStore.set(updateState({ ...nightly, releaseNotes: notes }));
    bridge.downloadUpdate.mockImplementationOnce(async () => {
      const done = updateState({
        ...nightly,
        releaseNotes: notes,
        status: "downloaded",
        downloadedVersion: nightly.availableVersion,
        downloadPercent: 100,
      });
      updateStore.set(done);
      return result(done);
    });
    await mount(_fixture);
    const popover = () => document.querySelector('[aria-label="Update release notes"]');

    await vi.waitFor(() => expect(footerButton(_fixture).textContent).toContain("Update"));
    await userEvent.hover(footerButton(_fixture));
    await vi.waitFor(() => expect(popover()).not.toBeNull());

    footerButton(_fixture).click();
    await vi.waitFor(() => expect(anchoredNotice()).not.toBeNull());
    await vi.waitFor(() => expect(popover()).toBeNull());

    const action = restartNow(anchoredNotice()!)!;
    const box = action.getBoundingClientRect();
    expect(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)).toBe(action);
  });

  it("closing the popover does not swallow a later keyboard focus", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const nightly = { channel: "nightly" as const, availableVersion: "0.6.19-nightly.2" };
    const notes = [{ version: "0.6.19-nightly.2", items: ["Newest change"], totalItems: 1 }];
    updateStore.set(updateState({ ...nightly, releaseNotes: notes }));
    bridge.downloadUpdate.mockImplementationOnce(async () => {
      const done = updateState({
        ...nightly,
        releaseNotes: notes,
        status: "downloaded",
        downloadedVersion: nightly.availableVersion,
        downloadPercent: 100,
      });
      updateStore.set(done);
      return result(done);
    });
    const elsewhere = document.createElement("button");
    _fixture.cleanup.defer(() => elsewhere.remove());
    elsewhere.textContent = "Elsewhere";
    document.body.prepend(elsewhere);
    await mount(_fixture);
    const popover = () => document.querySelector('[aria-label="Update release notes"]');

    await vi.waitFor(() => expect(footerButton(_fixture).textContent).toContain("Update"));
    elsewhere.focus();
    await userEvent.hover(footerButton(_fixture));
    await vi.waitFor(() => expect(popover()).not.toBeNull());
    footerButton(_fixture).click();
    await vi.waitFor(() => expect(anchoredNotice()).not.toBeNull());
    await vi.waitFor(() => expect(popover()).toBeNull());
    expect(document.activeElement).toBe(elsewhere);

    using _clock = fakeTimers();
    await userEvent.unhover(footerButton(_fixture));
    // Leaving starts the trigger's 150 ms hover-close timer, and an imperative open does not
    // cancel it. Focus later, as a person would, or that timer closes the focus-opened popover.
    await act(() => vi.advanceTimersByTimeAsync(300));
    await userEvent.tab();
    expect(document.activeElement).toBe(footerButton(_fixture));
    await vi.waitFor(() => expect(popover()).not.toBeNull());
    elsewhere.remove();
  });

  it("uses the corner stack when the sidebar footer is off screen", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture, "position:fixed;left:-600px;bottom:24px;width:240px");
    await downloadThroughFooter(_fixture);

    expect(anchoredNotice()).toBeNull();
    const notice = cornerNotice();
    expect(notice?.textContent).toContain("Update 0.6.19 is ready");
    expect(restartNow(notice!)).toBeDefined();
  });

  it("unmounting the footer closes its notice", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await mount(_fixture);
    await downloadThroughFooter(_fixture);
    expect(anchoredNotice()).not.toBeNull();

    await _fixture.root0.rerender(tree(false));

    await vi.waitFor(() => expect(anchoredNotice()).toBeNull());
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    host: undefined! as HTMLDivElement,
    stack,
    cleanup,
    root0: undefined! as Screen,
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
