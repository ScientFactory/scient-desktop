import {
  EnvironmentId,
  ThreadId,
  type DesktopFeedbackBridge,
  type FeedbackAppDetails,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";
import { FeedbackDialogHost } from "./FeedbackDialog";
import { requestFeedback, useFeedbackDraft } from "./feedbackStore";

const { toastAdd, exportConversation } = vi.hoisted(() => ({
  toastAdd: vi.fn(),
  exportConversation: vi.fn(),
}));
vi.mock("../../components/ui/toast", () => ({ toastManager: { add: toastAdd } }));
vi.mock("../conversationExport/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../conversationExport/client")>()),
  exportConversation,
}));

const DETAILS: FeedbackAppDetails = {
  version: "0.6.29",
  channel: "stable",
  platform: "darwin",
  osVersion: "26.1",
  arch: "arm64",
  locale: "en-US",
  rendererCrashes24h: 0,
  recentFailures: [{ name: "provider.turn", at: "2026-11-17T11:58:00.000Z", traceId: "abc123" }],
};

function installBridge() {
  const bridge = {
    prepare: vi.fn(async () => ({
      details: DETAILS,
      lastContactEmail: null,
      canSend: true,
      pendingReports: 0,
    })),
    captureScreenshot: vi.fn(async () => null),
    readRecentLogs: vi.fn(async () => "== End of the server log ==\nturn failed"),
    submit: vi.fn(async () => ({
      _tag: "sent" as const,
      id: "0f6c1d2e-3b4a-4c5d-8e6f-7a8b9c0d1e2f",
    })),
    takeFixedNotices: vi.fn(async () => []),
  } satisfies DesktopFeedbackBridge;
  (window as { desktopBridge?: unknown }).desktopBridge = { feedback: bridge };
  return {
    bridge,
    [Symbol.dispose]: () => {
      delete (window as { desktopBridge?: unknown }).desktopBridge;
      useFeedbackDraft.setState({ open: false, message: "", email: "", error: null, logs: null });
      toastAdd.mockReset();
    },
  };
}

/** Base UI marks the page behind a modal inert, which blocks pointer-driven locator clicks. */
const button = (name: string) =>
  [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === name,
  );
const press = (name: string) =>
  act(async () => {
    const target = button(name);
    if (target === undefined) throw new Error(`No ${name} button`);
    target.click();
  });

describe("Send feedback to Scient", () => {
  it("sends a reported error in two clicks with nothing the person did not add", async () => {
    using fixture = installBridge();
    const { bridge } = fixture;
    await using _screen = await render(<FeedbackDialogHost />);
    await act(() => requestFeedback({ source: "turn-error", error: { message: "Codex exited" } }));

    await vi.waitFor(() => expect(button("Send")?.disabled).toBe(false));
    await press("Send");

    await vi.waitFor(() => expect(bridge.submit).toHaveBeenCalledTimes(1));
    expect(bridge.submit).toHaveBeenCalledWith({
      message: "",
      source: "turn-error",
      screen: "other",
      contactEmail: null,
      details: DETAILS,
      error: { message: "Codex exited" },
      screenshot: null,
      logs: null,
      conversation: null,
    });
    await vi.waitFor(() =>
      expect(toastAdd).toHaveBeenCalledWith(expect.objectContaining({ title: "Feedback sent" })),
    );
  });

  it("does not carry an earlier error into a new report, and sends the logs it showed", async () => {
    using fixture = installBridge();
    const { bridge } = fixture;
    await using _screen = await render(<FeedbackDialogHost />);
    await act(() => requestFeedback({ source: "turn-error", error: { message: "Old failure" } }));
    await press("Cancel");
    await act(() => requestFeedback({ source: "sidebar" }));

    await vi.waitFor(() => expect(button("Send")?.disabled).toBe(true));
    expect(document.body.textContent).not.toContain("Old failure");

    await userEvent.fill(page.getByRole("textbox", { name: "Your feedback" }), "PDF goes blank");
    await press("Add recent logs");
    await vi.waitFor(() => expect(button("Show")).toBeDefined());
    await press("Show");
    await vi.waitFor(() => expect(document.body.textContent).toContain("turn failed"));
    await press("Send");

    await vi.waitFor(() => expect(bridge.submit).toHaveBeenCalledTimes(1));
    expect(bridge.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "PDF goes blank",
        source: "sidebar",
        error: null,
        logs: "== End of the server log ==\nturn failed",
        screenshot: null,
        conversation: null,
      }),
    );
  });

  it("keeps the words when the report could not be saved", async () => {
    using fixture = installBridge();
    const { bridge } = fixture;
    bridge.submit.mockResolvedValueOnce({ _tag: "failed", message: "Disk full." } as never);
    await using _screen = await render(<FeedbackDialogHost />);
    await act(() => requestFeedback({ source: "sidebar" }));
    const box = page.getByRole("textbox", { name: "Your feedback" });
    await userEvent.fill(box, "Keep me");
    await vi.waitFor(() => expect(button("Send")?.disabled).toBe(false));
    await press("Send");

    await expect.element(page.getByRole("alert")).toHaveTextContent("Disk full.");
    await expect.element(box).toHaveValue("Keep me");
    expect(toastAdd).not.toHaveBeenCalled();
  });

  it("drops a conversation that finishes exporting after its report was closed", async () => {
    using _fixture = installBridge();
    let finishExport: (value: unknown) => void = () => undefined;
    exportConversation.mockReturnValueOnce(
      new Promise((resolve) => {
        finishExport = resolve;
      }),
    );
    await using _screen = await render(<FeedbackDialogHost />);
    await act(() =>
      requestFeedback({
        source: "turn-error",
        error: { message: "Codex exited" },
        threadRef: {
          environmentId: EnvironmentId.make("4b1b7c1e-8d1f-4a5e-9b0e-0c9f5f1d2a3b"),
          threadId: ThreadId.make("9f0e1d2c-3b4a-4596-8778-695a4b3c2d1e"),
        },
      }),
    );
    await press("Add this conversation");
    await press("Cancel");
    await act(() => requestFeedback({ source: "sidebar" }));

    await act(async () =>
      finishExport({ text: "# Thread A\n\nprivate words", messageCount: 1, warnings: [] }),
    );
    expect(useFeedbackDraft.getState().conversation).toBeNull();
    expect(document.body.textContent).not.toContain("This conversation");
  });
});
