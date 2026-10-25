import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { findEnvironmentUpdate } from "./environment-maintenance";

afterEach(() => vi.unstubAllGlobals());

describe("Scient environment release channels", () => {
  const signal = new AbortController().signal;

  it("checks Beta only in the isolated owned feed and keeps the API fallback there", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        if (url === "https://github.com/ScientFactory/scient-desktop-beta/releases.atom")
          return new Response(
            "<feed><entry><id>tag:github.com,2008:Repository/1/v1.0.0</id></entry></feed>",
          );
        if (
          url ===
          "https://api.github.com/repos/ScientFactory/scient-desktop-beta/releases?per_page=100&page=1"
        )
          return Response.json([
            { tag_name: "v1.1.0-beta.20261020.2", draft: true, prerelease: true },
            { tag_name: "v1.1.0-beta.20261020.1", prerelease: true },
          ]);
        throw new Error(`Unexpected release request: ${url}`);
      }),
    );
    expect(await findEnvironmentUpdate("1.1.0-beta.20261019.1", signal)).toBe(
      "1.1.0-beta.20261020.1",
    );
    expect(urls).toHaveLength(2);
  });

  // Upstream deleted this row in its snap; it is the only guard of the Stable JSON Accept header.
  // regression: c6fd4ad1e4 fix(mobile): check for server updates without GitHub's API rate limit (#17900)
  it("checks stable updates as JSON without using the anonymous API quota", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) =>
        url === "https://github.com/ScientFactory/scient-desktop/releases/latest" &&
        new Headers(init?.headers).get("Accept") === "application/json"
          ? Response.json({ tag_name: "v1.1.0" })
          : new Response(null, { status: 403 }),
      ),
    );
    expect(await findEnvironmentUpdate("1.0.0", signal)).toBe("1.1.0");
    expect(await findEnvironmentUpdate("1.1.0", signal)).toBeNull();
    expect(await findEnvironmentUpdate("1.3.0", signal)).toBeNull();
  });

  it("rejects a prerelease returned as the latest Stable release", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === "https://github.com/ScientFactory/scient-desktop/releases/latest"
          ? Response.json({ tag_name: "v1.1.0-beta.20261020.1", prerelease: true })
          : Response.json([{ tag_name: "v1.0.1" }]),
      ),
    );
    expect(await findEnvironmentUpdate("1.0.0", signal)).toBe("1.0.1");
  });
});
