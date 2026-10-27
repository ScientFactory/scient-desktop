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
  it.effect("accepts SVG and XML-prefixed SVG only with the SVG media type and signature", () =>
    Effect.gen(function* () {
      const cases = [
        {
          body: '  <svg xmlns="http://www.w3.org/2000/svg"/>',
          mime: "image/svg+xml",
          accepted: true,
        },
        {
          body: '\n<?xml version="1.0"?><svg/>',
          mime: "image/svg+xml; charset=utf-8",
          accepted: true,
        },
        { body: "<svg/>", mime: "text/html", accepted: false },
        { body: "<html><svg/></html>", mime: "image/svg+xml", accepted: false },
        { body: "<svg-fake/>", mime: "image/svg+xml", accepted: false },
      ];
      for (const { body, mime, accepted } of cases) {
        const icon = makeCodexStoreIcons(
          async () => new Response(body, { headers: { "content-type": mime } }),
        );
        const result = yield* icon("https://files.openai.com/svg");
        expect(result).toBe(
          accepted
            ? `data:image/svg+xml;base64,${Buffer.from(body).toString("base64")}`
            : undefined,
        );
      }
    }),
  );
});

it.effect("resolves Codex app asset paths only on ChatGPT's observed image route", () =>
  Effect.gen(function* () {
    const urls: string[] = [];
    const icon = makeCodexStoreIcons(async (url) => {
      urls.push(String(url));
      return new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', {
        headers: { "content-type": "image/svg+xml" },
      });
    });
    const path = "/images/ecosystem/apps/github/icon.png";
    expect(yield* icon(path)).toMatch(/^data:image\/svg\+xml;base64,/);
    yield* icon(`https://chatgpt.com${path}`);
    expect(yield* icon("https://chatgpt.com/backend-api/content")).toBeUndefined();
    expect(yield* icon("//other.example/images/ecosystem/apps/github/icon.png")).toBeUndefined();
    expect(urls).toEqual([`https://chatgpt.com${path}`]);
  }),
);
