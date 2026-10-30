import * as NodeEvents from "node:events";
import type { Cookie, Session } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { keepSessionCookies, keptCookie } from "./keepSessionCookies.ts";

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
});
