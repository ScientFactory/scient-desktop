import "../../index.css";

import type { DesktopUpdateActionResult, DesktopUpdateState } from "@t3tools/contracts";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const toasts = vi.hoisted(() => ({ add: vi.fn() }));
const confirmDialog = vi.hoisted(() => ({ request: vi.fn(async () => true) }));
const updateState = vi.hoisted(() => ({ current: null as DesktopUpdateState | null }));

vi.mock("../../components/ui/toast", async () => {
  const { stackedThreadToast } = await import("../../components/ui/toastHelpers");
  return {
    stackedThreadToast,
    toastManager: { add: toasts.add, close: vi.fn() },
    anchoredToastManager: { add: vi.fn(), close: vi.fn() },
  };
});
vi.mock("../../confirmDialog", () => ({ requestConfirmDialog: confirmDialog.request }));
vi.mock("../../state/desktopUpdate", () => ({ useDesktopUpdateState: () => updateState.current }));

import { AboutVersionSection } from "../../components/settings/SettingsPanels";

const downloaded: DesktopUpdateState = {
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
};

const installUpdate = vi.fn<() => Promise<DesktopUpdateActionResult>>();
let host: HTMLDivElement;
let root: Root;

const installButton = () =>
  [...host.querySelectorAll("button")].find((button) => button.textContent === "Install");

beforeEach(() => {
  updateState.current = downloaded;
  installUpdate.mockReset();
  toasts.add.mockReset();
  confirmDialog.request.mockClear();
  Object.assign(window, { desktopBridge: { installUpdate } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  root.render(<AboutVersionSection />);
});

afterEach(() => {
  root.unmount();
  host.remove();
  delete (window as { desktopBridge?: unknown }).desktopBridge;
  vi.restoreAllMocks();
});

describe("Settings update Install", () => {
  it("installs directly, with no confirmation", async () => {
    installUpdate.mockResolvedValue({ accepted: true, completed: true, state: downloaded });
    await vi.waitFor(() => expect(installButton()).toBeDefined());

    installButton()!.click();

    await vi.waitFor(() => expect(installUpdate).toHaveBeenCalledTimes(1));
    expect(confirmDialog.request).not.toHaveBeenCalled();
  });

  it("reports a failed install and re-enables the button", async () => {
    installUpdate.mockRejectedValueOnce(new Error("IPC closed"));
    await vi.waitFor(() => expect(installButton()).toBeDefined());

    installButton()!.click();

    await vi.waitFor(() =>
      expect(toasts.add).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Could not install update", description: "IPC closed" }),
      ),
    );
    await vi.waitFor(() => expect(installButton()!.disabled).toBe(false));
    installUpdate.mockResolvedValue({ accepted: true, completed: true, state: downloaded });
    installButton()!.click();
    await vi.waitFor(() => expect(installUpdate).toHaveBeenCalledTimes(2));
  });
});
