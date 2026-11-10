import { describe, expect, it } from "vite-plus/test";

import { addRequestUsage, nativeTurnTokenUsage, type NativeRequestUsage } from "./turnUsage.ts";

const request = (model: string | undefined, inputTokens: number, outputTokens: number) =>
  ({ inputTokens, outputTokens, ...(model === undefined ? {} : { model }) }) as NativeRequestUsage;

describe("native turn usage", () => {
  it("lists the model with the most tokens first, so a helper model is not the main one", () => {
    let usage = addRequestUsage(undefined, request("helper-mini", 50, 10));
    for (const next of [
      request("main-large", 400, 200),
      request(undefined, 5, 5),
      request(" main-large ", 100, 50),
    ])
      usage = addRequestUsage(usage, next);
    expect(nativeTurnTokenUsage(usage, "completed", false).models).toEqual([
      "main-large",
      "helper-mini",
    ]);
  });
});
