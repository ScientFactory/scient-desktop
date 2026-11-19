import {
  encodeShareKey,
  encryptShareObject,
  generateShareKey,
} from "@scientfactory/scient-cloud/share-crypto";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../../test/render";
import { gzipBytes } from "../cloudConversationCodec";
import { fixtureConversation } from "../cloudConversation.test-fixtures";
import { SharePage } from "./SharePage";
import { readShareAddress } from "./shareReader";

const SHARE_ID = "AAAAAAAAAAAAAAAAAAAAAA";
const API = "https://cloud.test";

async function serveShare(key: Uint8Array) {
  const snapshot = await encryptShareObject(
    key,
    { version: 2, object: "snapshot" },
    await gzipBytes(new TextEncoder().encode(JSON.stringify(fixtureConversation))),
  );
  const requests: string[] = [];
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    requests.push(`${url} ${JSON.stringify(init?.headers ?? {})}`);
    if (url === `${API}/v1/public/shares/${SHARE_ID}`) {
      return Response.json({
        encrypted: true,
        currentVersion: 2,
        versions: [
          { version: 1, publishedAt: "2026-11-09T10:00:00.000Z" },
          { version: 2, publishedAt: "2026-11-10T10:00:00.000Z" },
        ],
        objects: [{ name: "snapshot", bytes: snapshot.byteLength }],
      });
    }
    if (url === `${API}/v1/public/shares/${SHARE_ID}/v/2/snapshot`) {
      return new Response(Uint8Array.from(snapshot));
    }
    return new Response(null, { status: 404 });
  });
  return { requests, [Symbol.dispose]: () => fetchSpy.mockRestore() };
}

describe("SharePage", () => {
  it("decrypts the shared conversation with the key from the link and never sends the key", async () => {
    const key = generateShareKey();
    const fragment = `#${encodeShareKey(key)}`;
    using served = await serveShare(key);

    await using screen = await render(
      <SharePage address={readShareAddress(`/s/${SHARE_ID}`, fragment)} apiOrigin={API} />,
    );

    await expect
      .element(screen.getByRole("heading", { name: "Fit the decay model" }))
      .toBeVisible();
    await expect.element(screen.getByText(/Fit the model in/)).toBeVisible();
    expect(served.requests.length).toBeGreaterThanOrEqual(2);
    for (const request of served.requests) expect(request).not.toContain(fragment.slice(1));
  });

  it("explains a link whose key doesn't match", async () => {
    using _served = await serveShare(generateShareKey());

    await using screen = await render(
      <SharePage
        address={readShareAddress(`/s/${SHARE_ID}`, `#${encodeShareKey(generateShareKey())}`)}
        apiOrigin={API}
      />,
    );

    await expect.element(screen.getByText(/doesn't unlock the conversation/)).toBeVisible();
  });
});
