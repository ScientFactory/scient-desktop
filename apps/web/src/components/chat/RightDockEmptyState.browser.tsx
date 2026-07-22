import "../../index.css";

import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { RightDockEmptyState } from "./RightDockEmptyState";

describe("RightDockEmptyState", () => {
  it("offers the four primary surfaces and explains unavailable actions", async () => {
    const onOpenPane = vi.fn();
    const screen = await render(
      <RightDockEmptyState
        workspaceAvailable={false}
        diffAvailable={false}
        onOpenPane={onOpenPane}
      />,
    );

    try {
      await expect.element(page.getByRole("heading", { name: "Open a surface" })).toBeVisible();
      await expect.element(page.getByRole("button", { name: /^Browser/ })).toBeVisible();
      await expect
        .element(page.getByRole("button", { name: /^Terminal/ }))
        .toHaveAttribute("aria-disabled", "true");
      await expect
        .element(page.getByRole("button", { name: /^Files/ }))
        .toHaveAttribute("aria-disabled", "true");
      await expect
        .element(page.getByRole("button", { name: /^Diff/ }))
        .toHaveAttribute("aria-disabled", "true");

      await page.getByRole("button", { name: /^Browser/ }).click();
      expect(onOpenPane).toHaveBeenCalledWith("browser");
      expect(onOpenPane).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });

  it("opens enabled workspace and diff surfaces", async () => {
    const onOpenPane = vi.fn();
    const screen = await render(
      <RightDockEmptyState workspaceAvailable diffAvailable onOpenPane={onOpenPane} />,
    );

    try {
      await page.getByRole("button", { name: /^Terminal/ }).click();
      await page.getByRole("button", { name: /^Files/ }).click();
      await page.getByRole("button", { name: /^Diff/ }).click();
      expect(onOpenPane.mock.calls.map(([kind]) => kind)).toEqual(["terminal", "explorer", "diff"]);
    } finally {
      await screen.unmount();
    }
  });
});
