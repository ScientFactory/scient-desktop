// @effect-diagnostics nodeBuiltinImport:off -- fixtures hash their archives.
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as TestClock from "effect/testing/TestClock";
import { ANTIGRAVITY_MARKETPLACES, antigravityCategories } from "./AntigravityPluginCatalog.ts";
import {
  ANTIGRAVITY_NOT_CLI,
  antigravityPluginCommandEnvironment,
  makeAntigravityPluginActions,
} from "./AntigravityProviderStore.ts";
import { makeZip, renameInZip } from "./AntigravityPluginArchive.testkit.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeManifest = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ name: Schema.String, version: Schema.String })),
);
const [OFFICIAL, PARTNERS] = ANTIGRAVITY_MARKETPLACES;
const GMAIL_ZIP = "https://www.gstatic.com/antigravity/plugins/gmail/gmail.zip?v=1";
const CANVA_ZIP = "https://www.gstatic.com/antigravity/plugins-partners/canva/canva.zip?v=1";
const sha256 = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

const gmailZip = makeZip([
  { name: "plugin.json", data: encode({ name: "gmail", version: "0.0.7" }) },
  { name: "skills/gmail/SKILL.md", data: "---\nname: gmail\n---\n" },
  { name: "skills/gmail/scripts/gmail", data: "#!/bin/sh\n", mode: 0o100755 },
]);

/** A fresh response per request: a cloned body stays open until every clone is read. */
type Route = (() => Response) | "hang" | "fail";

interface Fixture {
  readonly routes: Map<string, Route>;
  readonly fetched: string[];
  readonly calls: string[][];
  readonly installed: Map<string, { enabled: boolean; version?: string; path: string }>;
  readonly stagedScriptModes: number[];
  listOutput?: string;
  unavailable?: string;
}

const officialFeed = (gmail: Buffer, overrides: Record<string, unknown> = {}) => ({
  name: OFFICIAL.name,
  plugins: [
    {
      name: "gmail",
      displayName: "Gmail",
      version: "0.0.7",
      description: "Search, read, draft, and send emails in Gmail.",
      logo: "https://www.gstatic.com/images/gmail.svg",
      source: { type: "archive", url: GMAIL_ZIP, sha256: sha256(gmail) },
      ...overrides,
    },
    { name: "broken entry", source: { type: "archive" } },
    {
      name: "chemistry",
      displayName: "Chemistry",
      description: "Molecules",
      keywords: ["science"],
      source: {
        type: "archive",
        url: "https://example.com/chemistry.zip",
        sha256: "0".repeat(64),
      },
    },
  ],
});
const partnerFeed = (canva: Buffer) => ({
  name: PARTNERS.name,
  plugins: [
    {
      name: "canva",
      displayName: "Canva",
      version: "1.0.0",
      description: "Designs",
      author: { name: "Canva" },
      skills: ["./skills/edit-design"],
      source: { type: "archive", url: CANVA_ZIP, sha256: sha256(canva) },
    },
  ],
});

const setup = (configure?: (fixture: Fixture, zips: { gmail: Buffer; canva: Buffer }) => void) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stateDir = yield* fs.makeTempDirectoryScoped();
    const home = yield* fs.makeTempDirectoryScoped();
    const gmail = yield* gmailZip;
    const canva = yield* makeZip([
      { name: "plugin.json", data: encode({ name: "canva", version: "1.0.0" }) },
    ]);
    const fixture: Fixture = {
      routes: new Map<string, Route>([
        [OFFICIAL.url, () => Response.json(officialFeed(gmail))],
        [PARTNERS.url, () => Response.json(partnerFeed(canva))],
        [GMAIL_ZIP, () => new Response(gmail)],
        [CANVA_ZIP, () => new Response(canva)],
      ]),
      fetched: [],
      calls: [],
      installed: new Map(),
      stagedScriptModes: [],
    };
    configure?.(fixture, { gmail, canva });
    const http = HttpClient.make((request) => {
      fixture.fetched.push(request.url);
      const route = fixture.routes.get(request.url);
      if (route === "hang") return Effect.never;
      if (route === "fail" || route === undefined)
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response("missing", { status: 404 })),
        );
      return Effect.succeed(HttpClientResponse.fromWeb(request, route()));
    });
    const pluginPath = (name: string) => path.join(home, ".gemini", "config", "plugins", name);
    const run = (args: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        fixture.calls.push([...args]);
        const [, command, target] = args;
        if (command === "list") {
          if (fixture.listOutput !== undefined) return fixture.listOutput;
          return encode(
            [...fixture.installed].map(([name, plugin]) => ({
              name,
              enabled: plugin.enabled,
              ...(plugin.version ? { version: plugin.version } : {}),
              source: "antigravity",
              path: plugin.path,
            })),
          );
        }
        if (command === "install") {
          const manifest = yield* fs.readFileString(path.join(target!, "plugin.json"));
          const script = path.join(target!, "skills", "gmail", "scripts", "gmail");
          if (yield* fs.exists(script))
            fixture.stagedScriptModes.push(Number((yield* fs.stat(script)).mode));
          const parsed = yield* decodeManifest(manifest);
          fixture.installed.set(parsed.name, {
            enabled: true,
            version: parsed.version,
            path: pluginPath(parsed.name),
          });
          return "";
        }
        if (command === "uninstall") fixture.installed.delete(target!);
        if (command === "enable" || command === "disable") {
          const plugin = fixture.installed.get(target!);
          if (plugin) plugin.enabled = command === "enable";
        }
        return "";
      }).pipe(Effect.mapError(() => ({ message: "agy failed" })));
    const plugins = yield* makeAntigravityPluginActions({
      stateDir,
      run,
      unavailable: Effect.sync(() => fixture.unavailable),
    }).pipe(Effect.provideService(HttpClient.HttpClient, http));
    const store = plugins.actions.store!;
    return { ...plugins, store, fixture, stateDir, pluginPath, fs, path };
  });

const provide = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
) => Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer));

describe("AntigravityProviderStore", () => {
  it.effect("lists both catalogs in order with their publishers, skipping malformed entries", () =>
    provide(
      Effect.gen(function* () {
        const { store } = yield* setup();
        const page = yield* store.search({});
        expect(page.entries.map((entry) => entry.id)).toEqual([
          "gmail@antigravity-plugins-official",
          "chemistry@antigravity-plugins-official",
          "canva@antigravity-plugins-partners",
        ]);
        expect(page.entries[0]).toMatchObject({
          kind: "antigravity",
          publisherType: "google",
          publisher: "Google",
          installed: false,
        });
        expect(page.entries[0]!.disabledReason).toBeUndefined();
        expect(page.entries[1]!.disabledReason).toMatch(/Google's plugin host/);
        expect(page.entries[2]).toMatchObject({
          publisherType: "third-party",
          publisher: "Canva",
          includes: ["Skills"],
        });
        expect((yield* store.search({ query: "science" })).entries.map((e) => e.name)).toEqual([
          "chemistry",
        ]);
        const detail = yield* store.contents!("canva@antigravity-plugins-partners");
        expect(detail.deferred).toBe(true);
        expect(detail.skills.map((skill) => skill.name)).toEqual(["edit-design"]);
      }),
    ),
  );

  it.effect("keeps one catalog when the other fails, is too large or malformed", () =>
    provide(
      Effect.gen(function* () {
        for (const partner of [
          "fail" as const,
          () => new Response("x".repeat(4 * 1024 * 1024 + 1)),
          () => Response.json({ name: "someone-else", plugins: [] }),
          () => new Response("{not json"),
        ]) {
          const { store } = yield* setup((fixture) => fixture.routes.set(PARTNERS.url, partner));
          const page = yield* store.search({});
          expect(page.sourceFailures).toEqual([PARTNERS.name]);
          expect(page.entries.map((entry) => entry.name)).toEqual(["gmail", "chemistry"]);
        }
      }),
    ),
  );

  it.effect("times out a catalog that never answers", () =>
    provide(
      Effect.gen(function* () {
        const { store } = yield* setup((fixture) => fixture.routes.set(OFFICIAL.url, "hang"));
        const searching = yield* store
          .search({})
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust("21 seconds");
        const page = yield* Fiber.join(searching);
        expect(page.sourceFailures).toEqual([OFFICIAL.name]);
        expect(page.entries.map((entry) => entry.name)).toEqual(["canva"]);
      }),
    ),
  );

  it.effect("fetches each catalog once for concurrent and repeated reads until refreshed", () =>
    provide(
      Effect.gen(function* () {
        const { store, fixture } = yield* setup();
        yield* Effect.all([store.search({}), store.search({ preview: true })], {
          concurrency: "unbounded",
        });
        yield* store.search({ query: "gmail" });
        const feedReads = () => fixture.fetched.filter((url) => url.endsWith("marketplace.json"));
        expect(feedReads()).toHaveLength(2);
        yield* store.search({ refresh: true });
        expect(feedReads()).toHaveLength(4);
      }),
    ),
  );

  it.effect("adds a checked archive through agy and records where it came from", () =>
    provide(
      Effect.gen(function* () {
        const { store, actions, fixture, stateDir, pluginPath, fs, path } = yield* setup();
        yield* store.install("gmail@antigravity-plugins-official");
        const install = fixture.calls.find((call) => call[1] === "install")!;
        expect(install.slice(0, 2)).toEqual(["plugin", "install"]);
        expect(path.basename(install[2]!)).toBe("gmail");
        expect(yield* fs.exists(install[2]!)).toBe(false);
        expect(fixture.stagedScriptModes[0]! & 0o111).not.toBe(0);
        expect((yield* store.entry("gmail@antigravity-plugins-official")).installed).toBe(true);
        const listing = yield* actions.listPlugins({});
        expect(listing.plugins).toEqual([
          expect.objectContaining({
            id: "gmail@antigravity-plugins-official",
            marketplace: "antigravity-plugins-official",
            displayName: "Gmail",
            canUninstall: true,
            canSetEnabled: true,
            path: pluginPath("gmail"),
          }),
        ]);
        expect(
          yield* fs.readFileString(path.join(stateDir, "antigravity-plugins", "receipts.json")),
        ).toContain('"sha256"');
        expect(
          yield* fs.readDirectory(path.join(stateDir, "antigravity-plugins", "staging")),
        ).toEqual([]);

        yield* actions.setEnabled!({
          pluginId: "gmail@antigravity-plugins-official",
          enabled: false,
        });
        expect(fixture.calls.at(-1)).toEqual(["plugin", "disable", "gmail"]);
        yield* actions.uninstall({ pluginId: "gmail@antigravity-plugins-official" });
        expect(fixture.calls.at(-1)).toEqual(["plugin", "uninstall", "gmail"]);
        expect((yield* store.entry("gmail@antigravity-plugins-official")).installed).toBe(false);
      }),
    ),
  );

  it.effect("refuses an archive whose checksum differs and never installs it", () =>
    provide(
      Effect.gen(function* () {
        const { store, fixture, stateDir, fs, path } = yield* setup((fixture) =>
          fixture.routes.set(GMAIL_ZIP, () => new Response("tampered")),
        );
        const error = yield* store.install("gmail@antigravity-plugins-official").pipe(Effect.flip);
        expect(error.message).toMatch(/checksum/);
        expect(fixture.calls.some((call) => call[1] === "install")).toBe(false);
        const staging = path.join(stateDir, "antigravity-plugins", "staging");
        if (yield* fs.exists(staging)) expect(yield* fs.readDirectory(staging)).toEqual([]);
      }),
    ),
  );

  it.effect("refuses an unsafe archive even when its checksum matches", () =>
    provide(
      Effect.gen(function* () {
        const unsafe = renameInZip(
          yield* makeZip([
            { name: "plugin.json", data: encode({ name: "gmail", version: "0.0.7" }) },
            { name: "zz/evil", data: "x" },
          ]),
          "zz/evil",
          "../evil",
        );
        const { store, fixture, stateDir, fs, path } = yield* setup((fixture) => {
          fixture.routes.set(OFFICIAL.url, () => Response.json(officialFeed(unsafe)));
          fixture.routes.set(GMAIL_ZIP, () => new Response(unsafe));
        });
        const error = yield* store.install("gmail@antigravity-plugins-official").pipe(Effect.flip);
        expect(error.message).toMatch(/archive/);
        expect(fixture.calls.some((call) => call[1] === "install")).toBe(false);
        expect(
          yield* fs.readDirectory(path.join(stateDir, "antigravity-plugins", "staging")),
        ).toEqual([]);
        expect(yield* fs.exists(path.join(stateDir, "antigravity-plugins", "evil"))).toBe(false);
      }),
    ),
  );

  it.effect("never claims or removes a same-name plugin from another source", () =>
    provide(
      Effect.gen(function* () {
        const { store, actions, fixture, pluginPath } = yield* setup();
        fixture.installed.set("gmail", {
          enabled: true,
          version: "9.9.9",
          path: pluginPath("gmail"),
        });
        const entry = yield* store.entry("gmail@antigravity-plugins-official");
        expect(entry.installed).toBe(false);
        expect(entry.disabledReason).toMatch(/another source/);
        expect(
          (yield* store.install("gmail@antigravity-plugins-official").pipe(Effect.flip)).message,
        ).toMatch(/another source/);
        expect(fixture.calls.some((call) => call[1] === "install")).toBe(false);
        expect(
          (yield* actions
            .uninstall({ pluginId: "gmail@antigravity-plugins-official" })
            .pipe(Effect.flip)).message,
        ).toMatch(/no longer installed/);
        expect(fixture.calls.some((call) => call[1] === "uninstall")).toBe(false);
        const [native] = (yield* actions.listPlugins({})).plugins;
        expect(native).toMatchObject({
          id: "antigravity:gmail",
          sourceLabel: "Antigravity's plugins",
        });
        expect(native!.marketplace).toBeUndefined();
      }),
    ),
  );

  it.effect("treats a malformed installed list as unknown, never as empty", () =>
    provide(
      Effect.gen(function* () {
        for (const output of ["not json", encode([{ name: "gmail", enabled: true }])]) {
          const { store, actions } = yield* setup((fixture) => {
            fixture.listOutput = output;
          });
          expect((yield* actions.listPlugins({}).pipe(Effect.flip)).message).toMatch(
            /installed plugins/,
          );
          const page = yield* store.search({});
          expect(page.message).toMatch(/paused/);
          expect(page.entries[0]).toMatchObject({
            installationStateKnown: false,
            installed: false,
          });
          expect(page.entries[0]!.disabledReason).toMatch(/paused/);
          expect(
            (yield* store.install("gmail@antigravity-plugins-official").pipe(Effect.flip)).message,
          ).toMatch(/paused/);
        }
      }),
    ),
  );

  it.effect("keeps installed plugins and Remove working while both catalogs are down", () =>
    provide(
      Effect.gen(function* () {
        const { store, actions, fixture, pluginPath } = yield* setup((fixture) => {
          fixture.routes.set(OFFICIAL.url, "fail");
          fixture.routes.set(PARTNERS.url, "fail");
        });
        fixture.installed.set("canva", { enabled: true, path: pluginPath("canva") });
        const page = yield* store.search({});
        expect(page.entries).toEqual([]);
        expect(page.sourceFailures).toEqual([OFFICIAL.name, PARTNERS.name]);
        yield* actions.uninstall({ pluginId: "antigravity:canva" });
        expect(fixture.installed.size).toBe(0);
      }),
    ),
  );

  it.effect("explains why an instance that is not the agy CLI cannot add plugins", () =>
    provide(
      Effect.gen(function* () {
        const { store, actions, fixture } = yield* setup((fixture) => {
          fixture.unavailable = ANTIGRAVITY_NOT_CLI;
        });
        const page = yield* store.search({});
        expect(page.message).toBe(ANTIGRAVITY_NOT_CLI);
        expect(page.entries.every((entry) => entry.disabledReason === ANTIGRAVITY_NOT_CLI)).toBe(
          true,
        );
        expect((yield* actions.listPlugins({}).pipe(Effect.flip)).message).toBe(
          ANTIGRAVITY_NOT_CLI,
        );
        expect(fixture.calls).toEqual([]);
      }),
    ),
  );
});

it("files catalog plugins under reviewed Discover categories, then the catalog's own labels", () => {
  expect(antigravityCategories("scientific-literature", [], [])).toEqual(["papers"]);
  expect(antigravityCategories("gmail", ["Productivity"], [])).toEqual(["communication"]);
  expect(antigravityCategories("new-tool", ["Developer Tools", "Cloud"], [])).toEqual(["code"]);
  expect(antigravityCategories("new-db", [], ["graph", "database"])).toEqual(["data"]);
  expect(antigravityCategories("new-thing", [], ["misc"])).toEqual([]);
});

it.effect("filters a category page by those categories", () =>
  provide(
    Effect.gen(function* () {
      const { store } = yield* setup();
      const names = (category: string) =>
        store.search({ category }).pipe(Effect.map((page) => page.entries.map((e) => e.name)));
      expect(yield* names("communication")).toEqual(["gmail"]);
      expect(yield* names("chemistry")).toEqual(["chemistry"]);
      expect(yield* names("figures")).toEqual(["canva"]);
      expect(yield* names("most-used")).toEqual([]);
    }),
  ),
);

it("passes agy only what it needs to find the user's home", () => {
  expect(
    antigravityPluginCommandEnvironment({
      HOME: "/home/a",
      PATH: "/usr/bin",
      GEMINI_API_KEY: "secret",
      GEMINI_HOME: "/profile",
      T3CODE_HOME: "/live",
    }),
  ).toEqual({ HOME: "/home/a", PATH: "/usr/bin" });
});
