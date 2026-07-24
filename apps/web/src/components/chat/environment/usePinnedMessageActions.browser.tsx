// FILE: usePinnedMessageActions.browser.tsx
// Purpose: Browser coverage for action-local pin-limit feedback.

import "../../../index.css";

import {
  MessageId,
  PINNED_MESSAGES_MAX_COUNT,
  type PinnedMessage,
  ThreadId,
} from "@synara/contracts";
import { page } from "vitest/browser";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { usePinnedMessageActions } from "./usePinnedMessageActions";

const TARGET_MESSAGE_ID = "message-target" as MessageId;

function PinLimitHarness() {
  const pinnedMessages: PinnedMessage[] = Array.from(
    { length: PINNED_MESSAGES_MAX_COUNT },
    (_, index) => ({
      messageId: `message-${index}` as MessageId,
      label: null,
      done: false,
      pinnedAt: "2026-07-23T09:00:00.000Z",
    }),
  );
  const { handleTogglePinMessage, pinLimitMessageId } = usePinnedMessageActions({
    activeThreadId: "thread-1" as ThreadId,
    pinnedMessages,
  });

  return (
    <div>
      <button type="button" onClick={() => handleTogglePinMessage(TARGET_MESSAGE_ID)}>
        Pin message
      </button>
      {pinLimitMessageId === TARGET_MESSAGE_ID ? (
        <p role="status" aria-live="polite">
          You’ve reached the pinned-message limit for this thread.
        </p>
      ) : null}
    </div>
  );
}

describe("usePinnedMessageActions pin limit", () => {
  it("returns feedback to the owning pin control instead of opening a global alert", async () => {
    await render(<PinLimitHarness />);

    await page.getByRole("button", { name: "Pin message" }).click();

    await expect
      .element(page.getByRole("status"))
      .toHaveTextContent("pinned-message limit for this thread");
  });
});
