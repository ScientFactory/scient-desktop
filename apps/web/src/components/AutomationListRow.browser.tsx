// FILE: AutomationListRow.browser.tsx
// Purpose: Browser semantics and narrow-layout coverage for automation status rows.
// Layer: Vitest browser tests

import "../index.css";

import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { AutomationListRow } from "./AutomationListRow";

async function renderRow(meta: string, onClick = vi.fn()) {
  await render(
    <div data-testid="narrow-automation-list" className="w-[320px] max-w-full">
      <AutomationListRow
        onClick={onClick}
        leading={<span aria-hidden="true">●</span>}
        title="Nightly upstream review"
        detail="Scient desktop"
        meta={meta}
        onDelete={vi.fn()}
      />
    </div>,
  );
  return onClick;
}

describe("AutomationListRow", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps plain-language state in the row's accessible name and supports keyboard opening", async () => {
    const onClick = await renderRow("Waiting for approval");
    const row = page.getByRole("button", {
      name: /Nightly upstream review Scient desktop Waiting for approval/i,
    });

    const rowElement = await row.element();
    rowElement.focus();
    await userEvent.keyboard("{Enter}");

    expect(onClick).toHaveBeenCalledOnce();
    await expect.element(page.getByLabelText("Delete automation", { exact: true })).toBeVisible();
  });

  it("[geometry:linux] preserves the status at narrow sidebar widths without row overflow", async () => {
    await renderRow("Last run interrupted");

    const container = page.getByTestId("narrow-automation-list");
    const row = page.getByRole("button", {
      name: /Nightly upstream review Scient desktop Last run interrupted/i,
    });
    const meta = page.getByText("Last run interrupted");
    const containerBox = container.element().getBoundingClientRect();
    const rowBox = row.element().getBoundingClientRect();
    const metaBox = meta.element().getBoundingClientRect();

    expect(rowBox.right).toBeLessThanOrEqual(containerBox.right + 0.5);
    expect(metaBox.right).toBeLessThanOrEqual(rowBox.right + 0.5);
    await expect.element(meta).toBeVisible();
  });
});
