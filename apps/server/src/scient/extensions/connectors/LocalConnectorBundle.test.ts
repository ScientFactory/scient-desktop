import { describe, expect, it } from "@effect/vitest";

import { type BundleManifest, manifestSignIn } from "./LocalConnectorBundle.ts";

const withSignIn = (signIn: unknown) =>
  ({
    manifest_version: "0.3",
    name: "hours",
    version: "1.0.0",
    server: { type: "node", entry_point: "server.mjs" },
    _meta: { "com.scientfactory.scient": { signIn } },
  }) as unknown as BundleManifest;

describe("manifestSignIn", () => {
  it("resolves each write-back read to a path on the signed-in site", () => {
    expect(
      manifestSignIn(
        withSignIn({
          site: "https://hours.example.test",
          writeBack: { cookie: "sid", reads: { hours: "/api/hours?view=month" } },
        }),
      ),
    ).toEqual({
      site: "https://hours.example.test",
      writeBack: {
        cookie: "sid",
        path: "/",
        reads: { hours: "https://hours.example.test/api/hours?view=month" },
      },
    });
  });

  it("refuses a read that would leave the site", () => {
    for (const target of ["//evil.example/api", "https://evil.example/api", "api/hours"])
      expect(
        manifestSignIn(
          withSignIn({
            site: "https://hours.example.test",
            writeBack: { cookie: "sid", reads: { hours: target } },
          }),
        ),
      ).toHaveProperty("problem");
  });

  it("takes a token recipe on the site, and refuses one with a pattern that can't hold a token", () => {
    const signIn = (pattern: string, path = "/launch.php?passport={nonce}") =>
      manifestSignIn(
        withSignIn({ site: "https://lms.example.test", tokens: { app: { path, pattern } } }),
      );
    expect(signIn("token=([A-Za-z0-9]+)")).toMatchObject({
      tokens: { app: { url: "https://lms.example.test/launch.php?passport={nonce}" } },
    });
    expect(signIn("token=([")).toHaveProperty("problem");
    expect(signIn("token=(.+)", "https://evil.example/launch")).toHaveProperty("problem");
  });
});
