import "../../index.css";

import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { FoldersIcon } from "~/lib/icons";

import { IconButton } from "../ui/icon-button";
import { RightDock } from "./RightDock";

describe("RightDock", () => {
  it("places the active-pane action between Add panel and Collapse panel", async () => {
    await page.viewport(1280, 800);
    const screen = await render(
      <RightDock
        state={{
          open: true,
          activePaneId: "file:README.md",
          panes: [
            {
              id: "file:README.md",
              kind: "file",
              threadId: null,
              diffTurnId: null,
              diffFilePath: null,
              filePath: "README.md",
              pullRequestProjectId: null,
              pullRequestRepository: null,
              pullRequestNumber: null,
              pullRequestInitialTab: null,
            },
          ],
        }}
        minWidth={320}
        defaultWidth="480px"
        shouldAcceptWidth={() => true}
        addMenuKinds={["browser"]}
        activePaneAction={
          <IconButton label="Hide file explorer" aria-pressed="true" onClick={vi.fn()}>
            <FoldersIcon />
          </IconButton>
        }
        onSelectPane={vi.fn()}
        onClosePane={vi.fn()}
        onCollapse={vi.fn()}
        onOpenChange={vi.fn()}
        onAddPane={vi.fn()}
        renderPane={() => <div>File content</div>}
      />,
    );

    try {
      const addButton = page.getByRole("button", { name: "Add panel" });
      const explorerButton = page.getByRole("button", { name: "Hide file explorer" });
      const collapseButton = page.getByRole("button", { name: "Collapse panel" });
      await expect.element(addButton).toBeVisible();
      await expect.element(explorerButton).toBeVisible();
      await expect.element(collapseButton).toBeVisible();

      const addElement = await addButton.element();
      const explorerElement = await explorerButton.element();
      const collapseElement = await collapseButton.element();

      expect(addElement.compareDocumentPosition(explorerElement)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
      expect(explorerElement.compareDocumentPosition(collapseElement)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
    } finally {
      await screen.unmount();
    }
  });

  it("does not offer an already-open singleton panel as a new panel", async () => {
    const onAddPane = vi.fn();
    const screen = await render(
      <RightDock
        state={{
          open: true,
          activePaneId: "browser-1",
          panes: [
            {
              id: "browser-1",
              kind: "browser",
              threadId: null,
              diffTurnId: null,
              diffFilePath: null,
              filePath: null,
              pullRequestProjectId: null,
              pullRequestRepository: null,
              pullRequestNumber: null,
              pullRequestInitialTab: null,
            },
          ],
        }}
        minWidth={320}
        defaultWidth="480px"
        shouldAcceptWidth={() => true}
        addMenuKinds={["browser", "sidechat"]}
        onSelectPane={vi.fn()}
        onClosePane={vi.fn()}
        onCollapse={vi.fn()}
        onOpenChange={vi.fn()}
        onAddPane={onAddPane}
        renderPane={() => <div>Browser content</div>}
      />,
    );

    try {
      const addButton = page.getByRole("button", { name: "Add panel" });
      ((await addButton.element()) as HTMLButtonElement).click();
      await expect.element(page.getByRole("menuitem", { name: "Side" })).toBeVisible();
      expect(page.getByRole("menuitem", { name: "Browser" }).query()).toBeNull();
    } finally {
      await screen.unmount();
    }
  });
});
