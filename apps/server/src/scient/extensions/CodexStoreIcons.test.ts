import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { makeCodexStoreIcons } from "./CodexStoreIcons.ts";

describe("Codex store icon cache", () => {
  it.effect(
    "allows only signed file hosts and inlines bounded images, with expiring positive and negative cache entries",
    () =>
      Effect.gen(function* () {
        const urls: string[] = [];
        const icon = makeCodexStoreIcons(async (url) => {
          urls.push(String(url));
          return new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), {
            headers: { "content-type": "image/png" },
          });
        });
        const url = "https://files.openai.com/icon?signature=synthetic";
        expect(yield* icon(url)).toMatch(/^data:image\/png;base64,/);
        yield* icon(url);
        yield* icon("https://elsewhere.com/icon");
        yield* icon("http://127.0.0.1/icon");
        expect(urls).toHaveLength(1);
        yield* TestClock.adjust("1 hour");
        yield* icon(url);
        expect(urls).toHaveLength(2);
        let rejectedCalls = 0;
        const rejected = makeCodexStoreIcons(async () => {
          rejectedCalls++;
          return new Response("not an image", { headers: { "content-type": "image/png" } });
        });
        expect(yield* rejected(url)).toBeUndefined();
        expect(yield* rejected(url)).toBeUndefined();
        expect(rejectedCalls).toBe(1);
        const oversized = makeCodexStoreIcons(
          async () =>
            new Response(new Uint8Array(65 * 1024), { headers: { "content-type": "image/png" } }),
        );
        expect(yield* oversized(url)).toBeUndefined();
      }),
  );
});
