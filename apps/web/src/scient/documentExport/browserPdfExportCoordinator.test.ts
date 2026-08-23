import { describe, expect, it, vi } from "vite-plus/test";

import { runBrowserPdfExport } from "./browserPdfExportCoordinator";

describe("browser PDF export coordination", () => {
  it("coalesces concurrent exports for one logical document", async () => {
    let resolve!: (value: string) => void;
    const task = vi.fn(
      () =>
        new Promise<string>((complete) => {
          resolve = complete;
        }),
    );

    const first = runBrowserPdfExport("document-1", task);
    const second = runBrowserPdfExport("document-1", task);
    expect(task).toHaveBeenCalledOnce();
    resolve("complete");

    await expect(first).resolves.toBe("complete");
    await expect(second).resolves.toBe("complete");
  });

  it("allows a clean retry after success or failure", async () => {
    await expect(runBrowserPdfExport("document-2", async () => "first")).resolves.toBe("first");
    await expect(
      runBrowserPdfExport("document-2", async () => Promise.reject(new Error("failed"))),
    ).rejects.toThrow("failed");
    await expect(runBrowserPdfExport("document-2", async () => "retry")).resolves.toBe("retry");
  });
});
