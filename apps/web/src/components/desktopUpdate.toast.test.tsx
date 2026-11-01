import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { DesktopUpdateState } from "@t3tools/contracts";

const testState = vi.hoisted(() => ({
  addToast: vi.fn(),
}));

vi.mock("./ui/toast", () => ({
  toastManager: { add: testState.addToast },
}));

import { showDesktopUpdateDownloadedToast } from "./desktopUpdate.toast";

type ClickableElement = ReactElement<{ readonly onClick?: () => void }>;

function findReleaseNotesLink(node: ReactNode): ClickableElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findReleaseNotesLink(child);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const element = node as ReactElement<{ readonly children?: ReactNode }>;
  if (element.type === "button") return element as ClickableElement;
  if (typeof element.type === "function") {
    const render = element.type as (props: unknown) => ReactNode;
    return findReleaseNotesLink(render(element.props));
  }
  return findReleaseNotesLink(element.props.children);
}

function getDescription(): ReactNode {
  const toast = testState.addToast.mock.calls[0]?.[0] as { description?: ReactNode } | undefined;
  return toast?.description ?? null;
}

function downloadedState(overrides: Partial<DesktopUpdateState> = {}): DesktopUpdateState {
  return {
    enabled: true,
    status: "downloaded",
    channel: "latest",
    currentVersion: "0.6.7",
    hostArch: "arm64",
    appArch: "arm64",
    runningUnderArm64Translation: false,
    availableVersion: "0.6.8",
    downloadedVersion: "0.6.8",
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

describe("showDesktopUpdateDownloadedToast", () => {
  beforeEach(() => {
    testState.addToast.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // regression: 2cf25a2675 fix(desktop): link update notes to Scient releases (#219)
  it("opens the downloaded Scient release even when a newer version is available", async () => {
    const openExternal = vi.fn().mockResolvedValue(true);

    showDesktopUpdateDownloadedToast(
      { openExternal },
      downloadedState({ availableVersion: "0.6.9" }),
    );
    const link = findReleaseNotesLink(getDescription());
    link?.props.onClick?.();
    await vi.waitFor(() => {
      expect(openExternal).toHaveBeenCalledWith(
        "https://github.com/ScientFactory/scient-desktop/releases/tag/v0.6.8",
      );
    });
    expect(testState.addToast).toHaveBeenCalledTimes(1);
  });
});
