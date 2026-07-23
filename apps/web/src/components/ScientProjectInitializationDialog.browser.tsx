// FILE: ScientProjectInitializationDialog.browser.tsx
// Purpose: Browser-level coverage for direct Scient project setup choices.

import "../index.css";

import type { ScientProjectInitializationPreviewResult } from "@synara/contracts";
import { page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ScientProjectInitializationDialog } from "./ScientProjectInitializationDialog";

function readyPreview(
  overrides: Partial<ScientProjectInitializationPreviewResult> = {},
): ScientProjectInitializationPreviewResult {
  return {
    previewId: "opaque-preview",
    expiresAt: "2026-07-23T10:00:00.000Z",
    root: "/research/example",
    folderState: "empty-uninitialized",
    status: "ready",
    projectId: "project-id",
    canApply: true,
    canRecover: false,
    canRollback: false,
    operations: [],
    skills: [],
    issues: [],
    ...overrides,
  };
}

describe("ScientProjectInitializationDialog", () => {
  it("applies setup directly from the initial project choice", async () => {
    const onDecision = vi.fn();
    render(
      <ScientProjectInitializationDialog
        preview={readyPreview()}
        error={null}
        onDecision={onDecision}
      />,
    );

    await expect.element(page.getByText("Open “example”", { exact: true })).toBeVisible();
    await expect
      .element(page.getByText("What is a Scient project?", { exact: true }))
      .not.toBeInTheDocument();
    await expect.element(page.getByText("PROJECT.md", { exact: true })).not.toBeInTheDocument();

    await page.getByRole("button", { name: /^Set up a Scient project/ }).click();

    expect(onDecision).toHaveBeenCalledOnce();
    expect(onDecision).toHaveBeenCalledWith("apply");
  });

  it("keeps opening without setup as a separate direct choice", async () => {
    const onDecision = vi.fn();
    render(
      <ScientProjectInitializationDialog
        preview={readyPreview()}
        error={null}
        onDecision={onDecision}
      />,
    );

    await page.getByRole("button", { name: /^Open an empty project/ }).click();

    expect(onDecision).toHaveBeenCalledOnce();
    expect(onDecision).toHaveBeenCalledWith("open-only");
  });
});
