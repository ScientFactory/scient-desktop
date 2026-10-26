import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import {
  makeSharedPluginStore,
  sharedPluginDisplayName,
  sharedPluginShelfRank,
} from "./SharedPluginStore.ts";
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped();
  const home = path.join(root, "claude");
  const clone = path.join(root, "official");
  const agent = path.join(root, "agent");
  const write = Effect.fn("fixture.write")(function* (name: string, value: unknown) {
    yield* fs.makeDirectory(path.dirname(name), { recursive: true });
    yield* fs.writeFileString(name, encode(value));
  });
  yield* write(path.join(home, "plugins", "known_marketplaces.json"), {
    "claude-plugins-official": {
      installLocation: clone,
      source: { source: "github", repo: "anthropics/claude-plugins-official" },
    },
  });
  yield* write(path.join(clone, ".claude-plugin", "marketplace.json"), {
    name: "claude-plugins-official",
    plugins: [
      { name: "review", description: "Reviews code", source: "./plugins/review" },
      { name: "other", source: "./plugins/other" },
      { name: "-unsafe", source: "./plugins/unsafe" },
    ],
  });
  yield* write(path.join(clone, "plugins", "review", ".claude-plugin", "plugin.json"), {
    hooks: {},
    mcpServers: {},
  });
  yield* fs.makeDirectory(path.join(clone, "plugins", "review", "skills"));
  yield* write(path.join(home, "plugins", "plugin-directory-cache-v2.json"), {
    listings: [
      {
        name: "review",
        source: {
          repository: {
            url: "https://github.com/anthropics/claude-plugins-official",
            path: "plugins/review",
          },
        },
        checks: { review: { state: "done", by: { type: "anthropic" } } },
      },
    ],
  });
  return { home, clone, agent, path, write };
});
describe("shared marketplace store", () => {
  it.effect(
    "pages local catalogs without executing plugins, and reads includes and matched review provenance",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { home, clone, path, write } = yield* fixture;
          const calls: ReadonlyArray<string>[] = [];
          let installed = false;
          const store = yield* makeSharedPluginStore({
            kind: "claude",
            claudeHome: home,
            installed: () =>
              Effect.succeed({
                sequence: 1,
                plugins: installed
                  ? [
                      {
                        id: "review",
                        name: "review@claude-plugins-official",
                        source: "local",
                        enabled: true,
                      },
                    ]
                  : [],
              }),
            run: (args) =>
              Effect.sync(() => {
                calls.push(args);
                installed = true;
                return "";
              }),
          });
          const page = yield* store.search({ limit: 1 });
          expect(page.entries.map((entry) => entry.name)).toEqual(["review"]);
          expect(page.nextCursor).toBe("1");
          expect((yield* store.search({ cursor: "1", limit: 1 })).entries[0]?.name).toBe("other");
          expect(calls).toHaveLength(0);
          const detail = yield* store.entry("review@claude-plugins-official");
          expect(detail.includes).toEqual(["Skills", "Hooks", "MCP servers"]);
          expect(detail.review).toBe("anthropic");
          yield* store.install(detail.id);
          expect(calls).toEqual([["plugin", "install", "--scope", "user", detail.id]]);
          expect((yield* store.entry(detail.id)).installed).toBe(true);
          yield* write(path.join(home, "plugins", "plugin-directory-cache-v2.json"), {
            listings: [
              {
                name: "review",
                source: {
                  repository: { url: "https://github.com/someone/else", path: "plugins/review" },
                },
                checks: { review: { state: "done", by: { type: "anthropic" } } },
              },
            ],
          });
          expect((yield* store.entry(detail.id)).review).toBeUndefined();
          yield* write(path.join(clone, ".claude-plugin", "marketplace.json"), {
            name: "claude-plugins-official",
            plugins: [{ name: "review", source: "../../outside" }],
          });
          expect((yield* store.entry(detail.id)).includes).toEqual([]);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );
  it.effect("offers the official store explicitly and verifies the agent's own registry", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { home, clone, agent, path, write } = yield* fixture;
        const commands: ReadonlyArray<string>[] = [];
        const store = yield* makeSharedPluginStore({
          kind: "scient",
          claudeHome: home,
          agentRoot: agent,
          installed: () => Effect.succeed({ sequence: 1, plugins: [] }),
          run: (args) =>
            Effect.gen(function* () {
              commands.push(args);
              yield* write(path.join(agent, "marketplaces.json"), {
                version: 1,
                marketplaces: [
                  {
                    name: "claude-plugins-official",
                    catalogPath: path.join(clone, ".claude-plugin", "marketplace.json"),
                    sourceUri: "anthropics/claude-plugins-official",
                  },
                ],
              });
              return "";
            }),
        });
        expect((yield* store.search({})).canAddOfficialStore).toBe(true);
        expect(
          (yield* store.install("review@claude-plugins-official").pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(commands).toEqual([]);
        yield* store.addOfficialStore!();
        expect(commands).toEqual([
          ["plugin", "marketplace", "add", "anthropics/claude-plugins-official"],
        ]);
        expect((yield* store.search({})).canAddOfficialStore).toBe(false);
        expect(
          (yield* store.entry("review@claude-plugins-official")).disabledReason,
        ).toBeUndefined();
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});

it.effect(
  "adds an explicitly chosen source through Claude and refuses a conflicting marketplace name",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { home, clone, path, write } = yield* fixture;
        const commands: ReadonlyArray<string>[] = [];
        const store = yield* makeSharedPluginStore({
          kind: "claude",
          claudeHome: home,
          installed: () => Effect.succeed({ sequence: 1, plugins: [] }),
          run: (args) =>
            Effect.gen(function* () {
              commands.push(args);
              yield* write(path.join(home, "plugins", "known_marketplaces.json"), {
                lab: { installLocation: clone, source: { source: "github", repo: "org/lab" } },
              });
              return "";
            }),
        });
        expect(
          (yield* store.ensureMarketplace!({
            name: "claude-plugins-official",
            source: "someone/else",
          }).pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(commands).toEqual([]);
        yield* store.ensureMarketplace!({ name: "lab", source: "org/lab" });
        expect(commands).toEqual([["plugin", "marketplace", "add", "org/lab"]]);
        yield* store.ensureMarketplace!({ name: "lab", source: "https://github.com/org/lab.git" });
        expect(commands).toHaveLength(1);
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it("ranks reviewed plugins before familiar brands and formats readable slug names", () => {
  const entries = ["42crunch-api-security-testing", "github", "reviewed"].map((name) => ({
    name,
    rank: sharedPluginShelfRank(
      name,
      name === "reviewed" ? { state: "done", by: { type: "partner" } } : undefined,
    ),
  }));
  expect(entries.sort((a, b) => a.rank - b.rank).map((entry) => entry.name)).toEqual([
    "reviewed",
    "github",
    "42crunch-api-security-testing",
  ]);
  expect(sharedPluginShelfRank("unknown", { state: "pending", by: { type: "anthropic" } })).toBe(2);
  expect(sharedPluginDisplayName("github-api-pdf-tools")).toBe("GitHub API PDF Tools");
});
