import { MessageId, ThreadId, type ScientConversationExportPreparation } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ConversationExportForm } from "./ConversationExportDialog";
import {
  PRIVACY_WARNING,
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
      state={{ ...initialExportDialogState(prepared, registrations), ...state }}
      disabled={false}
      onChange={() => undefined}
    />,
  );
}

describe("ConversationExportForm", () => {
  it("renders registered formats and keyboard-operable controls with work log and reasoning off", () => {
    const markup = render();
    expect(markup).toContain(">Markdown<");
    expect(markup.match(/role="switch"/g)).toHaveLength(2);
    expect(markup.match(/aria-checked="false"/g)?.length).toBeGreaterThanOrEqual(2);
    expect(markup).toContain('role="radiogroup"');
    expect(markup).toContain("Whole conversation");
    expect(markup).not.toContain("With attachments (.zip)");
    expect(markup).not.toContain(PRIVACY_WARNING);
  });

  it("offers the zip choice only when there are attachments", () => {
    expect(render({ attachmentCount: 2 })).toContain("With attachments (.zip)");
  });

  it("shows the privacy and running-turn warnings", () => {
    const markup = render({ runningTurnOmitted: true }, { includeWorkLog: true });
    expect(markup).toContain(PRIVACY_WARNING);
    expect(markup).toContain(RUNNING_TURN_WARNING);
  });

  it("names formats this server cannot produce", () => {
    expect(
      render({
        formats: [{ format: "markdown", available: false, unavailableReason: "Not here." }],
      }),
    ).toContain("Markdown: Not here.");
  });
});
