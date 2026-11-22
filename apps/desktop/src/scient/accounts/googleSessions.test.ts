import { expect, it } from "vite-plus/test";
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
