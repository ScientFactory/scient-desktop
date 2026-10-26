import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { supportsScientClaudePlugins, ScientAgentSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { readClaudeInstalledPlugins, readScientClaudePlugins } from "./ClaudeInstalledPlugins.ts";
const decodeSettings = Schema.decodeSync(ScientAgentSettings);
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

describe("Claude plugin source compatibility", () => {
  it("defaults existing configurations on but requires a supported stable release", () => {
    expect(decodeSettings({}).useClaudePlugins).toBe(true);
    expect([null, "0.1.2", "0.1.3-beta.1", "invalid"].map(supportsScientClaudePlugins)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(["0.1.3", "0.2.0", "1.0.0"].map(supportsScientClaudePlugins)).toEqual([
      true,
      true,
      true,
    ]);
  });
  it.effect("reads the owner's registry and enablement without granting mutation authority", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped();
        yield* fs.makeDirectory(path.join(home, "plugins"));
        yield* fs.writeFileString(
          path.join(home, "plugins", "installed_plugins.json"),
          encode({
            version: 2,
            plugins: {
              "review@official": [{ scope: "user", installPath: "/plugin", version: "1.0.0" }],
              "project@official": [
                { scope: "project", projectPath: "/other", installPath: "/other-plugin" },
              ],
            },
          }),
        );
        yield* fs.writeFileString(
          path.join(home, "settings.json"),
          encode({ enabledPlugins: { "review@official": false } }),
        );
        const plugins = yield* readClaudeInstalledPlugins(home);
        expect(plugins).toHaveLength(1);
        expect(plugins[0]).toMatchObject({
          name: "review@official",
          enabled: false,
          sourceLabel: "Claude Code's plugins",
        });
        expect(plugins[0]?.canUninstall).toBeUndefined();
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});

it.effect(
  "uses project overrides, preserves distinct installed roots, and keeps disabled discovery sources off",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped();
        const project = path.join(home, "project");
        yield* fs.makeDirectory(path.join(home, "plugins"));
        yield* fs.makeDirectory(path.join(project, ".git"), { recursive: true });
        yield* fs.makeDirectory(path.join(project, ".claude"));
        yield* fs.writeFileString(
          path.join(home, "plugins", "installed_plugins.json"),
          encode({
            version: 2,
            plugins: {
              "review@official": [
                { scope: "user", installPath: "/v1" },
                { scope: "user", installPath: "/v2" },
              ],
            },
          }),
        );
        yield* fs.writeFileString(
          path.join(project, ".claude", "settings.local.json"),
          encode({ enabledPlugins: { "review@official": false } }),
        );
        const entries = yield* readClaudeInstalledPlugins(home, project);
        expect(new Set(entries.map((entry) => entry.id)).size).toBe(2);
        expect(entries.every((entry) => !entry.enabled)).toBe(true);
        let disabled: string[] = ["claude-plugins"];
        const run = (args: ReadonlyArray<string>) =>
          Effect.succeed(
            args[0] === "--runtime-info"
              ? encode({
                  product: "scient-agent",
                  version: "0.1.3",
                  upstream: { name: "oh-my-pi", version: "18.3.1" },
                  rpcProtocolVersions: [2],
                })
              : encode({
                  value: args.includes("disabledProviders") ? disabled : ["claude-plugins"],
                }),
          );
        expect(yield* readScientClaudePlugins(run, home, true, project)).toEqual([]);
        disabled = [];
        expect(yield* readScientClaudePlugins(run, home, false, project)).toHaveLength(2);
        yield* fs.writeFileString(
          path.join(home, "plugins", "installed_plugins.json"),
          "broken JSON",
        );
        expect((yield* readClaudeInstalledPlugins(home).pipe(Effect.result))._tag).toBe("Failure");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
