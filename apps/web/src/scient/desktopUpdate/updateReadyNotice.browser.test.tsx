import type { DesktopUpdateActionResult, DesktopUpdateState } from "@t3tools/contracts";
import type { ReactElement, ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const toasts = vi.hoisted(() => ({
  add: vi.fn(() => "corner-toast"),
  close: vi.fn(),
  anchoredAdd: vi.fn(() => "anchored-toast"),
  anchoredClose: vi.fn(),
}));

vi.mock("~/components/ui/toast", () => ({
  toastManager: { add: toasts.add, close: toasts.close },
  anchoredToastManager: { add: toasts.anchoredAdd, close: toasts.anchoredClose },
  stackedThreadToast: (options: Record<string, unknown>) => ({
    ...options,
    data: { actionLayout: "stacked-end" },
  }),
}));

import {
  installDesktopUpdateNow,
  isUpdateNoticeAnchorVisible,
  SCIENT_UPDATE_READY_NOTICE_TIMEOUT_MS,
  showScientUpdateReadyNotice,
} from "./updateReadyNotice";

interface NoticeOptions {
  readonly title: string;
  readonly description?: ReactNode;
  readonly timeout: number;
  readonly actionProps: { readonly children: ReactNode; readonly onClick: () => void };
  readonly positionerProps?: { readonly anchor: Element; readonly side: string };
}

function downloadedState(overrides: Partial<DesktopUpdateState> = {}): DesktopUpdateState {
  return {
    enabled: true,
    status: "downloaded",
    channel: "latest",
    currentVersion: "0.6.18",
    hostArch: "arm64",
    appArch: "arm64",
    runningUnderArm64Translation: false,
    availableVersion: "0.6.19",
    downloadedVersion: "0.6.19",
    releaseNotes: [],
    omittedReleaseCount: 0,
    downloadPercent: 100,
    checkedAt: null,
    message: null,
    errorContext: null,
    canRetry: true,
    ...overrides,
  };
}

function installResult(overrides: Partial<DesktopUpdateActionResult> = {}) {
  return {
    accepted: true,
    completed: true,
    state: downloadedState(),
    ...overrides,
  } satisfies DesktopUpdateActionResult;
}

function shell(installUpdate = vi.fn(async () => installResult())) {
  return { installUpdate, openExternal: vi.fn(async () => true) };
}

function visibleAnchor(): HTMLElement {
  const anchor = document.createElement("button");
  document.body.append(anchor);
  vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 700, 64, 20));
  return anchor;
}

function lastNotice(add: typeof toasts.add | typeof toasts.anchoredAdd): NoticeOptions {
  const call = add.mock.calls.at(-1) as unknown as [NoticeOptions] | undefined;
  if (!call) throw new Error("no notice was shown");
  return call[0];
}

async function renderDescription(description: ReactNode): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mountedRoots.push(root);
  root.render(<>{description}</>);
  await vi.waitFor(() => expect(host.textContent).not.toBe(""));
  return host;
}

const mountedRoots: Root[] = [];

beforeEach(() => {
  vi.stubGlobal("innerWidth", 1280);
  vi.stubGlobal("innerHeight", 800);
});

afterEach(() => {
  for (const root of mountedRoots.splice(0)) root.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  toasts.add.mockClear();
  toasts.close.mockClear();
  toasts.anchoredAdd.mockClear();
  toasts.anchoredClose.mockClear();
  document.body.replaceChildren();
});

describe("isUpdateNoticeAnchorVisible", () => {
  it("accepts an on-screen element", () => {
    expect(isUpdateNoticeAnchorVisible(visibleAnchor())).toBe(true);
  });

  it("rejects a missing, detached, collapsed or off-screen element", () => {
    expect(isUpdateNoticeAnchorVisible(null)).toBe(false);

    const detached = document.createElement("button");
    vi.spyOn(detached, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 700, 64, 20));
    expect(isUpdateNoticeAnchorVisible(detached)).toBe(false);

    const collapsed = visibleAnchor();
    vi.spyOn(collapsed, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 700, 0, 0));
    expect(isUpdateNoticeAnchorVisible(collapsed)).toBe(false);

    // The offcanvas sidebar slides its footer left of the viewport.
    const offCanvas = visibleAnchor();
    vi.spyOn(offCanvas, "getBoundingClientRect").mockReturnValue(new DOMRect(-250, 700, 64, 20));
    expect(isUpdateNoticeAnchorVisible(offCanvas)).toBe(false);
  });
});

describe("showScientUpdateReadyNotice", () => {
  it("anchors above a visible update button with a Restart action and a 5s timeout", () => {
    const anchor = visibleAnchor();
    showScientUpdateReadyNotice({ shell: shell(), state: downloadedState(), anchor });

    expect(toasts.add).not.toHaveBeenCalled();
    const notice = lastNotice(toasts.anchoredAdd);
    expect(notice.title).toBe("Update 0.6.19 is ready");
    expect(notice.timeout).toBe(SCIENT_UPDATE_READY_NOTICE_TIMEOUT_MS);
    expect(SCIENT_UPDATE_READY_NOTICE_TIMEOUT_MS).toBe(5_000);
    expect(notice.actionProps.children).toBe("Restart now");
    expect(notice.positionerProps).toMatchObject({ anchor, side: "top" });
  });

  it("falls back to the corner stack when the button is not on screen", () => {
    showScientUpdateReadyNotice({ shell: shell(), state: downloadedState(), anchor: null });

    expect(toasts.anchoredAdd).not.toHaveBeenCalled();
    const notice = lastNotice(toasts.add);
    expect(notice.actionProps.children).toBe("Restart now");
    expect(notice.positionerProps).toBeUndefined();
  });

  it("Restart now closes the notice and installs exactly once, with no confirmation", async () => {
    const confirm = vi.spyOn(window, "confirm");
    const installUpdate = vi.fn(async () => installResult());
    showScientUpdateReadyNotice({
      shell: shell(installUpdate),
      state: downloadedState(),
      anchor: visibleAnchor(),
    });

    lastNotice(toasts.anchoredAdd).actionProps.onClick();

    expect(toasts.anchoredClose).toHaveBeenCalledWith("anchored-toast");
    await vi.waitFor(() => expect(installUpdate).toHaveBeenCalledTimes(1));
    expect(confirm).not.toHaveBeenCalled();
  });

  it("close() dismisses the notice from whichever stack showed it", () => {
    showScientUpdateReadyNotice({ shell: shell(), state: downloadedState(), anchor: null }).close();
    expect(toasts.close).toHaveBeenCalledWith("corner-toast");
  });

  it("links the downloaded build's release notes", async () => {
    const noticeShell = shell();
    showScientUpdateReadyNotice({
      shell: noticeShell,
      state: downloadedState({ availableVersion: "0.6.20" }),
      anchor: null,
    });

    const host = await renderDescription(lastNotice(toasts.add).description);
    host.querySelector("button")?.click();
    await vi.waitFor(() =>
      expect(noticeShell.openExternal).toHaveBeenCalledWith(
        "https://github.com/ScientFactory/scient-desktop/releases/tag/v0.6.19",
      ),
    );
  });

  it("keeps the Windows install note that used to live in the confirmation", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
    showScientUpdateReadyNotice({
      shell: shell(),
      state: downloadedState({ availableVersion: null, downloadedVersion: null }),
      anchor: null,
    });

    const notice = lastNotice(toasts.add);
    expect(notice.title).toBe("Update is ready");
    const description = notice.description as ReactElement<{ children: ReactNode[] }>;
    expect(description.props.children).toContain(
      "Scient may stay closed for a few minutes while the update installs, then reopens.",
    );
  });

  it("omits the description on macOS when there is no version to link", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    showScientUpdateReadyNotice({
      shell: shell(),
      state: downloadedState({ availableVersion: null, downloadedVersion: null }),
      anchor: null,
    });
    expect(lastNotice(toasts.add).description).toBeUndefined();
  });
});

describe("installDesktopUpdateNow", () => {
  it("shows nothing when the install is accepted", async () => {
    await installDesktopUpdateNow({ installUpdate: vi.fn(async () => installResult()) });
    expect(toasts.add).not.toHaveBeenCalled();
  });

  it("reports an install the updater refused", async () => {
    await installDesktopUpdateNow({
      installUpdate: vi.fn(async () =>
        installResult({
          completed: false,
          state: downloadedState({ status: "error", message: "Signature mismatch" }),
        }),
      ),
    });
    expect(toasts.add).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Could not install update",
        description: "Signature mismatch",
      }),
    );
  });

  it("reports a rejected install call", async () => {
    await installDesktopUpdateNow({
      installUpdate: vi.fn(async () => {
        throw new Error("IPC closed");
      }),
    });
    expect(toasts.add).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Could not install update", description: "IPC closed" }),
    );
  });
});
