// FILE: browserPanelFocus.browser.tsx
// Purpose: Browser-level focus recovery regressions for final Browser-tab deletion.

import { afterEach, describe, expect, it } from "vitest";

import {
  restoreRightDockFocusAfterBrowserClose,
  restoreSplitChatFocusAfterBrowserClose,
} from "./browserPanelFocus";

afterEach(() => {
  document.body.replaceChildren();
});

describe("browser panel focus recovery", () => {
  it("focuses the newly active right-dock pane before other dock controls", () => {
    document.body.innerHTML = `
      <div data-right-dock-content>
        <button aria-pressed="true">Diff</button>
        <button aria-label="Add panel">Add</button>
        <button aria-label="Collapse panel">Collapse</button>
      </div>
    `;

    expect(restoreRightDockFocusAfterBrowserClose(document)).toBe(true);
    expect(document.activeElement?.textContent).toBe("Diff");
  });

  it("focuses the empty-state action after closing the dock's final pane", () => {
    document.body.innerHTML = `
      <div data-right-dock-content>
        <div data-right-dock-empty-state>
          <button>Browser</button>
        </div>
        <button aria-label="Collapse panel">Collapse</button>
      </div>
    `;

    expect(restoreRightDockFocusAfterBrowserClose(document)).toBe(true);
    expect(document.activeElement?.textContent).toBe("Browser");
  });

  it("returns focus to an enabled split-pane composer", () => {
    document.body.innerHTML = `
      <div data-split-chat-pane="pane-1" tabindex="-1">
        <form data-chat-composer-form="true">
          <div data-testid="composer-editor" contenteditable="true"></div>
        </form>
      </div>
      <div data-split-chat-pane="pane-2" tabindex="-1"></div>
    `;
    const pane = document.querySelector<HTMLElement>('[data-split-chat-pane="pane-1"]')!;
    let focusedPaneId = "pane-2";

    expect(
      restoreSplitChatFocusAfterBrowserClose(pane, () => {
        focusedPaneId = "pane-1";
      }),
    ).toBe(true);
    expect(focusedPaneId).toBe("pane-1");
    expect(document.activeElement).toBe(document.querySelector('[data-testid="composer-editor"]'));
  });

  it("uses the split pane itself when its composer is unavailable", () => {
    document.body.innerHTML = `
      <div data-split-chat-pane tabindex="-1">
        <form data-chat-composer-form="true">
          <div data-testid="composer-editor" contenteditable="false"></div>
        </form>
      </div>
    `;
    const pane = document.querySelector<HTMLElement>("[data-split-chat-pane]")!;

    expect(restoreSplitChatFocusAfterBrowserClose(pane, () => undefined)).toBe(true);
    expect(document.activeElement).toBe(pane);
  });
});
