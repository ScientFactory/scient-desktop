import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const saveAssetCopy = vi.fn();
const writeTextToClipboard = vi.fn();
const exportConversation = vi.fn();
const addToast = vi.fn();

vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({ documents: { saveAssetCopy } }),
}));
vi.mock("../../hooks/useCopyToClipboard", () => ({ writeTextToClipboard }));
vi.mock("../../components/ui/toast", () => ({ toastManager: { add: addToast } }));
vi.mock("./client", () => ({
  exportConversation,
  exportFileUrl: (_environmentId: string, relativeUrl: string) =>
    `http://127.0.0.1:3773${relativeUrl}`,
}));

const { copyConversationMarkdown, saveConversationExport, saveFailureMessage } =
  await import("./exportActions");

const threadRef = { environmentId: EnvironmentId.make("local"), threadId: ThreadId.make("t1") };

beforeEach(() => {
  saveAssetCopy.mockReset();
  writeTextToClipboard.mockReset();
  exportConversation.mockReset();
  addToast.mockReset();
});

describe("conversation export delivery", () => {
  it("saves through the shared Save Copy path with the export's file name", async () => {
    saveAssetCopy.mockResolvedValue({ _tag: "saved", path: "/Users/me/Study.md" });
    const result = await saveConversationExport(EnvironmentId.make("local"), {
      fileName: "Study.md",
      mediaType: "text/markdown; charset=utf-8",
      byteLength: 10,
      relativeUrl: "/api/assets/token/Study.md",
      expiresAt: 1,
    });
    expect(result).toEqual({ _tag: "saved", path: "/Users/me/Study.md" });
    expect(saveAssetCopy).toHaveBeenCalledWith({
      url: "http://127.0.0.1:3773/api/assets/token/Study.md",
      suggestedFileName: "Study.md",
    });
  });

  it("copies the conversation as default Markdown and confirms it", async () => {
    exportConversation.mockResolvedValue({ file: null, text: "# Study", warnings: [] });
    writeTextToClipboard.mockResolvedValue(true);
    await copyConversationMarkdown(threadRef);
    expect(exportConversation).toHaveBeenCalledWith(
      threadRef.environmentId,
      expect.objectContaining({
        threadId: "t1",
        format: "markdown",
        delivery: "clipboard",
        options: {
          includeWorkLog: false,
          includeReasoning: false,
          range: { _tag: "whole" },
          markdownPackaging: "text",
        },
      }),
    );
    expect(writeTextToClipboard).toHaveBeenCalledWith("# Study", "conversation Markdown");
    expect(addToast).toHaveBeenCalledWith({ type: "success", title: "Markdown copied" });
  });

  it("reports a copy that fails", async () => {
    exportConversation.mockRejectedValue(new Error("The conversation is too long to copy."));
    await copyConversationMarkdown(threadRef);
    expect(writeTextToClipboard).not.toHaveBeenCalled();
    expect(addToast).toHaveBeenCalledWith({
      type: "error",
      title: "Could not copy the conversation",
      description: "The conversation is too long to copy.",
    });

    exportConversation.mockResolvedValue({ file: null, text: "", warnings: [] });
    writeTextToClipboard.mockResolvedValue(false);
    await copyConversationMarkdown(threadRef);
    expect(addToast).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "error", title: "Could not copy the conversation" }),
    );
  });

  it("explains save failures", () => {
    expect(saveFailureMessage({ _tag: "failed", reason: "source-unavailable" })).toBe(
      "The export is no longer available. Export again.",
    );
  });
});
