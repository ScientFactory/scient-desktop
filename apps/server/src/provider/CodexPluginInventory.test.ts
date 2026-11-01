// @effect-diagnostics nodeBuiltinImport:off -- synthetic plugin folders only.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type * as CodexClient from "effect-codex-app-server/client";
import type * as CodexSchema from "effect-codex-app-server/schema";

import {
  CODEX_WORKSPACE_LISTING_CONCURRENCY,
  CodexInventoryIncomplete,
  codexInstalledPluginRoots,
  makeCodexNativeInventory,
  optionalCodexInventory,
  parseCodexInstalledPlugins,
  parseCodexMcpServers,
  requestCodexInstalledPlugins,
  requestCodexMcpServers,
} from "./CodexPluginInventory.ts";
import type { ProviderNativeInventory } from "./ScientProviderInstanceSeams.ts";

type PluginSummary = CodexSchema.V2PluginInstalledResponse__PluginSummary;
type McpServerStatus = CodexSchema.V2ListMcpServerStatusResponse__McpServerStatus;

const summary = (overrides: Partial<PluginSummary> & Pick<PluginSummary, "id" | "name">) =>
  ({
    authPolicy: "ON_USE",
    enabled: true,
    installPolicy: "AVAILABLE",
    installed: true,
    source: { type: "local", path: "/plugins/x" },
    ...overrides,
  }) satisfies PluginSummary;

const mcpStatus = (overrides: Partial<McpServerStatus> & Pick<McpServerStatus, "name">) =>
  ({
    authStatus: "unsupported",
    resourceTemplates: [],
    resources: [],
    tools: {},
    ...overrides,
  }) satisfies McpServerStatus;

const tool = {
  name: "t",
  inputSchema: {},
} as unknown as CodexSchema.V2ListMcpServerStatusResponse__Tool;

/**
 * A client that answers each method from a script and records every request.
 * A handler may return an Effect to answer late, or never.
 */
function scriptedClient(handlers: Record<string, (params: unknown) => unknown>) {
  const requests: Array<{ readonly method: string; readonly params: unknown }> = [];
  const notificationHandlers = new Map<string, (payload: unknown) => Effect.Effect<void>>();
  const client = {
    request: (method: string, params: unknown) =>
      Effect.suspend(() => {
        requests.push({ method, params });
        const handler = handlers[method];
        if (!handler) return Effect.fail({ _tag: "UnexpectedRequest" as const, method });
        const answer = handler(params);
        // Scripted answers run without services and fail only with tagged test errors.
        const lateAnswer = answer as Effect.Effect<unknown, { readonly _tag: string }>;
        return Effect.isEffect(answer) ? lateAnswer : Effect.succeed(answer);
      }),
    handleServerNotification: (
      method: string,
      handler: (payload: unknown) => Effect.Effect<void>,
    ) => Effect.sync(() => void notificationHandlers.set(method, handler)),
  } as unknown as CodexClient.CodexAppServerClient["Service"];
  const notify = (method: string, payload: unknown) =>
    Effect.suspend(() => notificationHandlers.get(method)?.(payload) ?? Effect.void);
  return { client, requests, notify };
}

describe("parseCodexInstalledPlugins", () => {
  it("maps installed plugins and allows uninstall only for local and remote sources", () => {
    const plugins = parseCodexInstalledPlugins({
      marketplaceLoadErrors: [{ marketplacePath: "/broken", message: "bad manifest" }],
      marketplaces: [
        {
          name: "openai-curated",
          interface: { displayName: "OpenAI Curated" },
          plugins: [
            summary({
              id: "linear@openai-curated",
              name: "linear",
              interface: {
                capabilities: [],
                screenshotUrls: [],
                screenshots: [],
                displayName: " Linear ",
                shortDescription: "Issues",
              },
              localVersion: "1.2.0",
              source: { type: "remote" },
            }),
            summary({
              id: "gitplug@openai-curated",
              name: "gitplug",
              enabled: false,
              source: { type: "git", url: "https://example.com/p.git" },
            }),
            summary({ id: "absent@openai-curated", name: "absent", installed: false }),
          ],
        },
        {
          name: "local",
          plugins: [
            summary({ id: "mine@local", name: "mine", version: "  " }),
            // The same plugin reported by a second marketplace entry is listed once.
            summary({ id: "linear@openai-curated", name: "linear" }),
            summary({ id: "  ", name: "blank-id" }),
          ],
        },
      ],
    });

    assert.deepStrictEqual(plugins, [
      {
        id: "linear@openai-curated",
        name: "linear",
        displayName: "Linear",
        description: "Issues",
        version: "1.2.0",
        marketplace: "OpenAI Curated",
        source: "remote",
        enabled: true,
        canUninstall: true,
      },
      {
        id: "gitplug@openai-curated",
        name: "gitplug",
        displayName: "Gitplug",
        marketplace: "OpenAI Curated",
        source: "remote",
        enabled: false,
        canUninstall: false,
      },
      {
        id: "mine@local",
        name: "mine",
        displayName: "Mine",
        marketplace: "local",
        source: "local",
        enabled: true,
        canUninstall: true,
      },
    ]);
  });

  it("keeps default-installed and admin-disabled plugins read-only", () => {
    const plugins = parseCodexInstalledPlugins({
      marketplaces: [
        {
          name: "openai-bundled",
          plugins: [
            summary({
              id: "browser@bundled",
              name: "browser",
              installPolicy: "INSTALLED_BY_DEFAULT",
            }),
            summary({ id: "locked@bundled", name: "locked", availability: "DISABLED_BY_ADMIN" }),
            summary({ id: "chosen@bundled", name: "chosen" }),
          ],
        },
      ],
    });

    assert.deepStrictEqual(
      plugins.map((plugin) => [plugin.id, plugin.canUninstall]),
      [
        ["browser@bundled", false],
        ["locked@bundled", false],
        ["chosen@bundled", true],
      ],
    );
  });

  it.effect("treats a marketplace that failed to load as an incomplete listing", () =>
    Effect.gen(function* () {
      const { client, requests } = scriptedClient({
        "plugin/installed": () => ({
          marketplaceLoadErrors: [{ marketplacePath: "/repo/.codex", message: "invalid json" }],
          marketplaces: [{ name: "home", plugins: [summary({ id: "a@home", name: "a" })] }],
        }),
      });
      const error = yield* requestCodexInstalledPlugins(client, ["/repo"]).pipe(Effect.flip);
      assert.instanceOf(error, CodexInventoryIncomplete);
      assert.include(error.message, "/repo/.codex (invalid json)");
      assert.deepStrictEqual(requests, [
        { method: "plugin/installed", params: { cwds: ["/repo"] } },
      ]);
    }),
  );

  it.effect("treats every marketplace failing as incomplete, never as an empty list", () =>
    Effect.gen(function* () {
      const { client } = scriptedClient({
        "plugin/installed": () => ({
          marketplaceLoadErrors: [
            { marketplacePath: "/a", message: "x" },
            { marketplacePath: "/b", message: "y" },
          ],
          marketplaces: [],
        }),
      });
      assert.strictEqual(
        yield* optionalCodexInventory("plugin listing", requestCodexInstalledPlugins(client)),
        undefined,
      );
    }),
  );
});

describe("parseCodexMcpServers", () => {
  it("maps auth and runtime state onto provider MCP server status", () => {
    const servers = parseCodexMcpServers([
      mcpStatus({ name: "notion", authStatus: "notLoggedIn", pluginId: "notion@curated" }),
      mcpStatus({ name: "expired", authStatus: "oAuth", runtimeStatus: "authenticationRequired" }),
      mcpStatus({
        name: "token",
        authStatus: "bearerToken",
        runtimeStatus: "authenticationRequired",
      }),
      mcpStatus({ name: "live", tools: { a: tool, b: tool } }),
      mcpStatus({ name: "broken", toolsError: "spawn ENOENT" }),
      mcpStatus({ name: "off", runtimeStatus: "disabled" }),
      mcpStatus({ name: "idle" }),
      mcpStatus({ name: "live" }),
    ]);

    assert.deepStrictEqual(servers, [
      { name: "notion", status: "needs-auth", pluginId: "notion@curated", canStartSignIn: true },
      { name: "expired", status: "needs-auth", canStartSignIn: true },
      { name: "token", status: "needs-auth" },
      { name: "live", status: "connected", toolCount: 2 },
      { name: "broken", status: "failed", error: "spawn ENOENT" },
      { name: "off", status: "disabled" },
      { name: "idle", status: "unknown" },
    ]);
  });

  it.effect("follows the cursor and treats a walk cut at the page bound as incomplete", () =>
    Effect.gen(function* () {
      let page = 0;
      const { client, requests } = scriptedClient({
        "mcpServerStatus/list": () => {
          page += 1;
          return { data: [mcpStatus({ name: `s${page}` })], nextCursor: `c${page}` };
        },
      });
      const error = yield* requestCodexMcpServers(client).pipe(Effect.flip);
      assert.instanceOf(error, CodexInventoryIncomplete);
      assert.strictEqual(requests.length, 10);
      assert.deepStrictEqual(requests[0], {
        method: "mcpServerStatus/list",
        params: { detail: "toolsAndAuthOnly", limit: 100 },
      });
      assert.deepStrictEqual(requests[1]?.params, {
        detail: "toolsAndAuthOnly",
        limit: 100,
        cursor: "c1",
      });
    }),
  );

  it.effect("ends at the last page", () =>
    Effect.gen(function* () {
      const { client, requests } = scriptedClient({
        "mcpServerStatus/list": (params) =>
          typeof params === "object" && params !== null && "cursor" in params
            ? { data: [mcpStatus({ name: "b" })], nextCursor: null }
            : { data: [mcpStatus({ name: "a" })], nextCursor: "next" },
      });
      const servers = yield* requestCodexMcpServers(client);
      assert.deepStrictEqual(
        servers.map((server) => server.name),
        ["a", "b"],
      );
      assert.strictEqual(requests.length, 2);
    }),
  );
});

describe("optionalCodexInventory", () => {
  it.effect("turns a failed listing into undefined instead of failing the probe", () =>
    Effect.gen(function* () {
      const { client } = scriptedClient({});
      const result = yield* optionalCodexInventory("MCP", requestCodexMcpServers(client));
      assert.strictEqual(result, undefined);
    }),
  );
});

describe("makeCodexNativeInventory workspace listing", () => {
  const homePlugin = {
    marketplaces: [{ name: "home", plugins: [summary({ id: "a@home", name: "a" })] }],
  };

  it.effect("publishes a workspace's plugins when the listing answers after its scan", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const listingGate = yield* Deferred.make<void>();
        const { client, requests } = scriptedClient({
          "plugin/installed": () => Deferred.await(listingGate).pipe(Effect.as(homePlugin)),
        });
        const opened: Array<string | undefined> = [];
        const inventory = yield* makeCodexNativeInventory((cwd) =>
          Effect.sync(() => {
            opened.push(cwd);
            return client;
          }),
        );
        const report = yield* Deferred.make<ProviderNativeInventory>();
        const publishing = yield* Deferred.make<void>();
        const publishedGate = yield* Deferred.make<void>();
        // Starting the listing returns at once; the scan is not held up.
        yield* inventory.workspace.refresh("/repo", (value) =>
          Deferred.succeed(publishing, undefined).pipe(
            Effect.andThen(Deferred.await(publishedGate)),
            Effect.andThen(Deferred.succeed(report, value)),
            Effect.asVoid,
          ),
        );
        yield* Deferred.succeed(listingGate, undefined);
        yield* Deferred.await(publishing);
        const completed = yield* Deferred.make<void>();
        const waiting = yield* inventory.workspace
          .awaitCurrent("/repo")
          .pipe(
            Effect.andThen(Deferred.succeed(completed, undefined)),
            Effect.forkChild({ startImmediately: true }),
          );
        assert.isFalse(yield* Deferred.isDone(completed));
        yield* Fiber.interrupt(waiting);
        const nextWaiter = yield* inventory.workspace
          .awaitCurrent("/repo")
          .pipe(Effect.forkChild({ startImmediately: true }));
        assert.isUndefined(nextWaiter.pollUnsafe());
        yield* Deferred.succeed(publishedGate, undefined);
        yield* Fiber.join(nextWaiter);
        const { sequence, ...published } = yield* Deferred.await(report);
        assert.isNumber(sequence);
        assert.deepStrictEqual(published, {
          cwd: "/repo",
          plugins: [
            {
              id: "a@home",
              name: "a",
              displayName: "A",
              marketplace: "home",
              source: "local",
              enabled: true,
              canUninstall: true,
            },
          ],
        });
        assert.deepStrictEqual(opened, ["/repo"]);
        assert.deepStrictEqual(requests[0]?.params, { cwds: ["/repo"] });
      }),
    ),
  );

  it.effect("stops a workspace listing when a newer scan of that workspace starts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const interrupted = yield* Ref.make(0);
        const { client } = scriptedClient({
          "plugin/installed": () =>
            Effect.never.pipe(Effect.onInterrupt(() => Ref.update(interrupted, (n) => n + 1))),
        });
        const inventory = yield* makeCodexNativeInventory(() => Effect.succeed(client));
        yield* inventory.workspace.refresh("/repo", () => Effect.void);
        yield* Effect.yieldNow;
        yield* inventory.workspace.cancel("/repo");
        assert.strictEqual(yield* Ref.get(interrupted), 1);
        // A newer listing replaces a running one; other workspaces are untouched.
        yield* inventory.workspace.refresh("/repo", () => Effect.void);
        yield* inventory.workspace.refresh("/other", () => Effect.void);
        yield* Effect.yieldNow;
        yield* inventory.workspace.refresh("/repo", () => Effect.void);
        assert.strictEqual(yield* Ref.get(interrupted), 2);
      }),
    ),
  );

  it.effect("publishes nothing for an incomplete or failed workspace listing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client } = scriptedClient({
          "plugin/installed": () => ({
            marketplaceLoadErrors: [{ marketplacePath: "/m", message: "offline" }],
            marketplaces: [],
          }),
        });
        const inventory = yield* makeCodexNativeInventory(() => Effect.succeed(client));
        const reports: ProviderNativeInventory[] = [];
        yield* inventory.workspace.refresh("/repo", (report) =>
          Effect.sync(() => {
            reports.push(report);
          }),
        );
        yield* inventory.workspace.awaitCurrent("/repo");
        assert.deepStrictEqual(reports, []);
      }),
    ),
  );
});

describe("makeCodexNativeInventory listing bounds and order", () => {
  it.effect("runs at most two workspace listings at once and cancels waiting ones", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const live = yield* Ref.make({ now: 0, peak: 0 });
        const opened: Array<string | undefined> = [];
        const { client } = scriptedClient({ "plugin/installed": () => Effect.never });
        const inventory = yield* makeCodexNativeInventory((cwd) =>
          Effect.acquireRelease(
            Effect.sync(() => void opened.push(cwd)).pipe(
              Effect.andThen(
                Ref.update(live, ({ now, peak }) => ({
                  now: now + 1,
                  peak: Math.max(peak, now + 1),
                })),
              ),
            ),
            () => Ref.update(live, ({ now, peak }) => ({ now: now - 1, peak })),
          ).pipe(Effect.as(client)),
        );
        const workspaces = Array.from({ length: 20 }, (_, index) => `/repo-${index}`);
        for (const cwd of workspaces) yield* inventory.workspace.refresh(cwd, () => Effect.void);
        for (let attempt = 0; attempt < 200; attempt++) yield* Effect.yieldNow;
        assert.strictEqual((yield* Ref.get(live)).peak, CODEX_WORKSPACE_LISTING_CONCURRENCY);

        // Stopping every listing at once stops the running and waiting ones;
        // none of the waiting ones starts afterwards.
        yield* inventory.workspace.retain(Effect.succeed(new Set()));
        for (let attempt = 0; attempt < 200; attempt++) yield* Effect.yieldNow;
        assert.strictEqual((yield* Ref.get(live)).now, 0);
        assert.strictEqual(opened.length, CODEX_WORKSPACE_LISTING_CONCURRENCY);
      }),
    ),
  );

  it.effect(
    "publishes each machine field as soon as it is listed, ordered by when the read began",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const mcpGate = yield* Deferred.make<void>();
          const { client } = scriptedClient({
            "plugin/installed": () => ({
              marketplaces: [{ name: "home", plugins: [summary({ id: "a@home", name: "a" })] }],
            }),
            "mcpServerStatus/list": () =>
              Deferred.await(mcpGate).pipe(Effect.as({ data: [mcpStatus({ name: "notion" })] })),
          });
          const inventory = yield* makeCodexNativeInventory(() => Effect.succeed(client));
          const reports = yield* inventory.reports.pipe(
            Stream.take(2),
            Stream.runCollect,
            Effect.forkChild,
          );
          const refresh = yield* inventory.refresh.pipe(Effect.forkChild);
          for (let attempt = 0; attempt < 50; attempt++) yield* Effect.yieldNow;
          yield* Deferred.succeed(mcpGate, undefined);
          yield* Fiber.join(refresh);
          const [plugins, mcpServers] = yield* Fiber.join(reports);
          assert.deepStrictEqual(
            plugins?.plugins?.map((plugin) => plugin.id),
            ["a@home"],
          );
          assert.strictEqual(plugins?.mcpServers, undefined);
          assert.deepStrictEqual(
            mcpServers?.mcpServers?.map((server) => server.name),
            ["notion"],
          );
          // Both reads began together, before anything else could change them.
          assert.strictEqual(plugins?.sequence, mcpServers?.sequence);
        }),
      ),
  );

  it.effect("stops only the listings of workspaces that are no longer published", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const interrupted: Array<string> = [];
        const inventory = yield* makeCodexNativeInventory((cwd) =>
          Effect.succeed(
            scriptedClient({
              "plugin/installed": () =>
                Effect.never.pipe(
                  Effect.onInterrupt(() => Effect.sync(() => void interrupted.push(cwd ?? ""))),
                ),
            }).client,
          ),
        );
        yield* inventory.workspace.refresh("/a", () => Effect.void);
        yield* inventory.workspace.refresh("/b", () => Effect.void);
        yield* inventory.workspace.refresh("/c", () => Effect.void);
        for (let attempt = 0; attempt < 50; attempt++) yield* Effect.yieldNow;
        // "/c" is still waiting for a permit; it stops without ever asking Codex.
        yield* inventory.workspace.retain(Effect.succeed(new Set(["/a", "/b"])));
        assert.deepStrictEqual(interrupted, []);
        yield* inventory.workspace.retain(Effect.succeed(new Set(["/b"])));
        assert.deepStrictEqual(interrupted, ["/a"]);
        yield* inventory.workspace.retain(Effect.succeed(new Set()));
        assert.deepStrictEqual(interrupted, ["/a", "/b"]);
      }),
    ),
  );

  it.effect(
    "gives a late subscriber the latest value of each machine field, with its read order",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let listings = 0;
          const { client } = scriptedClient({
            // The second listing loses a marketplace, so only the first one counts.
            "plugin/installed": () =>
              listings++ === 0
                ? {
                    marketplaces: [
                      { name: "home", plugins: [summary({ id: "a@home", name: "a" })] },
                    ],
                  }
                : {
                    marketplaceLoadErrors: [{ marketplacePath: "/m", message: "offline" }],
                    marketplaces: [],
                  },
            "mcpServerStatus/list": () => ({ data: [mcpStatus({ name: "notion" })] }),
          });
          const inventory = yield* makeCodexNativeInventory(() => Effect.succeed(client));
          yield* inventory.refresh;
          // Both fields finished before anyone subscribed.
          const first = yield* inventory.reports.pipe(Stream.take(2), Stream.runCollect);
          assert.deepStrictEqual(
            first.map((report) => [report.plugins?.length, report.mcpServers?.length]),
            [
              [1, undefined],
              [undefined, 1],
            ],
          );
          assert.strictEqual(first[0]?.sequence, first[1]?.sequence);

          yield* inventory.refresh;
          const [plugins, mcpServers] = yield* inventory.reports.pipe(
            Stream.take(2),
            Stream.runCollect,
          );
          assert.deepStrictEqual(
            plugins?.plugins?.map((plugin) => plugin.id),
            ["a@home"],
          );
          // Each field keeps the order of the read that produced it.
          assert.strictEqual(plugins?.sequence, first[0]?.sequence);
          assert.isAbove(mcpServers?.sequence ?? 0, plugins?.sequence ?? 0);
        }),
      ),
  );

  it.effect(
    "stops every stale listing even when the retaining caller is interrupted mid-teardown",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const teardownStarted = yield* Deferred.make<void>();
          const teardownGate = yield* Deferred.make<void>();
          const opened: Array<string> = [];
          const closed: Array<string> = [];
          const { client } = scriptedClient({ "plugin/installed": () => Effect.never });
          const inventory = yield* makeCodexNativeInventory((cwd) =>
            Effect.acquireRelease(
              Effect.sync(() => void opened.push(cwd ?? "")),
              () =>
                (cwd === "/a"
                  ? Deferred.succeed(teardownStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(teardownGate)),
                    )
                  : Effect.void
                ).pipe(Effect.andThen(Effect.sync(() => void closed.push(cwd ?? "")))),
            ).pipe(Effect.as(client)),
          );
          // "/a" and "/b" run; "/c" and "/d" wait for a permit.
          for (const cwd of ["/a", "/b", "/c", "/d"])
            yield* inventory.workspace.refresh(cwd, () => Effect.void);
          for (let attempt = 0; attempt < 50; attempt++) yield* Effect.yieldNow;
          assert.sameMembers(opened, ["/a", "/b"]);

          const retaining = yield* inventory.workspace
            .retain(Effect.succeed(new Set(["/d"])))
            .pipe(Effect.forkChild);
          yield* Deferred.await(teardownStarted);
          // The caller goes away while "/a" is still shutting down.
          yield* Fiber.interrupt(retaining);
          yield* Deferred.succeed(teardownGate, undefined);
          for (let attempt = 0; attempt < 100; attempt++) yield* Effect.yieldNow;

          // Every stale listing was stopped; the queued stale one never opened a
          // client, and the kept one took a freed permit.
          assert.sameMembers(closed, ["/a", "/b"]);
          assert.sameMembers(opened, ["/a", "/b", "/d"]);
          // Nothing stale is left to find: retaining nothing stops only "/d".
          yield* inventory.workspace.retain(Effect.succeed(new Set()));
          assert.sameMembers(closed, ["/a", "/b", "/d"]);
        }),
      ),
  );

  it.effect(
    "cancels a replacing refresh during its predecessor's teardown without starting it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const teardownStarted = yield* Deferred.make<void>();
          const teardownGate = yield* Deferred.make<void>();
          const opened: Array<string> = [];
          const { client } = scriptedClient({ "plugin/installed": () => Effect.never });
          let firstA = true;
          const inventory = yield* makeCodexNativeInventory((cwd) =>
            Effect.acquireRelease(
              Effect.sync(() => void opened.push(cwd ?? "")),
              () => {
                if (cwd !== "/a" || !firstA) return Effect.void;
                firstA = false;
                return Deferred.succeed(teardownStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(teardownGate)),
                );
              },
            ).pipe(Effect.as(client)),
          );
          yield* inventory.workspace.refresh("/a", () => Effect.void);
          for (let attempt = 0; attempt < 50; attempt++) yield* Effect.yieldNow;
          assert.deepStrictEqual(opened, ["/a"]);

          // A newer scan of "/a" replaces its listing; the old one exits slowly.
          const replacing = yield* inventory.workspace
            .refresh("/a", () => Effect.void)
            .pipe(Effect.forkChild);
          yield* Deferred.await(teardownStarted);
          // Cancelling the replacement completes while teardown is still held.
          yield* Fiber.interrupt(replacing);
          // Other workspaces are not held up behind that teardown.
          yield* inventory.workspace.refresh("/other", () => Effect.void);
          for (let attempt = 0; attempt < 50; attempt++) yield* Effect.yieldNow;
          assert.deepStrictEqual(opened, ["/a", "/other"]);

          yield* Deferred.succeed(teardownGate, undefined);
          for (let attempt = 0; attempt < 100; attempt++) yield* Effect.yieldNow;
          // The cancelled replacement never started a listing of its own.
          assert.deepStrictEqual(opened, ["/a", "/other"]);
        }),
      ),
  );
});

describe("makeCodexNativeInventory", () => {
  const lastReport = (reports: Stream.Stream<ProviderNativeInventory>) =>
    reports.pipe(
      Stream.runHead,
      Effect.map(Option.getOrUndefined),
      Effect.map((report) => {
        if (!report) return undefined;
        const { sequence: _sequence, ...fields } = report;
        return fields;
      }),
    );

  it.effect("publishes only the fields Codex listed completely", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client } = scriptedClient({
          "plugin/installed": () => ({
            marketplaceLoadErrors: [{ marketplacePath: "/m", message: "offline" }],
            marketplaces: [{ name: "home", plugins: [summary({ id: "a@home", name: "a" })] }],
          }),
          "mcpServerStatus/list": () => ({ data: [mcpStatus({ name: "notion" })] }),
        });
        const inventory = yield* makeCodexNativeInventory(() => Effect.succeed(client));
        yield* inventory.refresh;
        // The partial plugin listing is left out, so the last complete list stays.
        assert.deepStrictEqual(yield* lastReport(inventory.reports), {
          mcpServers: [{ name: "notion", status: "unknown" }],
        });
      }),
    ),
  );

  it.effect("bounds an enrichment whose listings never answer, publishing nothing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client } = scriptedClient({
          "plugin/installed": () => Effect.never,
          "mcpServerStatus/list": () => Effect.never,
        });
        const inventory = yield* makeCodexNativeInventory(() => Effect.succeed(client));
        const refresh = yield* inventory.refresh.pipe(Effect.forkChild);
        yield* TestClock.adjust("21 seconds");
        yield* Fiber.join(refresh);
        const report = yield* inventory.reports.pipe(
          Stream.runHead,
          Effect.timeoutOption("1 second"),
          Effect.forkChild,
        );
        yield* TestClock.adjust("1 second");
        assert.isTrue(Option.isNone(yield* Fiber.join(report)));
      }),
    ),
  );

  it.effect("uninstalls by plugin id in the requested workspace", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client, requests } = scriptedClient({
          "plugin/uninstall": (params) =>
            typeof params === "object" &&
            params !== null &&
            "pluginId" in params &&
            params.pluginId === "x@y"
              ? Effect.fail({ _tag: "PluginNotFound" as const })
              : {},
        });
        const opened: Array<string | undefined> = [];
        const { actions } = yield* makeCodexNativeInventory((cwd) =>
          Effect.sync(() => {
            opened.push(cwd);
            return client;
          }),
        );
        yield* actions.uninstall({ pluginId: "linear@curated", cwd: "/repo" });
        assert.deepStrictEqual(opened, ["/repo"]);
        assert.deepStrictEqual(requests, [
          { method: "plugin/uninstall", params: { pluginId: "linear@curated" } },
        ]);
        const rejected = yield* actions.uninstall({ pluginId: "x@y" }).pipe(Effect.flip);
        assert.strictEqual(rejected.message, "Codex could not uninstall 'x@y'.");
      }),
    ),
  );

  it.effect("reports an incomplete plugin listing as a failure, never as a list", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client } = scriptedClient({
          "plugin/installed": () => ({
            marketplaceLoadErrors: [{ marketplacePath: "/m", message: "offline" }],
            marketplaces: [],
          }),
        });
        const { actions } = yield* makeCodexNativeInventory(() => Effect.succeed(client));
        const error = yield* actions.listPlugins({}).pipe(Effect.flip);
        assert.include(error.message, "/m (offline)");
      }),
    ),
  );

  it.effect("reads one MCP server by name", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client, requests } = scriptedClient({
          "mcpServerStatus/list": () => ({
            data: [mcpStatus({ name: "notion", authStatus: "notLoggedIn" })],
          }),
        });
        const { actions } = yield* makeCodexNativeInventory(() => Effect.succeed(client));
        assert.deepStrictEqual(yield* actions.readMcpServer({ serverName: "notion" }), {
          name: "notion",
          status: "needs-auth",
          canStartSignIn: true,
        });
        assert.strictEqual(yield* actions.readMcpServer({ serverName: "ghost" }), undefined);
        assert.deepStrictEqual(requests[0]?.params, {
          detail: "toolsAndAuthOnly",
          limit: 100,
          serverName: "notion",
        });
      }),
    ),
  );

  it.effect("returns the sign-in page and settles on this server's completion only", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { client, requests, notify } = scriptedClient({
          "mcpServer/oauth/login": () => ({ authorizationUrl: "https://auth.example.com/start" }),
        });
        const { actions } = yield* makeCodexNativeInventory(() => Effect.succeed(client));
        const scope = yield* Scope.make();
        const attempt = yield* actions
          .startMcpSignIn({ serverName: "notion" })
          .pipe(Scope.provide(scope));
        assert.strictEqual(attempt.authorizationUrl, "https://auth.example.com/start");
        assert.deepStrictEqual(requests, [
          { method: "mcpServer/oauth/login", params: { name: "notion", timeoutSecs: 300 } },
        ]);

        yield* notify("mcpServer/oauthLogin/completed", { name: "other", success: true });
        yield* notify("mcpServer/oauthLogin/completed", {
          name: "notion",
          success: false,
          error: "access_denied",
        });
        const error = yield* attempt.waitForCompletion.pipe(Effect.flip);
        assert.strictEqual(error.message, "access_denied");
        yield* Scope.close(scope, Exit.void);
      }),
    ),
  );

  it.effect("retires its actions when the instance scope closes", () =>
    Effect.gen(function* () {
      const { client } = scriptedClient({});
      const instanceScope = yield* Scope.make();
      const { actions } = yield* makeCodexNativeInventory(() => Effect.succeed(client)).pipe(
        Scope.provide(instanceScope),
      );
      assert.isFalse(yield* actions.isRetired);
      yield* Scope.close(instanceScope, Exit.void);
      assert.isTrue(yield* actions.isRetired);
      yield* actions.whenRetired;
    }),
  );
});

it.effect("finds plugin folders in Codex's cache by its own names, never outside the cache", () =>
  Effect.gen(function* () {
    const home = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-codex-roots-"))),
      (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
    );
    const cache = NodePath.join(home, "cache");
    const cached = NodePath.join(cache, "remote-store", "keyed", "1.0.0");
    yield* Effect.promise(async () => {
      await NodeFSP.mkdir(cached, { recursive: true });
      await NodeFSP.mkdir(NodePath.join(home, "outside"), { recursive: true });
    });
    const roots = yield* codexInstalledPluginRoots(
      {
        marketplaces: [
          {
            name: "remote-store",
            plugins: [
              summary({
                id: "keyed@remote",
                name: "keyed",
                version: "1.0.0",
                source: { type: "remote" },
              }),
              summary({
                id: "absent@remote",
                name: "absent",
                version: "1.0.0",
                source: { type: "remote" },
              }),
              summary({
                id: "escape@remote",
                name: "..",
                version: "outside",
                source: { type: "remote" },
              }),
            ],
          },
        ],
      },
      cache,
    );
    const real = yield* Effect.promise(() => NodeFSP.realpath(cached));
    assert.deepStrictEqual(
      roots.map((plugin) => [plugin.id, plugin.root]),
      [
        ["keyed@remote", real],
        ["absent@remote", undefined],
        ["escape@remote", undefined],
      ],
    );
  }).pipe(Effect.scoped),
);
