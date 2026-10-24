import { createElement } from "react";
import { type ReactNode } from "react";
import { render } from "../../../test/render";

import "~/index.css";
import { describe, expect, it, vi } from "vite-plus/test";
vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentIdentificationMode: () => "none",
}));
vi.mock("../SidebarStageBackdrop", () => ({
  StageBackdropButtonArt: ({ variant }: { variant: string }) => `stage-${variant}`,
  useSidebarStageBackdropVariant: () => null,
}));
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
function renderRunningActions(
  showSendWhileRunning: boolean,
  hasSendableContent: boolean,
  isStopping = false,
) {
  return renderMarkup(
    createElement(ComposerPrimaryActions, {
      compact: true,
      canOperateThread: true,
      pendingAction: null,
      isRunning: true,
      canInterrupt: true,
      isStopping,
      showPlanFollowUpPrompt: false,
      promptHasText: hasSendableContent,
      isSendBusy: false,
      sendDisabledReason: null,
      isConnecting: false,
      isEnvironmentUnavailable: false,
      isPreparingWorktree: false,
      hasSendableContent,
      showSendWhileRunning,
      followUpBehavior: "queue",
      onPreviousPendingQuestion: () => {},
      onInterrupt: () => {},
      onImplementPlanInNewThread: () => {},
    }),
  );
}
describe("ComposerPrimaryActions", () => {
  // regression: 8e449111bd fix(orchestration): cancel checkpoint preparation on Stop
  it("acknowledges Stop visibly while keeping its retry button available", async () => {
    const markup = await renderRunningActions(false, false, true);
    expect(markup).toContain('role="status"');
    expect(markup).toContain("Stopping…");
    expect(markup).toContain('aria-label="Stop generation"');
    expect(markup).not.toContain("disabled");
    expect(await renderRunningActions(false, false)).not.toContain("Stopping…");
  });
  it("only renders stop while running when Enter-to-send is available", async () => {
    const markup = await renderRunningActions(false, true);
    expect(markup).toContain('aria-label="Stop generation"');
    // The submit button would read "Queue message" here; it must not render at all.
    expect(markup).not.toContain('aria-label="Queue message"');
  });
  it("renders the queue button alongside stop while running with sendable content", async () => {
    const markup = await renderRunningActions(true, true);
    expect(markup).toContain('aria-label="Stop generation"');
    // Submitting a running thread queues the message, so the button advertises
    // the real disposition instead of "Send message".
    expect(markup).toContain('aria-label="Queue message"');
    expect(markup).toContain('type="submit"');
  });
  it("keeps stop as the only action while running with an empty composer", async () => {
    const markup = await renderRunningActions(true, false);
    expect(markup).toContain('aria-label="Stop generation"');
    expect(markup).not.toContain('aria-label="Queue message"');
  });
});
async function renderMarkup(node: ReactNode): Promise<string> {
  await using screen = await render(node);
  return screen.container.innerHTML;
}
