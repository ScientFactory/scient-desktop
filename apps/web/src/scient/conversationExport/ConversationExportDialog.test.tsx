import { MessageId, ThreadId, type ScientConversationExportPreparation } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ConversationExportForm } from "./ConversationExportDialog";
import {
  INCLUDE_CAUTION,
  RUNNING_TURN_WARNING,
  initialExportDialogState,
} from "./exportDialog.logic";
import { registeredConversationExportFormats } from "./formatRegistry";

const preparation: ScientConversationExportPreparation = {
  threadId: ThreadId.make("thread-1"),
  title: "Study",
  formats: [{ format: "markdown", available: true, unavailableReason: null }],
  messageCount: 1,
  attachmentCount: 0,
  workLogEntryCount: 0,
  reasoningCount: 0,
  runningTurnOmitted: false,
  messages: [
    {
      messageId: MessageId.make("m1"),
      n: 1,
      role: "user",
      createdAt: "2026-09-27T10:00:00.000Z",
      excerpt: "Hi",
    },
  ],
};

function render(overrides: Partial<ScientConversationExportPreparation> = {}, state = {}) {
  const prepared = { ...preparation, ...overrides };
  const registrations = registeredConversationExportFormats();
  return renderToStaticMarkup(
    <ConversationExportForm
      preparation={prepared}
      registrations={registrations}
      state={{
        ...initialExportDialogState(registrations, "markdown"),
        ...state,
      }}
      disabled={false}
      onChange={() => undefined}
    />,
  );
}

describe("ConversationExportForm", () => {
  it("renders keyboard-operable controls with work log and reasoning off, and no format or range choice", () => {
    const markup = render();
    expect(markup).not.toContain("aria-pressed");
    expect(markup.match(/role="switch"/g)).toHaveLength(2);
    expect(markup.match(/aria-checked="false"/g)?.length).toBeGreaterThanOrEqual(2);
    expect(markup).not.toContain('role="radiogroup"');
    expect(markup).not.toContain("Whole conversation");
    expect(markup).not.toContain("With attachments (.zip)");
    expect(markup).not.toContain(INCLUDE_CAUTION);
  });

  it("offers the zip choice only when there are attachments", () => {
    expect(render({ attachmentCount: 2 })).toContain("With attachments (.zip)");
  });

  it("shows the caution line only while a toggle is on, and the running-turn warning", () => {
    expect(render({}, { includeWorkLog: true })).toContain(INCLUDE_CAUTION);
    expect(render({}, { includeReasoning: true })).toContain(INCLUDE_CAUTION);
    const markup = render({ runningTurnOmitted: true });
    expect(markup).not.toContain(INCLUDE_CAUTION);
    expect(markup).toContain(RUNNING_TURN_WARNING);
  });
});
