import { describe, expect, it } from "@effect/vitest";

import type { ConnectorFetch } from "../connectors/ConnectorOutbound.ts";
import { fetchIconDataUri, iconDataUri, MAX_ICON_BYTES } from "./DiscoverIcons.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const WEBP = new Uint8Array([
  ...Buffer.from("RIFF"),
  0x24,
  0,
  0,
  0,
  ...Buffer.from("WEBP"),
  ...Buffer.from("VP8 "),
]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');

const respondWith =
  (response: () => Response): ConnectorFetch =>
  async () =>
    response();

describe("Discover icons", () => {
  it("inlines allowed image types whose bytes match", () => {
    expect(iconDataUri("image/png", PNG)).toBe(
      `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`,
    );
    expect(iconDataUri("image/jpeg", JPEG)).toMatch(/^data:image\/jpeg;base64,/u);
    expect(iconDataUri("image/webp", WEBP)).toMatch(/^data:image\/webp;base64,/u);
    expect(iconDataUri("Image/SVG+XML; charset=utf-8", SVG)).toMatch(
      /^data:image\/svg\+xml;base64,/u,
    );
  });

  it("rejects other types, mismatched bytes, empty and oversized icons", () => {
    expect(iconDataUri("image/x-icon", PNG)).toBeUndefined();
    expect(iconDataUri("image/gif", PNG)).toBeUndefined();
    expect(iconDataUri("text/html", SVG)).toBeUndefined();
    expect(iconDataUri(null, PNG)).toBeUndefined();
    // Declared as PNG but HTML bytes (a soft 404 page).
    expect(iconDataUri("image/png", new TextEncoder().encode("<!doctype html>"))).toBeUndefined();
    expect(iconDataUri("image/svg+xml", new TextEncoder().encode("<html></html>"))).toBeUndefined();
    expect(iconDataUri("image/png", new Uint8Array())).toBeUndefined();
    const oversized = new Uint8Array(MAX_ICON_BYTES + 1);
    oversized.set(PNG);
    expect(iconDataUri("image/png", oversized)).toBeUndefined();
    const atLimit = new Uint8Array(MAX_ICON_BYTES);
    atLimit.set(PNG);
    expect(iconDataUri("image/png", atLimit)).toMatch(/^data:image\/png;base64,/u);
  });

  it("falls back to no icon on any fetch failure", async () => {
    const url = "https://icons.example/icon.png";
    expect(
      await fetchIconDataUri(
        respondWith(() => new Response(PNG, { headers: { "content-type": "image/png" } })),
        url,
      ),
    ).toMatch(/^data:image\/png;base64,/u);
    for (const fetch of [
      respondWith(
        () => new Response(PNG, { status: 404, headers: { "content-type": "image/png" } }),
      ),
      respondWith(() => new Response(PNG, { headers: { "content-type": "image/x-icon" } })),
      respondWith(() => new Response("<html>", { headers: { "content-type": "image/png" } })),
      async () => {
        throw new TypeError("fetch failed");
      },
      // The egress policy errors the body stream once it exceeds the cap.
      respondWith(
        () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(PNG);
                controller.error(new Error("The connector response exceeded the size limit."));
              },
            }),
            { headers: { "content-type": "image/png" } },
          ),
      ),
    ] satisfies ReadonlyArray<ConnectorFetch>) {
      expect(await fetchIconDataUri(fetch, url)).toBeUndefined();
    }
  });

  it("asks only for allowed image types", async () => {
    let accept: string | null = null;
    await fetchIconDataUri(async (_url, init) => {
      accept = new Headers(init?.headers).get("accept");
      return new Response(PNG, { headers: { "content-type": "image/png" } });
    }, "https://icons.example/icon.png");
    expect(accept).toBe("image/png, image/jpeg, image/webp, image/svg+xml");
  });
});
