import { expect, it } from "vite-plus/test";

import { latexPlacedImageUrl } from "./latexResultFileDigests";

it("gives new bytes at the same placed path a new image cache key", () => {
  const url = "https://example.test/assets/file?ticket=original";
  const before = latexPlacedImageUrl(url, "first-sha");
  const after = latexPlacedImageUrl(url, "second-sha");
  expect(before).not.toBe(after);
  expect(new URL(after).searchParams.get("ticket")).toBe("original");
  expect(new URL(after).searchParams.get("result")).toBe("second-sha");
  expect(latexPlacedImageUrl(url, undefined)).toBe(url);
});
