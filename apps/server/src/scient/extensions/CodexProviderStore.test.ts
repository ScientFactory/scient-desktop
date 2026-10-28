// @effect-diagnostics nodeBuiltinImport:off -- Real local plugin document fixtures.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type * as CodexClient from "effect-codex-app-server/client";
import type * as CodexSchema from "effect-codex-app-server/schema";
import { resolveBrandIcon } from "./BrandIcons.ts";
import { makeCodexNativeInventory } from "../../provider/CodexPluginInventory.ts";
import {
  codexAppInstallUrl,
  codexStoreDisabledReason,
  makeCodexProviderStore,
} from "./CodexProviderStore.ts";
const decodeInstall = Schema.decodeUnknownEffect(Schema.Struct({ pluginName: Schema.String }));
const encode = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
type Plugin = CodexSchema.V2PluginListResponse__PluginSummary;
const plugin = (id: string, overrides: Partial<Plugin> = {}): Plugin => ({
  id,
  name: id,
  installed: false,
  enabled: true,
  authPolicy: "ON_INSTALL",
  installPolicy: "AVAILABLE",
  source: { type: "remote" },
  interface: {
    displayName: id,
    shortDescription: `Plugin ${id}`,
    logoUrl: `https://files.openai.com/${id}`,
    capabilities: [],
    screenshots: [],
    screenshotUrls: [],
  },
  ...overrides,
});
function clientFixture(plugins: ReadonlyArray<Plugin>) {
  const state = {
    plugins,
    account: {
      type: "chatgpt",
      email: "test@example.com",
      planType: "plus",
    } as CodexSchema.V2GetAccountResponse__Account | null,
    installed: new Set<string>(),
    app: {
      id: "app",
      name: "Sample",
      isAccessible: false,
      isEnabled: true,
      installUrl: "https://chatgpt.com/apps/sample/app",
      pluginDisplayNames: ["sample"],
      toolSummaries: [
        {
          name: "search",
          title: "Search pages",
          description: "Find pages",
          isReadOnly: true,
          isEnabled: true,
        },
        { name: "create", description: "Create pages", isReadOnly: false, isEnabled: false },
      ],
    },
    remoteContents: "---\nname: search\n---\n# Remote instructions" as string | null,
    localPlugins: [] as Plugin[],
    skills: [{ name: "search" }] as Array<{ name: string; path?: string; description?: string }>,
    summary: undefined as Plugin | undefined,
    repeatCursor: false,
    incomplete: false,
  };
  const calls: Array<{ method: string; params: unknown }> = [];
  const notifications = new Map<string, (input: unknown) => Effect.Effect<void>>();
  const client = {
    request: (method: string, params: unknown) =>
      Effect.suspend<unknown, { readonly message: string }, never>(() => {
        calls.push({ method, params });
        switch (method) {
          case "account/read":
            return Effect.succeed({ account: state.account, requiresOpenaiAuth: true });
          case "plugin/list":
            return Effect.succeed({
              featuredPluginIds: ["featured", "notion"],
              marketplaces: [{ name: "remote", plugins: state.plugins }],
              marketplaceLoadErrors: state.incomplete
                ? [{ marketplacePath: "/bad", message: "bad" }]
                : [],
            });
          case "plugin/installed":
            return Effect.succeed({
              marketplaces: [
                {
                  name: "remote",
                  plugins: [...state.plugins, ...state.localPlugins]
                    .filter((plugin) => state.installed.has(plugin.id))
                    .map((plugin) => ({ ...plugin, installed: true })),
                },
              ],
            });
          case "plugin/read":
            return Effect.succeed({
              plugin: {
                summary: state.summary,
                apps: [{ id: "app", name: "Sample", installUrl: state.app.installUrl }],
                skills: state.skills,
                mcpServers: ["sample"],
                hooks: [],
              },
            });
          case "plugin/skill/read":
            return Effect.succeed({ contents: state.remoteContents });
          case "app/installed":
            return Effect.succeed({
              apps: state.app.isAccessible
                ? [{ id: state.app.id, enabled: state.app.isEnabled, callable: true }]
                : [],
            });
          case "app/read":
            return Effect.succeed({ apps: [state.app], missingAppIds: [] });
          case "plugin/install": {
            return decodeInstall(params).pipe(
              Effect.mapError(() => ({ message: "Invalid install parameters" })),
              Effect.tap(({ pluginName }) => Effect.sync(() => state.installed.add(pluginName))),
              Effect.as({
                authPolicy: "ON_INSTALL",
                appsNeedingAuth: [{ id: "app", name: "Sample", installUrl: state.app.installUrl }],
              }),
            );
          }
          default:
            return Effect.fail({ message: `Unexpected ${method}` });
        }
      }),
    handleServerNotification: (method: string, handler: (input: unknown) => Effect.Effect<void>) =>
      Effect.sync(() => {
        notifications.set(method, handler);
      }),
  } as unknown as CodexClient.CodexAppServerClient["Service"];
  const notify = (method: string, input: unknown) =>
    Effect.suspend(() => notifications.get(method)?.(input) ?? Effect.undefined);
  return { client, calls, state, notify };
}
describe("Codex provider store", () => {
  it.effect("carries store categories and filters before pagination with subject overrides", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const research = plugin("zotero", {
          interface: { ...plugin("zotero").interface!, category: "Education & Research" },
        });
        const data = plugin("warehouse", {
          interface: { ...plugin("warehouse").interface!, category: "Data & Analytics" },
        });
        const fixture = clientFixture([research, data]);
        const store = yield* makeCodexProviderStore(() => Effect.succeed(fixture.client));
        const page = yield* store.search({ category: "data", limit: 1 });
        expect(page.total).toBe(1);
        expect(page.entries[0]).toMatchObject({ name: "warehouse", category: "Data & Analytics" });
        expect(
          (yield* store.search({ category: "writing" })).entries.map((entry) => entry.name),
        ).toEqual(["zotero"]);
      }),
    ),
  );

  it.effect("resolves curated cross-store names to a unique canonical plugin id", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = clientFixture([plugin("notion@curated", { name: "notion" })]);
        const store = yield* makeCodexProviderStore(() => Effect.succeed(fixture.client));
        expect((yield* store.entry("notion")).id).toBe("notion@curated");
      }),
    ),
  );

  it.effect(
    "installs from the displayed catalog without a second forced refresh and preserves provider errors",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = clientFixture([plugin("latex")]);
          const original = fixture.client.request;
          let failInstall = false;
          const client = {
            ...fixture.client,
            request: ((method: string, params: unknown) =>
              method === "plugin/install" && failInstall
                ? Effect.fail({ message: "The plugin download was rejected" })
                : original(
                    method as Parameters<typeof original>[0],
                    params as never,
                  )) as typeof original,
          };
          const store = yield* makeCodexProviderStore(() => Effect.succeed(client));
          yield* store.entry("latex");
          yield* store.install("latex");
          expect((yield* store.entry("latex")).installed).toBe(true);
          expect(fixture.calls.filter((call) => call.method === "plugin/list")).toHaveLength(1);
          failInstall = true;
          expect((yield* store.install("latex").pipe(Effect.flip)).message).toBe(
            "The plugin download was rejected",
          );
        }),
      ),
  );

  it.effect("prefers bundled brands in store details and app contents, with runtime fallback", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = clientFixture([plugin("slack"), plugin("unknown-service")]);
        fixture.state.app.name = "Slack";
        const fetched: string[] = [];
        const runtimeIcon = "data:image/png;base64,cnVudGltZQ==";
        const store = yield* makeCodexProviderStore(
          () => Effect.succeed(fixture.client),
          (url) =>
            Effect.sync(() => {
              if (url) fetched.push(url);
              return runtimeIcon;
            }),
        );
        expect((yield* store.entry("slack")).iconUrl).toBe(resolveBrandIcon("Slack"));
        expect((yield* store.entry("unknown-service")).iconUrl).toBe(runtimeIcon);
        expect(fetched).toEqual(["https://files.openai.com/unknown-service"]);
        const contents = yield* store.contents("slack");
        expect(contents.apps[0]?.iconUrl).toBe(resolveBrandIcon("Slack"));
      }),
    ),
  );

  it.effect(
    "keeps a large catalog server-side, fetches only visible icons, and refreshes on TTL or request",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = clientFixture([
            plugin("featured"),
            plugin("notion"),
            plugin("installed"),
            ...Array.from({ length: 8112 }, (_, i) => plugin(`item-${i}`)),
          ]);
          fixture.state.installed.add("installed");
          const icons: string[] = [];
          const store = yield* makeCodexProviderStore(
            () => Effect.succeed(fixture.client),
            (url) =>
              Effect.sync(() => {
                if (url) icons.push(url);
                return undefined;
              }),
          );
          const preview = yield* store.search({ preview: true });
          expect(preview.entries.map((entry) => entry.id)).toEqual(["featured", "notion"]);
          expect(icons).toEqual(["https://files.openai.com/featured"]);
          expect(preview.entries.find((entry) => entry.id === "notion")?.iconUrl).toBe(
            resolveBrandIcon("Notion"),
          );
          const page = yield* store.search({ limit: 5 });
          expect(page.entries).toHaveLength(5);
          expect(page.total).toBe(8115);
          expect(page.nextCursor).toBe("5");
          expect(encode(page).length).toBeLessThan(20_000);
          expect(encode(page)).not.toContain("https://files.openai.com");
          expect(fixture.calls.filter((call) => call.method === "plugin/list")).toHaveLength(1);
          yield* store.search({ query: "item-8000", limit: 5, preview: true });
          expect(icons.at(-1)).toBe("https://files.openai.com/item-8000");
          yield* TestClock.adjust("1 hour");
          yield* store.search({ limit: 1 });
          expect(fixture.calls.filter((call) => call.method === "plugin/list")).toHaveLength(2);
          yield* store.search({ refresh: true, limit: 1 });
          expect(fixture.calls.filter((call) => call.method === "plugin/list")).toHaveLength(3);
        }),
      ),
  );
  it.effect(
    "installs by the owner's marketplace and re-reads app connection state on notifications",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fixture = clientFixture([plugin("sample")]);
          const store = yield* makeCodexProviderStore(
            () => Effect.succeed(fixture.client),
            () => Effect.undefined,
          );
          expect((yield* store.entry("sample")).installed).toBe(false);
          const installed = yield* store.install("sample");
          expect(installed).toMatchObject({
            authPolicy: "ON_INSTALL",
            appsNeedingAuth: [{ name: "Sample", installUrl: fixture.state.app.installUrl }],
          });
          expect(fixture.calls.find((call) => call.method === "plugin/install")?.params).toEqual({
            pluginName: "sample",
            remoteMarketplaceName: "remote",
          });
          expect((yield* store.entry("sample")).apps).toEqual([
            {
              id: "app",
              name: "Sample",
              connected: false,
              enabled: true,
              installUrl: fixture.state.app.installUrl,
            },
          ]);
          const announced = yield* store.changes.pipe(
            Stream.take(1),
            Stream.runDrain,
            Effect.forkChild({ startImmediately: true }),
          );
          fixture.state.app.isAccessible = true;
          yield* fixture.notify("app/list/updated", { data: [fixture.state.app] });
          yield* Fiber.join(announced);
          const entry = yield* store.entry("sample");
          expect(entry.apps[0]?.connected).toBe(true);
          expect(entry.includes).toEqual(["Skill: search", "MCP server: sample"]);
          expect(fixture.calls.some((call) => call.method === "app/list")).toBe(false);
          expect(
            fixture.calls
              .filter((call) => call.method === "app/read")
              .every(
                (call) =>
                  JSON.stringify(call.params) ===
                  JSON.stringify({ appIds: ["app"], includeTools: false }),
              ),
          ).toBe(true);
        }),
      ),
  );
  it.effect("drops account-specific caches and rejects partial stores without paging apps", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = clientFixture([plugin("sample")]);
        const store = yield* makeCodexProviderStore(
          () => Effect.succeed(fixture.client),
          () => Effect.undefined,
        );
        yield* store.search({});
        fixture.state.account = { type: "apiKey" };
        expect(yield* store.search({})).toMatchObject({
          entries: [],
          message: expect.stringContaining("ChatGPT"),
        });
        fixture.state.account = { type: "chatgpt", email: "other@example.com", planType: "plus" };
        fixture.state.incomplete = true;
        expect((yield* store.search({}).pipe(Effect.result))._tag).toBe("Failure");
        fixture.state.incomplete = false;
        yield* store.entry("sample");
        expect(fixture.calls.some((call) => call.method === "app/list")).toBe(false);
      }),
    ),
  );
  it.effect(
    "never submits a policy-disabled install and closes the child lease with its scope",
    () =>
      Effect.gen(function* () {
        const fixture = clientFixture([plugin("sample", { availability: "DISABLED_BY_ADMIN" })]);
        let live = 0;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const store = yield* makeCodexProviderStore(
              () =>
                Effect.acquireRelease(
                  Effect.sync(() => {
                    live++;
                    return fixture.client;
                  }),
                  () =>
                    Effect.sync(() => {
                      live--;
                    }),
                ),
              () => Effect.undefined,
            );
            expect((yield* store.install("sample").pipe(Effect.result))._tag).toBe("Failure");
            expect(fixture.calls.some((call) => call.method === "plugin/install")).toBe(false);
          }),
        );
        expect(live).toBe(0);
      }),
  );
  it("honors policy and plan restrictions and accepts only the provider's app sign-in pages", () => {
    expect(
      codexStoreDisabledReason(plugin("x", { installPolicy: "NOT_AVAILABLE" }), "plus"),
    ).toContain("Not available");
    expect(
      codexStoreDisabledReason(plugin("x", { eligiblePlanTypes: ["enterprise"] }), "plus"),
    ).toBe("Requires enterprise");
    expect(codexAppInstallUrl("https://chatgpt.com/apps/sample/app")).toBe(
      "https://chatgpt.com/apps/sample/app",
    );
    expect(
      [
        "http://chatgpt.com/apps/x",
        "https://elsewhere.com/apps/x",
        "https://chatgpt.com/login",
      ].map(codexAppInstallUrl),
    ).toEqual([undefined, undefined, undefined]);
  });
});

it.effect("refreshes installed app summaries without reloading or publishing the full store", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = clientFixture([plugin("sample"), plugin("uninstalled")]);
      fixture.state.installed.add("sample");
      fixture.state.app.isAccessible = true;
      fixture.state.app.pluginDisplayNames = [];
      const inventory = yield* makeCodexNativeInventory(() => Effect.succeed(fixture.client));
      yield* inventory.actions.refreshInventory!({ force: true, connectionsOnly: true });
      const report = yield* inventory.reports.pipe(Stream.runHead);
      expect(report._tag).toBe("Some");
      if (report._tag === "Some") {
        expect(report.value.plugins).toMatchObject([
          { id: "sample", apps: [{ name: "Sample", connected: true }] },
        ]);
        expect(encode(report.value).length).toBeLessThan(5000);
      }
      expect(fixture.calls.some((call) => call.method === "plugin/list")).toBe(false);
      expect(
        fixture.calls.filter((call) => call.method === "app/installed").at(-1)?.params,
      ).toEqual({ forceRefresh: true });
    }),
  ),
);

it.effect(
  "reads cached skills for installed plugins absent from the marketplace and rejects foreign paths",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cache = yield* Effect.acquireRelease(
          Effect.promise(() =>
            NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-codex-contents-")),
          ),
          (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
        );
        const root = NodePath.join(cache, "plugin");
        const directory = NodePath.join(root, "skills", "search");
        const path = NodePath.join(directory, "SKILL.md");
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(directory, { recursive: true });
          await NodeFSP.writeFile(path, "---\nname: search\n---\n# Search locally");
          await NodeFSP.writeFile(
            NodePath.join(root, "mcp.json"),
            JSON.stringify({
              mcpServers: {
                sample: { headers: { Authorization: "Bearer ${SYNTHETIC_KEY}" } },
              },
            }),
          );
        });
        const fixture = clientFixture([]);
        fixture.state.localPlugins = [plugin("local")];
        fixture.state.installed.add("local");
        fixture.state.summary = plugin("local", { source: { type: "local", path: root } });
        fixture.state.skills = [{ name: "search", path, description: "Search locally" }];
        const store = yield* makeCodexProviderStore(
          () => Effect.succeed(fixture.client),
          () => Effect.undefined,
          cache,
        );
        expect((yield* store.contents("local")).requiredKeys).toEqual(["SYNTHETIC_KEY"]);
        expect((yield* store.contents("local")).skills).toMatchObject([
          { name: "search", documentAvailable: true, enabled: true },
        ]);
        expect(yield* store.skillDocument("local", "search")).toEqual({
          instructions: "# Search locally",
        });
        yield* store.contents("local");
        expect(fixture.calls.filter((call) => call.method === "plugin/read")).toHaveLength(1);
        expect(fixture.calls.some((call) => call.method === "plugin/list")).toBe(false);
        expect(fixture.calls.filter((call) => call.method === "plugin/installed")).toHaveLength(1);

        fixture.state.summary = plugin("local", { source: { type: "remote" } });
        fixture.state.localPlugins = [plugin("local", { version: "cached-remote" })];
        yield* store.search({ refresh: true });
        expect((yield* store.contents("local")).requiredKeys).toEqual(["SYNTHETIC_KEY"]);
        expect(yield* store.keyServerRoot("local")).toBe(
          yield* Effect.promise(() => NodeFSP.realpath(root)),
        );

        fixture.state.skills = [
          { name: "search", path: NodePath.join(NodeOS.tmpdir(), "outside/SKILL.md") },
        ];
        fixture.state.localPlugins = [plugin("local", { version: "2" })];
        yield* store.search({ refresh: true });
        expect((yield* store.contents("local")).skills[0]?.documentAvailable).toBe(false);
        expect((yield* store.skillDocument("local", "search").pipe(Effect.result))._tag).toBe(
          "Failure",
        );
      }),
    ),
);

it.effect(
  "does not queue skill contents behind store icon downloads and coalesces plugin reads",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = clientFixture([plugin("sample")]);
        fixture.state.installed.add("sample");
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let openings = 0;
        const store = yield* makeCodexProviderStore(
          () =>
            Effect.sync(() => {
              openings++;
              return fixture.client;
            }),
          (url) =>
            url
              ? Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.as(undefined),
                )
              : Effect.undefined,
        );
        const page = yield* store
          .search({ limit: 1 })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(started);
        const reading = yield* Effect.all([store.contents("sample"), store.contents("sample")], {
          concurrency: "unbounded",
        }).pipe(Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust(0);
        const completedBeforeIcons = reading.pollUnsafe();
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(page);
        expect(completedBeforeIcons?._tag).toBe("Success");
        const [first, second] = yield* Fiber.join(reading);
        expect(first.skills).toEqual(second.skills);
        expect(first.mcpServers).toEqual([{ name: "sample" }]);
        expect(openings).toBe(1);
        expect(fixture.calls.filter((call) => call.method === "plugin/read")).toHaveLength(1);
      }),
    ),
);

it.effect("lets a slow first store request finish instead of timing it out at 15 seconds", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = clientFixture([plugin("sample")]);
      fixture.state.installed.add("sample");
      const release = yield* Deferred.make<void>();
      const base = fixture.client;
      const request = base.request as (
        method: string,
        params: unknown,
      ) => Effect.Effect<unknown, { readonly message: string }>;
      const client = {
        ...base,
        request: (method: string, params: unknown) =>
          method === "account/read"
            ? Deferred.await(release).pipe(Effect.andThen(request(method, params)))
            : request(method, params),
      } as typeof base;
      const store = yield* makeCodexProviderStore(
        () => Effect.succeed(client),
        () => Effect.undefined,
      );
      const reading = yield* store
        .contents("sample")
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust("20 seconds");
      expect(reading.pollUnsafe()).toBeUndefined();
      yield* Deferred.succeed(release, undefined);
      expect((yield* Fiber.join(reading)).skills).toHaveLength(1);
    }),
  ),
);

it.effect("keeps the shared client when one operation fails while another is in flight", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = clientFixture([plugin("sample")]);
      fixture.state.installed.add("sample");
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let openings = 0;
      let live = 0;
      const store = yield* makeCodexProviderStore(
        () =>
          Effect.acquireRelease(
            Effect.sync(() => {
              openings++;
              live++;
              return fixture.client;
            }),
            () =>
              Effect.sync(() => {
                live--;
              }),
          ),
        (url) =>
          url
            ? Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.as(undefined),
              )
            : Effect.undefined,
      );
      const page = yield* store
        .search({ limit: 1 })
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(started);
      expect((yield* store.entry("missing").pipe(Effect.result))._tag).toBe("Failure");
      expect(live).toBe(1);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(page);
      expect((yield* store.contents("sample")).skills).toHaveLength(1);
      expect(openings).toBe(1);
    }),
  ),
);

it.effect(
  "reads uninstalled remote skills, strips front matter, bounds bytes and preserves app tool metadata",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = clientFixture([
          plugin("notion@remote", { remotePluginId: "remote-notion" }),
        ]);
        const store = yield* makeCodexProviderStore(
          () => Effect.succeed(fixture.client),
          () => Effect.undefined,
        );
        const contents = yield* store.contents("notion@remote");
        expect(contents.skills[0]).toMatchObject({ documentAvailable: true, enabled: false });
        expect(contents.apps[0]?.toolSummaries).toEqual(fixture.state.app.toolSummaries);
        expect(contents.apps[0]?.toolCounts).toEqual({ read: 1, write: 1 });
        expect(fixture.calls.find((call) => call.method === "app/read")?.params).toMatchObject({
          includeTools: true,
        });
        expect(yield* store.skillDocument("notion@remote", "search")).toEqual({
          instructions: "# Remote instructions",
        });
        expect(fixture.calls.find((call) => call.method === "plugin/skill/read")?.params).toEqual({
          remoteMarketplaceName: "remote",
          remotePluginId: "remote-notion",
          skillName: "search",
        });
        const reads = fixture.calls.length;
        yield* TestClock.adjust("61 minutes");
        expect(yield* store.skillDocument("notion@remote", "search")).toEqual({
          instructions: "# Remote instructions",
        });
        expect(fixture.calls).toHaveLength(reads);
        fixture.state.plugins = [
          plugin("notion@remote", { remotePluginId: "remote-notion", version: "2" }),
        ];
        yield* store.search({ refresh: true });
        fixture.state.remoteContents = "# Updated version";
        expect(yield* store.skillDocument("notion@remote", "search")).toEqual({
          instructions: "# Updated version",
        });
        expect(fixture.calls.filter((call) => call.method === "plugin/read")).toHaveLength(2);
        yield* fixture.notify("account/updated", {});
        fixture.state.remoteContents = "é".repeat(128 * 1024 + 1);
        expect(
          (yield* store.skillDocument("notion@remote", "search").pipe(Effect.result))._tag,
        ).toBe("Failure");
        fixture.state.remoteContents = null;
        expect(
          (yield* store.skillDocument("notion@remote", "search").pipe(Effect.result))._tag,
        ).toBe("Failure");
      }),
    ),
);
