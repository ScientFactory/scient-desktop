// @vitest-environment jsdom

import {
  EnvironmentId,
  MessageId,
  ThreadId,
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

const threadRef = {
  environmentId: EnvironmentId.make("local"),
  threadId: ThreadId.make("thread-1"),
};
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

function pandocStatus(installed: boolean) {
  return {
    version: "3.11",
    installed,
    canInstall: true,
    unavailableReason: null,
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
  readPandocTool.mockResolvedValue(pandocStatus(false));
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

async function open() {
  await act(async () => requestConversationExport(threadRef));
  await act(async () => {
    await Promise.resolve();
  });
}

function switches() {
  return [...document.querySelectorAll<HTMLElement>('[role="switch"]')];
}

async function pressKey(target: HTMLElement, key: string) {
  await act(async () => {
    target.focus();
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    target.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
  });
}

describe("ConversationExportDialog", () => {
  it("is operated by keyboard and resets sensitive options when reopened", async () => {
    prepareConversationExport.mockResolvedValue(preparation);
    await act(async () => root.render(<ConversationExportDialogHost />));
    await open();

    const [workLog, reasoning] = switches();
    expect(workLog?.getAttribute("aria-checked")).toBe("false");
    expect(reasoning?.getAttribute("aria-checked")).toBe("false");

    await pressKey(workLog!, " ");
    await pressKey(reasoning!, "Enter");
    expect(switches().map((element) => element.getAttribute("aria-checked"))).toEqual([
      "true",
      "true",
    ]);
    expect(document.body.textContent).toContain(
      "Work log and reasoning can include file paths, command output, and secrets.",
    );

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    await pressKey(dialog, "Escape");
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    await open();
    expect(switches().map((element) => element.getAttribute("aria-checked"))).toEqual([
      "false",
      "false",
    ]);
    expect(document.body.textContent).not.toContain("can include file paths");
    expect(prepareConversationExport).toHaveBeenCalledTimes(2);
  });

  it("shows a recoverable error when the environment is not connected", async () => {
    prepareConversationExport.mockRejectedValueOnce(
      new Error("The conversation's environment is not connected."),
    );
    prepareConversationExport.mockResolvedValueOnce(preparation);
    await act(async () => root.render(<ConversationExportDialogHost />));
    await open();

    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "The conversation's environment is not connected.",
    );
    const retry = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Try again",
    )!;
    await act(async () => retry.click());
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(switches()).toHaveLength(2);
  });

  it("offers the Pandoc install for Word and selects Word once it is installed", async () => {
    prepareConversationExport.mockResolvedValueOnce(preparation);
    prepareConversationExport.mockResolvedValueOnce({
      ...preparation,
      formats: [
        ...preparation.formats,
        { format: "docx", available: true, unavailableReason: null },
      ],
    });
    installPandocTool.mockResolvedValue(pandocStatus(true));
    await act(async () => root.render(<ConversationExportDialogHost />));
    await open();

    expect(document.body.textContent).toContain("Word export needs Pandoc (40 MB).");
    const install = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Install Pandoc (40 MB)",
    )!;
    await act(async () => install.click());
    await act(async () => {
      await Promise.resolve();
    });

    expect(installPandocTool).toHaveBeenCalledWith(threadRef.environmentId);
    expect(prepareConversationExport).toHaveBeenCalledTimes(2);
    const pressed = [...document.querySelectorAll('[aria-pressed="true"]')].map(
      (element) => element.textContent,
    );
    expect(pressed).toEqual(["Word"]);
    expect(document.body.textContent).not.toContain("Install Pandoc");
    exportConversation.mockResolvedValue({ file: null, warnings: [] });
    const exportButton = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Export",
    )!;
    await act(async () => exportButton.click());
    expect(prepareConversationWordDiagrams).toHaveBeenCalledOnce();
    expect(exportConversation.mock.calls[0]?.[1]).toMatchObject({
      format: "docx",
      diagramCapture: { sourceDigest: `sha256:${"a".repeat(64)}`, diagrams: [] },
    });
  });
});
