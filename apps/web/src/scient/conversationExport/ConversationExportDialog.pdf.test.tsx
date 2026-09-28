// @vitest-environment jsdom

import {
  EnvironmentId,
  ThreadId,
  type ScientConversationExportPreparation,
} from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { exportConversationPdf, navigate, toastAdd } = vi.hoisted(() => ({
  exportConversationPdf: vi.fn(),
  navigate: vi.fn(async () => undefined),
  toastAdd: vi.fn(),
}));
const prepareConversationExport = vi.fn();
vi.mock("./client", () => ({
  prepareConversationExport,
  exportConversation: vi.fn(),
  prepareConversationWordDiagrams: vi.fn(),
}));
vi.mock("../documentExport/conversationPdfExport", () => ({
  conversationPdfAvailability: () => ({ available: true }),
  exportConversationPdf,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => navigate,
}));
vi.mock("../../components/ui/toast", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../components/ui/toast")>();
  return { ...actual, toastManager: { ...actual.toastManager, add: toastAdd } };
});

const { ConversationExportDialogHost, requestConversationExport } =
  await import("./ConversationExportDialog");

const threadRef = {
  environmentId: EnvironmentId.make("local"),
  threadId: ThreadId.make("thread-sidebar"),
};
const preparation: ScientConversationExportPreparation = {
  threadId: threadRef.threadId,
  title: "Study",
  formats: [
    { format: "markdown", available: true, unavailableReason: null },
    { format: "pdf", available: true, unavailableReason: null },
  ],
  messageCount: 0,
  attachmentCount: 0,
  workLogEntryCount: 0,
  reasoningCount: 0,
  runningTurnOmitted: false,
  messages: [],
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  prepareConversationExport.mockReset().mockResolvedValue(preparation);
  exportConversationPdf.mockReset();
  navigate.mockClear();
  toastAdd.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const button = (label: string) =>
  [...document.querySelectorAll("button")].find((element) => element.textContent === label)!;

async function exportAsPdf() {
  await act(async () => root.render(<ConversationExportDialogHost />));
  await act(async () => requestConversationExport(threadRef));
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => button("PDF").click());
  await act(async () => button("Export").click());
}

describe("ConversationExportDialog PDF delivery", () => {
  it("saves the PDF, then Open shows it in the exported conversation", async () => {
    const open = vi.fn();
    exportConversationPdf.mockResolvedValue({
      title: "Export saved",
      description: "/Users/someone/Study.pdf",
      warnings: [],
      open,
    });
    await exportAsPdf();

    expect(exportConversationPdf).toHaveBeenCalledWith(
      expect.objectContaining({ threadRef, request: expect.objectContaining({ format: "pdf" }) }),
    );
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(toastAdd).toHaveBeenCalledOnce();
    const toast = toastAdd.mock.calls[0]![0];
    expect(toast).toMatchObject({
      type: "success",
      title: "Export saved",
      description: "/Users/someone/Study.pdf",
      actionProps: { children: "Open" },
    });
    expect(open).not.toHaveBeenCalled();
    toast.actionProps.onClick();
    expect(open).toHaveBeenCalledOnce();
    // A sidebar export's conversation may not be on screen; Open goes there.
    expect(navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: threadRef.environmentId, threadId: threadRef.threadId },
    });
  });

  it("stays open without a notice when saving is cancelled", async () => {
    exportConversationPdf.mockResolvedValue(null);
    await exportAsPdf();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(toastAdd).not.toHaveBeenCalled();
    expect(button("Export").disabled).toBe(false);
  });

  it("shows why the PDF could not be exported and stays open", async () => {
    exportConversationPdf.mockRejectedValue(new Error("The file could not be written."));
    await exportAsPdf();
    expect(
      [...document.querySelectorAll('[role="alert"]')].map((alert) => alert.textContent),
    ).toContain("The file could not be written.");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(toastAdd).not.toHaveBeenCalled();
  });
});
