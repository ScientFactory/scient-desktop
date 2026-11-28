import { expect, it, vi } from "vite-plus/test";
import { parseGoogleSessions, readGoogleSessions } from "./googleSessions.ts";

const row = (email: string, valid: number) => {
  const fields: Array<unknown> = ["gaia.l.a", 1, "Name", email, "picture", 1, 1, 0, 0, valid];
  return fields;
};

it("reads each listed address and whether Google still accepts it", () => {
  expect(
    parseGoogleSessions(
      JSON.stringify(["gaia.l.a.r", [row("a@example.com", 1), row("b@example.com", 0)]]),
    ),
  ).toEqual([
    { email: "a@example.com", valid: true },
    { email: "b@example.com", valid: false },
  ]);
  expect(parseGoogleSessions(JSON.stringify(["gaia.l.a.r", []]))).toEqual([]);
  expect(parseGoogleSessions("<html>")).toBeNull();
  // regression: an entry with no validity field read as signed out, and a broken one vanished.
  expect(
    parseGoogleSessions(
      JSON.stringify(["gaia.l.a.r", [["gaia.l.a", 1, "Name", "a@example.com", "picture"]]]),
    ),
  ).toBeNull();
  expect(
    parseGoogleSessions(JSON.stringify(["gaia.l.a.r", [row("a@example.com", 1), ["broken"]]])),
  ).toBeNull();
  expect(parseGoogleSessions(JSON.stringify({}))).toBeNull();
});

it("doesn't contact Google for a profile that has never been there", async () => {
  const requests: string[] = [];
  const session = (cookies: ReadonlyArray<object>) => ({
    cookies: { get: async () => cookies },
    fetch: async (url: string) => {
      requests.push(url);
      return new Response(JSON.stringify(["gaia.l.a.r", [row("a@example.com", 1)]]));
    },
  });
  const read = (cookies: ReadonlyArray<object>) =>
    readGoogleSessions(session(cookies) as unknown as Parameters<typeof readGoogleSessions>[0]);
  expect(await read([])).toEqual([]);
  expect(requests).toEqual([]);
  expect(await read([{ name: "synthetic" }])).toEqual([{ email: "a@example.com", valid: true }]);
  expect(requests).toHaveLength(1);
});

it("asks for leave only right before contacting Google, and asks nothing when refused", async () => {
  const requests: string[] = [];
  const session = (cookies: ReadonlyArray<object>) =>
    ({
      cookies: { get: async () => cookies },
      fetch: async (url: string) => {
        requests.push(url);
        return new Response(JSON.stringify(["gaia.l.a.r", []]));
      },
    }) as unknown as Parameters<typeof readGoogleSessions>[0];
  let asked = 0;
  const refuse = () => {
    asked += 1;
    return false;
  };
  // A profile that has never seen Google: nothing to ask, so leave isn't needed.
  expect(await readGoogleSessions(session([]), refuse)).toEqual([]);
  expect(asked).toBe(0);
  expect(await readGoogleSessions(session([{ name: "synthetic" }]), refuse)).toBeNull();
  expect(asked).toBe(1);
  expect(requests).toEqual([]);
});

it("calls no answer, a hung probe or an empty list beside Google's sign-in cookies unknown", async () => {
  const jar = (names: ReadonlyArray<string>) =>
    names.map((name) => ({ name, domain: ".google.com" }));
  const session = (names: ReadonlyArray<string>, answer: () => Promise<Response>) =>
    ({
      cookies: { get: async () => jar(names) },
      fetch: answer,
    }) as unknown as Parameters<typeof readGoogleSessions>[0];
  const empty = async () => new Response(JSON.stringify(["gaia.l.a.r", []]));
  // regression: an empty list wrote every row signed out while Google still accepted the profile.
  expect(await readGoogleSessions(session(["SID", "NID"], empty))).toBeNull();
  // With no sign-in cookie left, the empty list is corroborated.
  expect(await readGoogleSessions(session(["NID"], empty))).toEqual([]);
  expect(
    await readGoogleSessions(
      session(["SID"], async () => {
        throw new TypeError("net::ERR_INTERNET_DISCONNECTED");
      }),
    ),
  ).toBeNull();
  vi.useFakeTimers();
  try {
    const hung = readGoogleSessions(session(["SID"], () => new Promise<Response>(() => {})));
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await hung).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});
