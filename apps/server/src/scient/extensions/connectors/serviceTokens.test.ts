import { describe, expect, it } from "@effect/vitest";

import { extractServiceToken, tokenUrl } from "./serviceTokens.ts";

// A Moodle-shaped launch answer: base64 of "<site hash>:::<token>:::<private token>".
const payload = Buffer.from(
  "synthetic-site-hash:::synthetic-ws-token-0001:::synthetic-private",
).toString("base64");
const launch = {
  url: "https://lms.example.test/2026/admin/tool/mobile/launch.php?service=app&passport={nonce}",
  pattern: /app:\/\/token=([A-Za-z0-9+/=]+)/u,
  decode: "base64" as const,
  separator: ":::",
  part: 1,
};

describe("extractServiceToken", () => {
  it("takes the token from the redirect's address or the page, by the connector's recipe", () => {
    expect(extractServiceToken(launch, { location: `app://token=${payload}` })).toBe(
      "synthetic-ws-token-0001",
    );
    expect(
      extractServiceToken(launch, { body: `<a href="app://token=${payload}">Open the app</a>` }),
    ).toBe("synthetic-ws-token-0001");
  });

  it("gives up on a pattern that backtracks without end, instead of holding the server", () => {
    // Unbounded, this match backtracks for hours; the test finishing is the check.
    expect(
      extractServiceToken(
        { ...launch, pattern: /(a+)+token=(\w+)$/u, decode: undefined, separator: undefined },
        { body: `${"a".repeat(40)}!` },
      ),
    ).toBeUndefined();
  });

  it("finds none in a page that holds none, or holds something that isn't one token", () => {
    expect(
      extractServiceToken(launch, { body: "<form><input type=password></form>" }),
    ).toBeUndefined();
    const broken = Buffer.from("only-one-part").toString("base64");
    expect(extractServiceToken(launch, { location: `app://token=${broken}` })).toBeUndefined();
  });
});

it("fills the nonce wherever the address put it", () => {
  expect(tokenUrl(launch, "abc123")).toBe(
    "https://lms.example.test/2026/admin/tool/mobile/launch.php?service=app&passport=abc123",
  );
  expect(tokenUrl({ ...launch, url: "https://lms.example.test/t/%7Bnonce%7D" }, "abc123")).toBe(
    "https://lms.example.test/t/abc123",
  );
});
