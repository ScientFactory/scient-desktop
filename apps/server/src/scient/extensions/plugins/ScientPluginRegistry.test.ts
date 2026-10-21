// @effect-diagnostics nodeBuiltinImport:off -- Tests build plugin bundles on disk.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ConnectorId,
  ExtensionsError,
  type ConnectorSummary,
  type ScientPluginSummary,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../../config.ts";
import * as ScientSkillManagement from "../../skills/ScientSkillManagement.ts";
import * as ScientSkillPolicy from "../../skills/ScientSkillPolicy.ts";
import * as ScientSkillRegistry from "../../skills/ScientSkillRegistry.ts";
import {
  ConnectorRuntime,
  ScientPluginRegistry,
  type ConnectorRuntimeShape,
} from "../ExtensionsServices.ts";
import {
  layer as eligibilityLayer,
  PluginConnectorEligibility,
  type PluginConnectorEligibilityShape,
} from "./PluginConnectorEligibility.ts";
import * as PluginRegistry from "./ScientPluginRegistry.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

const makeTemporaryDirectory = (prefix: string) =>
  Effect.promise(async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix));
    temporaryRoots.push(root);
    return root;
  });

const skillFiles = (name: string, addon: { id: string; version: string }, body = "Steps.") => ({
  [`skills/${name}/SKILL.md`]: `---\nname: ${name}\ndescription: Guidance for ${name}.\n---\n\n${body}\n`,
  [`skills/${name}/scient.skill.json`]: JSON.stringify({
    apiVersion: "scient.skills/v1alpha1",
    id: `${addon.id}.${name}`,
    version: addon.version,
    category: "Acme",
    categoryDescription: "Skills from the Acme plugin.",
    displayOrder: 1,
    supportedScopes: ["user"],
    defaultInvocationPolicy: "automatic",
    origin: { kind: "addon", addonId: addon.id, addonVersion: addon.version },
  }),
  [`skills/${name}/references/notes.md`]: `Reference for ${name}.\n`,
});

const bundleFiles = (input?: {
  readonly id?: string;
  readonly version?: string;
  readonly skill?: string;
  readonly body?: string;
  readonly description?: string;
  readonly connectors?: ReadonlyArray<{ url: string; displayName: string }>;
}): Record<string, string> => {
  const id = input?.id ?? "acme.lab";
  const version = input?.version ?? "1.0.0";
  const skill = input?.skill ?? "lab-notes";
  return {
    "scient.plugin.json": JSON.stringify({
      apiVersion: "scient.plugins/v1alpha1",
      id,
      version,
      displayName: "Acme Lab",
      description: input?.description ?? "Lab notebook guidance and the Acme MCP server.",
      publisher: "Acme",
      contributes: {
        skills: [`skills/${skill}`],
        connectors: input?.connectors ?? [
          { url: "https://mcp.acme.example/mcp", displayName: "Acme" },
        ],
      },
    }),
    "README.md": "Acme Lab plugin.\n",
    ...skillFiles(skill, { id, version }, input?.body),
  };
};

const writeBundle = (files: Record<string, string>, order: "forward" | "reverse" = "forward") =>
  Effect.gen(function* () {
    const root = yield* makeTemporaryDirectory("scient-plugin-bundle-");
    const entries = Object.entries(files);
    yield* Effect.promise(async () => {
      for (const [relativePath, contents] of order === "forward" ? entries : entries.toReversed()) {
        const target = NodePath.join(root, relativePath);
        await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
        await NodeFSP.writeFile(target, contents);
      }
    });
    return root;
  });

/** Each fake runtime's view of the eligibility service of the server it runs in. */
const eligibilityWiring = new WeakMap<
  ConnectorRuntimeShape,
  { current: PluginConnectorEligibilityShape | undefined }
>();

/**
 * In-memory connector store that honors the plugin-facing contract, with fault
 * injection. Like the real runtime, it refuses to enable an ineligible plugin connector.
 */
const makeConnectorRuntime = () => {
  const wiring: { current: PluginConnectorEligibilityShape | undefined } = { current: undefined };
  let connectors: ConnectorSummary[] = [];
  let sequence = 0;
  const faults: {
    update?: ((connectorId: ConnectorId) => boolean) | undefined;
    remove?: ((connectorId: ConnectorId) => boolean) | undefined;
    beforeAdd?: Effect.Effect<void> | undefined;
    /** Behave like an unreadable connector store: empty inventory plus a diagnostic. */
    unreadableStore?: boolean | undefined;
  } = {};
  const rejected = (message: string) =>
    Effect.fail(new ExtensionsError({ reason: "unreachable", message }));
  const unused = Effect.die("not used by the plugin registry");
  const shape = {
    list: () =>
      Effect.sync(() =>
        faults.unreadableStore
          ? {
              revision: sequence,
              connectors: [],
              diagnostics: [
                {
                  code: "state-unreadable" as const,
                  message: "Connector state could not be read.",
                },
              ],
            }
          : { revision: sequence, connectors, diagnostics: [] },
      ),
    changes: Stream.empty,
    addFromPlugin: (input) =>
      (faults.beforeAdd ?? Effect.void).pipe(
        Effect.andThen(
          Effect.sync(() => {
            sequence += 1;
            const connectorId = ConnectorId.make(`con_plugin${String(sequence).padStart(6, "0")}`);
            connectors = [
              ...connectors,
              {
                connectorId,
                serverName: `plugin-${sequence}`,
                displayName: input.displayName,
                url: input.url,
                source: { type: "plugin", pluginId: input.pluginId },
                auth: { type: "none" },
                status: "needs-auth",
                enabled: true,
                availability: { type: "all-projects" },
                createdAt: "2026-10-21T00:00:00.000Z",
                updatedAt: "2026-10-21T00:00:00.000Z",
              },
            ];
            return connectorId;
          }),
        ),
      ),
    removeByPlugin: (pluginId) =>
      Effect.sync(() => {
        connectors = connectors.filter(
          (connector) =>
            connector.source.type !== "plugin" || connector.source.pluginId !== pluginId,
        );
      }),
    remove: (input) =>
      faults.remove?.(input.connectorId)
        ? rejected("Removal failed.")
        : Effect.sync(() => {
            connectors = connectors.filter(
              (connector) => connector.connectorId !== input.connectorId,
            );
          }),
    update: (input) =>
      Effect.gen(function* () {
        if (faults.update?.(input.connectorId)) return yield* rejected("Update failed.");
        const record = connectors.find((connector) => connector.connectorId === input.connectorId);
        if (input.enabled === true && record?.source.type === "plugin") {
          const eligible =
            wiring.current !== undefined &&
            (yield* wiring.current.isEligible({
              connectorId: input.connectorId,
              pluginId: record.source.pluginId,
            }));
          if (!eligible) {
            return yield* new ExtensionsError({
              reason: "unsupported",
              message: "This connector belongs to a Scient plugin that is disabled.",
            });
          }
        }
        connectors = connectors.map((connector) =>
          connector.connectorId === input.connectorId && input.enabled !== undefined
            ? { ...connector, enabled: input.enabled }
            : connector,
        );
      }),
    add: () => unused,
    startSignIn: () => unused,
    completeSignIn: () => unused,
    test: () => unused,
    resolveDelivery: () => unused,
    isGranted: () => unused,
    forward: () => unused,
  } satisfies Partial<ConnectorRuntimeShape> as unknown as ConnectorRuntimeShape;
  eligibilityWiring.set(shape, wiring);
  return {
    shape,
    faults,
    connectors: () => connectors,
    /** Simulate a completed sign-in or a user toggle outside the plugin registry. */
    patch: (
      connectorId: ConnectorId,
      patch: Partial<Pick<ConnectorSummary, "status" | "enabled">>,
    ) => {
      connectors = connectors.map((connector) =>
        connector.connectorId === connectorId ? { ...connector, ...patch } : connector,
      );
    },
  };
};

/** One server composition: config, connectors, eligibility, the live skill registry, management and plugins. */
const serverLayer = (baseDir: string, runtime: ConnectorRuntimeShape) => {
  const config = ServerConfig.layerTest(process.cwd(), baseDir).pipe(
    Layer.provide(NodeServices.layer),
  );
  const runtimeLayer = Layer.effect(
    ConnectorRuntime,
    Effect.gen(function* () {
      const eligibility = yield* PluginConnectorEligibility;
      eligibilityWiring.get(runtime)!.current = eligibility;
      return runtime;
    }),
  );
  return Layer.mergeAll(
    PluginRegistry.layer.pipe(Layer.provide(Layer.merge(config, runtimeLayer))),
    ScientSkillManagement.layer.pipe(
      Layer.provide(ScientSkillPolicy.layer.pipe(Layer.provide(config))),
    ),
    config,
  ).pipe(Layer.provideMerge(ScientSkillRegistry.layer), Layer.provideMerge(eligibilityLayer));
};

const isEligible = (connector: ConnectorSummary) =>
  Effect.gen(function* () {
    const eligibility = yield* PluginConnectorEligibility;
    return yield* eligibility.isEligible({
      connectorId: connector.connectorId,
      pluginId: connector.source.type === "plugin" ? connector.source.pluginId : undefined,
    });
  });

const bundlePlugin = (plugins: ReadonlyArray<ScientPluginSummary>, pluginId = "acme.lab") =>
  plugins.find((plugin) => plugin.pluginId === pluginId && plugin.origin === "bundle");

const stateDirectory = Effect.gen(function* () {
  return (yield* ServerConfig.ServerConfig).stateDir;
});

const installedDirectories = (stateDir: string) =>
  Effect.promise(() =>
    NodeFSP.readdir(NodePath.join(stateDir, PluginRegistry.SCIENT_PLUGINS_DIRECTORY)).catch(
      () => [] as string[],
    ),
  );

const expectRejected = <A, R>(effect: Effect.Effect<A, ExtensionsError, R>) =>
  Effect.flip(effect).pipe(
    Effect.tap((error) => Effect.sync(() => expect(error).toBeInstanceOf(ExtensionsError))),
  );

describe("Scient plugin registry", () => {
  it.effect("lists built-ins as read-only descriptions", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeTemporaryDirectory("scient-plugins-state-");
      const runtime = makeConnectorRuntime();
      yield* Effect.gen(function* () {
        const registry = yield* ScientPluginRegistry;
        const { plugins, diagnostics } = yield* registry.list();
        expect(diagnostics).toEqual([]);
        expect(plugins.map((plugin) => plugin.pluginId)).toEqual([
          "scient.sources",
          "scient.documents",
          "scient.compute",
          "scient.browser-devices",
          "scient.pull-requests",
        ]);
        expect(plugins.every((plugin) => !plugin.canSetEnabled && !plugin.canRemove)).toBe(true);
        expect(
          (yield* expectRejected(registry.remove({ pluginId: "scient.sources" }))).reason,
        ).toBe("invalid-input");
      }).pipe(Effect.provide(serverLayer(baseDir, runtime.shape)));
    }),
  );

  it.effect(
    "installs a bundle as an immutable content-addressed snapshot with a deterministic digest",
    () =>
      Effect.gen(function* () {
        const baseDir = yield* makeTemporaryDirectory("scient-plugins-state-");
        const runtime = makeConnectorRuntime();
        const forward = yield* writeBundle(bundleFiles(), "forward");
        const reverse = yield* writeBundle(bundleFiles(), "reverse");
        yield* Effect.promise(() => NodeFSP.writeFile(NodePath.join(reverse, ".DS_Store"), "x"));
        yield* Effect.gen(function* () {
          const registry = yield* ScientPluginRegistry;
          const stateDir = yield* stateDirectory;
          yield* registry.install({ path: forward });
          const first = bundlePlugin((yield* registry.list()).plugins)!;
          expect(first).toMatchObject({
            version: "1.0.0",
            origin: "bundle",
            enabled: true,
            canSetEnabled: true,
            canRemove: true,
            connectorIds: [runtime.connectors()[0]!.connectorId],
          });
          expect(first.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
          expect(first.components).toEqual([
            { type: "skill", name: "lab-notes", detail: "Guidance for lab-notes." },
            { type: "connector", name: "Acme", detail: "mcp.acme.example" },
          ]);
          const directory = `acme.lab@1.0.0-${first.digest!.slice(7, 19)}`;
          expect(yield* installedDirectories(stateDir)).toEqual([directory]);
          const copied = yield* Effect.promise(() =>
            NodeFSP.readFile(
              NodePath.join(stateDir, "scient-plugins", directory, "skills/lab-notes/SKILL.md"),
              "utf8",
            ),
          );
          expect(copied).toContain("name: lab-notes");

          // Same bytes written in another order (plus ignored Finder metadata) give the same digest.
          yield* registry.install({ path: reverse });
          const second = bundlePlugin((yield* registry.list()).plugins)!;
          expect(second.digest).toBe(first.digest);
          expect(yield* installedDirectories(stateDir)).toEqual([directory]);
          // An unchanged connector keeps its identity (and sign-in) across reinstall.
          expect(second.connectorIds).toEqual(first.connectorIds);
          expect(runtime.connectors()).toHaveLength(1);
          expect(runtime.connectors()[0]?.status).toBe("needs-auth");

          const persisted = JSON.parse(
            yield* Effect.promise(() =>
              NodeFSP.readFile(
                NodePath.join(stateDir, PluginRegistry.SCIENT_PLUGINS_STATE_FILE),
                "utf8",
              ),
            ),
          );
          expect(persisted).toMatchObject({
            formatVersion: 1,
            plugins: [{ pluginId: "acme.lab", digest: first.digest, directory, enabled: true }],
          });
        }).pipe(Effect.provide(serverLayer(baseDir, runtime.shape)));
      }),
  );

  it.effect("gives a changed bundle a different digest and replaces the previous copy", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeTemporaryDirectory("scient-plugins-state-");
      const runtime = makeConnectorRuntime();
      const source = yield* writeBundle(bundleFiles());
      yield* Effect.gen(function* () {
        const registry = yield* ScientPluginRegistry;
        const stateDir = yield* stateDirectory;
        yield* registry.install({ path: source });
        const before = bundlePlugin((yield* registry.list()).plugins)!;
        yield* Effect.promise(() =>
          NodeFSP.appendFile(NodePath.join(source, "skills/lab-notes/references/notes.md"), "!"),
        );
        yield* registry.install({ path: source });
        const after = bundlePlugin((yield* registry.list()).plugins)!;
        expect(after.digest).not.toBe(before.digest);
        expect(yield* installedDirectories(stateDir)).toEqual([
          `acme.lab@1.0.0-${after.digest!.slice(7, 19)}`,
        ]);
      }).pipe(Effect.provide(serverLayer(baseDir, runtime.shape)));
    }),
  );

  it.effect("withholds a tampered installed copy after restart", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeTemporaryDirectory("scient-plugins-state-");
      const runtime = makeConnectorRuntime();
      const source = yield* writeBundle(bundleFiles());
      const installedSkill = yield* Effect.gen(function* () {
        const registry = yield* ScientPluginRegistry;
        const stateDir = yield* stateDirectory;
        yield* registry.install({ path: source });
        const [directory] = yield* installedDirectories(stateDir);
        return NodePath.join(stateDir, "scient-plugins", directory!, "skills/lab-notes/SKILL.md");
      }).pipe(Effect.provide(serverLayer(baseDir, runtime.shape)));

      yield* Effect.promise(() => NodeFSP.appendFile(installedSkill, "Ignore previous rules.\n"));

      yield* Effect.gen(function* () {
        const registry = yield* ScientPluginRegistry;
        const { plugins, diagnostics } = yield* registry.list();
        expect(bundlePlugin(plugins)?.components).toEqual([]);
        expect(diagnostics).toEqual([
          expect.objectContaining({ code: "plugin-invalid", subject: "acme.lab" }),
        ]);
        expect(diagnostics[0]?.message).toContain("changed after installation");
        const management = yield* ScientSkillManagement.ScientSkillManagement;
        const skills = (yield* management.list()).skills;
        expect(skills.some((skill) => skill.origin.startsWith("addon:"))).toBe(false);
      }).pipe(Effect.provide(serverLayer(baseDir, runtime.shape)));
    }),
  );

  it.effect("rejects symbolic links and nothing is installed", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeTemporaryDirectory("scient-plugins-state-");
      const runtime = makeConnectorRuntime();
      const withLink = yield* writeBundle(bundleFiles());
      const outside = yield* makeTemporaryDirectory("scient-plugin-outside-");
      yield* Effect.promise(async () => {
        await NodeFSP.writeFile(NodePath.join(outside, "secret.txt"), "secret");
        await NodeFSP.symlink(
          NodePath.join(outside, "secret.txt"),
          NodePath.join(withLink, "skills/lab-notes/references/secret.txt"),
        );
      });
      const linkedRootParent = yield* makeTemporaryDirectory("scient-plugin-link-");
      const linkedRoot = NodePath.join(linkedRootParent, "bundle");
      const real = yield* writeBundle(bundleFiles());
      yield* Effect.promise(() => NodeFSP.symlink(real, linkedRoot));

      yield* Effect.gen(function* () {
        const registry = yield* ScientPluginRegistry;
        const stateDir = yield* stateDirectory;
        const linkedFile = yield* expectRejected(registry.install({ path: withLink }));
        expect(linkedFile.reason).toBe("invalid-input");
        expect(linkedFile.message).toContain("symbolic link");
        const linkedDirectory = yield* expectRejected(registry.install({ path: linkedRoot }));
        expect(linkedDirectory.message).toContain("real directory");
        const relative = yield* expectRejected(registry.install({ path: "relative/bundle" }));
        expect(relative.message).toContain("absolute");
        expect(bundlePlugin((yield* registry.list()).plugins)).toBeUndefined();
        expect(yield* installedDirectories(stateDir)).toEqual([]);
        expect(runtime.connectors()).toEqual([]);
      }).pipe(Effect.provide(serverLayer(baseDir, runtime.shape)));
    }),
  );

  it.effect(
    "rejects skills that claim another origin, shadow a Scient skill, or a reserved id",
    () =>
      Effect.gen(function* () {
        const baseDir = yield* makeTemporaryDirectory("scient-plugins-state-");
        const runtime = makeConnectorRuntime();
        const foreignOrigin = bundleFiles();
        foreignOrigin["skills/lab-notes/scient.skill.json"] = foreignOrigin[
          "skills/lab-notes/scient.skill.json"
        ]!.replace('"addonId":"acme.lab"', '"addonId":"other.lab"');
        const foreign = yield* writeBundle(foreignOrigin);
        const shadow = yield* writeBundle(bundleFiles({ skill: "pdf-authoring" }));
        const reserved = yield* writeBundle(bundleFiles({ id: "scient.sources" }));
        yield* Effect.gen(function* () {
          const registry = yield* ScientPluginRegistry;
          expect((yield* expectRejected(registry.install({ path: foreign }))).message).toContain(
            "must declare origin",
          );
          expect((yield* expectRejected(registry.install({ path: shadow }))).message).toContain(
            "conflicts",
          );
          expect((yield* expectRejected(registry.install({ path: reserved }))).message).toContain(
            "reserved",
          );
          expect(runtime.connectors()).toEqual([]);
        }).pipe(Effect.provide(serverLayer(baseDir, runtime.shape)));
      }),
  );

  it.effect(
    "offers bundle skills in the catalog without activating them, and only while enabled",
    () =>
      Effect.gen(function* () {
        const baseDir = yield* makeTemporaryDirectory("scient-plugins-state-");
        const runtime = makeConnectorRuntime();
        const source = yield* writeBundle(bundleFiles());
        yield* Effect.gen(function* () {
          const registry = yield* ScientPluginRegistry;
          const management = yield* ScientSkillManagement.ScientSkillManagement;
          yield* registry.install({ path: source });

          const addon = (yield* management.list()).skills.find(
            (skill) => skill.name === "lab-notes",
          );
          expect(addon).toMatchObject({
            id: "acme.lab.lab-notes",
            origin: "addon:acme.lab@1.0.0",
            scope: "user",
            defaultActive: false,
            active: false,
          });
          const activated = yield* management.setUserActivation({
            releaseKey: addon!.releaseKey,
            active: true,
            invocationPolicy: "explicit",
          });
          expect(activated.skills.find((skill) => skill.name === "lab-notes")?.active).toBe(true);

          yield* registry.setEnabled({ pluginId: "acme.lab", enabled: false });
          expect(
            (yield* management.list()).skills.some((skill) => skill.name === "lab-notes"),
          ).toBe(false);
          expect(runtime.connectors().map((connector) => connector.enabled)).toEqual([false]);
          expect(bundlePlugin((yield* registry.list()).plugins)?.enabled).toBe(false);

          // Re-enabling restores the user's own choice rather than a plugin default.
          yield* registry.setEnabled({ pluginId: "acme.lab", enabled: true });
          expect(
            (yield* management.list()).skills.find((skill) => skill.name === "lab-notes"),
          ).toMatchObject({ active: true, invocationPolicy: "explicit" });
          expect(runtime.connectors().map((connector) => connector.enabled)).toEqual([true]);
        }).pipe(Effect.provide(serverLayer(baseDir, runtime.shape)));
      }),
  );

  it.effect("removal deletes the installed files, its connectors and its skills", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeTemporaryDirectory("scient-plugins-state-");
      const runtime = makeConnectorRuntime();
      const source = yield* writeBundle(
        bundleFiles({
          connectors: [
            { url: "https://mcp.acme.example/mcp", displayName: "Acme" },
            { url: "https://tools.acme.example/mcp", displayName: "Acme tools" },
          ],
        }),
      );
      yield* Effect.gen(function* () {
        const registry = yield* ScientPluginRegistry;
        const management = yield* ScientSkillManagement.ScientSkillManagement;
        const stateDir = yield* stateDirectory;
        const changes = yield* registry.changes.pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        yield* registry.install({ path: source });
        expect(runtime.connectors()).toHaveLength(2);
        yield* registry.remove({ pluginId: "acme.lab" });

        expect(runtime.connectors()).toEqual([]);
        expect(yield* installedDirectories(stateDir)).toEqual([]);
        expect(bundlePlugin((yield* registry.list()).plugins)).toBeUndefined();
        expect((yield* management.list()).skills.some((skill) => skill.name === "lab-notes")).toBe(
          false,
        );
        const persisted = JSON.parse(
          yield* Effect.promise(() =>
            NodeFSP.readFile(
              NodePath.join(stateDir, PluginRegistry.SCIENT_PLUGINS_STATE_FILE),
              "utf8",
            ),
          ),
        );
        expect(persisted.plugins).toEqual([]);
        expect((yield* expectRejected(registry.remove({ pluginId: "acme.lab" }))).reason).toBe(
          "not-found",
        );
        expect(yield* Fiber.join(changes)).toHaveLength(2);
      }).pipe(Effect.provide(serverLayer(baseDir, runtime.shape)));
    }),
  );

  it.effect("preserves an unreadable state file and refuses changes", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeTemporaryDirectory("scient-plugins-state-");
      const runtime = makeConnectorRuntime();
      const source = yield* writeBundle(bundleFiles());
      const statePath = yield* Effect.gen(function* () {
        const stateDir = yield* stateDirectory;
        const path = NodePath.join(stateDir, PluginRegistry.SCIENT_PLUGINS_STATE_FILE);
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(stateDir, { recursive: true });
          await NodeFSP.writeFile(path, "{ not json");
        });
        return path;
      }).pipe(
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), baseDir).pipe(Layer.provide(NodeServices.layer)),
        ),
      );
      yield* Effect.gen(function* () {
        const registry = yield* ScientPluginRegistry;
        expect((yield* registry.list()).diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
          "state-unreadable",
        ]);
        expect((yield* expectRejected(registry.install({ path: source }))).reason).toBe(
          "state-unavailable",
        );
        expect(yield* Effect.promise(() => NodeFSP.readFile(statePath, "utf8"))).toBe("{ not json");
      }).pipe(Effect.provide(serverLayer(baseDir, runtime.shape)));
    }),
  );

  it.effect("keeps unreadable records when it rewrites the state", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeTemporaryDirectory("scient-plugins-state-");
      const runtime = makeConnectorRuntime();
      const source = yield* writeBundle(bundleFiles());
      const unknownRecord = { pluginId: "future.plugin", schema: "from a newer Scient" };
      const statePath = yield* Effect.gen(function* () {
        const stateDir = yield* stateDirectory;
        const path = NodePath.join(stateDir, PluginRegistry.SCIENT_PLUGINS_STATE_FILE);
        yield* Effect.promise(async () => {
          await NodeFSP.mkdir(stateDir, { recursive: true });
          await NodeFSP.writeFile(
            path,
            JSON.stringify({ formatVersion: 1, plugins: [unknownRecord] }),
          );
        });
        return path;
      }).pipe(
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), baseDir).pipe(Layer.provide(NodeServices.layer)),
        ),
      );
      yield* Effect.gen(function* () {
        const registry = yield* ScientPluginRegistry;
        expect((yield* registry.list()).diagnostics).toEqual([
          expect.objectContaining({ code: "plugin-invalid" }),
        ]);
        yield* registry.install({ path: source });
        const persisted = JSON.parse(
          yield* Effect.promise(() => NodeFSP.readFile(statePath, "utf8")),
        );
        expect(persisted.plugins).toEqual([
          expect.objectContaining({ pluginId: "acme.lab" }),
          unknownRecord,
        ]);
      }).pipe(Effect.provide(serverLayer(baseDir, runtime.shape)));
    }),
  );

  it.effect(
    "an interrupted install still commits atomically, and a later change waits for it",
    () =>
      Effect.gen(function* () {
        const baseDir = yield* makeTemporaryDirectory("scient-plugins-state-");
        const runtime = makeConnectorRuntime();
        const source = yield* writeBundle(bundleFiles());
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        runtime.faults.beforeAdd = Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
        );
        yield* Effect.gen(function* () {
          const registry = yield* ScientPluginRegistry;
          const installing = yield* Effect.forkChild(registry.install({ path: source }));
          yield* Deferred.await(entered);
          const interrupting = yield* Effect.forkChild(Fiber.interrupt(installing));
          // Queued behind the install; it would fail with not-found if it ran first.
          const disabling = yield* Effect.forkChild(
            registry.setEnabled({ pluginId: "acme.lab", enabled: false }),
          );
          yield* Effect.yieldNow;
          runtime.faults.beforeAdd = undefined;
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(interrupting);
          yield* Fiber.join(disabling);
          expect(bundlePlugin((yield* registry.list()).plugins)?.enabled).toBe(false);
          expect(runtime.connectors().map((connector) => connector.enabled)).toEqual([false]);
        }).pipe(Effect.provide(serverLayer(baseDir, runtime.shape)));

        // Disk agrees with what the first server published.
        yield* Effect.gen(function* () {
          const registry = yield* ScientPluginRegistry;
          const { plugins, diagnostics } = yield* registry.list();
          expect(diagnostics).toEqual([]);
          expect(bundlePlugin(plugins)).toMatchObject({
            enabled: false,
            connectorIds: runtime.connectors().map((connector) => connector.connectorId),
          });
        }).pipe(Effect.provide(serverLayer(baseDir, runtime.shape)));
      }),
  );

  it.effect(
    "never leaves a disabled plugin with enabled connectors, even after a failed update",
    () =>
      Effect.gen(function* () {
        const baseDir = yield* makeTemporaryDirectory("scient-plugins-state-");
        const runtime = makeConnectorRuntime();
        const source = yield* writeBundle(
          bundleFiles({
            connectors: [
              { url: "https://mcp.acme.example/mcp", displayName: "Acme" },
              { url: "https://tools.acme.example/mcp", displayName: "Acme tools" },
            ],
          }),
        );
        yield* Effect.gen(function* () {
          const registry = yield* ScientPluginRegistry;
          yield* registry.install({ path: source });
          const [first, second] = runtime.connectors();
          runtime.patch(first!.connectorId, { status: "connected" });
          runtime.patch(second!.connectorId, { status: "connected" });
          runtime.faults.update = (connectorId) => connectorId === second!.connectorId;
          yield* expectRejected(registry.setEnabled({ pluginId: "acme.lab", enabled: false }));
          // The plugin stays enabled; revocation went first and only partly through.
          expect(bundlePlugin((yield* registry.list()).plugins)?.enabled).toBe(true);
          runtime.faults.update = undefined;
          yield* registry.setEnabled({ pluginId: "acme.lab", enabled: false });
          expect(runtime.connectors().map((connector) => connector.enabled)).toEqual([
            false,
            false,
          ]);
          // Drift outside the registry (a manual toggle) is corrected on the next start.
          runtime.patch(first!.connectorId, { enabled: true });
        }).pipe(Effect.provide(serverLayer(baseDir, runtime.shape)));

        yield* Effect.gen(function* () {
          yield* ScientPluginRegistry;
          expect(runtime.connectors().map((connector) => connector.enabled)).toEqual([
            false,
            false,
          ]);
        }).pipe(Effect.provide(serverLayer(baseDir, runtime.shape)));
      }),
  );

  it.effect("disables a tampered plugin's signed-in connectors until it is reinstalled", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeTemporaryDirectory("scient-plugins-state-");
      const runtime = makeConnectorRuntime();
      const source = yield* writeBundle(bundleFiles());
      const installedManifest = yield* Effect.gen(function* () {
        const registry = yield* ScientPluginRegistry;
        const stateDir = yield* stateDirectory;
        yield* registry.install({ path: source });
        runtime.patch(runtime.connectors()[0]!.connectorId, { status: "connected" });
        const [directory] = yield* installedDirectories(stateDir);
        return NodePath.join(stateDir, "scient-plugins", directory!, "scient.plugin.json");
      }).pipe(Effect.provide(serverLayer(baseDir, runtime.shape)));
      yield* Effect.promise(() => NodeFSP.appendFile(installedManifest, " "));

      yield* Effect.gen(function* () {
        const registry = yield* ScientPluginRegistry;
        expect(runtime.connectors()).toMatchObject([{ status: "connected", enabled: false }]);
        // Enabling an unverified copy does not re-grant its connectors.
        yield* registry.setEnabled({ pluginId: "acme.lab", enabled: true });
        expect(runtime.connectors()[0]?.enabled).toBe(false);
        yield* registry.install({ path: source });
        expect(runtime.connectors()).toMatchObject([{ status: "connected", enabled: true }]);
      }).pipe(Effect.provide(serverLayer(baseDir, runtime.shape)));
    }),
  );

  it.effect("disables plugin connectors while the state file is unreadable", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeTemporaryDirectory("scient-plugins-state-");
      const runtime = makeConnectorRuntime();
      const source = yield* writeBundle(bundleFiles());
      const statePath = yield* Effect.gen(function* () {
        const registry = yield* ScientPluginRegistry;
        yield* registry.install({ path: source });
        return NodePath.join(yield* stateDirectory, PluginRegistry.SCIENT_PLUGINS_STATE_FILE);
      }).pipe(Effect.provide(serverLayer(baseDir, runtime.shape)));
      yield* Effect.promise(() => NodeFSP.writeFile(statePath, "{ truncated"));
      yield* Effect.gen(function* () {
        yield* ScientPluginRegistry;
        expect(runtime.connectors()).toMatchObject([{ enabled: false }]);
      }).pipe(Effect.provide(serverLayer(baseDir, runtime.shape)));
    }),
  );

  it.effect(
    "needs a fresh activation when a reinstall changes skill bytes under the same version",
    () =>
      Effect.gen(function* () {
        const baseDir = yield* makeTemporaryDirectory("scient-plugins-state-");
        const runtime = makeConnectorRuntime();
        const source = yield* writeBundle(bundleFiles());
        yield* Effect.gen(function* () {
          const registry = yield* ScientPluginRegistry;
          const management = yield* ScientSkillManagement.ScientSkillManagement;
          yield* registry.install({ path: source });
          const before = (yield* management.list()).skills.find(
            (skill) => skill.name === "lab-notes",
          );
          yield* management.setUserActivation({
            releaseKey: before!.releaseKey,
            active: true,
            invocationPolicy: "automatic",
          });
          yield* Effect.promise(() =>
            NodeFSP.appendFile(NodePath.join(source, "skills/lab-notes/SKILL.md"), "New step.\n"),
          );
          yield* registry.install({ path: source });
          const after = (yield* management.list()).skills.find(
            (skill) => skill.name === "lab-notes",
          );
          expect(after).toMatchObject({ origin: before!.origin, version: before!.version });
          expect(after?.releaseKey).not.toBe(before!.releaseKey);
          expect(after?.active).toBe(false);
        }).pipe(Effect.provide(serverLayer(baseDir, runtime.shape)));
      }),
  );

  it.effect(
    "fails a reinstall that cannot retire a dropped connector and converges afterwards",
    () =>
      Effect.gen(function* () {
        const baseDir = yield* makeTemporaryDirectory("scient-plugins-state-");
        const runtime = makeConnectorRuntime();
        const original = yield* writeBundle(bundleFiles());
        const replacement = yield* writeBundle(
          bundleFiles({
            version: "2.0.0",
            connectors: [{ url: "https://next.acme.example/mcp", displayName: "Acme next" }],
          }),
        );
        yield* Effect.gen(function* () {
          const registry = yield* ScientPluginRegistry;
          yield* registry.install({ path: original });
          const [dropped] = runtime.connectors();
          runtime.patch(dropped!.connectorId, { status: "connected" });
          // Retiring the dropped connector fails, and so does rolling back the new one.
          runtime.faults.remove = () => true;
          yield* expectRejected(registry.install({ path: replacement }));
          const kept = bundlePlugin((yield* registry.list()).plugins)!;
          expect(kept).toMatchObject({ version: "1.0.0", connectorIds: [dropped!.connectorId] });
          expect(runtime.connectors()).toHaveLength(2);

          // The next change reconciles: the never-committed connector is removed.
          runtime.faults.remove = undefined;
          yield* registry.setEnabled({ pluginId: "acme.lab", enabled: true });
          expect(runtime.connectors().map((connector) => connector.connectorId)).toEqual([
            dropped!.connectorId,
          ]);
          yield* registry.install({ path: replacement });
          expect(runtime.connectors()).toMatchObject([{ url: "https://next.acme.example/mcp" }]);
          expect(bundlePlugin((yield* registry.list()).plugins)?.version).toBe("2.0.0");
        }).pipe(Effect.provide(serverLayer(baseDir, runtime.shape)));
      }),
  );

  it.effect("removes orphaned connectors and leftover copies after a crash", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeTemporaryDirectory("scient-plugins-state-");
      const runtime = makeConnectorRuntime();
      const source = yield* writeBundle(bundleFiles());
      const stateDir = yield* Effect.gen(function* () {
        const registry = yield* ScientPluginRegistry;
        yield* registry.install({ path: source });
        return yield* stateDirectory;
      }).pipe(Effect.provide(serverLayer(baseDir, runtime.shape)));
      const [installedDirectory] = yield* installedDirectories(stateDir);
      // A crash before an install committed: connectors and files without a record.
      yield* runtime.shape.addFromPlugin({
        pluginId: "acme.lab",
        url: "https://uncommitted.acme.example/mcp",
        displayName: "Uncommitted",
        description: undefined,
      });
      yield* runtime.shape.addFromPlugin({
        pluginId: "ghost.plugin",
        url: "https://ghost.example/mcp",
        displayName: "Ghost",
        description: undefined,
      });
      yield* Effect.promise(async () => {
        const storage = NodePath.join(stateDir, PluginRegistry.SCIENT_PLUGINS_DIRECTORY);
        await NodeFSP.mkdir(NodePath.join(storage, ".staging-crashed"), { recursive: true });
        await NodeFSP.writeFile(NodePath.join(storage, ".staging-crashed", "x"), "x");
        await NodeFSP.mkdir(NodePath.join(storage, "acme.lab@0.9.0-aaaaaaaaaaaa"));
      });

      yield* Effect.gen(function* () {
        const registry = yield* ScientPluginRegistry;
        expect(runtime.connectors().map((connector) => connector.url)).toEqual([
          "https://mcp.acme.example/mcp",
        ]);
        expect(yield* installedDirectories(stateDir)).toEqual([installedDirectory]);
        expect((yield* registry.list()).diagnostics).toEqual([]);
      }).pipe(Effect.provide(serverLayer(baseDir, runtime.shape)));
    }),
  );

  it.effect(
    "grants plugin connectors only for enabled, verified owners, even when writes fail",
    () =>
      Effect.gen(function* () {
        const baseDir = yield* makeTemporaryDirectory("scient-plugins-state-");
        const runtime = makeConnectorRuntime();
        const source = yield* writeBundle(bundleFiles());
        const urlConnector: ConnectorSummary = {
          connectorId: ConnectorId.make("con_userurl00001"),
          serverName: "user-url",
          displayName: "User URL",
          url: "https://user.example/mcp",
          source: { type: "url" },
          auth: { type: "none" },
          status: "connected",
          enabled: true,
          availability: { type: "all-projects" },
          createdAt: "2026-10-21T00:00:00.000Z",
          updatedAt: "2026-10-21T00:00:00.000Z",
        };
        const { installedManifest, stateDir } = yield* Effect.gen(function* () {
          const registry = yield* ScientPluginRegistry;
          // Connectors not sourced from a plugin are never gated here.
          expect(yield* isEligible(urlConnector)).toBe(true);
          yield* registry.install({ path: source });
          const [owned] = runtime.connectors();
          runtime.patch(owned!.connectorId, { status: "connected" });
          expect(yield* isEligible(owned!)).toBe(true);

          // A direct toggle cannot re-grant a disabled plugin's connector.
          yield* registry.setEnabled({ pluginId: "acme.lab", enabled: false });
          expect(yield* isEligible(owned!)).toBe(false);
          const toggle = yield* expectRejected(
            runtime.shape.update({ connectorId: owned!.connectorId, enabled: true }),
          );
          expect(toggle.reason).toBe("unsupported");
          expect(runtime.connectors()[0]?.enabled).toBe(false);
          yield* registry.setEnabled({ pluginId: "acme.lab", enabled: true });
          expect(yield* isEligible(owned!)).toBe(true);

          const stateDir = yield* stateDirectory;
          const [directory] = yield* installedDirectories(stateDir);
          return {
            stateDir,
            installedManifest: NodePath.join(
              stateDir,
              "scient-plugins",
              directory!,
              "scient.plugin.json",
            ),
          };
        }).pipe(Effect.provide(serverLayer(baseDir, runtime.shape)));

        // Tampered copy and an orphan, while every revoking write fails.
        yield* Effect.promise(() => NodeFSP.appendFile(installedManifest, " "));
        yield* runtime.shape.addFromPlugin({
          pluginId: "ghost.plugin",
          url: "https://ghost.example/mcp",
          displayName: "Ghost",
          description: undefined,
        });
        runtime.faults.update = () => true;
        runtime.faults.remove = () => true;
        yield* Effect.gen(function* () {
          const registry = yield* ScientPluginRegistry;
          const [owned, orphan] = runtime.connectors();
          expect(owned).toMatchObject({ status: "connected", enabled: true });
          expect(orphan).toMatchObject({ enabled: true });
          expect(yield* isEligible(owned!)).toBe(false);
          expect(yield* isEligible(orphan!)).toBe(false);
          expect(
            (yield* registry.list()).diagnostics.filter(
              (diagnostic) =>
                diagnostic.subject === "acme.lab" || diagnostic.subject === "ghost.plugin",
            ),
          ).toHaveLength(3);
        }).pipe(Effect.provide(serverLayer(baseDir, runtime.shape)));

        // Unreadable plugin state: ownership unknown, every plugin connector denied.
        yield* Effect.promise(() =>
          NodeFSP.writeFile(
            NodePath.join(stateDir, PluginRegistry.SCIENT_PLUGINS_STATE_FILE),
            "{ truncated",
          ),
        );
        yield* Effect.gen(function* () {
          yield* ScientPluginRegistry;
          for (const connector of runtime.connectors()) {
            expect(yield* isEligible(connector)).toBe(false);
          }
        }).pipe(Effect.provide(serverLayer(baseDir, runtime.shape)));
      }),
  );

  it.effect("a failed repair install never re-grants a tampered plugin's connector", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeTemporaryDirectory("scient-plugins-state-");
      const runtime = makeConnectorRuntime();
      const source = yield* writeBundle(bundleFiles());
      const stateDir = yield* Effect.gen(function* () {
        const registry = yield* ScientPluginRegistry;
        yield* registry.install({ path: source });
        runtime.patch(runtime.connectors()[0]!.connectorId, { status: "connected" });
        return yield* stateDirectory;
      }).pipe(Effect.provide(serverLayer(baseDir, runtime.shape)));
      const [directory] = yield* installedDirectories(stateDir);
      yield* Effect.promise(() =>
        NodeFSP.appendFile(
          NodePath.join(stateDir, "scient-plugins", directory!, "scient.plugin.json"),
          " ",
        ),
      );

      yield* Effect.gen(function* () {
        const registry = yield* ScientPluginRegistry;
        const [connector] = runtime.connectors();
        expect(connector).toMatchObject({ status: "connected", enabled: false });
        // The state file cannot be replaced: the repair cannot commit.
        yield* Effect.promise(() => NodeFSP.chmod(stateDir, 0o500));
        const failure = yield* expectRejected(registry.install({ path: source })).pipe(
          Effect.ensuring(Effect.promise(() => NodeFSP.chmod(stateDir, 0o700))),
        );
        expect(failure.reason).toBe("state-unavailable");
        expect(runtime.connectors()[0]?.enabled).toBe(false);
        expect(yield* isEligible(connector!)).toBe(false);
      }).pipe(Effect.provide(serverLayer(baseDir, runtime.shape)));

      yield* Effect.gen(function* () {
        const registry = yield* ScientPluginRegistry;
        expect(runtime.connectors()[0]?.enabled).toBe(false);
        // A committed repair re-grants the retained, signed-in connector.
        yield* registry.install({ path: source });
        const [connector] = runtime.connectors();
        expect(connector).toMatchObject({ status: "connected", enabled: true });
        expect(yield* isEligible(connector!)).toBe(true);
      }).pipe(Effect.provide(serverLayer(baseDir, runtime.shape)));
    }),
  );

  it.effect("never commits state the next start could not read", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeTemporaryDirectory("scient-plugins-state-");
      const runtime = makeConnectorRuntime();
      const source = yield* writeBundle(bundleFiles());
      const stateDir = yield* stateDirectory.pipe(
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), baseDir).pipe(Layer.provide(NodeServices.layer)),
        ),
      );
      const statePath = NodePath.join(stateDir, PluginRegistry.SCIENT_PLUGINS_STATE_FILE);
      /** A state file of exactly `bytes`, holding one record a newer Scient wrote. */
      const writeStateOfSize = (bytes: number) =>
        Effect.promise(async () => {
          const empty = JSON.stringify({
            formatVersion: 1,
            plugins: [{ pluginId: "future.plugin", blob: "" }],
          });
          const contents = JSON.stringify({
            formatVersion: 1,
            plugins: [{ pluginId: "future.plugin", blob: "x".repeat(bytes - empty.length) }],
          });
          await NodeFSP.mkdir(stateDir, { recursive: true });
          await NodeFSP.writeFile(statePath, contents);
          return contents;
        });
      const readState = Effect.promise(() => NodeFSP.readFile(statePath, "utf8"));

      // Over budget: refused, nothing written, pre-commit work rolled back.
      const nearlyFull = yield* writeStateOfSize(PluginRegistry.MAX_STATE_BYTES - 100);
      yield* Effect.gen(function* () {
        const registry = yield* ScientPluginRegistry;
        const error = yield* expectRejected(registry.install({ path: source }));
        expect(error.reason).toBe("limit-reached");
        expect(yield* readState).toBe(nearlyFull);
        expect(runtime.connectors()).toEqual([]);
        expect(yield* installedDirectories(stateDir)).toEqual([]);
        expect(bundlePlugin((yield* registry.list()).plugins)).toBeUndefined();
      }).pipe(Effect.provide(serverLayer(baseDir, runtime.shape)));

      // Within budget: accepted, and the next start reads it back.
      yield* writeStateOfSize(PluginRegistry.MAX_STATE_BYTES - 4_000);
      yield* Effect.gen(function* () {
        const registry = yield* ScientPluginRegistry;
        yield* registry.install({ path: source });
        expect(Buffer.byteLength(yield* readState)).toBeLessThanOrEqual(
          PluginRegistry.MAX_STATE_BYTES,
        );
      }).pipe(Effect.provide(serverLayer(baseDir, runtime.shape)));
      yield* Effect.gen(function* () {
        const registry = yield* ScientPluginRegistry;
        const { plugins, diagnostics } = yield* registry.list();
        expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["plugin-invalid"]);
        expect(diagnostics[0]?.subject).toBe(PluginRegistry.SCIENT_PLUGINS_STATE_FILE);
        expect(bundlePlugin(plugins)).toMatchObject({
          enabled: true,
          connectorIds: runtime.connectors().map((connector) => connector.connectorId),
        });
        // Ownership of connectors removed elsewhere is not kept, so it cannot pile up.
        yield* runtime.shape.remove({ connectorId: runtime.connectors()[0]!.connectorId });
        yield* registry.setEnabled({ pluginId: "acme.lab", enabled: true });
        expect(JSON.parse(yield* readState).plugins[0].connectors).toEqual([]);
      }).pipe(Effect.provide(serverLayer(baseDir, runtime.shape)));
    }),
  );

  it.effect("keeps connector ownership while the connector store cannot be read", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeTemporaryDirectory("scient-plugins-state-");
      const runtime = makeConnectorRuntime();
      const source = yield* writeBundle(bundleFiles());
      const other = yield* writeBundle(
        bundleFiles({ id: "zeta.lab", skill: "zeta-notes", connectors: [] }),
      );
      const owned = yield* Effect.gen(function* () {
        const registry = yield* ScientPluginRegistry;
        yield* registry.install({ path: source });
        const [connector] = runtime.connectors();
        runtime.patch(connector!.connectorId, { status: "connected" });

        runtime.faults.unreadableStore = true;
        // Commits that touch every plugin record while the inventory is degraded.
        yield* registry.setEnabled({ pluginId: "acme.lab", enabled: false });
        yield* registry.setEnabled({ pluginId: "acme.lab", enabled: true });
        yield* registry.install({ path: other });
        // Changing the plugin's own connectors needs a complete inventory.
        expect((yield* expectRejected(registry.install({ path: source }))).reason).toBe(
          "state-unavailable",
        );
        const statePath = NodePath.join(
          yield* stateDirectory,
          PluginRegistry.SCIENT_PLUGINS_STATE_FILE,
        );
        const persisted = JSON.parse(
          yield* Effect.promise(() => NodeFSP.readFile(statePath, "utf8")),
        );
        expect(
          persisted.plugins.find((record: { pluginId: string }) => record.pluginId === "acme.lab")
            .connectors,
        ).toEqual([{ connectorId: connector!.connectorId, url: connector!.url }]);
        return connector!;
      }).pipe(Effect.provide(serverLayer(baseDir, runtime.shape)));

      // The store is repaired: the connector is still owned, not removed as an orphan.
      runtime.faults.unreadableStore = false;
      yield* Effect.gen(function* () {
        const registry = yield* ScientPluginRegistry;
        expect(runtime.connectors()).toMatchObject([
          { connectorId: owned.connectorId, status: "connected", enabled: true },
        ]);
        expect(bundlePlugin((yield* registry.list()).plugins)?.connectorIds).toEqual([
          owned.connectorId,
        ]);
        expect(yield* isEligible(owned)).toBe(true);
      }).pipe(Effect.provide(serverLayer(baseDir, runtime.shape)));
    }),
  );

  it.effect("rejects an over-budget replacement before retiring any connector", () =>
    Effect.gen(function* () {
      const baseDir = yield* makeTemporaryDirectory("scient-plugins-state-");
      const runtime = makeConnectorRuntime();
      const original = yield* writeBundle(bundleFiles());
      // Same metadata size; only the ten new connectors (about 15 KB of
      // ownership entries) push the state over budget, so the preflight must
      // count connectors that do not exist yet.
      const replacement = yield* writeBundle(
        bundleFiles({
          version: "2.0.0",
          connectors: Array.from({ length: 10 }, (_, index) => ({
            url: `https://next.acme.example/mcp/${index}/${"a".repeat(1_450)}`,
            displayName: `Acme next ${index}`,
          })),
        }),
      );
      const { statePath, connector } = yield* Effect.gen(function* () {
        const registry = yield* ScientPluginRegistry;
        yield* registry.install({ path: original });
        const [installed] = runtime.connectors();
        runtime.patch(installed!.connectorId, { status: "connected" });
        return {
          statePath: NodePath.join(yield* stateDirectory, PluginRegistry.SCIENT_PLUGINS_STATE_FILE),
          connector: installed!,
        };
      }).pipe(Effect.provide(serverLayer(baseDir, runtime.shape)));

      // Fill the state to 8 KB below the budget with a record a newer Scient wrote.
      const filled = yield* Effect.promise(async () => {
        const state = JSON.parse(await NodeFSP.readFile(statePath, "utf8"));
        const withBlob = (blob: string) =>
          JSON.stringify({
            formatVersion: 1,
            plugins: [...state.plugins, { pluginId: "future.plugin", blob }],
          });
        const contents = withBlob(
          "x".repeat(PluginRegistry.MAX_STATE_BYTES - 8_000 - withBlob("").length),
        );
        await NodeFSP.writeFile(statePath, contents);
        return contents;
      });

      yield* Effect.gen(function* () {
        const registry = yield* ScientPluginRegistry;
        const error = yield* expectRejected(registry.install({ path: replacement }));
        expect(error.reason).toBe("limit-reached");
        // Nothing was created or retired; the signed-in connector is untouched.
        expect(runtime.connectors()).toEqual([{ ...connector, status: "connected" }]);
        expect(yield* Effect.promise(() => NodeFSP.readFile(statePath, "utf8"))).toBe(filled);
      }).pipe(Effect.provide(serverLayer(baseDir, runtime.shape)));

      yield* Effect.gen(function* () {
        const registry = yield* ScientPluginRegistry;
        expect(bundlePlugin((yield* registry.list()).plugins)).toMatchObject({
          version: "1.0.0",
          connectorIds: [connector.connectorId],
        });
        expect(runtime.connectors()).toMatchObject([
          { connectorId: connector.connectorId, status: "connected", enabled: true },
        ]);
      }).pipe(Effect.provide(serverLayer(baseDir, runtime.shape)));
    }),
  );
});
