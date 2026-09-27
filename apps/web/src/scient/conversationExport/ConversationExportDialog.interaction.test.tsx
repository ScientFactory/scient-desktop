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
vi.mock("./client", () => ({ prepareConversationExport, exportConversation }));

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

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  prepareConversationExport.mockReset();
  exportConversation.mockReset();
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
});
