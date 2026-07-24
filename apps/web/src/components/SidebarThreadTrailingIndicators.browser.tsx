// FILE: SidebarThreadTrailingIndicators.browser.tsx
// Purpose: Prove thread-jump hints coexist with durable sidebar status semantics and geometry.
// Layer: Vitest browser tests

import "../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import type { ThreadStatusPill } from "./Sidebar.logic";
import { resolveThreadRowTrailingReserveClass } from "./Sidebar.logic";
import { SidebarThreadTrailingIndicators } from "./SidebarThreadTrailingIndicators";

function status(label: "Working" | "Pending Approval" | "Completed"): ThreadStatusPill {
  return {
    label,
    colorClass: "text-sky-600",
    dotClass: "bg-sky-500",
    pulse: label === "Working",
    dismissible: false,
  };
}

async function renderIndicators(label: "Working" | "Pending Approval" | "Completed") {
  await render(
    <div className="flex w-40 items-center justify-end gap-1">
      <SidebarThreadTrailingIndicators
        isSubagentThread={false}
        threadJumpLabel="⌘+1"
        threadJumpLabelParts={["⌘", "1"]}
        threadStatus={status(label)}
      />
    </div>,
  );
}

async function renderRepresentativeRow(input: {
  jumpLabel: string;
  jumpParts: readonly string[];
  threadStatus: ThreadStatusPill | null;
}) {
  await render(
    <div
      data-testid="sidebar-row"
      className={`relative flex h-8 w-64 min-w-0 items-center ${resolveThreadRowTrailingReserveClass(
        {
          metaChipCount: 0,
          jumpHintParts: input.jumpParts,
          hasStatus: Boolean(input.threadStatus),
        },
      )}`}
    >
      <span data-testid="row-content" className="min-w-0 flex-1 truncate">
        A long thread title with project context
      </span>
      <div
        data-testid="trailing-cluster"
        className="absolute top-1/2 right-1.5 flex -translate-y-1/2 items-center gap-1"
      >
        <SidebarThreadTrailingIndicators
          isSubagentThread={false}
          threadJumpLabel={input.jumpLabel}
          threadJumpLabelParts={input.jumpParts}
          threadStatus={input.threadStatus}
        />
      </div>
    </div>,
  );
}

function expectRowContentBeforeTrailingCluster() {
  const contentBox = page.getByTestId("row-content").element().getBoundingClientRect();
  const trailingBox = page.getByTestId("trailing-cluster").element().getBoundingClientRect();

  expect(contentBox.right).toBeLessThanOrEqual(trailingBox.left + 0.5);
}

describe("SidebarThreadTrailingIndicators", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["Working", "Pending Approval", "Completed"] as const)(
    "renders the jump hint and %s status together",
    async (label) => {
      await renderIndicators(label);

      await expect.element(page.getByLabelText("Jump to thread: ⌘+1")).toBeVisible();
      await expect.element(page.getByLabelText(`Thread status: ${label}`)).toBeVisible();
      await expect.element(page.getByText("⌘", { exact: true })).toBeVisible();
      await expect.element(page.getByText("1", { exact: true })).toBeVisible();
    },
  );

  it("[geometry:linux] keeps the status beside the complete hint without overlap", async () => {
    await renderIndicators("Pending Approval");

    const jumpBox = page.getByLabelText("Jump to thread: ⌘+1").element().getBoundingClientRect();
    const statusBox = page
      .getByLabelText("Thread status: Pending Approval")
      .element()
      .getBoundingClientRect();

    expect(jumpBox.right).toBeLessThanOrEqual(statusBox.left + 0.5);
  });

  it("[geometry:linux] keeps row content clear of a simultaneous hint and status", async () => {
    await renderRepresentativeRow({
      jumpLabel: "⌘+1",
      jumpParts: ["⌘", "1"],
      threadStatus: status("Pending Approval"),
    });

    expectRowContentBeforeTrailingCluster();
  });

  it("[geometry:linux] keeps row content clear of a wide Ctrl jump hint", async () => {
    await renderRepresentativeRow({
      jumpLabel: "Ctrl+1",
      jumpParts: ["Ctrl", "1"],
      threadStatus: null,
    });

    expectRowContentBeforeTrailingCluster();
  });

  it("[geometry:linux] keeps row content clear of Ctrl jump and status together", async () => {
    await renderRepresentativeRow({
      jumpLabel: "Ctrl+1",
      jumpParts: ["Ctrl", "1"],
      threadStatus: status("Pending Approval"),
    });

    expectRowContentBeforeTrailingCluster();
  });
});
