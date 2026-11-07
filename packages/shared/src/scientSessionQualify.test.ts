import type { SessionCookie } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { COPY_CASES, domainCookie, type QualifyJar } from "./scientSessionQualify.ts";

/** An in-memory jar; `overHttp` is what a browser does with a raw http:// write. */
const fakeJar = (overHttp: "refuses" | "accepts"): QualifyJar => {
  let cookies: SessionCookie[] = [];
  return {
    set: async (written) => {
      for (const cookie of written)
        if (!cookie.name.startsWith("__Secure-") || cookie.secure)
          cookies = [...cookies.filter((old) => old.name !== cookie.name), cookie];
    },
    read: async () => cookies,
    remove: async (gone) => {
      cookies = cookies.filter((cookie) => !gone.some((old) => old.name === cookie.name));
    },
    sentTo: async () => cookies.map((cookie) => cookie.name),
    setOverHttp: async (name) => {
      if (overHttp === "accepts") cookies.push(domainCookie(name, { secure: false }));
    },
  };
};

describe("the shared copy cases", () => {
  it("fail the prefixes case when a browser takes a __Secure- cookie from an http:// page", async () => {
    const [, prefixes] = COPY_CASES.find(([name]) => name === "prefixes")!;
    expect(await prefixes(fakeJar("refuses"), fakeJar("refuses"))).toBeUndefined();
    expect(await prefixes(fakeJar("refuses"), fakeJar("accepts"))).toBe(
      "a __Secure- cookie from an http:// page was accepted",
    );
  });
});
