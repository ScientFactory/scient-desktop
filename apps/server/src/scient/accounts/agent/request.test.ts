import { expect, it } from "vite-plus/test";
import type { ApiKeyAuth } from "@t3tools/contracts";
import { accountRequest, checkAccountRequest, publicAccountAddresses } from "./request.ts";

it("limits methods, origins and literal network addresses before account use", () => {
  expect(publicAccountAddresses([{ address: "8.8.8.8" }])).toBe(true);
  expect(publicAccountAddresses([{ address: "8.8.8.8" }, { address: "10.0.0.1" }])).toBe(false);
  expect(publicAccountAddresses([])).toBe(false);
  expect(
    checkAccountRequest("https://api.example.com/resource", ["example.com"], "head", true).hostname,
  ).toBe("api.example.com");
  for (const [url, sites, method] of [
    ["https://api.example.com", ["example.com"], "POST"],
    ["https://example.com.attacker.test", ["example.com"], "GET"],
    ["https://127.0.0.1", ["https://127.0.0.1"], "GET"],
    ["https://10.0.0.1", ["https://10.0.0.1"], "GET"],
    ["https://169.254.169.254", ["https://169.254.169.254"], "GET"],
    ["https://[::1]", ["https://[::1]"], "GET"],
  ] as const)
    expect(() => checkAccountRequest(url, sites, method, true)).toThrow("refused");
});

it("injects each API auth form and removes every raw or applied credential from text and binary response bytes", async () => {
  const token = "synthetic-token";
  for (const auth of [
    { type: "bearer" },
    { type: "header", name: "x-api-key" },
    { type: "basic", username: "fixture" },
    { type: "query", name: "key" },
  ] satisfies ApiKeyAuth[]) {
    const result = await accountRequest(
      { method: "GET", url: "https://api.example.com" },
      ["example.com"],
      false,
      auth,
      token,
      undefined,
      {
        close: async () => {},
        fetch: async (url, input) => {
          const headers = new Headers(input?.headers);
          const value =
            auth.type === "query"
              ? new URL(url).searchParams.get("key")
              : headers.get(auth.type === "header" ? auth.name : "authorization");
          expect(value).toBe(
            auth.type === "bearer"
              ? `Bearer ${token}`
              : auth.type === "basic"
                ? `Basic ${Buffer.from(`fixture:${token}`).toString("base64")}`
                : token,
          );
          return new Response(
            Buffer.concat([Buffer.from([0]), Buffer.from(`${token} ${value} ${token}`)]),
            { headers: { "content-type": "application/octet-stream" } },
          );
        },
      },
    );
    expect(Buffer.from(result.bytes).includes(Buffer.from(token))).toBe(false);
    expect(Buffer.from(result.bytes)[0]).toBe(0);
    expect(result.text).toBe(false);
  }
});

it("checks every redirect, strips identifying headers and query auth across origins, and never replays a body", async () => {
  const seen: Array<{ url: string; auth: string | null; custom: string | null }> = [];
  const transport = {
    close: async () => {},
    fetch: async (url: string | URL, input?: RequestInit) => {
      const headers = new Headers(input?.headers);
      seen.push({
        url: String(url),
        auth: headers.get("authorization"),
        custom: headers.get("x-session"),
      });
      if (seen.length === 1)
        return new Response(null, { status: 302, headers: { location: "/same" } });
      if (seen.length === 2)
        return new Response(null, {
          status: 302,
          headers: { location: "https://other.example.com/path?key=synthetic-token" },
        });
      return new Response("safe", { headers: { "content-type": "text/plain" } });
    },
  };
  const result = await accountRequest(
    { method: "GET", url: "https://api.example.com", headers: { "x-session": "synthetic-header" } },
    ["example.com"],
    true,
    { type: "bearer" },
    "synthetic-token",
    undefined,
    transport,
  );
  expect(result.status).toBe(200);
  expect(seen.map((item) => item.auth)).toEqual([
    "Bearer synthetic-token",
    "Bearer synthetic-token",
    null,
  ]);
  expect(seen[2]).toEqual({ url: "https://other.example.com/path", auth: null, custom: null });
  let queryHops = 0;
  await accountRequest(
    { method: "GET", url: "https://api.example.com" },
    ["example.com"],
    true,
    { type: "query", name: "key" },
    "synthetic-token",
    undefined,
    {
      close: async () => {},
      fetch: async (url) => {
        queryHops++;
        expect(new URL(url).searchParams.get("key")).toBe("synthetic-token");
        return queryHops === 1
          ? new Response(null, { status: 302, headers: { location: "/next" } })
          : new Response("safe");
      },
    },
  );
  let calls = 0;
  const redirect = {
    close: async () => {},
    fetch: async () => {
      calls++;
      return new Response(null, { status: 302, headers: { location: "https://untrusted.test" } });
    },
  };
  await expect(
    accountRequest(
      { method: "GET", url: "https://api.example.com" },
      ["example.com"],
      true,
      { type: "query", name: "key" },
      "synthetic-token",
      undefined,
      redirect,
    ),
  ).rejects.toThrow("refused");
  expect(calls).toBe(1);
  calls = 0;
  await expect(
    accountRequest(
      { method: "POST", url: "https://api.example.com", body: "fixture" },
      ["example.com"],
      false,
      { type: "bearer" },
      "synthetic-token",
      undefined,
      redirect,
    ),
  ).rejects.toThrow("refused");
  expect(calls).toBe(1);
});

it("redacts escaped JSON and encoded text without leaking the account key", async () => {
  const token = "synthetic-token-with-escapes";
  const escaped = Array.from(
    token,
    (letter) => "\\u" + letter.charCodeAt(0).toString(16).padStart(4, "0"),
  ).join("");
  for (const [body, contentType] of [
    ['{"token":"' + escaped + '"}', "application/json"],
    [encodeURIComponent(token.replaceAll("-", "/")), "text/plain"],
  ]) {
    const value = contentType === "text/plain" ? token.replaceAll("-", "/") : token;
    const result = await accountRequest(
      { method: "GET", url: "https://api.example.com" },
      ["example.com"],
      true,
      { type: "bearer" },
      value,
      undefined,
      {
        fetch: async () => new Response(body, { headers: { "content-type": contentType! } }),
        close: async () => {},
      },
    );
    const text = new TextDecoder().decode(result.bytes);
    expect(text).toContain("[redacted]");
    expect(text).not.toContain(body!);
  }
});

it("bounds upstream response bodies and closes an exchange after refusal", async () => {
  let closed = false;
  const refused = await accountRequest(
    { method: "GET", url: "https://api.example.com" },
    ["example.com"],
    true,
    { type: "bearer" },
    "synthetic-token",
    undefined,
    {
      fetch: async () => new Response(new Uint8Array(32 * 1024 * 1024 + 1)),
      close: async () => {
        closed = true;
      },
    },
  ).then(
    () => false,
    () => true,
  );
  expect(refused).toBe(true);
  expect(closed).toBe(true);
});
