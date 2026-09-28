// @vitest-environment jsdom

import {
  EnvironmentId,
  MessageId,
  ThreadId,
  type ConversationExportFormat,
  type ScientConversationExportPreparation,
} from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const prepareConversationExport = vi.fn();
const exportConversation = vi.fn();
const prepareConversationWordDiagrams = vi.fn();
vi.mock("./client", () => ({
  prepareConversationExport,
  exportConversation,
  prepareConversationWordDiagrams,
}));
const readPandocTool = vi.fn();
const installPandocTool = vi.fn();
vi.mock("../wordExport/client", () => ({ readPandocTool, installPandocTool }));

const { ConversationExportDialogHost, requestConversationExport } =
  await import("./ConversationExportDialog");
const { handleConversationExportMenuAction } = await import("./menu");
const { INCLUDE_CAUTION } = await import("./exportDialog.logic");
const { buildThreadActionMenuItems } = await import("../../components/threadActionMenu.logic");
const { toastManager } = await import("../../components/ui/toast");

const threadRef = {
  environmentId: EnvironmentId.make("local"),
  threadId: ThreadId.make("thread-1"),
};
const everyFormat = (["markdown", "pdf", "docx", "scic"] as const).map((format) => ({
  format,
  available: true,
  unavailableReason: null,
}));
const preparation: ScientConversationExportPreparation = {
  threadId: ThreadId.make("thread-1"),
  title: "Study",
  formats: [{ format: "markdown", available: true, unavailableReason: null }],
  messageCount: 2,
  attachmentCount: 0,
  workLogEntryCount: 2,
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

function pandocStatus(overrides: { installed?: boolean; canInstall?: boolean } = {}) {
  const installed = overrides.installed ?? false;
  return {
    version: "3.11",
    installed,
    canInstall: overrides.canInstall ?? true,
    unavailableReason:
      overrides.canInstall === false ? "Pandoc has no build for this computer." : null,
    downloadBytes: 41_832_712,
    install: {
      state: installed ? "ready" : "idle",
      bytesReceived: null,
      totalBytes: null,
      failureReason: null,
      updatedAtEpochMs: 1,
    },
  };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  prepareConversationExport.mockReset();
  exportConversation.mockReset();
  prepareConversationWordDiagrams
    .mockReset()
    .mockResolvedValue({ sourceDigest: `sha256:${"a".repeat(64)}`, diagrams: [] });
  readPandocTool.mockReset();
  readPandocTool.mockResolvedValue(pandocStatus());
  installPandocTool.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

async function renderHost() {
  await act(async () => root.render(<ConversationExportDialogHost />));
}

async function open(format: ConversationExportFormat = "markdown") {
  await act(async () => requestConversationExport(threadRef, format));
  await flush();
}

function dialog() {
  return document.querySelector<HTMLElement>('[role="dialog"]');
}

function switches() {
  return [...document.querySelectorAll<HTMLElement>('[role="switch"]')];
}

function button(name: string) {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === name || candidate.getAttribute("aria-label") === name,
  );
}

function statusTexts() {
  return [...document.querySelectorAll('[role="status"]')].map((element) => element.textContent);
}

async function pressKey(target: HTMLElement, key: string) {
  await act(async () => {
    target.focus();
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    target.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
  });
}

/**
 * Enter on a focused native button: the browser turns the key into a click
 * with no pointer detail, which jsdom does not synthesize itself.
 */
async function activateByKeyboard(target: HTMLButtonElement) {
  expect(target.tagName).toBe("BUTTON");
  await pressKey(target, "Enter");
  await act(async () => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 0 }));
  });
  await flush();
}

async function click(target: HTMLElement) {
  await act(async () => target.click());
  await flush();
}

describe("ConversationExportDialog", () => {
  it("opens each Export submenu entry as its own dialog, with no format switcher", async () => {
    prepareConversationExport.mockResolvedValue({ ...preparation, formats: everyFormat });
    await renderHost();
    const titles: string[] = [];
    for (const format of ["markdown", "pdf", "docx", "scic"]) {
      await act(async () => {
        expect(handleConversationExportMenuAction(`export-conversation:${format}`, threadRef)).toBe(
          true,
        );
      });
      await flush();
      titles.push(dialog()?.querySelector('[data-slot="dialog-title"]')?.textContent ?? "");
      expect(dialog()?.querySelector("[aria-pressed]")).toBeNull();
    }
    expect(titles).toEqual([
      "Export as Markdown",
      "Export as PDF",
      "Export as Word",
      "Export as Scient file",
    ]);
    expect(handleConversationExportMenuAction("copy-path", threadRef)).toBe(false);
  });

  it("names the saved file on the primary button, and offers no Copy", async () => {
    prepareConversationExport.mockResolvedValue({ ...preparation, attachmentCount: 1 });
    await renderHost();
    await open("markdown");

    expect(button("Save .md")).toBeDefined();
    expect(button("Copy")).toBeUndefined();
    const zip = [...document.querySelectorAll<HTMLElement>('[role="radio"]')].find((radio) =>
      radio.closest("label")?.textContent?.includes("With attachments (.zip)"),
    )!;
    await click(zip);
    expect(button("Save .zip")).toBeDefined();
    expect(button("Save .md")).toBeUndefined();
  });

  it("is operated by keyboard, cautions only while a toggle is on, and resets when reopened", async () => {
    prepareConversationExport.mockResolvedValue(preparation);
    await renderHost();
    await open();
    expect(document.body.textContent).not.toContain(INCLUDE_CAUTION);

    const [workLog, reasoning] = switches();
    expect(workLog?.getAttribute("aria-checked")).toBe("false");
    expect(reasoning?.getAttribute("aria-checked")).toBe("false");

    await pressKey(workLog!, " ");
    expect(document.body.textContent).toContain(INCLUDE_CAUTION);
    await pressKey(reasoning!, "Enter");
    expect(switches().map((element) => element.getAttribute("aria-checked"))).toEqual([
      "true",
      "true",
    ]);
    await pressKey(workLog!, " ");
    expect(document.body.textContent).toContain(INCLUDE_CAUTION);
    await pressKey(reasoning!, " ");
    expect(document.body.textContent).not.toContain(INCLUDE_CAUTION);
    await pressKey(reasoning!, " ");

    await pressKey(dialog()!, "Escape");
    expect(dialog()).toBeNull();

    await open();
    expect(switches().map((element) => element.getAttribute("aria-checked"))).toEqual([
      "false",
      "false",
    ]);
    expect(document.body.textContent).not.toContain(INCLUDE_CAUTION);
    expect(prepareConversationExport).toHaveBeenCalledTimes(2);
  });

  it("announces preparing and exporting progress", async () => {
    let resolvePreparation!: (value: ScientConversationExportPreparation) => void;
    prepareConversationExport.mockReturnValue(
      new Promise((resolve) => {
        resolvePreparation = resolve;
      }),
    );
    let resolveExport!: (value: unknown) => void;
    exportConversation.mockReturnValue(
      new Promise((resolve) => {
        resolveExport = resolve;
      }),
    );
    await renderHost();
    await open();
    expect(statusTexts()).toContain("Preparing the conversation…");

    await act(async () => resolvePreparation(preparation));
    await flush();
    expect(statusTexts()).not.toContain("Preparing the conversation…");

    await click(button("Save .md")!);
    expect(statusTexts()).toContain("Exporting…");
    expect(button("Save .md")?.disabled).toBe(true);

    await act(async () => resolveExport({ file: null, text: null, warnings: [] }));
    await flush();
    expect(dialog()).toBeNull();
  });

  it("clears an export error when the user changes an option", async () => {
    prepareConversationExport.mockResolvedValue(preparation);
    exportConversation.mockRejectedValue(new Error("The conversation could not be exported."));
    await renderHost();
    await open();

    await click(button("Save .md")!);
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "The conversation could not be exported.",
    );
    await pressKey(switches()[0]!, " ");
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it("opens and closes the info cards by mouse and keyboard", async () => {
    prepareConversationExport.mockResolvedValue({ ...preparation, formats: everyFormat });
    await renderHost();
    await open("docx");
    readPandocTool.mockResolvedValue(pandocStatus({ installed: true }));

    const about = button("About Word export")!;
    expect(about).toBeDefined();
    await click(about);
    expect(document.body.textContent).toContain(
      "Equations stay editable. Images, tables, footnotes and citations are kept.",
    );
    await pressKey(document.querySelector<HTMLElement>('[data-slot="popover-popup"]')!, "Escape");
    await flush();
    expect(document.body.textContent).not.toContain("Equations stay editable.");
    // Escape closes only the card, not the dialog under it.
    expect(dialog()).not.toBeNull();

    const card = "Equations stay editable.";
    await activateByKeyboard(about);
    expect(document.body.textContent).toContain(card);
    await pressKey(document.querySelector<HTMLElement>('[data-slot="popover-popup"]')!, "Escape");
    await flush();
    expect(document.body.textContent).not.toContain(card);
    expect(document.activeElement).toBe(about);
    // A second press of the trigger closes an open card.
    await click(about);
    expect(document.body.textContent).toContain(card);
    await click(about);
    expect(document.body.textContent).not.toContain(card);
  });

  it("shows the Pandoc requirement for Word, with no Save, and continues once installed", async () => {
    prepareConversationExport.mockResolvedValueOnce(preparation);
    prepareConversationExport.mockResolvedValueOnce({
      ...preparation,
      formats: [
        ...preparation.formats,
        { format: "docx", available: true, unavailableReason: null },
      ],
    });
    installPandocTool.mockResolvedValue(pandocStatus({ installed: true }));
    await renderHost();
    await open("docx");
    await flush();

    expect(document.body.textContent).toContain(
      "Word export needs Pandoc (40 MB, one-time download).",
    );
    expect(switches()).toHaveLength(0);
    expect(button("Save .docx")).toBeUndefined();
    await click(button("Install Pandoc")!);

    expect(installPandocTool).toHaveBeenCalledWith(threadRef.environmentId);
    expect(prepareConversationExport).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain("Pandoc");
    expect(switches()).toHaveLength(2);
    exportConversation.mockResolvedValue({ file: null, text: null, warnings: [] });
    await click(button("Save .docx")!);
    expect(prepareConversationWordDiagrams).toHaveBeenCalledOnce();
    expect(exportConversation.mock.calls[0]?.[1]).toMatchObject({
      format: "docx",
      options: { range: { _tag: "whole" } },
      diagramCapture: { sourceDigest: `sha256:${"a".repeat(64)}`, diagrams: [] },
    });
  });

  it("reads Word's availability again after a failed Word export", async () => {
    const withWord = {
      ...preparation,
      formats: [
        ...preparation.formats,
        { format: "docx" as const, available: true, unavailableReason: null },
      ],
    };
    readPandocTool.mockResolvedValue(pandocStatus({ installed: true }));
    prepareConversationExport.mockResolvedValue(withWord);
    exportConversation.mockRejectedValue(new Error("Scient could not start Pandoc."));
    await renderHost();
    await open("docx");
    await flush();
    expect(prepareConversationExport).toHaveBeenCalledTimes(1);

    await click(button("Save .docx")!);

    expect(document.body.textContent).toContain("Scient could not start Pandoc.");
    expect(prepareConversationExport).toHaveBeenCalledTimes(2);
  });

  it("says why Word cannot run on this computer, with nothing to press", async () => {
    readPandocTool.mockResolvedValue(pandocStatus({ canInstall: false }));
    prepareConversationExport.mockResolvedValue(preparation);
    await renderHost();
    await open("docx");
    await flush();

    expect(document.body.textContent).toContain("Pandoc has no build for this computer.");
    expect(button("Install Pandoc")).toBeUndefined();
    expect(button("Save .docx")).toBeUndefined();
    expect(button("Cancel")).toBeDefined();
  });

  it("shows a recoverable error when the environment is not connected", async () => {
    prepareConversationExport.mockRejectedValueOnce(
      new Error("The conversation's environment is not connected."),
    );
    prepareConversationExport.mockResolvedValueOnce(preparation);
    await renderHost();
    await open();

    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "The conversation's environment is not connected.",
    );
    await click(button("Try again")!);
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(switches()).toHaveLength(2);
  });
});

describe("Copy ▸ Conversation as Markdown", () => {
  it("copies the default Markdown from the thread menu and confirms it", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const addToast = vi.spyOn(toastManager, "add");
    await renderHost();
    exportConversation.mockResolvedValue({
      file: null,
      text: "# Study\n\nHi",
      warnings: [],
    });
    const items = buildThreadActionMenuItems({
      branch: null,
      projectFilter: null,
      isPinned: false,
      isSettled: false,
      autoSettleEnabled: true,
      isSnoozed: false,
      canSnoozeNow: true,
      isRegeneratingTitle: false,
      isRunning: false,
      supports: {
        settlement: false,
        autoSettleOptOut: false,
        snooze: false,
        pinning: false,
        titleRegeneration: false,
      },
      snoozePresets: [],
    });
    const entry = items
      .find((item) => item.id === "copy")
      ?.children?.find((child) => child.label === "Conversation as Markdown");
    expect(entry).toBeDefined();

    await act(async () => {
      expect(handleConversationExportMenuAction(entry!.id, threadRef)).toBe(true);
    });
    await flush();

    expect(exportConversation).toHaveBeenCalledOnce();
    expect(exportConversation.mock.calls[0]?.[0]).toBe(threadRef.environmentId);
    expect(exportConversation.mock.calls[0]?.[1]).toMatchObject({
      threadId: threadRef.threadId,
      format: "markdown",
      delivery: "clipboard",
      options: {
        includeWorkLog: false,
        includeReasoning: false,
        range: { _tag: "whole" },
        markdownPackaging: "text",
      },
    });
    expect(writeText).toHaveBeenCalledWith("# Study\n\nHi");
    expect(addToast).toHaveBeenCalledWith({ type: "success", title: "Markdown copied" });
    // Copying opens no dialog.
    expect(dialog()).toBeNull();
    addToast.mockRestore();
  });
});
