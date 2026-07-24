// FILE: EnvironmentStudioFolderRow.browser.tsx
// Purpose: Browser regression coverage for the Studio native-folder action.
// Layer: Vitest browser tests

import "../../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { transientAlertManager } from "~/notifications/transientAlert";

import { studioFolderActionLabel } from "./EnvironmentPanel.logic";
import { EnvironmentStudioFolderRow } from "./EnvironmentStudioFolderRow";

const STUDIO_FOLDER = "/Users/tester/Projects/research notes";
const STUDIO_FOLDER_ACTION_LABEL = studioFolderActionLabel({
  studioFolderPath: STUDIO_FOLDER,
  platform: navigator.platform,
});

function installDesktopShowInFolder(showInFolder: (path: string) => Promise<void>) {
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: { showInFolder },
  });
}

afterEach(() => {
  Reflect.deleteProperty(window, "desktopBridge");
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("EnvironmentStudioFolderRow", () => {
  it("opens the exact selected path once and closes only after native success", async () => {
    let resolveOpen!: () => void;
    const pendingOpen = new Promise<void>((resolve) => {
      resolveOpen = resolve;
    });
    const showInFolder = vi.fn(() => pendingOpen);
    const onClose = vi.fn();
    installDesktopShowInFolder(showInFolder);

    const screen = await render(
      <EnvironmentStudioFolderRow
        isStudioChat
        studioFolderPath={STUDIO_FOLDER}
        onClose={onClose}
      />,
    );
    try {
      const action = page.getByRole("button", {
        name: STUDIO_FOLDER_ACTION_LABEL,
      });
      await expect.element(action).toHaveAttribute("title", expect.stringContaining(STUDIO_FOLDER));
      expect(page.getByText("research notes")).toBeVisible();

      const button = document.querySelector<HTMLButtonElement>(
        `button[aria-label$="${STUDIO_FOLDER}"]`,
      );
      expect(button).not.toBeNull();
      button?.click();
      button?.click();

      await vi.waitFor(() => expect(showInFolder).toHaveBeenCalledTimes(1));
      expect(showInFolder).toHaveBeenCalledWith(STUDIO_FOLDER);
      expect(onClose).not.toHaveBeenCalled();
      await expect.element(action).toBeDisabled();

      resolveOpen();
      await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    } finally {
      await screen.unmount();
    }
  });

  it("keeps the panel open and reports the native failure", async () => {
    const showInFolder = vi.fn(async () => {
      throw new Error("Folder is unavailable");
    });
    const onClose = vi.fn();
    const alert = vi.spyOn(transientAlertManager, "add");
    installDesktopShowInFolder(showInFolder);

    const screen = await render(
      <EnvironmentStudioFolderRow
        isStudioChat
        studioFolderPath={STUDIO_FOLDER}
        onClose={onClose}
      />,
    );
    try {
      await page.getByRole("button", { name: STUDIO_FOLDER_ACTION_LABEL }).click();

      await vi.waitFor(() => expect(alert).toHaveBeenCalledTimes(1));
      expect(alert).toHaveBeenCalledWith({
        title: "Unable to open folder",
        description: "Folder is unavailable",
      });
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("does not offer a no-op browser action or expose the row outside Studio", async () => {
    const withoutBridge = await render(
      <EnvironmentStudioFolderRow
        isStudioChat
        studioFolderPath={STUDIO_FOLDER}
        onClose={vi.fn()}
      />,
    );
    expect(page.getByRole("button")).not.toBeInTheDocument();
    await withoutBridge.unmount();

    installDesktopShowInFolder(vi.fn(async () => undefined));
    const outsideStudio = await render(
      <EnvironmentStudioFolderRow
        isStudioChat={false}
        studioFolderPath={STUDIO_FOLDER}
        onClose={vi.fn()}
      />,
    );
    expect(page.getByRole("button")).not.toBeInTheDocument();
    await outsideStudio.unmount();
  });
});
