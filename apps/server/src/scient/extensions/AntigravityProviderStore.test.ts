// @effect-diagnostics nodeBuiltinImport:off -- fixtures hash their archives.
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, type ProviderInstallState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type * as Scope from "effect/Scope";
import type { ChildProcessSpawner } from "effect/process";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as TestClock from "effect/testing/TestClock";
import { ANTIGRAVITY_MARKETPLACES, antigravityCategories } from "./AntigravityPluginCatalog.ts";
import {
  ANTIGRAVITY_CUSTOM_NOT_CLI,
  ANTIGRAVITY_NOT_CLI,
  ANTIGRAVITY_SYSTEM_NOT_CLI,
  antigravityPluginCommandEnvironment,
  makeAntigravityInstancePlugins,
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
  readonly installed: Map<
    string,
    { enabled: boolean; version?: string; path: string; source?: string | null }
  >;
  readonly stagedScriptModes: number[];
  listOutput?: string;
  unavailable?: string;
  /** Whether agy itself is signed in, which its own marketplace install needs. */
  nativeSignedIn?: boolean;
  /** Runs right after a directory install, as another program might. */
  afterArchiveInstall?: () => Effect.Effect<void>;
  /** The named install times out even though agy installed the plugin. */
  namedTimesOut?: boolean;
}

const GMAIL_DESCRIPTION = "Search, read, draft, and send emails in Gmail.";
const isArchiveInstall = (call: ReadonlyArray<string>) =>
  call[1] === "install" && !call[2]!.includes("@");

const officialFeed = (gmail: Buffer, overrides: Record<string, unknown> = {}) => ({
  name: OFFICIAL.name,
  plugins: [
    {
      name: "gmail",
      displayName: "Gmail",
      version: "0.0.7",
      description: GMAIL_DESCRIPTION,
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
      mcpServers: "./mcp_config.json",
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
              ...(plugin.source === null ? {} : { source: plugin.source ?? "antigravity" }),
              path: plugin.path,
            })),
          );
        }
        if (command === "install" && target!.includes("@")) {
          // agy's own marketplace install: it records the marketplace as the plugin's source.
          if (!fixture.nativeSignedIn) return yield* Effect.fail("unknown marketplace");
          const [name, marketplace] = target!.split("@") as [string, string];
          // Like agy: a folder another source holds is refused, never replaced.
          if (fixture.installed.has(name)) return yield* Effect.fail("another plugin is installed");
          yield* fs.makeDirectory(pluginPath(name), { recursive: true });
          yield* fs.writeFileString(
            path.join(pluginPath(name), "plugin.json"),
            encode({ name, version: "0.0.7", description: GMAIL_DESCRIPTION }),
          );
          fixture.installed.set(name, {
            enabled: true,
            version: "0.0.7",
            path: pluginPath(name),
            source: marketplace,
          });
          if (fixture.namedTimesOut) return yield* Effect.fail("timed out");
          return "";
        }
        if (command === "install") {
          const manifest = yield* fs.readFileString(path.join(target!, "plugin.json"));
          const script = path.join(target!, "skills", "gmail", "scripts", "gmail");
          if (yield* fs.exists(script))
            fixture.stagedScriptModes.push(Number((yield* fs.stat(script)).mode));
          const parsed = yield* decodeManifest(manifest);
          // Like agy: the staged folder is copied, replacing any same-name folder.
          yield* fs.remove(pluginPath(parsed.name), { recursive: true, force: true });
          yield* fs.makeDirectory(path.dirname(pluginPath(parsed.name)), { recursive: true });
          yield* fs.copy(target!, pluginPath(parsed.name));
          fixture.installed.set(parsed.name, {
            enabled: true,
            version: parsed.version,
            path: pluginPath(parsed.name),
          });
          if (fixture.afterArchiveInstall) yield* fixture.afterArchiveInstall();
          return "";
        }
        if (command === "uninstall") {
          fixture.installed.delete(target!);
          yield* fs.remove(pluginPath(target!), { recursive: true, force: true });
        }
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
  effect: Effect.Effect<
    A,
    E,
    FileSystem.FileSystem | Path.Path | Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
  >,
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
          includes: ["Skills", "MCP servers"],
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
        const install = fixture.calls.find(isArchiveInstall)!;
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
        expect(fixture.calls).toContainEqual(["plugin", "disable", "gmail"]);
        yield* actions.uninstall({ pluginId: "gmail@antigravity-plugins-official" });
        expect(fixture.calls).toContainEqual(["plugin", "uninstall", "gmail"]);
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
        expect(fixture.calls.some(isArchiveInstall)).toBe(false);
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
        expect(fixture.calls.some(isArchiveInstall)).toBe(false);
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
        expect(entry.disabledReason).toMatch(/different plugin named gmail/);
        expect(
          (yield* store.install("gmail@antigravity-plugins-official").pipe(Effect.flip)).message,
        ).toMatch(/different plugin named gmail/);
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

  it.effect("does not replace a same-name plugin installed while the archive downloaded", () =>
    provide(
      Effect.gen(function* () {
        const { store, fixture, stateDir, pluginPath, fs, path } = yield* setup((fixture, zips) =>
          fixture.routes.set(GMAIL_ZIP, () => {
            fixture.installed.set("gmail", {
              enabled: true,
              version: "1.0.0",
              path: "/app/plugins/gmail",
            });
            return new Response(zips.gmail);
          }),
        );
        const installedMeanwhile = fixture.installed;
        const error = yield* store.install("gmail@antigravity-plugins-official").pipe(Effect.flip);
        expect(error.message).toMatch(/while Scient was preparing/);
        expect(fixture.calls.some(isArchiveInstall)).toBe(false);
        expect(installedMeanwhile.get("gmail")?.version).toBe("1.0.0");
        expect(yield* fs.exists(pluginPath("gmail"))).toBe(false);
        expect(
          yield* fs.readDirectory(path.join(stateDir, "antigravity-plugins", "staging")),
        ).toEqual([]);
      }),
    ),
  );

  it.effect("treats a replaced copy at the same name, version and folder as a local plugin", () =>
    provide(
      Effect.gen(function* () {
        const { store, actions, fixture, pluginPath, fs, path } = yield* setup();
        const id = "gmail@antigravity-plugins-official";
        yield* store.install(id);
        expect((yield* actions.listPlugins({})).plugins[0]!.id).toBe(id);
        // Removed and installed again in the Antigravity app: same name, version and folder.
        yield* fs.remove(pluginPath("gmail"), { recursive: true });
        yield* fs.makeDirectory(pluginPath("gmail"), { recursive: true });
        yield* fs.writeFileString(
          path.join(pluginPath("gmail"), "plugin.json"),
          encode({ name: "gmail", version: "0.0.7", description: "another copy" }),
        );
        const [replaced] = (yield* actions.listPlugins({})).plugins;
        expect(replaced).toMatchObject({ id: "antigravity:gmail" });
        expect((yield* store.entry(id)).installed).toBe(false);
        expect((yield* actions.uninstall({ pluginId: id }).pipe(Effect.flip)).message).toMatch(
          /no longer installed/,
        );
        expect(fixture.calls.some((call) => call[1] === "uninstall")).toBe(false);
      }),
    ),
  );

  it.effect("needs agy's version and source to match the receipt", () =>
    provide(
      Effect.gen(function* () {
        const { store, actions, fixture } = yield* setup();
        const id = "gmail@antigravity-plugins-official";
        yield* store.install(id);
        const gmail = fixture.installed.get("gmail")!;
        const { version: _version, ...unversioned } = gmail;
        fixture.installed.set("gmail", unversioned);
        expect((yield* actions.listPlugins({})).plugins[0]!.id).toBe("antigravity:gmail");
        fixture.installed.set("gmail", { ...gmail, source: "gemini" });
        expect((yield* actions.listPlugins({})).plugins[0]!.id).toBe("antigravity:gmail");
        fixture.installed.set("gmail", gmail);
        expect((yield* actions.listPlugins({})).plugins[0]!.id).toBe(id);
      }),
    ),
  );

  it.effect("adds through agy's own marketplace install when agy is signed in", () =>
    provide(
      Effect.gen(function* () {
        const { store, actions, fixture, stateDir, fs, path } = yield* setup((fixture) => {
          fixture.nativeSignedIn = true;
        });
        const id = "gmail@antigravity-plugins-official";
        yield* store.install(id);
        expect(fixture.calls).toContainEqual(["plugin", "install", id]);
        expect(fixture.calls.some(isArchiveInstall)).toBe(false);
        expect(fixture.fetched).not.toContain(GMAIL_ZIP);
        expect((yield* store.entry(id)).installed).toBe(true);
        expect((yield* actions.listPlugins({})).plugins[0]).toMatchObject({
          id,
          sourceLabel: "Antigravity Marketplace",
        });
        const receipts = path.join(stateDir, "antigravity-plugins", "receipts.json");
        if (yield* fs.exists(receipts))
          expect(yield* fs.readFileString(receipts)).not.toContain('"gmail"');
      }),
    ),
  );

  it.effect("recognises a plugin agy installed from its marketplace outside Scient", () =>
    provide(
      Effect.gen(function* () {
        const { store, actions, fixture, pluginPath } = yield* setup();
        const id = "gmail@antigravity-plugins-official";
        fixture.installed.set("gmail", {
          enabled: true,
          version: "0.0.7",
          path: pluginPath("gmail"),
          source: "antigravity-plugins-official",
        });
        const entry = yield* store.entry(id);
        expect(entry.installed).toBe(true);
        expect(entry.disabledReason).toBeUndefined();
        expect((yield* actions.listPlugins({})).plugins[0]).toMatchObject({
          id,
          displayName: "Gmail",
        });
        yield* actions.uninstall({ pluginId: id });
        expect(fixture.calls).toContainEqual(["plugin", "uninstall", "gmail"]);
      }),
    ),
  );

  it.effect("recognises a copy installed before agy recorded origins by its manifest", () =>
    provide(
      Effect.gen(function* () {
        const { store, actions, fixture, pluginPath, fs, path } = yield* setup();
        const id = "gmail@antigravity-plugins-official";
        const older = (description: string) =>
          Effect.gen(function* () {
            yield* fs.makeDirectory(pluginPath("gmail"), { recursive: true });
            yield* fs.writeFileString(
              path.join(pluginPath("gmail"), "plugin.json"),
              encode({ name: "gmail", version: "0.0.5", description }),
            );
            fixture.installed.set("gmail", {
              enabled: true,
              version: "0.0.5",
              path: pluginPath("gmail"),
              source: null,
            });
          });
        yield* older(GMAIL_DESCRIPTION);
        expect((yield* store.entry(id)).installed).toBe(true);
        // Shown as added, but it keeps its own identity: Marketplace Remove never acts on it.
        expect((yield* actions.listPlugins({})).plugins[0]).toMatchObject({
          id: "antigravity:gmail",
          displayName: "Gmail",
        });
        expect((yield* actions.uninstall({ pluginId: id }).pipe(Effect.flip)).message).toMatch(
          /no longer installed/,
        );
        expect(fixture.calls.some((call) => call[1] === "uninstall")).toBe(false);
        // Same name, nothing else in common: someone else's plugin, never claimed.
        yield* older("My own mail helper");
        const entry = yield* store.entry(id);
        expect(entry.installed).toBe(false);
        expect(entry.disabledReason).toMatch(/different plugin named gmail/);
      }),
    ),
  );

  it.effect("trusts agy's list after a named install, whatever the command reported", () =>
    provide(
      Effect.gen(function* () {
        const { store, fixture } = yield* setup((fixture) => {
          fixture.nativeSignedIn = true;
          fixture.namedTimesOut = true;
        });
        const id = "gmail@antigravity-plugins-official";
        // agy installed it before the command failed: that is an Add, not a reason to fall back.
        yield* store.install(id);
        expect(fixture.calls.some(isArchiveInstall)).toBe(false);
        expect((yield* store.entry(id)).installed).toBe(true);
      }),
    ),
  );

  it.effect("records no receipt for a copy swapped in right after the archive install", () =>
    provide(
      Effect.gen(function* () {
        const { store, actions, stateDir, pluginPath, fs, path } = yield* setup((fixture) => {
          fixture.afterArchiveInstall = () =>
            fs
              .writeFileString(
                path.join(pluginPath("gmail"), "plugin.json"),
                encode({ name: "gmail", version: "0.0.7", description: "someone else's" }),
              )
              .pipe(Effect.orDie);
        });
        const id = "gmail@antigravity-plugins-official";
        const error = yield* store.install(id).pipe(Effect.flip);
        expect(error.message).toMatch(/changed while Scient added it/);
        const receipts = path.join(stateDir, "antigravity-plugins", "receipts.json");
        if (yield* fs.exists(receipts))
          expect(yield* fs.readFileString(receipts)).not.toContain('"gmail"');
        expect((yield* actions.listPlugins({})).plugins[0]!.id).toBe("antigravity:gmail");
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
        expect(
          page.entries.every(
            (entry) => entry.disabledReason === ANTIGRAVITY_NOT_CLI && entry.storeUnavailable,
          ),
        ).toBe(true);
        expect((yield* actions.listPlugins({}).pipe(Effect.flip)).message).toBe(
          ANTIGRAVITY_NOT_CLI,
        );
        expect(fixture.calls).toEqual([]);
      }),
    ),
  );
});

it.live("refreshes every instance that shares the plugin folder after a change", () =>
  provide(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped();
      const shared = path.join(stateDir, "home", ".gemini", "config", "plugins");
      const other = path.join(stateDir, "other", ".gemini", "config", "plugins");
      const enabled = new Map([["canva", true]]);
      const run = (args: ReadonlyArray<string>) =>
        Effect.sync(() => {
          const [, command, name] = args;
          if (command === "enable" || command === "disable")
            enabled.set(name!, command === "enable");
          return command === "list"
            ? encode(
                [...enabled].map(([plugin, on]) => ({
                  name: plugin,
                  enabled: on,
                  path: path.join(shared, plugin),
                })),
              )
            : "";
        });
      const http = HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 404 }))),
      );
      const instance = (pluginHome: string) =>
        makeAntigravityPluginActions({
          stateDir,
          run,
          unavailable: Effect.undefined,
          pluginHome,
        }).pipe(Effect.provideService(HttpClient.HttpClient, http));
      const [acting, peer, elsewhere] = yield* Effect.all([
        instance(shared),
        instance(shared),
        instance(other),
      ]);
      const latest = (reports: typeof peer.reports) =>
        Stream.runHead(reports).pipe(Effect.timeoutOption("1 second"), Effect.map(Option.flatten));
      const refused = yield* acting.actions.setEnabled!({
        pluginId: "antigravity:canva",
        enabled: false,
        cwd: "/work",
      }).pipe(Effect.flip);
      expect(refused.message).toMatch(/not a workspace/);
      expect(enabled.get("canva")).toBe(true);

      yield* acting.actions.setEnabled!({ pluginId: "antigravity:canva", enabled: false });
      for (const reports of [acting.reports, peer.reports]) {
        const report = yield* latest(reports);
        expect(report._tag).toBe("Some");
        if (report._tag === "Some") {
          expect(report.value.cwd).toBeUndefined();
          expect(report.value.plugins?.map((plugin) => plugin.enabled)).toEqual([false]);
        }
      }
      expect((yield* latest(elsewhere.reports))._tag).toBe("None");
    }),
  ),
);

it.live("tells open pages when an update switches the runtime to agy, and only then", () =>
  provide(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectoryScoped();
      const install = yield* SubscriptionRef.make<ProviderInstallState>({
        driver: ProviderDriverKind.make("antigravity"),
        operationId: null,
        phase: "idle",
        downloadedBytes: 0,
        totalBytes: null,
        version: null,
        installedVersion: "1.4.5",
        canRemove: true,
        message: null,
      });
      let harnessPath: string | null = path.join(stateDir, "localharness_external");
      const executable = (source: "managed" | "path" | "override") =>
        Effect.sync(() => ({
          executablePath: path.join(stateDir, "agy"),
          harnessPath,
          source,
          version: harnessPath === null ? "1.0.0" : "1.4.5",
          managedVersionDirectory: null,
        }));
      const http = HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status: 404 }))),
      );
      const instance = (source: "managed" | "path" | "override") =>
        makeAntigravityInstancePlugins({
          installation: {
            resolve: () => executable(source),
            acquire: () => executable(source),
            changes: SubscriptionRef.changes(install),
          },
          binaryPath: source === "override" ? path.join(stateDir, "acp") : "",
          environment: { HOME: stateDir },
          stateDir,
        }).pipe(Effect.provideService(HttpClient.HttpClient, http));
      const store = (yield* instance("managed")).actions.store!;
      // Each older runtime's reason names the step Settings offers for it.
      const custom = (yield* instance("override")).actions.store!;
      expect((yield* custom.search({})).message).toBe(ANTIGRAVITY_CUSTOM_NOT_CLI);
      const onPath = (yield* instance("path")).actions.store!;
      expect((yield* onPath.search({})).message).toBe(ANTIGRAVITY_SYSTEM_NOT_CLI);
      expect((yield* store.search({})).message).toBe(ANTIGRAVITY_NOT_CLI);
      const nextChange = () =>
        store.changes!.pipe(
          Stream.runHead,
          Effect.timeoutOption("300 millis"),
          Effect.map(Option.flatten),
          Effect.forkChild({ startImmediately: true }),
        );

      // Download progress, and a finished install of the same older runtime, change nothing.
      const quiet = yield* nextChange();
      yield* SubscriptionRef.update(install, (state) => ({
        ...state,
        operationId: "repair",
        phase: "downloading" as const,
      }));
      yield* SubscriptionRef.update(install, (state) => ({
        ...state,
        phase: "succeeded" as const,
      }));
      expect((yield* Fiber.join(quiet))._tag).toBe("None");

      const switched = yield* nextChange();
      harnessPath = null;
      yield* SubscriptionRef.update(install, (state) => ({
        ...state,
        operationId: "update",
        phase: "downloading" as const,
      }));
      yield* SubscriptionRef.update(install, (state) => ({
        ...state,
        phase: "succeeded" as const,
        installedVersion: "1.0.0",
      }));
      expect((yield* Fiber.join(switched))._tag).toBe("Some");
      expect((yield* store.search({})).message).not.toBe(ANTIGRAVITY_NOT_CLI);
    }),
  ),
);

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
