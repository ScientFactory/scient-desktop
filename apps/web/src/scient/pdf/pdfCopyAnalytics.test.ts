import type { AssetCopyResult } from "@scientfactory/document-artifacts";
import { EnvironmentId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { begin, finish } = vi.hoisted(() => ({ begin: vi.fn(), finish: vi.fn() }));
vi.mock("../analytics/client", () => ({ beginScientUiOperation: begin }));
import { observePdfCopy } from "./pdfCopyAnalytics";

describe("PDF copy outcomes", () => {
  beforeEach(() => {
    begin.mockReset().mockReturnValue(finish);
    finish.mockReset();
  });
  const cases: ReadonlyArray<
    readonly [AssetCopyResult, "completed" | "failed" | "cancelled" | null]
  > = [
    [{ _tag: "saved", path: "/private/report.pdf" }, "completed"],
    [{ _tag: "cancelled" }, "cancelled"],
    [{ _tag: "failed", reason: "write-failed" }, "failed"],
    [{ _tag: "download-started" }, null],
  ];
  for (const [result, outcome] of cases) {
    it(`preserves ${result._tag} and sends only its bounded outcome`, async () => {
      const task = vi.fn(async () => result);
      await expect(observePdfCopy(EnvironmentId.make("environment-1"), task)).resolves.toBe(result);
      expect(task).toHaveBeenCalledOnce();
      expect(begin).toHaveBeenCalledExactlyOnceWith("environment-1", "document-export");
      expect(finish).toHaveBeenCalledExactlyOnceWith(outcome);
    });
  }
  it("preserves the exact rejected error without passing it into analytics", async () => {
    const error = new Error("private URL and error");
    await expect(
      observePdfCopy(EnvironmentId.make("environment-1"), () => Promise.reject(error)),
    ).rejects.toBe(error);
    expect(finish).toHaveBeenCalledExactlyOnceWith("failed");
  });
});
