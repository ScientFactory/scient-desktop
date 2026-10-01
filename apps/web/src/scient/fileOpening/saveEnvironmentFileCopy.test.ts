import { EnvironmentId, type AssetResource } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const saveAssetCopy = vi.fn();
vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({ documents: { saveAssetCopy } }),
}));

import { fileCopyNotice, saveEnvironmentFileCopy } from "./saveEnvironmentFileCopy";

const environmentId = EnvironmentId.make("environment-save-copy-test");

describe("saveEnvironmentFileCopy", () => {
  afterEach(() => {
    saveAssetCopy.mockReset();
  });

  it("asks the environment for the one exact file and saves it under its own name", async () => {
    const requested: AssetResource[] = [];
    saveAssetCopy.mockResolvedValue({ _tag: "download-started" });

    const result = await saveEnvironmentFileCopy({
      environmentId,
      path: "/Users/me/out/results.xlsx",
      httpBaseUrl: "https://host.example:3773",
      createAssetUrl: async ({ input }) => {
        requested.push(input.resource);
        return AsyncResult.success({
          relativeUrl: "/api/assets/token/results.xlsx",
          expiresAt: 1,
          sourcePath: "/private/Users/me/out/results.xlsx",
        });
      },
    });

    expect(result).toEqual({ _tag: "download-started" });
    // Exact access only: a copy of one file never grants its folder.
    expect(requested).toEqual([
      { _tag: "environment-file", path: "/Users/me/out/results.xlsx", access: "exact" },
    ]);
    expect(saveAssetCopy).toHaveBeenCalledExactlyOnceWith({
      url: "https://host.example:3773/api/assets/token/results.xlsx",
      suggestedFileName: "results.xlsx",
    });
  });

  it("reports a file the environment cannot serve without touching the device", async () => {
    const result = await saveEnvironmentFileCopy({
      environmentId,
      path: "C:\\data\\gone.bin",
      httpBaseUrl: "https://host.example:3773",
      createAssetUrl: async () => AsyncResult.failure(Cause.fail(new Error("not found"))),
    });

    expect(result).toEqual({ _tag: "failed", reason: "source-unavailable" });
    expect(saveAssetCopy).not.toHaveBeenCalled();
    expect(fileCopyNotice(result)).toMatchObject({
      type: "error",
      title: "This file is no longer available",
    });
  });

  it("claims only what is known about the outcome", () => {
    expect(fileCopyNotice({ _tag: "saved", path: "/tmp/a" })?.title).toBe("Copy saved");
    expect(fileCopyNotice({ _tag: "download-started" })?.title).toBe("Download started");
    expect(fileCopyNotice({ _tag: "cancelled" })).toBeNull();
  });
});
