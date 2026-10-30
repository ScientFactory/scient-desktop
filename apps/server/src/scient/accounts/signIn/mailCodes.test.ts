import { expect, it } from "vite-plus/test";
import { codeInMailFeed } from "./mailCodes.ts";

const entry = (title: string, summary: string, issued: string) =>
  `<entry><title>${title}</title><summary>${summary}</summary><issued>${issued}</issued></entry>`;

it("takes the code from mail that arrived after the sign-in began", () => {
  const since = Date.parse("2026-10-30T10:00:00Z");
  const feed = `<feed>${[
    entry("Your code", "Use 222222 to sign in", "2026-10-30T10:01:00Z"),
    entry("Your code", "Use 111111 to sign in", "2026-10-30T09:00:00Z"),
  ].join("")}</feed>`;
  expect(codeInMailFeed(feed, since)).toBe("222222");
  expect(codeInMailFeed(feed, since + 3_600_000)).toBeUndefined();
});

it("ignores mail without a code", () => {
  const feed = `<feed>${entry("Invoice 482913", "Thanks", "2026-10-30T10:01:00Z")}</feed>`;
  expect(codeInMailFeed(feed, 0)).toBeUndefined();
});

it("reads escaped text", () => {
  const feed = `<feed>${entry("Sign-in &amp; security", "Your code: 482913", "2026-10-30T10:01:00Z")}</feed>`;
  expect(codeInMailFeed(feed, 0)).toBe("482913");
});
