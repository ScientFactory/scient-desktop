import { MessageId, ThreadId, type ScientConversationExportPreparation } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  RUNNING_TURN_WARNING,
  buildExportRequest,
  copyMarkdownRequest,
  exportDialogWarnings,
  exportFormatAvailability,
  exportSaveLabel,
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
  it("registers Markdown, PDF, Word, and Scient file in menu order", () => {
    expect(registrations.map((entry) => [entry.format, entry.menuLabel])).toEqual([
      ["markdown", "Markdown (.md)"],
      ["pdf", "PDF (.pdf)"],
      ["docx", "Word (.docx)"],
      ["scic", "Scient file (.scic)"],
    ]);
    // Word offers its install where it is unavailable.
    expect(registrations[2]?.UnavailableAction).toBeDefined();
  });

  it("marks a format the server does not advertise as unavailable with its reason", () => {
    expect(exportFormatAvailability("markdown", preparation, registrations)).toEqual({
      available: true,
    });
    expect(exportFormatAvailability("scic", preparation, registrations)).toEqual({
      available: false,
      reason: "Not available on this Scient.",
    });
    expect(
      exportFormatAvailability(
        "pdf",
        {
          ...preparation,
          formats: [
            {
              format: "pdf",
              available: false,
              unavailableReason: "A connected Scient desktop is required.",
            },
          ],
        },
        registrations,
      ),
    ).toEqual({ available: false, reason: "A connected Scient desktop is required." });
  });

  it("adds a format's client requirement to the server's capability", () => {
    const withPdf = {
      ...preparation,
      formats: [{ format: "pdf" as const, available: true, unavailableReason: null }],
    };
    const pdf: ConversationExportFormatRegistration = {
      format: "pdf",
      label: "PDF",
      menuLabel: "PDF (.pdf)",
      about: "About.",
      saveLabel: "Save PDF",
      clientAvailability: () => ({ available: false, reason: "Needs the desktop app." }),
    };
    expect(exportFormatAvailability("pdf", withPdf, [pdf])).toEqual({
      available: false,
      reason: "Needs the desktop app.",
    });
    expect(
      exportFormatAvailability("pdf", withPdf, [
        { ...pdf, clientAvailability: () => ({ available: true }) },
      ]),
    ).toEqual({ available: true });
  });

  it("starts with the requested format and work log and reasoning off", () => {
    expect(initialExportDialogState(registrations, "markdown")).toEqual({
      format: "markdown",
      variant: "text",
      includeWorkLog: false,
      includeReasoning: false,
    });
    expect(initialExportDialogState(registrations, "scic")).toEqual({
      format: "scic",
      variant: null,
      includeWorkLog: false,
      includeReasoning: false,
    });
  });

  it("offers text or zip only when the conversation has attachments", () => {
    const state = initialExportDialogState(registrations, "markdown");
    expect(offeredVariant(state, preparation, registrations)).toBeNull();
    const withAttachments = { ...preparation, attachmentCount: 2 };
    expect(
      offeredVariant(state, withAttachments, registrations)?.choices.map((choice) => choice.label),
    ).toEqual(["Text only (.md)", "With attachments (.zip)"]);
  });

  it("names the saved file type on the primary button", () => {
    const withAttachments = { ...preparation, attachmentCount: 2 };
    const state = initialExportDialogState(registrations, "markdown");
    expect(exportSaveLabel(state, preparation, registrations)).toBe("Save .md");
    expect(exportSaveLabel(state, withAttachments, registrations)).toBe("Save .md");
    expect(
      exportSaveLabel({ ...state, variant: "with-attachments" }, withAttachments, registrations),
    ).toBe("Save .zip");
    const labels = (["pdf", "docx", "scic"] as const).map((format) =>
      exportSaveLabel(initialExportDialogState(registrations, format), preparation, registrations),
    );
    expect(labels).toEqual(["Save PDF", "Save .docx", "Save .scic"]);
  });

  it("reports a running turn without changing the include choices", () => {
    expect(exportDialogWarnings(preparation)).toEqual([]);
    expect(exportDialogWarnings({ ...preparation, runningTurnOmitted: true })).toEqual([
      RUNNING_TURN_WARNING,
    ]);
  });

  it("builds the request from the choices", () => {
    const state = {
      ...initialExportDialogState(registrations, "markdown"),
      includeWorkLog: true,
      variant: "with-attachments",
    };
    expect(
      buildExportRequest({
        threadId: preparation.threadId,
        state,
        preparation: { ...preparation, attachmentCount: 1 },
        registrations,
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
        range: { _tag: "whole" },
        markdownPackaging: "with-attachments",
      },
    });
    expect(
      buildExportRequest({
        threadId: ThreadId.make("t1"),
        state: initialExportDialogState(registrations, "scic"),
        preparation,
        registrations,
        timeZone: null,
      }),
    ).toEqual({
      threadId: "t1",
      format: "scic",
      options: { includeWorkLog: false, includeReasoning: false, range: { _tag: "whole" } },
      delivery: "file",
    });
  });

  it("copies the whole conversation as text-only Markdown without work log or reasoning", () => {
    expect(copyMarkdownRequest(ThreadId.make("t1"), "Europe/Paris")).toEqual({
      threadId: "t1",
      format: "markdown",
      delivery: "clipboard",
      timeZone: "Europe/Paris",
      options: {
        includeWorkLog: false,
        includeReasoning: false,
        range: { _tag: "whole" },
        markdownPackaging: "text",
      },
    });
  });

  it("lets a format re-register without changing menu order", () => {
    const scic = registrations.find((entry) => entry.format === "scic")!;
    registerConversationExportFormat({ ...scic });
    expect(registeredConversationExportFormats().map((entry) => entry.format)).toEqual([
      "markdown",
      "pdf",
      "docx",
      "scic",
    ]);
  });
});
