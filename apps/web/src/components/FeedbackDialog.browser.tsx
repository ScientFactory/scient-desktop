// FILE: FeedbackDialog.browser.tsx
// Purpose: Covers feedback submission session guards and accessible completion feedback.

import "../index.css";

import { page } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const submitFeedback = vi.hoisted(() => vi.fn());

vi.mock("../feedback", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../feedback")>()),
  submitFeedback,
}));

import type { FeedbackThreadContext } from "../feedback";
import { FeedbackDialog } from "./FeedbackDialog";

const context: FeedbackThreadContext = {
  provider: "codex",
  model: "gpt-5",
  projectKind: "local",
  environmentMode: "local",
  runtimeMode: "native",
  interactionMode: "default",
  sessionStatus: "idle",
  latestTurnState: null,
  messageCount: 2,
  activityCount: 0,
  hasPendingApproval: false,
  hasPendingUserInput: false,
  hasThreadError: false,
};

function dialog(open: boolean) {
  return <FeedbackDialog open={open} context={context} onOpenChange={() => undefined} />;
}

describe("FeedbackDialog", () => {
  beforeEach(() => submitFeedback.mockReset());

  it("ignores an old submission after close and reopen", async () => {
    let resolveFirst: (() => void) | undefined;
    submitFeedback.mockImplementationOnce(
      () => new Promise<void>((resolve) => (resolveFirst = resolve)),
    );
    const screen = await render(dialog(true));
    await page.getByRole("textbox", { name: "Feedback details" }).fill("First session");
    await page.getByRole("button", { name: "Submit" }).click();

    await screen.rerender(dialog(false));
    await screen.rerender(dialog(true));
    await expect.element(page.getByRole("textbox", { name: "Feedback details" })).toHaveValue("");

    resolveFirst?.();
    await new Promise((resolve) => window.setTimeout(resolve, 0));

    await expect.element(page.getByRole("textbox", { name: "Feedback details" })).toBeVisible();
    expect(page.getByText("Feedback sent").query()).toBeNull();
  });

  it("announces and focuses the completion status for the current session", async () => {
    submitFeedback.mockResolvedValue(undefined);
    await render(dialog(true));
    await page.getByRole("textbox", { name: "Feedback details" }).fill("Current session");
    await page.getByRole("button", { name: "Submit" }).click();

    const status = page.getByRole("status");
    await expect.element(status).toHaveTextContent("Feedback sent");
    await expect.poll(() => document.activeElement?.getAttribute("role")).toBe("status");
  });
});
