import * as NodeEvents from "node:events";
import type { Cookie, Session } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { keepSessionCookies, keptCookie } from "./keepSessionCookies.ts";
import { mainInsertTracker, makeInsertTracker } from "./mainInserts.ts";
import { rememberAccountsSession } from "./sessionIdentity.ts";

const sessionCookie: Cookie = {
  name: "shibsession",
  value: "value",
  domain: "idp.example.ac.il",
  hostOnly: true,
  path: "/idp",
  secure: true,
  httpOnly: true,
  sameSite: "no_restriction",
  session: true,
};

function fakeSession() {
  const cookies = Object.assign(new NodeEvents.EventEmitter(), {
    set: vi.fn(() => Promise.resolve()),
    flushStore: vi.fn(() => Promise.resolve()),
  });
  return cookies as typeof cookies & Session["cookies"];
}

describe("keepSessionCookies", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it("gives a session cookie an expiry and keeps everything else about it", () => {
    expect(keptCookie(sessionCookie, 1_000)).toEqual({
      url: "https://idp.example.ac.il/idp",
      name: "shibsession",
      value: "value",
      path: "/idp",
      secure: true,
      httpOnly: true,
      sameSite: "no_restriction",
      expirationDate: 1_000 + 90 * 24 * 60 * 60,
    });
  });

  it("keeps a domain cookie's domain", () => {
    expect(
      keptCookie({ ...sessionCookie, domain: ".example.org", hostOnly: false }, 0),
    ).toMatchObject({ url: "https://example.org/idp", domain: ".example.org" });
  });

  it("saves a new session cookie once, and leaves stored or removed cookies alone", () => {
    const cookies = fakeSession();
    keepSessionCookies({ cookies });
    cookies.emit("changed", {}, sessionCookie, "inserted", false);
    cookies.emit("changed", {}, { ...sessionCookie, session: false }, "inserted", false);
    cookies.emit("changed", {}, sessionCookie, "explicit", true);
    expect(cookies.set).toHaveBeenCalledTimes(1);
  });

  it("writes sign-in cookies to disk soon, not on every tracker change", () => {
    const cookies = fakeSession();
    keepSessionCookies({ cookies });
    cookies.emit("changed", {}, { ...sessionCookie, httpOnly: false }, "inserted", false);
    vi.advanceTimersByTime(5_000);
    expect(cookies.flushStore).not.toHaveBeenCalled();
    cookies.emit("changed", {}, sessionCookie, "inserted", false);
    cookies.emit("changed", {}, sessionCookie, "inserted", false);
    vi.advanceTimersByTime(5_000);
    expect(cookies.flushStore).toHaveBeenCalledTimes(1);
  });

  it("records what lands in Main, but not its own upkeep of a session cookie", () => {
    vi.setSystemTime(1_000_000);
    const session = { cookies: fakeSession() };
    rememberAccountsSession(session as unknown as Session, "environment");
    keepSessionCookies(session);
    const tracker = mainInsertTracker(session)!;
    vi.setSystemTime(1_010_000);
    session.cookies.emit("changed", {}, sessionCookie, "inserted", false);
    expect(tracker.touchedSince(["example.ac.il"], 1_005_000)).toBe(true);
    vi.setSystemTime(1_020_000);
    session.cookies.emit("changed", {}, { ...sessionCookie, session: false }, "inserted", false);
    expect(tracker.touchedSince(["example.ac.il"], 1_015_000)).toBe(false);
    expect(mainInsertTracker({ cookies: fakeSession() })).toBeUndefined();
  });
});

describe("the Main insert tracker", () => {
  it("vouches only for times since it started, and raises that floor as it forgets sites", () => {
    const tracker = makeInsertTracker(100, 2);
    tracker.record("a.test", 200);
    tracker.record("b.test", 300);
    expect(tracker.touchedSince(["a.test"], 150)).toBe(true);
    expect(tracker.touchedSince(["a.test"], 250)).toBe(false);
    expect(tracker.touchedSince(["c.test"], 50)).toBe(true);
    tracker.record("c.test", 400);
    expect(tracker.touchedSince(["a.test"], 150)).toBe(true);
    expect(tracker.touchedSince(["a.test"], 250)).toBe(false);
    expect(tracker.touchedSince(["b.test"], 250)).toBe(true);
  });
});
