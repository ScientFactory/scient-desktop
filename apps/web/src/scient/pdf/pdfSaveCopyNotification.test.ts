import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  revealAvailable: true,
  revealSavedAsset: vi.fn(),
  toastAdd: vi.fn(),
}));

vi.mock("~/components/ui/toast", () => ({ toastManager: { add: mocks.toastAdd } }));
vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({
    documents: mocks.revealAvailable ? { revealSavedAsset: mocks.revealSavedAsset } : {},
  }),
}));

import { announcePdfSaveCopyResult } from "./pdfSaveCopyNotification";

describe("announcePdfSaveCopyResult", () => {
  beforeEach(() => {
    mocks.revealAvailable = true;
    mocks.revealSavedAsset.mockReset();
    mocks.toastAdd.mockReset();
    vi.stubGlobal("navigator", { platform: "MacIntel" });
  });

  it("offers a compact native reveal action after a confirmed save", async () => {
    mocks.revealSavedAsset.mockResolvedValue(undefined);

    announcePdfSaveCopyResult({ _tag: "saved", path: "/tmp/report.pdf" });

    expect(mocks.toastAdd).toHaveBeenCalledOnce();
    const notification = mocks.toastAdd.mock.calls[0]?.[0];
    expect(notification).toMatchObject({
      type: "success",
      title: "PDF saved",
      data: { compact: true },
      actionProps: { children: "Show in Finder" },
    });
    expect(notification).not.toHaveProperty("description");

    notification?.actionProps.onClick();
    await vi.waitFor(() => expect(mocks.revealSavedAsset).toHaveBeenCalledWith("/tmp/report.pdf"));
  });

  it("reports a native reveal failure without changing the successful save result", async () => {
    mocks.revealSavedAsset.mockRejectedValue(new Error("The file was moved."));

    announcePdfSaveCopyResult({ _tag: "saved", path: "/tmp/report.pdf" });
    mocks.toastAdd.mock.calls[0]?.[0].actionProps.onClick();

    await vi.waitFor(() =>
      expect(mocks.toastAdd).toHaveBeenLastCalledWith({
        type: "error",
        title: "Unable to show PDF in Finder",
        description: "The file was moved.",
      }),
    );
  });

  it("keeps export warnings visible in the saved-file notification", () => {
    announcePdfSaveCopyResult(
      { _tag: "saved", path: "/tmp/report.pdf" },
      { warnings: ["Canvas content was flattened"] },
    );

    expect(mocks.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "warning",
        title: "PDF saved with warnings",
        description: "Canvas content was flattened",
        actionProps: expect.objectContaining({ children: "Show in Finder" }),
      }),
    );
  });

  it("keeps cancellation silent", () => {
    announcePdfSaveCopyResult({ _tag: "cancelled" });

    expect(mocks.toastAdd).not.toHaveBeenCalled();
  });

  it("omits the reveal action when the app host does not advertise it", () => {
    mocks.revealAvailable = false;

    announcePdfSaveCopyResult({ _tag: "saved", path: "/tmp/report.pdf" });

    expect(mocks.toastAdd).toHaveBeenCalledWith({
      type: "success",
      title: "PDF saved",
      data: { compact: true },
    });
  });
});
