import { page } from "vitest/browser";

import { render as _fixtureRender, type Screen } from "../../../test/render";
import type { DesktopUpdateActionResult, DesktopUpdateState } from "@t3tools/contracts";
import type { ReactElement, ReactNode } from "react";

import { describe, expect, it, vi } from "vite-plus/test";

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

function visibleAnchor(_fixture: _Fixture): HTMLElement {
  const anchor = document.createElement("button");
  document.body.append(_ownDOM(_fixture, anchor));
  anchor.style.cssText =
    "position:fixed;left:10px;top:700px;width:64px;height:20px;padding:0;border:0";
  return anchor;
}

function lastNotice(add: typeof toasts.add | typeof toasts.anchoredAdd): NoticeOptions {
  const call = add.mock.calls.at(-1) as unknown as [NoticeOptions] | undefined;
  if (!call) throw new Error("no notice was shown");
  return call[0];
}

async function renderDescription(_fixture: _Fixture, description: ReactNode): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(_ownDOM(_fixture, host));
  const root = _fixture.stack.use(await _fixtureRender(null, { container: host, router: false }));
  _fixture.root0.push(root);
  await root.rerender(<>{description}</>);
  await vi.waitFor(() => expect(host.textContent).not.toBe(""));
  return host;
}

async function _setupFixture0(_fixture: _Fixture) {
  const previousViewport = { width: innerWidth, height: innerHeight };
  _fixture.stack.defer(() => page.viewport(previousViewport.width, previousViewport.height));
  await page.viewport(1280, 800);
}

async function _cleanupFixture1(_fixture: _Fixture) {
  for (const root of _fixture.root0.splice(0)) await root.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  toasts.add.mockClear();
  toasts.close.mockClear();
  toasts.anchoredAdd.mockClear();
  toasts.anchoredClose.mockClear();
  _clearOwnedDOM(_fixture);
}

describe("isUpdateNoticeAnchorVisible", () => {
  it("accepts an on-screen element", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    expect(isUpdateNoticeAnchorVisible(visibleAnchor(_fixture))).toBe(true);
  });

  it("rejects a missing, detached, collapsed or off-screen element", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    expect(isUpdateNoticeAnchorVisible(null)).toBe(false);

    const detached = document.createElement("button");
    expect(isUpdateNoticeAnchorVisible(detached)).toBe(false);

    const collapsed = visibleAnchor(_fixture);
    collapsed.style.width = "0px";
    collapsed.style.height = "0px";
    expect(isUpdateNoticeAnchorVisible(collapsed)).toBe(false);

    // The offcanvas sidebar slides its footer left of the viewport.
    const offCanvas = visibleAnchor(_fixture);
    offCanvas.style.left = "-250px";
    expect(isUpdateNoticeAnchorVisible(offCanvas)).toBe(false);
  });
});

describe("showScientUpdateReadyNotice", () => {
  it("anchors above a visible update button with a Restart action and a 5s timeout", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const anchor = visibleAnchor(_fixture);
    showScientUpdateReadyNotice({ shell: shell(), state: downloadedState(), anchor });

    expect(toasts.add).not.toHaveBeenCalled();
    const notice = lastNotice(toasts.anchoredAdd);
    expect(notice.title).toBe("Update 0.6.19 is ready");
    expect(notice.timeout).toBe(SCIENT_UPDATE_READY_NOTICE_TIMEOUT_MS);
    expect(SCIENT_UPDATE_READY_NOTICE_TIMEOUT_MS).toBe(5_000);
    expect(notice.actionProps.children).toBe("Restart now");
    expect(notice.positionerProps).toMatchObject({ anchor, side: "top" });
  });

  it("falls back to the corner stack when the button is not on screen", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    showScientUpdateReadyNotice({ shell: shell(), state: downloadedState(), anchor: null });

    expect(toasts.anchoredAdd).not.toHaveBeenCalled();
    const notice = lastNotice(toasts.add);
    expect(notice.actionProps.children).toBe("Restart now");
    expect(notice.positionerProps).toBeUndefined();
  });

  it("Restart now runs the caller's install when one is given", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const install = vi.fn(async () => {});
    const installUpdate = vi.fn(async () => installResult());
    showScientUpdateReadyNotice({
      shell: shell(installUpdate),
      state: downloadedState(),
      anchor: null,
      install,
    });

    lastNotice(toasts.add).actionProps.onClick();

    expect(install).toHaveBeenCalledTimes(1);
    expect(installUpdate).not.toHaveBeenCalled();
    expect(toasts.close).toHaveBeenCalledWith("corner-toast");
  });

  it("Restart now closes the notice and installs exactly once, with no confirmation", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const confirm = vi.spyOn(window, "confirm");
    const installUpdate = vi.fn(async () => installResult());
    showScientUpdateReadyNotice({
      shell: shell(installUpdate),
      state: downloadedState(),
      anchor: visibleAnchor(_fixture),
    });

    lastNotice(toasts.anchoredAdd).actionProps.onClick();

    expect(toasts.anchoredClose).toHaveBeenCalledWith("anchored-toast");
    await vi.waitFor(() => expect(installUpdate).toHaveBeenCalledTimes(1));
    expect(confirm).not.toHaveBeenCalled();
  });

  it("close() dismisses the notice from whichever stack showed it", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    showScientUpdateReadyNotice({ shell: shell(), state: downloadedState(), anchor: null }).close();
    expect(toasts.close).toHaveBeenCalledWith("corner-toast");
  });

  it("links the downloaded build's release notes", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const noticeShell = shell();
    showScientUpdateReadyNotice({
      shell: noticeShell,
      state: downloadedState({ availableVersion: "0.6.20" }),
      anchor: null,
    });

    const host = await renderDescription(_fixture, lastNotice(toasts.add).description);
    host.querySelector("button")?.click();
    await vi.waitFor(() =>
      expect(noticeShell.openExternal).toHaveBeenCalledWith(
        "https://github.com/ScientFactory/scient-desktop/releases/tag/v0.6.19",
      ),
    );
  });

  it("keeps the Windows install note that used to live in the confirmation", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

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

  it("omits the description on macOS when there is no version to link", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await installDesktopUpdateNow({ installUpdate: vi.fn(async () => installResult()) });
    expect(toasts.add).not.toHaveBeenCalled();
  });

  it("reports an install the updater refused, with its message", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await installDesktopUpdateNow({
      installUpdate: vi.fn(async () =>
        installResult({
          accepted: false,
          completed: false,
          state: downloadedState({ message: "No downloaded update" }),
        }),
      ),
    });
    expect(toasts.add).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Could not install update",
        description: "No downloaded update",
      }),
    );
  });

  it("reports a refusal that carries no message", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await installDesktopUpdateNow({
      installUpdate: vi.fn(async () => installResult({ accepted: false, completed: false })),
    });
    expect(toasts.add).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Could not install update",
        description: "Another update step is still running. Try again in a moment.",
      }),
    );
  });

  it("shares one request between concurrent callers, then allows a new one", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    let finish: (value: DesktopUpdateActionResult) => void = () => {};
    const installUpdate = vi.fn(
      () => new Promise<DesktopUpdateActionResult>((resolve) => (finish = resolve)),
    );
    const first = installDesktopUpdateNow({ installUpdate });
    const second = installDesktopUpdateNow({ installUpdate });
    expect(second).toBe(first);
    expect(installUpdate).toHaveBeenCalledTimes(1);

    finish(installResult());
    await first;

    const third = vi.fn(async () => installResult());
    await installDesktopUpdateNow({ installUpdate: third });
    expect(third).toHaveBeenCalledTimes(1);
  });

  it("reports an accepted install that failed", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

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

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    _ownedDOM: [] as Node[],

    stack,
    cleanup,
    root0: [] as Screen[],
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

function _ownDOM<T extends Node>(_fixture: _Fixture, node: T): T {
  _fixture._ownedDOM.push(node);
  _fixture.stack.defer(() => {
    node.parentNode?.removeChild(node);
  });
  return node;
}
function _clearOwnedDOM(_fixture: _Fixture) {
  for (const node of _fixture._ownedDOM.splice(0)) node.parentNode?.removeChild(node);
}
