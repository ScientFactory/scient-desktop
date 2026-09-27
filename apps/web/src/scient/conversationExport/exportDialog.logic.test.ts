import { MessageId, ThreadId, type ScientConversationExportPreparation } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  PRIVACY_WARNING,
  RUNNING_TURN_WARNING,
  buildExportRequest,
  canCopyExport,
  exportDialogWarnings,
  exportFormatOptions,
  initialExportDialogState,
  offeredVariant,
} from "./exportDialog.logic";
import {
  registerConversationExportFormat,
  registeredConversationExportFormats,
  type ConversationExportFormatRegistration,
} from "./formatRegistry";
import "./formats";

const preparation: ScientConversationExportPreparation = {
  threadId: ThreadId.make("thread-1"),
  title: "Study",
  formats: [{ format: "markdown", available: true, unavailableReason: null }],
  messageCount: 2,
  attachmentCount: 0,
  workLogEntryCount: 3,
  reasoningCount: 1,
  runningTurnOmitted: false,
  messages: [
    {
      messageId: MessageId.make("m1"),
      n: 1,
      role: "user",
      createdAt: "2026-09-27T10:00:00.000Z",
      excerpt: "Hi",
    },
    {
      messageId: MessageId.make("m2"),
      n: 2,
      role: "assistant",
      createdAt: "2026-09-27T10:01:00.000Z",
      excerpt: "Hello",
    },
  ],
};
const registrations = registeredConversationExportFormats();

describe("export dialog", () => {
  it("registers Markdown and Word through the format registry", () => {
    expect(registrations.map((entry) => entry.format)).toEqual(["markdown", "docx"]);
    expect(exportFormatOptions(preparation, registrations)).toEqual([
      { registration: registrations[0], available: true, unavailableReason: null },
      {
        registration: registrations[1],
        available: false,
        unavailableReason: "Not available on this Scient.",
      },
    ]);
    // Word offers its install where it is unavailable, and is never copied.
    expect(registrations[1]?.UnavailableAction).toBeDefined();
    expect(registrations[1]?.supportsCopy).toBe(false);
  });

  it("starts with work log and reasoning off and the whole conversation", () => {
    expect(initialExportDialogState(preparation, registrations)).toEqual({
      format: "markdown",
      variant: "text",
      includeWorkLog: false,
      includeReasoning: false,
      range: "whole",
      throughMessageId: "m2",
    });
  });

  it("marks registered formats the server cannot produce as unavailable with its reason", () => {
    const pdf: ConversationExportFormatRegistration = {
      format: "pdf",
      label: "PDF",
      supportsCopy: false,
    };
    const options = exportFormatOptions(
      {
        ...preparation,
        formats: [
          ...preparation.formats,
          {
            format: "pdf",
            available: false,
            unavailableReason: "A connected Scient desktop is required.",
          },
        ],
      },
      [...registrations, pdf],
    );
    expect(options.find((option) => option.registration.format === "pdf")).toMatchObject({
      available: false,
      unavailableReason: "A connected Scient desktop is required.",
    });
    expect(exportFormatOptions(preparation, [pdf])[0]?.unavailableReason).toBe(
      "Not available on this Scient.",
    );
  });

  it("offers text or zip only when the conversation has attachments", () => {
    const state = initialExportDialogState(preparation, registrations);
    expect(offeredVariant(state, preparation, registrations)).toBeNull();
    const withAttachments = { ...preparation, attachmentCount: 2 };
    expect(
      offeredVariant(state, withAttachments, registrations)?.choices.map((choice) => choice.value),
    ).toEqual(["text", "with-attachments"]);
    expect(
      canCopyExport({ ...state, variant: "with-attachments" }, withAttachments, registrations),
    ).toBe(false);
    expect(canCopyExport(state, withAttachments, registrations)).toBe(true);
  });

  it("warns about privacy when the work log or reasoning is included, and about a running turn", () => {
    const state = initialExportDialogState(preparation, registrations);
    expect(exportDialogWarnings(state, preparation)).toEqual([]);
    expect(exportDialogWarnings({ ...state, includeReasoning: true }, preparation)).toEqual([
      PRIVACY_WARNING,
    ]);
    expect(exportDialogWarnings(state, { ...preparation, runningTurnOmitted: true })).toEqual([
      RUNNING_TURN_WARNING,
    ]);
  });

  it("builds the request from the choices", () => {
    const state = {
      ...initialExportDialogState(preparation, registrations),
      includeWorkLog: true,
      range: "through-message" as const,
      throughMessageId: MessageId.make("m1"),
      variant: "with-attachments",
    };
    const withAttachments = { ...preparation, attachmentCount: 1 };
    expect(
      buildExportRequest({
        threadId: preparation.threadId,
        state,
        preparation: withAttachments,
        registrations,
        delivery: "file",
        timeZone: "Asia/Jerusalem",
      }),
    ).toEqual({
      threadId: "thread-1",
      format: "markdown",
      delivery: "file",
      timeZone: "Asia/Jerusalem",
      options: {
        includeWorkLog: true,
        includeReasoning: false,
        range: { _tag: "through-message", messageId: "m1" },
        markdownPackaging: "with-attachments",
      },
    });
    expect(
      buildExportRequest({
        threadId: preparation.threadId,
        state,
        preparation: withAttachments,
        registrations,
        delivery: "clipboard",
        timeZone: null,
      })?.options.markdownPackaging,
    ).toBe("text");
  });

  it("lets a later format register without changing the dialog", () => {
    registerConversationExportFormat({
      format: "scic",
      label: "Scient (.scic)",
      supportsCopy: false,
    });
    expect(registeredConversationExportFormats().map((entry) => entry.format)).toEqual([
      "markdown",
      "docx",
      "scic",
    ]);
  });
});
