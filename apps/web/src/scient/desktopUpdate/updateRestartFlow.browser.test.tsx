import "../../index.css";

import type { DesktopUpdateActionResult, DesktopUpdateState } from "@t3tools/contracts";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

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
vi.mock("../../state/desktopUpdate", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
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

let host: HTMLDivElement;
let root: Root;

function mount(footerStyle = "position:fixed;left:24px;bottom:24px;width:240px") {
  host = document.createElement("div");
  host.setAttribute("style", footerStyle);
  document.body.append(host);
  root = createRoot(host);
  root.render(tree(true));
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

function footerButton(): HTMLButtonElement {
  const button = host.querySelector("button");
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

async function downloadThroughFooter() {
  await vi.waitFor(() => expect(footerButton().textContent).toContain("Update"));
  footerButton().click();
  await vi.waitFor(() => expect(anchoredNotice() ?? cornerNotice()).not.toBeNull());
}

beforeEach(() => {
  Object.assign(window, { desktopBridge: bridge });
  updateStore.set(updateState());
  bridge.downloadUpdate.mockClear();
  bridge.installUpdate.mockClear();
});

afterEach(() => {
  root.unmount();
  host.remove();
  delete (window as { desktopBridge?: unknown }).desktopBridge;
  vi.restoreAllMocks();
});

describe("update restart flow", () => {
  it("footer Restart installs immediately, with no confirmation", async () => {
    const confirm = vi.spyOn(window, "confirm");
    updateStore.set(downloaded());
    mount();

    await vi.waitFor(() => expect(footerButton().textContent).toBe("Restart"));
    footerButton().click();

    await vi.waitFor(() => expect(bridge.installUpdate).toHaveBeenCalledTimes(1));
    expect(confirm).not.toHaveBeenCalled();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  });

  it("a finished download shows Restart now above the button, and it installs", async () => {
    mount();
    await downloadThroughFooter();

    const notice = anchoredNotice();
    expect(notice).not.toBeNull();
    expect(cornerNotice()).toBeNull();
    expect(notice?.textContent).toContain("Update 0.6.19 is ready");

    await vi.waitFor(() => {
      const noticeBox = anchoredNotice()!.getBoundingClientRect();
      const buttonBox = footerButton().getBoundingClientRect();
      expect(noticeBox.bottom).toBeLessThanOrEqual(buttonBox.top + 1);
      expect(buttonBox.top - noticeBox.bottom).toBeLessThan(40);
      expect(noticeBox.right).toBeGreaterThan(buttonBox.left);
      expect(noticeBox.left).toBeLessThan(buttonBox.right);
    });

    restartNow(notice!)?.click();
    await vi.waitFor(() => expect(bridge.installUpdate).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(anchoredNotice()).toBeNull());
  });

  it(
    "the notice steps aside after 5 seconds, leaving Restart in the footer",
    async () => {
      mount();
      await downloadThroughFooter();
      expect(anchoredNotice()).not.toBeNull();

      await vi.waitFor(() => expect(anchoredNotice()).toBeNull(), {
        timeout: SCIENT_UPDATE_READY_NOTICE_TIMEOUT_MS + 3_000,
        interval: 100,
      });
      expect(footerButton().textContent).toBe("Restart");
      expect(bridge.installUpdate).not.toHaveBeenCalled();
    },
    SCIENT_UPDATE_READY_NOTICE_TIMEOUT_MS + 10_000,
  );

  it("closing the notice leaves Restart in the footer without installing", async () => {
    mount();
    await downloadThroughFooter();

    anchoredNotice()!.querySelector<HTMLButtonElement>('[data-slot="toast-close"]')!.click();

    await vi.waitFor(() => expect(anchoredNotice()).toBeNull());
    expect(footerButton().textContent).toBe("Restart");
    expect(bridge.installUpdate).not.toHaveBeenCalled();
  });

  it("uses the corner stack when the sidebar footer is off screen", async () => {
    mount("position:fixed;left:-600px;bottom:24px;width:240px");
    await downloadThroughFooter();

    expect(anchoredNotice()).toBeNull();
    const notice = cornerNotice();
    expect(notice?.textContent).toContain("Update 0.6.19 is ready");
    expect(restartNow(notice!)).toBeDefined();
  });

  it("unmounting the footer closes its notice", async () => {
    mount();
    await downloadThroughFooter();
    expect(anchoredNotice()).not.toBeNull();

    root.render(tree(false));

    await vi.waitFor(() => expect(anchoredNotice()).toBeNull());
  });
});
