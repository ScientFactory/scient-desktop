import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { AssetCopyRequest, AssetCopyResult } from "./contracts.ts";

const decodeAssetCopyRequest = Schema.decodeUnknownSync(AssetCopyRequest);
const decodeAssetCopyResult = Schema.decodeUnknownSync(AssetCopyResult);

describe("asset copy contracts", () => {
  it("accepts bounded transport data and every expected outcome", () => {
    expect(
      decodeAssetCopyRequest({
        url: "https://assets.scient.test/report.pdf?token=fixture",
        suggestedFileName: "דו״ח מדעי.pdf",
      }),
    ).toEqual({
      url: "https://assets.scient.test/report.pdf?token=fixture",
      suggestedFileName: "דו״ח מדעי.pdf",
    });

    for (const result of [
      { _tag: "saved", path: "/tmp/report.pdf" },
      { _tag: "download-started" },
      { _tag: "cancelled" },
      { _tag: "failed", reason: "source-changed" },
    ] as const) {
      expect(decodeAssetCopyResult(result)).toEqual(result);
    }
  });

  it.each(["../report.pdf", "folder/report.pdf", "folder\\report.pdf", "bad\0name.pdf"])(
    "rejects an unsafe suggested filename: %s",
    (suggestedFileName) => {
      expect(() =>
        decodeAssetCopyRequest({
          url: "https://assets.scient.test/report.pdf",
          suggestedFileName,
        }),
      ).toThrow();
    },
  );
});
