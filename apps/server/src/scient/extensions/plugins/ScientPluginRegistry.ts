// @effect-diagnostics nodeBuiltinImport:off -- Plugin bundle storage is a Node filesystem boundary, like skill releases.
/**
 * Never execute bundle content. Publish enabled/verified ownership for grant-time checks, and
 * reconcile declared URLs at startup/before changes so crashes or failed writes cannot retain
 * orphan authority. Disabled/unverified ownership must revoke delivery independently of durable
 * connector writes.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  loadEmbeddedSkillRelease,
  skillOriginKey,
  SKILL_DOCUMENT_FILE,
  type SkillRelease,
} from "@scientfactory/scient-skills";
import {
  ConnectorId,
  ExtensionsError,
  ScientPluginId,
  TrimmedNonEmptyString,
  type ExtensionComponent,
  type ExtensionsDiagnostic,
  type ScientPluginSummary,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../../config.ts";
import * as ScientSkillRegistry from "../../skills/ScientSkillRegistry.ts";
import {
  ConnectorRuntime,
  ScientPluginRegistry,
  type ScientPluginRegistryShape,
} from "../ExtensionsServices.ts";
import { BUILT_IN_SCIENT_PLUGINS, isReservedScientPluginId } from "./BuiltInPlugins.ts";
import { BundleRejected, snapshotBundle, type BundleSnapshot } from "./BundleSnapshot.ts";
import { PluginConnectorEligibility } from "./PluginConnectorEligibility.ts";
import {
  parseScientPluginManifest,
  SCIENT_PLUGIN_MANIFEST_FILE,
  type ScientPluginManifest,
} from "./ScientPluginManifest.ts";

export const SCIENT_PLUGINS_STATE_FILE = "scient-plugins.json";
export const SCIENT_PLUGINS_DIRECTORY = "scient-plugins";
/** One budget for writing and reading `scient-plugins.json`. */
export const MAX_STATE_BYTES = 1024 * 1024;
const MAX_INSTALLED_PLUGINS = 100;
/** The longest id `ConnectorId` admits; sizes connectors not yet created. */
const LONGEST_CONNECTOR_ID = ConnectorId.make(`con_${"0".repeat(64)}`);

const Sha256Digest = Schema.String.check(Schema.isPattern(/^sha256:[0-9a-f]{64}$/u));

const OwnedConnector = Schema.Struct({
  connectorId: ConnectorId,
  /** The URL as declared by the manifest that created it. */
  url: TrimmedNonEmptyString,
});
type OwnedConnector = typeof OwnedConnector.Type;

const InstalledPluginRecord = Schema.Struct({
  pluginId: ScientPluginId,
  version: TrimmedNonEmptyString,
  digest: Sha256Digest,
  /** `<id>@<version>-<digest12>` beneath `<stateDir>/scient-plugins`. */
  directory: Schema.String.check(Schema.isPattern(/^[a-z0-9.-]+@[0-9A-Za-z.+-]+-[0-9a-f]{12}$/u)),
  displayName: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  publisher: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  installedAt: TrimmedNonEmptyString,
  /** Connectors this plugin created; any other plugin-sourced connector is an orphan. */
  connectors: Schema.Array(OwnedConnector),
});
type InstalledPluginRecord = typeof InstalledPluginRecord.Type;

const PersistedPluginsState = Schema.Struct({
  formatVersion: Schema.Literal(1),
  /** Entries are decoded one by one so an unreadable entry is preserved, not dropped. */
  plugins: Schema.Array(Schema.Unknown),
});
const PersistedPluginsStateJson = Schema.fromJsonString(PersistedPluginsState);
const decodePersistedPluginsState = Schema.decodeUnknownExit(PersistedPluginsStateJson);
const encodePersistedPluginsState = Schema.encodeEffect(PersistedPluginsStateJson);
const decodeInstalledPluginRecord = Schema.decodeUnknownExit(InstalledPluginRecord);

interface LoadedBundle {
  readonly manifest: ScientPluginManifest;
  readonly digest: string;
  readonly releases: ReadonlyArray<SkillRelease>;
}

interface InstalledPlugin {
  readonly record: InstalledPluginRecord;
  /** Absent when the installed copy is missing, changed, or no longer valid. */
  readonly bundle: LoadedBundle | undefined;
  readonly problem: string | undefined;
}

interface RegistryState {
  readonly plugins: ReadonlyArray<InstalledPlugin>;
  /** Unreadable persisted entries, written back verbatim. */
  readonly preserved: ReadonlyArray<unknown>;
  /** The state file itself is unreadable: it is never overwritten and changes are refused. */
  readonly unreadable: boolean;
  readonly skillRejections: ReadonlyArray<ExtensionsDiagnostic>;
  /** Connector or storage cleanup that the latest reconciliation could not finish. */
  readonly cleanupProblems: ReadonlyArray<ExtensionsDiagnostic>;
}

const compareStrings = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const isNodeError = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code;

const invalidInput = (message: string) => new ExtensionsError({ reason: "invalid-input", message });

/** Read-only and cancellable: interruption aborts the scan before any side effect. */
const snapshot = (root: string) =>
  Effect.tryPromise({
    try: (signal) => snapshotBundle(root, { signal }),
    catch: (cause) =>
      cause instanceof BundleRejected
        ? invalidInput(cause.message)
        : new ExtensionsError({
            reason: "invalid-input",
            message: "The plugin bundle could not be read.",
          }),
  });

/** Validate the manifest and load every contributed skill from the in-memory snapshot. */
const loadBundle = Effect.fn("ScientPluginRegistry.loadBundle")(function* (bundle: BundleSnapshot) {
  const manifestFile = bundle.files.find(
    (file) => file.relativePath === SCIENT_PLUGIN_MANIFEST_FILE,
  );
  if (manifestFile === undefined) {
    return yield* invalidInput(`The bundle has no ${SCIENT_PLUGIN_MANIFEST_FILE}.`);
  }
  const manifest = yield* parseScientPluginManifest(manifestFile.bytes);
  const origin = skillOriginKey({
    kind: "addon",
    addonId: manifest.id,
    addonVersion: manifest.version,
  });
  const releases: SkillRelease[] = [];
  for (const directory of manifest.contributes.skills ?? []) {
    const prefix = `${directory}/`;
    const skillFiles = Object.fromEntries(
      bundle.files
        .filter((file) => file.relativePath.startsWith(prefix))
        .map((file) => [file.relativePath.slice(prefix.length), file.bytes] as const),
    );
    if (skillFiles[SKILL_DOCUMENT_FILE] === undefined) {
      return yield* invalidInput(`Contributed skill '${directory}' has no ${SKILL_DOCUMENT_FILE}.`);
    }
    const release = yield* Effect.try({
      try: () => loadEmbeddedSkillRelease(NodePath.posix.basename(directory), skillFiles),
      catch: (cause) =>
        invalidInput(
          `Contributed skill '${directory}' is invalid: ${
            cause instanceof Error ? cause.message : "validation failed"
          }`,
        ),
    });
    if (release.origin !== origin) {
      return yield* invalidInput(
        `Contributed skill '${directory}' must declare origin {"kind":"addon","addonId":"${manifest.id}","addonVersion":"${manifest.version}"} in scient.skill.json.`,
      );
    }
    const clash = releases.find(
      (other) => other.id === release.id || other.name.toLowerCase() === release.name.toLowerCase(),
    );
    if (clash !== undefined) {
      return yield* invalidInput(
        `Contributed skills '${clash.name}' and '${release.name}' share an id or name.`,
      );
    }
    releases.push(release);
  }
  return { manifest, digest: bundle.digest, releases } satisfies LoadedBundle;
});

const bundleDirectoryName = (manifest: ScientPluginManifest, digest: string): string =>
  `${manifest.id}@${manifest.version}-${digest.slice("sha256:".length, "sha256:".length + 12)}`;

const normalizedUrl = (url: string): string => (URL.canParse(url) ? new URL(url).href : url);

const cleanupProblem = (subject: string, message: string, error: ExtensionsError) =>
  ({
    code: "plugin-invalid",
    subject,
    message: `${message} ${error.message}`,
  }) satisfies ExtensionsDiagnostic;

const make = Effect.fn("ScientPluginRegistry.make")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const skillRegistry = yield* ScientSkillRegistry.ScientSkillRegistry;
  const connectors = yield* ConnectorRuntime;
  const eligibility = yield* PluginConnectorEligibility;
  const statePath = NodePath.join(config.stateDir, SCIENT_PLUGINS_STATE_FILE);
  const bundlesRoot = NodePath.join(config.stateDir, SCIENT_PLUGINS_DIRECTORY);
  const writePermit = yield* Semaphore.make(1);
  const changes = yield* PubSub.unbounded<void>();

  const readPersisted = Effect.tryPromise({
    try: async (): Promise<
      | { readonly status: "absent" }
      | { readonly status: "unreadable" }
      | { readonly status: "read"; readonly entries: ReadonlyArray<unknown> }
    > => {
      let stat;
      try {
        stat = await NodeFSP.lstat(statePath);
      } catch (error) {
        if (isNodeError(error, "ENOENT")) return { status: "absent" };
        throw error;
      }
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_STATE_BYTES) {
        return { status: "unreadable" };
      }
      const decoded = decodePersistedPluginsState(await NodeFSP.readFile(statePath, "utf8"));
      return Exit.isSuccess(decoded)
        ? { status: "read", entries: decoded.value.plugins }
        : { status: "unreadable" };
    },
    catch: () => undefined,
  }).pipe(Effect.orElseSucceed(() => ({ status: "unreadable" as const })));

  /** Re-snapshot an installed copy and require the digest recorded at install time. */
  const verifyInstalled = (record: InstalledPluginRecord) =>
    snapshot(NodePath.join(bundlesRoot, record.directory)).pipe(
      Effect.flatMap((bundle) =>
        bundle.digest === record.digest
          ? loadBundle(bundle)
          : Effect.fail(
              invalidInput(
                "The installed plugin files changed after installation. Reinstall or remove it.",
              ),
            ),
      ),
      Effect.filterOrFail(
        (bundle) =>
          bundle.manifest.id === record.pluginId && bundle.manifest.version === record.version,
        () => invalidInput("The installed plugin does not match its record."),
      ),
      Effect.match({
        onSuccess: (bundle): InstalledPlugin => ({ record, bundle, problem: undefined }),
        onFailure: (error): InstalledPlugin => ({
          record,
          bundle: undefined,
          problem: error.message,
        }),
      }),
    );

  const persisted = yield* readPersisted;
  const initialPlugins: InstalledPlugin[] = [];
  const preserved: unknown[] = [];
  if (persisted.status === "read") {
    for (const entry of persisted.entries) {
      const decoded = decodeInstalledPluginRecord(entry);
      if (Exit.isFailure(decoded)) {
        preserved.push(entry);
        continue;
      }
      if (initialPlugins.some((plugin) => plugin.record.pluginId === decoded.value.pluginId)) {
        preserved.push(entry);
        continue;
      }
      initialPlugins.push(yield* verifyInstalled(decoded.value));
    }
  }
  if (persisted.status === "unreadable") {
    yield* Effect.logWarning("Scient plugin state is unreadable; it is preserved unchanged.");
  }
  const state = yield* Ref.make<RegistryState>({
    plugins: initialPlugins.sort((left, right) =>
      compareStrings(left.record.pluginId, right.record.pluginId),
    ),
    preserved,
    unreadable: persisted.status === "unreadable",
    skillRejections: [],
    cleanupProblems: [],
  });

  /**
   * Publish committed state: skills of enabled, verified bundles (disabled ones
   * stay installed but withheld) and the connectors they may grant. Grants are
   * gated on this, so revocation does not depend on a connector write.
   */
  const publishState = Effect.gen(function* () {
    const current = yield* Ref.get(state);
    const active = current.plugins.flatMap((plugin) =>
      plugin.record.enabled && plugin.bundle !== undefined
        ? [{ record: plugin.record, bundle: plugin.bundle }]
        : [],
    );
    yield* eligibility.publish(
      current.unreadable
        ? undefined
        : new Set(
            active.flatMap((plugin) => plugin.record.connectors.map((entry) => entry.connectorId)),
          ),
    );
    const rejections = yield* skillRegistry.replaceAddonReleases(
      active.map((plugin) => ({
        addonId: plugin.record.pluginId,
        addonVersion: plugin.record.version,
        releases: plugin.bundle.releases,
      })),
    );
    yield* Ref.update(state, (previous) => ({
      ...previous,
      skillRejections: rejections.map((rejection): ExtensionsDiagnostic => ({
        code: "plugin-invalid",
        subject: rejection.addonId,
        message: rejection.message,
      })),
    }));
  });

  /**
   * Converge connectors and storage on the committed plugin records. Fails
   * closed: when ownership cannot be established (unreadable state or
   * unreadable records), plugin connectors are disabled rather than removed.
   */
  const reconcile = Effect.gen(function* () {
    const current = yield* Ref.get(state);
    const problems: ExtensionsDiagnostic[] = [];
    const inventory = yield* connectors.list();
    const ownershipKnown = !current.unreadable && current.preserved.length === 0;
    for (const connector of inventory.connectors) {
      if (connector.source.type !== "plugin") continue;
      const pluginId = connector.source.pluginId;
      const plugin = current.plugins.find((entry) => entry.record.pluginId === pluginId);
      const owned =
        plugin?.record.connectors.some((entry) => entry.connectorId === connector.connectorId) ??
        false;
      if (!owned && ownershipKnown) {
        yield* connectors
          .remove({ connectorId: connector.connectorId })
          .pipe(
            Effect.catch((error) =>
              Effect.sync(() =>
                problems.push(
                  cleanupProblem(
                    pluginId,
                    `Connector '${connector.displayName}' no longer belongs to an installed plugin and could not be removed.`,
                    error,
                  ),
                ),
              ),
            ),
          );
        continue;
      }
      const eligible =
        owned && plugin !== undefined && plugin.record.enabled && plugin.bundle !== undefined;
      if (!eligible && connector.enabled) {
        yield* connectors
          .update({ connectorId: connector.connectorId, enabled: false })
          .pipe(
            Effect.catch((error) =>
              Effect.sync(() =>
                problems.push(
                  cleanupProblem(
                    pluginId,
                    `Connector '${connector.displayName}' of a disabled or unverified plugin could not be disabled.`,
                    error,
                  ),
                ),
              ),
            ),
          );
      }
    }
    if (ownershipKnown) {
      const referenced = new Set(current.plugins.map((plugin) => plugin.record.directory));
      yield* Effect.tryPromise(async () => {
        const names = await NodeFSP.readdir(bundlesRoot).catch((error: unknown) => {
          if (isNodeError(error, "ENOENT")) return [] as string[];
          throw error;
        });
        for (const name of names) {
          if (!referenced.has(name)) {
            await NodeFSP.rm(NodePath.join(bundlesRoot, name), { recursive: true, force: true });
          }
        }
      }).pipe(
        Effect.catch(() =>
          Effect.sync(() =>
            problems.push({
              code: "plugin-invalid",
              subject: SCIENT_PLUGINS_DIRECTORY,
              message:
                "Leftover plugin files could not be removed; Scient retries on the next change.",
            }),
          ),
        ),
      );
    }
    yield* Ref.update(state, (previous) => ({ ...previous, cleanupProblems: problems }));
  });

  yield* Effect.uninterruptible(publishState.pipe(Effect.andThen(reconcile)));

  const writeState = (contents: string) =>
    Effect.tryPromise({
      try: async () => {
        await NodeFSP.mkdir(config.stateDir, { recursive: true });
        const temporaryPath = `${statePath}.${NodeCrypto.randomUUID()}.tmp`;
        try {
          await NodeFSP.writeFile(temporaryPath, contents, {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600,
          });
          await NodeFSP.rename(temporaryPath, statePath);
        } finally {
          await NodeFSP.rm(temporaryPath, { force: true });
        }
      },
      catch: () =>
        new ExtensionsError({
          reason: "state-unavailable",
          message: "Scient plugin state could not be saved.",
        }),
    });

  /**
   * Ids of every connector the runtime holds, or `undefined` when its
   * inventory is incomplete (unreadable store or records): absence from such an
   * inventory proves nothing, so nothing may be pruned or treated as gone.
   */
  const authoritativeConnectorIds = connectors
    .list()
    .pipe(
      Effect.map((inventory) =>
        inventory.diagnostics.some(
          (diagnostic) =>
            diagnostic.code === "state-unreadable" ||
            diagnostic.code === "connector-record-unreadable",
        )
          ? undefined
          : new Set(inventory.connectors.map((connector) => connector.connectorId)),
      ),
    );

  /** Drop ownership of connectors confirmed gone (their ids are never reused). */
  const pruneOwnership = (
    candidate: ReadonlyArray<InstalledPlugin>,
    liveIds: ReadonlySet<ConnectorId> | undefined,
  ): ReadonlyArray<InstalledPlugin> =>
    liveIds === undefined
      ? candidate
      : candidate.map((plugin) =>
          plugin.record.connectors.every((entry) => liveIds.has(entry.connectorId))
            ? plugin
            : {
                ...plugin,
                record: {
                  ...plugin.record,
                  connectors: plugin.record.connectors.filter((entry) =>
                    liveIds.has(entry.connectorId),
                  ),
                },
              },
        );

  /**
   * Encode the full state, preserved entries included. It must fit the startup
   * reader's budget, otherwise the next start could not read it.
   */
  const encodeWithinBudget = Effect.fn("ScientPluginRegistry.encodeWithinBudget")(function* (
    plugins: ReadonlyArray<InstalledPlugin>,
  ) {
    const current = yield* Ref.get(state);
    const contents = yield* encodePersistedPluginsState({
      formatVersion: 1,
      plugins: [...plugins.map((plugin) => plugin.record), ...current.preserved],
    }).pipe(
      Effect.mapError(
        () =>
          new ExtensionsError({
            reason: "state-unavailable",
            message: "Scient plugin state could not be encoded.",
          }),
      ),
    );
    if (Buffer.byteLength(contents, "utf8") > MAX_STATE_BYTES) {
      return yield* new ExtensionsError({
        reason: "limit-reached",
        message: `Scient plugin state would exceed ${MAX_STATE_BYTES / 1024} KiB. Remove a plugin and try again.`,
      });
    }
    return contents;
  });

  /**
   * Persist, then publish in memory. Callers run it inside an uninterruptible
   * section. A commit that would exceed the state budget fails with
   * `limit-reached` and writes nothing.
   */
  const commit = Effect.fn("ScientPluginRegistry.commit")(function* (
    candidate: ReadonlyArray<InstalledPlugin>,
  ) {
    const plugins = pruneOwnership(candidate, yield* authoritativeConnectorIds);
    const contents = yield* encodeWithinBudget(plugins);
    yield* writeState(contents);
    yield* Ref.update(state, (previous) => ({ ...previous, plugins }));
    yield* publishState;
  });

  const removeDirectory = (directory: string) =>
    Effect.tryPromise(() =>
      NodeFSP.rm(NodePath.join(bundlesRoot, directory), { recursive: true, force: true }),
    ).pipe(Effect.ignore);

  /** Copy the snapshot into its content-addressed directory; reuse an intact existing copy. */
  const writeInstalledCopy = (directory: string, bundle: BundleSnapshot) =>
    Effect.tryPromise({
      try: async (): Promise<{ readonly created: boolean }> => {
        const target = NodePath.join(bundlesRoot, directory);
        const existing = await snapshotBundle(target).catch(() => undefined);
        if (existing?.digest === bundle.digest) return { created: false };
        await NodeFSP.mkdir(bundlesRoot, { recursive: true, mode: 0o700 });
        const staging = NodePath.join(bundlesRoot, `.staging-${NodeCrypto.randomUUID()}`);
        try {
          for (const file of bundle.files) {
            const destination = NodePath.join(staging, ...file.relativePath.split("/"));
            await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true, mode: 0o700 });
            await NodeFSP.writeFile(destination, file.bytes, { flag: "wx", mode: 0o600 });
          }
          await NodeFSP.rm(target, { recursive: true, force: true });
          await NodeFSP.rename(staging, target);
        } finally {
          await NodeFSP.rm(staging, { recursive: true, force: true });
        }
        return { created: true };
      },
      catch: () =>
        new ExtensionsError({
          reason: "state-unavailable",
          message: "The plugin bundle could not be copied into Scient's plugin storage.",
        }),
    });

  const requireWritable = Effect.gen(function* () {
    const current = yield* Ref.get(state);
    if (current.unreadable) {
      return yield* new ExtensionsError({
        reason: "state-unavailable",
        message: `${SCIENT_PLUGINS_STATE_FILE} is unreadable, so plugin changes are paused to preserve it.`,
      });
    }
    return current;
  });

  const findPlugin = Effect.fn("ScientPluginRegistry.findPlugin")(function* (
    current: RegistryState,
    pluginId: string,
  ) {
    if (isReservedScientPluginId(pluginId)) {
      return yield* invalidInput("Built-in plugins are controlled by their own settings.");
    }
    const plugin = current.plugins.find((entry) => entry.record.pluginId === pluginId);
    if (plugin === undefined) {
      return yield* new ExtensionsError({
        reason: "not-found",
        message: `No Scient plugin '${pluginId}' is installed.`,
      });
    }
    return plugin;
  });

  const liveOwned = (owned: ReadonlyArray<OwnedConnector>) =>
    connectors
      .list()
      .pipe(
        Effect.map((inventory) =>
          inventory.connectors.filter((connector) =>
            owned.some((entry) => entry.connectorId === connector.connectorId),
          ),
        ),
      );

  /**
   * One serialized, uninterruptible change. Once started, every filesystem and
   * connector step runs to completion and the permit is held until it has, so
   * an interrupted caller cannot let a later change commit underneath it.
   */
  const mutate = <A>(change: Effect.Effect<A, ExtensionsError>) =>
    writePermit.withPermits(1)(
      Effect.uninterruptible(
        reconcile.pipe(
          Effect.andThen(change),
          Effect.tap(() => PubSub.publish(changes, undefined)),
        ),
      ),
    );

  const install: ScientPluginRegistryShape["install"] = Effect.fn("ScientPluginRegistry.install")(
    function* (input) {
      if (!NodePath.isAbsolute(input.path)) {
        return yield* invalidInput("The plugin path must be an absolute path on the server host.");
      }
      yield* requireWritable;
      // Reading and validating are side-effect free and stay interruptible.
      const bundle = yield* snapshot(input.path);
      const loaded = yield* loadBundle(bundle);
      const { manifest } = loaded;
      if (isReservedScientPluginId(manifest.id)) {
        return yield* invalidInput(`Plugin id '${manifest.id}' is reserved for Scient.`);
      }
      yield* mutate(
        Effect.gen(function* () {
          const current = yield* requireWritable;
          const previous = current.plugins.find((plugin) => plugin.record.pluginId === manifest.id);
          if (previous === undefined && current.plugins.length >= MAX_INSTALLED_PLUGINS) {
            return yield* new ExtensionsError({
              reason: "limit-reached",
              message: `At most ${MAX_INSTALLED_PLUGINS} Scient plugins can be installed.`,
            });
          }
          // A bundle cannot shadow a Scient skill or another plugin's skill,
          // whether that plugin is currently enabled or not.
          const registered = [
            ...(yield* skillRegistry.current).catalog.releases.filter(
              (release) => !release.origin.startsWith("addon:"),
            ),
            ...current.plugins
              .filter((plugin) => plugin.record.pluginId !== manifest.id)
              .flatMap((plugin) => plugin.bundle?.releases ?? []),
          ];
          for (const release of loaded.releases) {
            const clash = registered.find(
              (other) =>
                other.id === release.id || other.name.toLowerCase() === release.name.toLowerCase(),
            );
            if (clash !== undefined) {
              return yield* invalidInput(
                `Skill '${release.name}' conflicts with the already registered skill '${clash.name}' (${clash.origin}).`,
              );
            }
          }

          const enabled = previous?.record.enabled ?? true;
          const installedAt = DateTime.formatIso(yield* DateTime.now);
          const directory = bundleDirectoryName(manifest, loaded.digest);
          const others = current.plugins.filter((plugin) => plugin.record.pluginId !== manifest.id);
          const candidateState = (
            otherPlugins: ReadonlyArray<InstalledPlugin>,
            pluginConnectors: ReadonlyArray<OwnedConnector>,
          ) =>
            [
              ...otherPlugins,
              {
                record: {
                  pluginId: manifest.id,
                  version: manifest.version,
                  digest: loaded.digest,
                  directory,
                  displayName: manifest.displayName,
                  description: manifest.description,
                  publisher: manifest.publisher,
                  enabled,
                  installedAt,
                  connectors: pluginConnectors,
                },
                bundle: loaded,
                problem: undefined,
              } satisfies InstalledPlugin,
            ].sort((left, right) => compareStrings(left.record.pluginId, right.record.pluginId));

          // Reconcile against a complete connector inventory before committing removals. A degraded
          // listing can make a retained connector appear dropped and erase its ownership/sign-in.
          const owned = previous?.record.connectors ?? [];
          const wanted = manifest.contributes.connectors ?? [];
          const liveIds = yield* authoritativeConnectorIds;
          if (liveIds === undefined && (owned.length > 0 || wanted.length > 0)) {
            return yield* new ExtensionsError({
              reason: "state-unavailable",
              message:
                "Connector storage could not be read completely, so this plugin's connectors cannot be changed now.",
            });
          }
          const live = yield* liveOwned(owned);
          const wantedUrls = new Set(wanted.map((definition) => normalizedUrl(definition.url)));
          const retained = owned.filter(
            (entry) =>
              wantedUrls.has(normalizedUrl(entry.url)) &&
              live.some((connector) => connector.connectorId === entry.connectorId),
          );
          const retainedUrls = new Set(retained.map((entry) => normalizedUrl(entry.url)));
          const dropped = live.filter(
            (connector) => !retained.some((entry) => entry.connectorId === connector.connectorId),
          );
          const toAdd = wanted.filter(
            (definition) => !retainedUrls.has(normalizedUrl(definition.url)),
          );

          // Size the full candidate before creating/retiring anything. Count longest-ID
          // placeholders because they are not live yet; prune only other plugins as the eventual
          // commit will.
          yield* encodeWithinBudget(
            candidateState(pruneOwnership(others, liveIds), [
              ...retained,
              ...toAdd.map((definition) => ({
                connectorId: LONGEST_CONNECTOR_ID,
                url: definition.url,
              })),
            ]),
          );

          const copy = yield* writeInstalledCopy(directory, bundle);
          const added: OwnedConnector[] = [];
          // Anything left behind by a failed rollback is an orphan, which the
          // next reconciliation removes.
          const rollback = Effect.suspend(() =>
            Effect.forEach(
              added,
              (entry) => connectors.remove({ connectorId: entry.connectorId }).pipe(Effect.ignore),
              { discard: true },
            ),
          ).pipe(
            Effect.andThen(
              copy.created && directory !== previous?.record.directory
                ? removeDirectory(directory)
                : Effect.void,
            ),
          );

          yield* Effect.gen(function* () {
            for (const definition of toAdd) {
              const connectorId = yield* connectors.addFromPlugin({
                pluginId: manifest.id,
                url: definition.url,
                displayName: definition.displayName,
                description: definition.description,
              });
              added.push({ connectorId, url: definition.url });
              if (!enabled) yield* connectors.update({ connectorId, enabled: false });
            }
            // Revoking retained connectors is safe before the commit; granting
            // waits until the verified replacement is durably committed.
            if (!enabled) {
              for (const connector of live) {
                if (
                  connector.enabled &&
                  retained.some((entry) => entry.connectorId === connector.connectorId)
                ) {
                  yield* connectors.update({ connectorId: connector.connectorId, enabled: false });
                }
              }
            }
            for (const connector of dropped) {
              yield* connectors.remove({ connectorId: connector.connectorId });
            }
            yield* commit(candidateState(others, [...retained, ...added]));
          }).pipe(Effect.onError(() => rollback));

          // Committed and published: retained connectors of an enabled plugin
          // (for example after repairing a tampered copy) may be granted again.
          // A failure leaves them disabled and is reported, not rolled back.
          if (enabled) {
            const failures: ExtensionsDiagnostic[] = [];
            for (const connector of live) {
              if (
                connector.enabled ||
                !retained.some((entry) => entry.connectorId === connector.connectorId)
              ) {
                continue;
              }
              yield* connectors
                .update({ connectorId: connector.connectorId, enabled: true })
                .pipe(
                  Effect.catch((error) =>
                    Effect.sync(() =>
                      failures.push(
                        cleanupProblem(
                          manifest.id,
                          `Connector '${connector.displayName}' could not be re-enabled; enable it in Settings.`,
                          error,
                        ),
                      ),
                    ),
                  ),
                );
            }
            yield* Ref.update(state, (previous) => ({
              ...previous,
              cleanupProblems: [...previous.cleanupProblems, ...failures],
            }));
          }
          if (previous !== undefined && previous.record.directory !== directory) {
            yield* removeDirectory(previous.record.directory);
          }
        }),
      );
    },
  );

  const remove: ScientPluginRegistryShape["remove"] = (input) =>
    mutate(
      Effect.gen(function* () {
        const current = yield* requireWritable;
        const plugin = yield* findPlugin(current, input.pluginId);
        // Connectors go first: a failure leaves the plugin installed, so a
        // retry converges instead of orphaning its connectors.
        yield* connectors.removeByPlugin(input.pluginId);
        yield* commit(current.plugins.filter((entry) => entry !== plugin));
        yield* removeDirectory(plugin.record.directory);
      }),
    ).pipe(Effect.withSpan("ScientPluginRegistry.remove"));

  const setEnabled: ScientPluginRegistryShape["setEnabled"] = (input) =>
    mutate(
      Effect.gen(function* () {
        const current = yield* requireWritable;
        const plugin = yield* findPlugin(current, input.pluginId);
        const updated = current.plugins.map((entry) =>
          entry === plugin
            ? { ...entry, record: { ...entry.record, enabled: input.enabled } }
            : entry,
        );
        const setConnectors = (enabled: boolean) =>
          liveOwned(plugin.record.connectors).pipe(
            Effect.flatMap((live) =>
              Effect.forEach(
                live.filter((connector) => connector.enabled !== enabled),
                (connector) => connectors.update({ connectorId: connector.connectorId, enabled }),
                { discard: true },
              ),
            ),
          );
        if (!input.enabled) {
          // Revoke first: a failure leaves the plugin enabled with fewer
          // enabled connectors, never disabled with granted ones.
          yield* setConnectors(false);
          yield* commit(updated);
          return;
        }
        yield* commit(updated);
        // An unverified copy keeps its connectors disabled until reinstalled.
        if (plugin.bundle !== undefined) yield* setConnectors(true);
      }),
    ).pipe(Effect.withSpan("ScientPluginRegistry.setEnabled"));

  const list: ScientPluginRegistryShape["list"] = Effect.fn("ScientPluginRegistry.list")(
    function* () {
      const current = yield* Ref.get(state);
      const inventory = yield* connectors.list();
      const diagnostics: ExtensionsDiagnostic[] = [];
      if (current.unreadable) {
        diagnostics.push({
          code: "state-unreadable",
          subject: SCIENT_PLUGINS_STATE_FILE,
          message: `${SCIENT_PLUGINS_STATE_FILE} could not be read. It is preserved unchanged, plugin changes are paused and plugin connectors are disabled.`,
        });
      }
      if (current.preserved.length > 0) {
        diagnostics.push({
          code: "plugin-invalid",
          subject: SCIENT_PLUGINS_STATE_FILE,
          message: `${current.preserved.length} installed plugin record(s) could not be read and were preserved.`,
        });
      }
      for (const plugin of current.plugins) {
        if (plugin.problem !== undefined) {
          diagnostics.push({
            code: "plugin-invalid",
            subject: plugin.record.pluginId,
            message: plugin.problem,
          });
        }
      }
      diagnostics.push(...current.skillRejections, ...current.cleanupProblems);
      const bundles = current.plugins.map((plugin): ScientPluginSummary => {
        const components: ExtensionComponent[] = [
          ...(plugin.bundle?.releases ?? []).map((release): ExtensionComponent => ({
            type: "skill",
            name: release.name,
            detail: release.description,
          })),
          ...(plugin.bundle?.manifest.contributes.connectors ?? []).map(
            (definition): ExtensionComponent => ({
              type: "connector",
              name: definition.displayName,
              detail: new URL(definition.url).host,
            }),
          ),
        ];
        return {
          pluginId: plugin.record.pluginId,
          version: plugin.record.version,
          displayName: plugin.record.displayName,
          description: plugin.record.description,
          publisher: plugin.record.publisher,
          origin: "bundle",
          digest: plugin.record.digest,
          components,
          enabled: plugin.record.enabled,
          canSetEnabled: true,
          canRemove: true,
          installedAt: plugin.record.installedAt,
          connectorIds: plugin.record.connectors
            .filter((entry) =>
              inventory.connectors.some((connector) => connector.connectorId === entry.connectorId),
            )
            .map((entry) => entry.connectorId),
        };
      });
      return { plugins: [...BUILT_IN_SCIENT_PLUGINS, ...bundles], diagnostics };
    },
  );

  return ScientPluginRegistry.of({
    list,
    install,
    remove,
    setEnabled,
    changes: Stream.fromPubSub(changes),
  });
});

/**
 * Requires the live `ScientSkillRegistry` (from the Scient skills layer) and
 * the same `PluginConnectorEligibility` instance the connector runtime reads.
 * `ScientSkillRegistry` is a Reference with a dormant default, so composing
 * this layer without it would publish add-on skills into an unused registry.
 */
export const layer = Layer.effect(ScientPluginRegistry, make());
