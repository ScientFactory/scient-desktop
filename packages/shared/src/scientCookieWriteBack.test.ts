import type { SessionCookie } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { cookieHeaderFor, decideWriteBack, isWriteBackSlot } from "./scientCookieWriteBack.ts";
import { KEPT_SESSION_SECONDS } from "./scientSessionCookies.ts";

const NOW = 1_800_000_000;
const SITE = new URL("https://hours.example.test");

const slot = (overrides: Partial<SessionCookie> = {}): SessionCookie => ({
  name: "sid",
  value: "synthetic-old",
  domain: "hours.example.test",
  hostOnly: true,
  path: "/",
  secure: true,
  httpOnly: true,
  sameSite: "lax",
  expires: NOW + 3600,
  ...overrides,
});

const decide = (headers: ReadonlyArray<string>, signedOut = false, base: SessionCookie = slot()) =>
  decideWriteBack({
    slot: base,
    url: new URL("https://hours.example.test/api/hours"),
    headers,
    receivedAtSeconds: NOW,
    signedOut,
  });

describe("decideWriteBack", () => {
  it("takes a rotated value with Max-Age counted from receipt, ahead of Expires", () => {
    expect(
      decide([
        "sid=synthetic-new; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600; Expires=Wed, 01 Jan 2099 00:00:00 GMT",
      ]),
    ).toEqual({
      type: "rotate",
      cookie: { ...slot(), value: "synthetic-new", expires: NOW + 600 },
    });
  });

  it("gives a session-only reply the kept expiry", () => {
    const decision = decide(["sid=synthetic-new; Path=/; Secure; HttpOnly"]);
    expect(decision).toMatchObject({
      type: "rotate",
      cookie: { expires: NOW + KEPT_SESSION_SECONDS, sameSite: "unspecified" },
    });
  });

  it("deletes the slot on Max-Age=0 or a past date, even from a signed-out reply", () => {
    expect(decide(["sid=; Max-Age=0; Path=/"], true)).toEqual({ type: "delete" });
    expect(decide(["sid=x; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT"])).toEqual({
      type: "delete",
    });
  });

  it("refuses a looser slot, a second header, or a rotation while signed out", () => {
    for (const header of ["sid=n; Path=/; HttpOnly", "sid=n; Path=/; Secure"])
      expect(decide([header])).toEqual({ type: "refused", reason: "widened" });
    // regression: a Strict session cookie came back as SameSite=None and was written.
    expect(
      decide(
        ["sid=n; Path=/; Secure; HttpOnly; SameSite=None"],
        false,
        slot({ sameSite: "strict" }),
      ),
    ).toEqual({ type: "refused", reason: "widened" });
    expect(
      decide(
        ["sid=n; Path=/; Secure; HttpOnly; SameSite=Strict"],
        false,
        slot({ sameSite: "lax" }),
      ),
    ).toMatchObject({ type: "rotate", cookie: { sameSite: "strict" } });
    expect(decide(["sid=a; Path=/; Secure; HttpOnly", "sid=b; Path=/; Secure; HttpOnly"])).toEqual({
      type: "refused",
      reason: "ambiguous",
    });
    expect(decide(["sid=n; Path=/; Secure; HttpOnly"], true)).toEqual({
      type: "refused",
      reason: "signed-out",
    });
    expect(decide(["sid=n; Path=/; Secure; HttpOnly; Max-Age=soon"])).toEqual({
      type: "refused",
      reason: "malformed",
    });
  });

  it("leaves a same-name cookie elsewhere alone, its deletion included", () => {
    // regression: expiring sid at another path deleted the session's own sid.
    for (const header of [
      "sid=; Path=/app; Max-Age=0",
      "sid=; Domain=example.test; Path=/; Max-Age=0",
      "sid=n; Path=/; Secure; HttpOnly; Partitioned",
    ])
      expect(decide([header])).toEqual({ type: "none" });
    // No Path: the request's directory, here /api, not the slot's /.
    expect(decide(["sid=; Max-Age=0"])).toEqual({ type: "none" });
    expect(decide(["sid=; Max-Age=0"], false, slot({ path: "/api" }))).toEqual({ type: "delete" });
  });

  it("ignores other cookies, so write-back never makes a slot", () => {
    expect(decide(["tracker=1; Path=/", "csrf=2; Path=/; Secure"])).toEqual({ type: "none" });
  });
});

describe("isWriteBackSlot", () => {
  it("is only the host-only, Secure, HttpOnly cookie at the named path", () => {
    expect(isWriteBackSlot(slot(), SITE, "sid", "/")).toBe(true);
    expect(
      isWriteBackSlot(slot({ domain: ".hours.example.test", hostOnly: false }), SITE, "sid", "/"),
    ).toBe(false);
    expect(isWriteBackSlot(slot({ httpOnly: false }), SITE, "sid", "/")).toBe(false);
  });
});

describe("cookieHeaderFor", () => {
  it("sends what a browser would: matching host and path, longest path first, live only", () => {
    const cookies = [
      slot(),
      slot({ name: "deep", path: "/api", value: "d" }),
      slot({ name: "other", domain: "other.example.test", value: "o" }),
      slot({ name: "old", expires: NOW - 1, value: "x" }),
      slot({ name: "parent", domain: ".example.test", hostOnly: false, value: "p" }),
    ];
    expect(cookieHeaderFor(cookies, new URL("https://hours.example.test/api/hours"), NOW)).toBe(
      "deep=d; sid=synthetic-old; parent=p",
    );
  });
});
