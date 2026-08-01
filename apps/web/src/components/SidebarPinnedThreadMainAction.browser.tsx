// FILE: SidebarPinnedThreadMainAction.browser.tsx
// Purpose: Browser regressions for pinned-row activation and sibling family disclosure controls.

import "../index.css";

import { page, userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { render } from "vitest-browser-react";

import { SidebarPinnedThreadMainAction } from "./SidebarPinnedThreadMainAction";
import {
  SidebarThreadFamilyDisclosureButton,
  SidebarThreadFamilyDisclosureRegion,
  sidebarThreadFamilyRegionId,
} from "./SidebarThreadFamilyDisclosure";

const REGION_ID = sidebarThreadFamilyRegionId("pinned", "thread-root");

function PinnedRowHarness(props: { readonly onActivate: () => void }) {
  const [open, setOpen] = useState(true);
  return (
    <div>
      <div className="flex w-80 items-center">
        <SidebarPinnedThreadMainAction
          projectLabel="Scient desktop"
          hasTrailingStatusGlyph={false}
          onActivate={props.onActivate}
          onDoubleClick={vi.fn()}
          onPointerDown={vi.fn()}
          onPointerUp={vi.fn()}
        >
          <span>Main analysis</span>
        </SidebarPinnedThreadMainAction>
        <SidebarThreadFamilyDisclosureButton
          childCount={1}
          controls={REGION_ID}
          open={open}
          threadTitle="Main analysis"
          onToggle={() => setOpen((current) => !current)}
        />
        <button type="button" aria-label="Pinned row actions">
          More
        </button>
      </div>
      <SidebarThreadFamilyDisclosureRegion id={REGION_ID} open={open} threadTitle="Main analysis">
        <button type="button">Child conversation</button>
      </SidebarThreadFamilyDisclosureRegion>
    </div>
  );
}

describe("SidebarPinnedThreadMainAction", () => {
  it("activates the conversation from either the title or its visible project label", async () => {
    const onActivate = vi.fn();
    await render(<PinnedRowHarness onActivate={onActivate} />);

    await page.getByText("Main analysis", { exact: true }).click();
    await page.getByText("Scient desktop", { exact: true }).click();

    expect(onActivate).toHaveBeenCalledTimes(2);
    await expect
      .element(page.getByRole("button", { name: "Main analysis Scient desktop" }))
      .toBeVisible();
  });

  it("keeps disclosure and hover actions as sibling controls", async () => {
    const onActivate = vi.fn();
    await render(<PinnedRowHarness onActivate={onActivate} />);

    const disclosure = page.getByRole("button", {
      name: "Collapse 1 subagent under “Main analysis”",
    });
    const disclosureElement = disclosure.element();
    const mainActionElement = page
      .getByRole("button", { name: "Main analysis Scient desktop" })
      .element();
    const hoverActionsElement = page.getByRole("button", { name: "Pinned row actions" }).element();
    await disclosure.click();
    await page.getByRole("button", { name: "Pinned row actions" }).click();

    expect(onActivate).not.toHaveBeenCalled();
    expect(disclosureElement.parentElement).toBe(mainActionElement.parentElement);
    expect(hoverActionsElement.parentElement).toBe(mainActionElement.parentElement);
    expect(mainActionElement.contains(disclosureElement)).toBe(false);
    expect(mainActionElement.contains(hoverActionsElement)).toBe(false);
    expect(disclosureElement.getAttribute("aria-expanded")).toBe("false");
  });

  it("supports native Enter and Space activation from the complete main action", async () => {
    const onActivate = vi.fn();
    await render(<PinnedRowHarness onActivate={onActivate} />);
    const mainAction = page.getByRole("button", {
      name: "Main analysis Scient desktop",
    });

    mainAction.element().focus();
    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard(" ");

    expect(onActivate).toHaveBeenCalledTimes(2);
  });

  it("retains a closing family inertly for animation, then removes its children", async () => {
    await render(<PinnedRowHarness onActivate={vi.fn()} />);
    const child = page.getByRole("button", { name: "Child conversation" }).element();

    await page
      .getByRole("button", {
        name: "Collapse 1 subagent under “Main analysis”",
      })
      .click();

    expect(document.body.contains(child)).toBe(true);
    expect(child.closest("[inert]")).not.toBeNull();
    await expect
      .poll(() => document.body.textContent?.includes("Child conversation") ?? false, {
        timeout: 1_000,
      })
      .toBe(false);
  });
});
