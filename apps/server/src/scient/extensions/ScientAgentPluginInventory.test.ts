import { describe, expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
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
