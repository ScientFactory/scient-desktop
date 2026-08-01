// FILE: SidebarIconButton.browser.tsx
// Purpose: Verifies per-button tooltip timing and alignment stay local to the requested control.

import "../index.css";

import { page, userEvent } from "vitest/browser";
import { expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { SidebarIconButton } from "./SidebarIconButton";

function TestIcon(props: { className?: string }) {
  return <svg aria-hidden="true" className={props.className} />;
}

it("opens a tuned right-side tooltip promptly and slightly above its trigger", async () => {
  const screen = await render(
    <div className="flex h-32 items-center pl-12">
      <SidebarIconButton
        icon={TestIcon}
        label="Add project"
        tooltip="Add project"
        tooltipSide="right"
        tooltipDelay={150}
        tooltipAlignOffset={-3}
      />
    </div>,
  );

  try {
    const trigger = page.getByRole("button", { name: "Add project" });
    const hoverStartedAt = performance.now();
    await userEvent.hover(trigger);
    const tooltip = page.getByText("Add project", { exact: true });
    await expect.element(tooltip).toBeVisible();
    expect(performance.now() - hoverStartedAt).toBeLessThan(500);

    const triggerRect = (await trigger.element()).getBoundingClientRect();
    const tooltipRect = (await tooltip.element()).getBoundingClientRect();
    expect(tooltipRect.left).toBeGreaterThan(triggerRect.right);
    expect(tooltipRect.top + tooltipRect.height / 2).toBeLessThan(
      triggerRect.top + triggerRect.height / 2,
    );
  } finally {
    await screen.unmount();
  }
});
