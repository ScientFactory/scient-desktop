import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as DesktopManagedPolicy from "../../app/DesktopManagedPolicy.ts";
import * as BrowserSession from "../BrowserSession.ts";
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

describe("BrowserImport.writeCookies for Scient Accounts", () => {
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
        skippedByReason: {
          appBoundEncryption: 0,
          decryptFailed: 0,
          partitionUnsupported: 0,
          writeFailed: 1,
        },
        importedGoogle: false,
      });
    }),
  );

  it.effect("counts the sites it wrote, not the ones it kept or that refused a cookie", () =>
    Effect.gen(function* () {
      const result = yield* BrowserImport.writeCookies(
        {
          cookies: {
            set: (details: { readonly url: string }) =>
              details.url.includes("refused")
                ? Promise.reject(new Error("fixture"))
                : Promise.resolve(),
            flushStore: () => Promise.resolve(),
          },
        },
        {
          cookies: [
            "https://mail.google.com/",
            "https://notgoogle.com/",
            "https://mail.notgoogle.com/",
            "https://refused.example.net/",
          ].map((url) => ({ ...cookie("fixture", false), url })),
          undecryptable: 0,
          undecryptableHosts: [],
        },
        ["google.com"],
      );
      assert.equal(result.imported, 2);
      assert.equal(result.importedSites, 1);
    }),
  );

  it.effect("keeps the reader's causes apart from refused writes, each row once", () =>
    Effect.gen(function* () {
      const result = yield* BrowserImport.writeCookies(
        {
          cookies: {
            set: (details: { readonly url: string }) =>
              details.url.includes("refused")
                ? Promise.reject(new Error("fixture"))
                : Promise.resolve(),
            flushStore: () => Promise.resolve(),
          },
        },
        {
          cookies: ["https://accounts.google.com/", "https://refused.example/"].map((url) => ({
            ...cookie("fixture", false),
            url,
          })),
          undecryptable: 4,
          undecryptableHosts: ["bound.example"],
          skippedByReason: { appBoundEncryption: 2, decryptFailed: 1, partitionUnsupported: 1 },
        },
      );
      assert.equal(result.imported, 1);
      assert.equal(result.skipped, 5);
      assert.deepStrictEqual(result.skippedByReason, {
        appBoundEncryption: 2,
        decryptFailed: 1,
        partitionUnsupported: 1,
        writeFailed: 1,
      });
      assert.isTrue(result.importedGoogle);
    }),
  );
});

const importerOn = Effect.fnUntraced(function* (platform: NodeJS.Platform) {
  const fileSystem = yield* FileSystem.FileSystem;
  const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "scient-import-win-" });
  const environment = { HOME: home, LOCALAPPDATA: `${home}/Local`, APPDATA: `${home}/Roaming` };
  // Installed, by its user-data folder alone: there is no cookie database to read.
  yield* fileSystem.makeDirectory(`${home}/Local/Google/Chrome/User Data`, { recursive: true });
  return yield* BrowserImport.BrowserImport.pipe(
    Effect.provide(
      BrowserImport.layer.pipe(
        Layer.provide(
          Layer.succeed(
            BrowserSession.BrowserSession,
            BrowserSession.BrowserSession.of({
              getPartition: () => Effect.die("unreachable"),
              isPartition: () => false,
              getSession: () => Effect.die("a blocked source must not reach a session"),
              clearCookies: () => Effect.die("unreachable"),
              clearCache: () => Effect.die("unreachable"),
            }),
          ),
        ),
        Layer.provide(DesktopManagedPolicy.layerTest()),
        Layer.provide(Layer.succeed(HostProcess.Environment, environment)),
        Layer.provide(Layer.succeed(HostProcess.Platform, platform)),
        Layer.provide(Layer.succeed(HostProcess.ExecutablePath, `${home}/Scient.exe`)),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );
});

describe("Chromium browsers on Windows", () => {
  it.effect("are listed as protected when installed and not installed otherwise", () =>
    Effect.gen(function* () {
      const sources = yield* (yield* importerOn("win32")).listSources;
      const reason = (id: string) => sources.find((source) => source.id === id)?.unavailable;
      assert.equal(reason("chrome"), "appBoundEncryption");
      for (const id of ["edge", "brave", "vivaldi", "opera", "arc", "firefox", "zen", "helium"])
        assert.equal(reason(id), "notInstalled", id);
      assert.equal(reason("safari"), "unsupportedPlatform");
      assert.deepStrictEqual(sources.find((source) => source.id === "chrome")?.profiles, []);

      // The same folders mean nothing on macOS.
      const mac = yield* (yield* importerOn("darwin")).listSources;
      assert.equal(mac.find((source) => source.id === "chrome")?.unavailable, "notInstalled");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("refuse an import with the same reason, before any read", () =>
    Effect.gen(function* () {
      const error = yield* (yield* importerOn("win32"))
        .importCookies({
          input: { sourceId: "chrome", sourceProfileDirectory: "Default", targetProfileId: "work" },
          scope: "persist:scient-test",
          persistent: true,
        })
        .pipe(Effect.flip);
      assert.instanceOf(error, BrowserImport.BrowserImportFailedError);
      assert.equal(error.reason, "appBoundEncryption");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
