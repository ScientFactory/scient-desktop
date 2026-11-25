import { describe, expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { makeScientAgentPluginInventory } from "./ScientAgentPluginInventory.ts";

const listing = {
  npm: [
    {
      name: "@lab/tools",
      version: "1.0.0",
      path: "/missing/npm",
      enabled: true,
      manifest: { description: "Tools" },
    },
  ],
  marketplace: [
    {
      id: "review@official",
      scope: "user",
      entries: [{ installPath: "/missing/review", version: "2.0.0", enabled: false }],
    },
  ],
};

describe("Scient Agent plugin inventory", () => {
  it.effect("publishes a complete native listing and routes scoped actions to the owner", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const commands: ReadonlyArray<string>[] = [];
        const native = yield* makeScientAgentPluginInventory((_cwd, args) =>
          Effect.sync(() => {
            commands.push(args);
            return JSON.stringify(listing);
          }),
        );
        yield* native.actions.refreshInventory!({ force: true });
        const report = yield* native.reports.pipe(Stream.runHead);
        expect(report._tag === "Some" && report.value.plugins).toMatchObject([
          { id: "npm:@lab/tools", sourceLabel: "npm/git", canSetEnabled: true },
          { id: "user:review@official", enabled: false, sourceLabel: "Marketplace" },
        ]);
        yield* native.actions.setEnabled!({ pluginId: "user:review@official", enabled: true });
        expect(commands.at(-1)).toEqual(["plugin", "enable", "--scope", "user", "review@official"]);
        yield* native.actions.uninstall({ pluginId: "npm:@lab/tools" });
        expect(commands.at(-1)).toEqual(["plugin", "uninstall", "@lab/tools"]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect(
    "reads plugins and standalone apps concurrently and keeps own plugins when foreign discovery fails",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const ownStarted = yield* Deferred.make<void>();
          const standaloneStarted = yield* Deferred.make<void>();
          const native = yield* makeScientAgentPluginInventory(
            () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(ownStarted, undefined);
                yield* Deferred.await(standaloneStarted);
                return JSON.stringify(listing);
              }),
            () => Effect.fail({ message: "Claude registry unavailable" }),
            () =>
              Effect.gen(function* () {
                yield* Deferred.succeed(standaloneStarted, undefined);
                yield* Deferred.await(ownStarted);
                return [
                  { name: "Gmail", scope: "chatgpt", status: "connected" as const },
                  { name: "local", status: "unknown" as const },
                ];
              }),
          );
          yield* native.actions.refreshInventory!({ force: true });
          const report = yield* native.reports.pipe(Stream.runHead);
          expect(report._tag).toBe("Some");
          if (report._tag === "Some") {
            expect(report.value.plugins?.map((plugin) => plugin.name)).toEqual([
              "@lab/tools",
              "review@official",
            ]);
            expect(report.value.mcpServers?.map((server) => server.name)).toEqual([
              "Gmail",
              "local",
            ]);
          }
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "retains the last apps after a failed read and publishes a successful empty answer",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          let failed = false;
          let signedOut = false;
          const native = yield* makeScientAgentPluginInventory(
            () => Effect.succeed(JSON.stringify(listing)),
            undefined,
            () =>
              failed
                ? Effect.fail({ message: "apps read timed out" })
                : Effect.succeed(
                    signedOut
                      ? []
                      : [{ name: "Gmail", scope: "chatgpt", status: "connected" as const }],
                  ),
          );
          yield* native.actions.refreshInventory!({ force: true });
          failed = true;
          expect(
            (yield* native.actions.refreshInventory!({ force: true }).pipe(Effect.result))._tag,
          ).toBe("Failure");
          const retained = yield* native.reports.pipe(Stream.runHead);
          expect(retained._tag === "Some" && retained.value.mcpServers).toEqual([
            { name: "Gmail", scope: "chatgpt", status: "connected" },
          ]);
          failed = false;
          signedOut = true;
          yield* native.actions.refreshInventory!({ force: true });
          const cleared = yield* native.reports.pipe(Stream.runHead);
          expect(cleared._tag === "Some" && cleared.value.mcpServers).toEqual([]);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("publishes the live MCP listing when the configuration read fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let configReadable = true;
        const live = JSON.stringify({
          servers: [{ name: "cloudflare", status: "needs-auth", canStartSignIn: true }],
        });
        const native = yield* makeScientAgentPluginInventory(
          () => Effect.succeed(JSON.stringify(listing)),
          undefined,
          () =>
            configReadable
              ? Effect.succeed([{ name: "Gmail", scope: "chatgpt", status: "connected" as const }])
              : Effect.fail({ message: "Could not read Scient Agent's MCP configuration." }),
          { list: () => Effect.succeed(live), login: () => Effect.undefined },
        );
        yield* native.actions.refreshInventory!({ force: true });
        configReadable = false;
        yield* native.actions.refreshInventory!({ force: true });
        const report = yield* native.reports.pipe(Stream.runHead);
        // The live rows publish, and the apps last read stay beside them.
        expect(report._tag === "Some" && report.value.mcpServers).toMatchObject([
          { name: "cloudflare", status: "needs-auth", canStartSignIn: true },
          { name: "Gmail", scope: "chatgpt", status: "connected" },
        ]);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("rejects partial listings and does not act on a vanished plugin", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let calls = 0;
        const native = yield* makeScientAgentPluginInventory(() =>
          Effect.sync(() => {
            calls++;
            return '{"npm":[]}';
          }),
        );
        expect(
          (yield* native.actions.uninstall({ pluginId: "gone" }).pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(calls).toBe(1);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
