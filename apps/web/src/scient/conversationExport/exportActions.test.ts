import { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const saveAssetCopy = vi.fn();
const writeTextToClipboard = vi.fn();

vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({ documents: { saveAssetCopy } }),
}));
vi.mock("../../hooks/useCopyToClipboard", () => ({ writeTextToClipboard }));
vi.mock("./client", () => ({
  exportFileUrl: (_environmentId: string, relativeUrl: string) =>
    `http://127.0.0.1:3773${relativeUrl}`,
}));

const { copyConversationExport, saveConversationExport, saveFailureMessage } =
  await import("./exportActions");

beforeEach(() => {
  saveAssetCopy.mockReset();
  writeTextToClipboard.mockReset();
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

  it("copies Markdown text", async () => {
    await copyConversationExport("# Study");
    expect(writeTextToClipboard).toHaveBeenCalledWith("# Study", "conversation Markdown");
  });

  it("explains save failures", () => {
    expect(saveFailureMessage({ _tag: "failed", reason: "source-unavailable" })).toBe(
      "The export is no longer available. Export again.",
    );
  });
});
