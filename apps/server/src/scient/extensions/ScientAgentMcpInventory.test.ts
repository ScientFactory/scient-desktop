import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { makeScientAgentPluginInventory } from "./ScientAgentPluginInventory.ts";
import { readScientAgentMcpServers } from "./ScientAgentMcpInventory.ts";
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

describe("Scient Agent standalone MCP inventory", () => {
  it.effect(
    "publishes configured servers without leaking their credentials or claiming they connected",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped();
          yield* fs.makeDirectory(path.join(root, "agent"));
          const file = path.join(root, "agent", "mcp.json");
          yield* fs.writeFileString(
            file,
            encode({
              mcpServers: {
                lab: { command: "lab", env: { API_KEY: "synthetic-private-key" } },
                off: { url: "https://example.com", disabled: true },
              },
            }),
          );
          const servers = yield* readScientAgentMcpServers(root);
          expect(servers).toEqual([
            { name: "lab", scope: "user", status: "unknown" },
            { name: "off", scope: "user", status: "disabled" },
          ]);
          expect(encode(servers)).not.toContain("synthetic-private-key");
          const native = yield* makeScientAgentPluginInventory(
            () => Effect.succeed(encode({ npm: [], marketplace: [] })),
            () => Effect.succeed([]),
            () =>
              readScientAgentMcpServers(root).pipe(
                Effect.provideService(FileSystem.FileSystem, fs),
                Effect.provideService(Path.Path, path),
              ),
          );
          yield* native.actions.refreshInventory!({ force: true });
          const report = yield* native.reports.pipe(Stream.runHead);
          expect(report._tag === "Some" && report.value.mcpServers).toEqual(servers);
          yield* fs.writeFileString(file, "broken JSON");
          expect(
            (yield* native.actions.refreshInventory!({ force: true }).pipe(Effect.result))._tag,
          ).toBe("Failure");
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("Scient Agent live MCP servers", () => {
  const plugins = encode({ npm: [], marketplace: [] });
  const fileRows = [
    { name: "lab", scope: "user", status: "unknown" as const },
    { name: "off", scope: "user", status: "disabled" as const },
    { name: "Gmail", scope: "chatgpt", status: "connected" as const },
  ];
  const agentList = encode({
    servers: [
      {
        name: "figma",
        status: "needs-auth",
        pluginId: "figma@openai-curated",
        canStartSignIn: true,
      },
      { name: "lab", status: "connected", scope: "user", toolCount: 3 },
    ],
  });

  it.effect("lets the agent's listing replace guessed rows and falls back when it fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let answer: Effect.Effect<string | undefined, { readonly message: string }> =
          Effect.succeed(agentList);
        const requests: Array<string | undefined> = [];
        const native = yield* makeScientAgentPluginInventory(
          () => Effect.succeed(plugins),
          undefined,
          () => Effect.succeed(fileRows),
          {
            list: (serverName) =>
              Effect.sync(() => requests.push(serverName)).pipe(Effect.andThen(answer)),
            login: () => Effect.undefined,
          },
        );
        yield* native.actions.refreshInventory!({ force: true });
        const live = yield* native.reports.pipe(Stream.runHead);
        expect(live._tag === "Some" && live.value.mcpServers).toEqual([
          {
            name: "figma",
            status: "needs-auth",
            pluginId: "figma@openai-curated",
            canStartSignIn: true,
          },
          { name: "lab", status: "connected", scope: "user", toolCount: 3 },
          fileRows[1],
          fileRows[2],
        ]);
        expect(yield* native.actions.readMcpServer({ serverName: "figma" })).toMatchObject({
          canStartSignIn: true,
        });
        expect(requests.at(-1)).toBe("figma");

        answer = Effect.succeed(encode({ error: { message: "config unreadable" } }));
        yield* native.actions.refreshInventory!({ force: true });
        const fallback = yield* native.reports.pipe(Stream.runHead);
        expect(fallback._tag === "Some" && fallback.value.mcpServers).toEqual(fileRows);
        expect(
          (yield* native.actions.readMcpServer({ serverName: "figma" }).pipe(Effect.flip)).message,
        ).toBe("config unreadable");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps file rows and the agent-managed sign-in for an executable without mcp", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const native = yield* makeScientAgentPluginInventory(
          () => Effect.succeed(plugins),
          undefined,
          () => Effect.succeed(fileRows),
          { list: () => Effect.undefined, login: () => Effect.undefined },
        );
        yield* native.actions.refreshInventory!({ force: true });
        const report = yield* native.reports.pipe(Stream.runHead);
        expect(report._tag === "Some" && report.value.mcpServers).toEqual(fileRows);
        expect(yield* native.actions.readMcpServer({ serverName: "lab" })).toBeUndefined();
        const failure = yield* native.actions
          .startMcpSignIn({ serverName: "lab" })
          .pipe(Effect.flip);
        expect(failure.message).toBe("Manage this MCP server's sign-in in Scient Agent.");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("follows the login lines to completion, failure or an early exit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const url = encode({ type: "authorization_url", url: "https://auth.example/start" });
        let lines: ReadonlyArray<string> = [];
        const refreshed = yield* Deferred.make<void>();
        let listed = 0;
        const native = yield* makeScientAgentPluginInventory(
          () => Effect.succeed(plugins),
          undefined,
          () => Effect.succeed([]),
          {
            list: () =>
              Effect.sync(() => ++listed).pipe(
                Effect.tap(() => Deferred.succeed(refreshed, undefined)),
                Effect.as(agentList),
              ),
            login: () => Effect.succeed(Stream.fromIterable(lines)),
          },
        );
        const signIn = native.actions.startMcpSignIn({ serverName: "figma" });

        lines = ["progress text", url, encode({ type: "completed" })];
        const attempt = yield* signIn;
        expect(attempt.authorizationUrl).toBe("https://auth.example/start");
        yield* attempt.waitForCompletion;
        yield* Deferred.await(refreshed);
        expect(listed).toBe(1);

        lines = [url, encode({ type: "failed", message: "Access denied" })];
        expect((yield* (yield* signIn).waitForCompletion.pipe(Effect.flip)).message).toBe(
          "Access denied",
        );

        lines = [url];
        expect((yield* (yield* signIn).waitForCompletion.pipe(Effect.flip)).message).toContain(
          "did not finish signing in to 'figma'",
        );

        lines = [encode({ error: { message: "Unknown MCP server 'figma'." } })];
        expect((yield* signIn.pipe(Effect.flip)).message).toBe("Unknown MCP server 'figma'.");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
