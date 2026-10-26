import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type * as CodexClient from "effect-codex-app-server/client";
import type * as CodexSchema from "effect-codex-app-server/schema";
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
    },
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
                  plugins: state.plugins
                    .filter((plugin) => state.installed.has(plugin.id))
                    .map((plugin) => ({ ...plugin, installed: true })),
                },
              ],
            });
          case "plugin/read":
            return Effect.succeed({
              plugin: {
                apps: [{ id: "app", name: "Sample", installUrl: state.app.installUrl }],
                skills: [{ name: "search" }],
                mcpServers: ["sample"],
                hooks: [],
              },
            });
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
    Effect.suspend(() => notifications.get(method)?.(input) ?? Effect.void);
  return { client, calls, state, notify };
}
describe("Codex provider store", () => {
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
          expect(preview.entries.map((entry) => entry.id)).toEqual(["featured", "installed"]);
          expect(icons).toHaveLength(2);
          const page = yield* store.search({ limit: 5 });
          expect(page.entries).toHaveLength(5);
          expect(page.total).toBe(8115);
          expect(page.nextCursor).toBe("5");
          expect(encode(page).length).toBeLessThan(5000);
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
            () => Effect.succeed(undefined),
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
              .every((call) => JSON.stringify(call.params) === JSON.stringify({ appIds: ["app"] })),
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
          () => Effect.succeed(undefined),
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
              () => Effect.succeed(undefined),
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
    }),
  ),
);
