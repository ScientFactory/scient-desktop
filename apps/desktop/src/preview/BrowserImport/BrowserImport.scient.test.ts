import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as BrowserImport from "./BrowserImport.ts";
import type { ImportedCookie } from "./CookieDatabase.ts";

const cookie = (name: string, partitioned: boolean): ImportedCookie => ({
  url: "https://chips.example/",
  name,
  value: "synthetic",
  domain: undefined,
  path: "/",
  secure: true,
  httpOnly: true,
  expirationDate: undefined,
  sameSite: "no_restriction",
  ...(partitioned
    ? { partitionKey: { topLevelSite: "https://top.example", hasCrossSiteAncestor: false } }
    : {}),
});

describe("BrowserImport.writeCookies with partitioned cookies", () => {
  it.effect("sends them to the partition writer and counts the ones it refuses", () =>
    Effect.gen(function* () {
      const plain: Array<string> = [];
      const partitioned: Array<string> = [];
      const result = yield* BrowserImport.writeCookies(
        {
          cookies: {
            set: (details: { readonly name?: string }) => {
              plain.push(details.name ?? "");
              return Promise.resolve();
            },
            flushStore: () => Promise.resolve(),
          },
        },
        {
          cookies: [cookie("plain", false), cookie("chip", true), cookie("refused", true)],
          undecryptable: 0,
          undecryptableHosts: [],
        },
        [],
        (written) => {
          partitioned.push(written.name);
          return Effect.succeed(written.name === "chip");
        },
      );
      assert.deepStrictEqual(plain, ["plain"]);
      assert.deepStrictEqual(partitioned, ["chip", "refused"]);
      assert.deepStrictEqual(result, {
        imported: 2,
        skipped: 1,
        skippedDomains: ["chips.example"],
        importedSites: 1,
      });
    }),
  );
});
