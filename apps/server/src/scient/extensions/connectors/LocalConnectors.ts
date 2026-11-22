/**
 * Local connectors as folders with an MCP Bundle manifest: adding one (a bundle, a typed command,
 * a registry package or another app's server), its settings and Accounts keys, what it still
 * needs, and how each agent session starts it. The manifest is read at every start, so editing
 * the folder and restarting applies the change.
 */
import {
  type AccountSummary,
  type ConnectorAddInput,
  type ConnectorId,
  ExtensionsError,
  type LocalBundleField,
  type LocalBundleSettingsInput,
  type LocalConnectorSetupItem,
  type LocalConnectorSummary,
  type LocalEnvironmentInput,
  type LocalImportableServer,
  type LocalInspection,
  type LocalKeyInput,
  type LocalKeysInput,
  type ProjectId,
  type VaultSecretRef,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { accountTokenRef } from "../../accounts/AccountBoundRef.ts";
import type { AccountsService } from "../../accounts/AccountsService.ts";
import { type ConnectorSessionsShape, needsYouMessage } from "../../accounts/connectorSessions.ts";
import { latestHistory } from "../../storage/FolderHistory.ts";
import { downloadBundle } from "./LocalBundleDownload.ts";
import type { ConnectorFetch } from "./ConnectorOutbound.ts";
import type { ProjectStoreV2 } from "../../../orchestration-v2/ProjectStore.ts";
import {
  parseScientPluginManifest,
  SCIENT_PLUGIN_MANIFEST_FILE,
} from "../plugins/ScientPluginManifest.ts";
import { credentialSet, programCredentials } from "./ConnectorRedaction.ts";
import type { ConnectorRecord, LocalLaunchRecord } from "./ConnectorStateStore.ts";
import {
  type BundleDirectories,
  type BundleManifest,
  bundleFields,
  bundleLaunch,
  type GeneratedVariable,
  generatedManifest,
  inspectionOf,
  manifestSignIn,
  manifestWorkingDirectory,
  platformUnavailable,
  readBundleManifest,
  readFolderManifest,
  resolveSettings,
  unpackBundle,
  withDirectories,
  writeFolderManifest,
} from "./LocalConnectorBundle.ts";
import {
  folderServers,
  type ImportedServer,
  importableSummary,
  keyArgument,
  looksLikeKey,
  readImportableServers,
  sameSource,
} from "./LocalConnectorImport.ts";
import {
  commandLineOf,
  LocalLaunchError,
  type LocalLaunchTemplate,
  programUnavailable,
  resolveLocalLaunch,
} from "./LocalConnectorLaunch.ts";
import type { LocalStart } from "./LocalConnectorProcesses.ts";

const CONNECTORS_FOLDER = "connectors";
const CONNECTOR_HISTORY_FOLDER = "connector-history";
const ACCOUNT_PREFIX = "account:";
const SETUP_STUB = ".scient-setup.mjs";

/** Answers a connector that is not set up yet: its tools say what is missing and how to fix it. */
const SETUP_STUB_SOURCE = `
import { createInterface } from "node:readline";
const setup = JSON.parse(process.env.SCIENT_CONNECTOR_SETUP ?? "{}");
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const tools = setup.tools.length > 0 ? setup.tools : [{ name: "setup_needed", description: setup.message }];
createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined || message.method === undefined) return;
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: {
      protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: {} }, serverInfo: { name: setup.name, version: "setup" },
      instructions: setup.message } });
  } else if (message.method === "tools/list") {
    send({ jsonrpc: "2.0", id: message.id, result: { tools: tools.map((tool) => ({
      name: tool.name, description: tool.description ?? setup.message,
      inputSchema: { type: "object", additionalProperties: true } })) } });
  } else if (message.method === "tools/call") {
    send({ jsonrpc: "2.0", id: message.id, result: { isError: true,
      content: [{ type: "text", text: setup.message }] } });
  } else if (message.method === "ping") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  } else {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
  }
});
`;

const SetupJson = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.String,
    message: Schema.String,
    tools: Schema.Array(
      Schema.Struct({ name: Schema.String, description: Schema.optional(Schema.String) }),
    ),
  }),
);
const encodeSetup = Schema.encodeSync(SetupJson);

type SettingValue = string | number | boolean | ReadonlyArray<string>;
type LocalTarget = Extract<
  ConnectorAddInput["target"],
  {
    readonly type:
      | "local-bundle"
      | "local-command"
      | "local-package"
      | "local-import"
      | "registry-bundle";
  }
>;

const invalid = (message: string) => new ExtensionsError({ reason: "invalid-input", message });
const unsupported = (message: string) => new ExtensionsError({ reason: "unsupported", message });

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "connector";

/** The manifest's command and arguments on this computer, for display and a runtime check. */
const programOf = (
  manifest: BundleManifest,
  directory: string,
  directories: BundleDirectories,
  platform: NodeJS.Platform,
): Pick<LocalLaunchTemplate, "runtime" | "command" | "args"> => {
  const config = manifest.server.mcp_config;
  const override = config?.platform_overrides?.[platform];
  const fill = (text: string) => withDirectories(text, directories, directory);
  const command =
    override?.command ??
    config?.command ??
    (manifest.server.type === "uv"
      ? "uv"
      : manifest.server.type === "node"
        ? "node"
        : `${directory}/${manifest.server.entry_point}`);
  return {
    runtime: manifest.server.type === "node" && command === "node" ? "scient-node" : "system",
    command: fill(command),
    args: (override?.args ?? config?.args ?? []).map(fill),
  };
};

/** Variables of a typed command, a package or an imported server, as manifest questions. */
const variablesOf = (entries: ReadonlyArray<LocalEnvironmentInput>) => {
  const fixed: Record<string, string> = {};
  const variables: GeneratedVariable[] = [];
  const keys: Record<string, LocalKeyInput> = {};
  for (const entry of entries) {
    if (!entry.secret) {
      fixed[entry.name] = entry.value;
      continue;
    }
    variables.push({ name: entry.name, secret: true, required: true });
    if (entry.account !== undefined) keys[entry.name] = { type: "account", ref: entry.account };
    else if (entry.value.trim() !== "")
      keys[entry.name] = { type: "value", value: entry.value.trim() };
  }
  return { fixed, variables, keys };
};

const hostOf = (site: string) => (URL.canParse(site) ? new URL(site).host : site);

/** The account id a record's `signIn` names. */
const signInAccountOf = (local: Pick<LocalLaunchRecord, "signIn">) =>
  local.signIn?.startsWith(ACCOUNT_PREFIX) ? local.signIn.slice(ACCOUNT_PREFIX.length) : undefined;

const NO_CREDENTIALS = credentialSet([]);

/** How a start went that the check reports: what it ran without. */
export interface CheckedStart extends LocalStart {
  readonly missing: ReadonlyArray<string>;
}

export const makeLocalConnectors = Effect.fn("LocalConnectors.make")(function* (options: {
  readonly stateDir: string;
  readonly accounts: Option.Option<AccountsService["Service"]>;
  readonly projects: ProjectStoreV2["Service"];
  readonly sessions: Option.Option<ConnectorSessionsShape>;
  /** Downloads MCP Registry bundles, under the connector egress rules. */
  readonly bundleFetch: ConnectorFetch;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const withFiles = <A, E>(
    effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
  ): Effect.Effect<A, E> =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
  const root = path.join(options.stateDir, CONNECTORS_FOLDER);
  const historyRoot = path.join(options.stateDir, CONNECTOR_HISTORY_FOLDER);
  const stubPath = path.join(root, SETUP_STUB);
  yield* fileSystem.makeDirectory(root, { recursive: true }).pipe(Effect.ignore);
  yield* fileSystem.writeFileString(stubPath, SETUP_STUB_SOURCE).pipe(Effect.ignore);

  const revisionOf =
    Option.isNone(options.accounts) || options.accounts.value.bindingRevision === undefined
      ? Effect.succeed<number | undefined>(undefined)
      : options.accounts.value.bindingRevision;

  const directories = Effect.gen(function* () {
    return {
      home: yield* HostProcess.HomeDirectory,
      separator: (yield* HostProcess.Platform) === "win32" ? "\\" : "/",
    };
  });

  /** Every key value a running copy may hold, per connector, for redacting echoes. */
  const started = new Map<string, Set<string>>();
  /** Every session cookie value a running copy may hold, kept across new sign-ins. */
  const startedCookies = new Map<string, Set<string>>();
  /** The Accounts revision and key values each connector last started with, per project. */
  const authorized = new Map<
    string,
    {
      readonly revision: number | undefined;
      readonly values: string;
      /** A copy started with other key values while older copies may still run. */
      readonly mixed: boolean;
    }
  >();
  const authorizationKey = (connectorId: string, projectId: ProjectId | undefined) =>
    `${connectorId}\u0000${projectId ?? ""}`;

  /** Parsed manifests by folder, re-read when the file changes. */
  const manifests = new Map<
    string,
    { readonly stamp: string; readonly manifest: BundleManifest }
  >();
  const manifestOf = Effect.fn("LocalConnectors.manifest")(function* (directory: string) {
    const info = yield* fileSystem
      .stat(path.join(directory, "manifest.json"))
      .pipe(Effect.orElseSucceed(() => undefined));
    const stamp =
      info === undefined
        ? ""
        : `${Option.getOrUndefined(info.mtime)?.getTime() ?? 0}:${String(info.size)}`;
    const cached = manifests.get(directory);
    if (cached !== undefined && cached.stamp === stamp && stamp !== "") return cached.manifest;
    const manifest = yield* readFolderManifest(directory);
    manifests.set(directory, { stamp, manifest });
    return manifest;
  });

  const apiKeys = Effect.gen(function* () {
    if (Option.isNone(options.accounts)) return [] as ReadonlyArray<AccountSummary>;
    const snapshot = yield* options.accounts.value.snapshot.pipe(
      Effect.orElseSucceed(() => undefined),
    );
    return (snapshot?.accounts ?? []).filter((account) => account.details.kind === "api-key");
  });

  /** Account names by ref, for showing which key a connector uses. */
  const keyNames = Effect.map(
    apiKeys,
    (accounts) =>
      new Map(accounts.map((account) => [accountTokenRef(account.accountId), account.name])),
  );

  const isAnswered = (value: SettingValue | undefined) =>
    value !== undefined && value !== "" && !(Array.isArray(value) && value.length === 0);

  /** The sign-in a connector's manifest asks for, and what it has for it now. */
  const signInOf = Effect.fn("LocalConnectors.signInOf")(function* (
    manifest: BundleManifest,
    local: LocalLaunchRecord,
  ) {
    const asked = manifestSignIn(manifest);
    if (asked === undefined || "problem" in asked) return asked;
    const accountId = signInAccountOf(local);
    const account =
      accountId === undefined || Option.isNone(options.sessions)
        ? undefined
        : yield* options.sessions.value.account(accountId);
    return {
      site: asked.site,
      state:
        account === undefined
          ? ("missing" as const)
          : // Until the person signs in again; their sign-in clears it.
            local.signInNeedsUser && account.signIn?.state !== "signed-in"
            ? ("needs-user" as const)
            : ("linked" as const),
      ...(account === undefined ? {} : { accountId: account.accountId, account: account.name }),
    };
  });

  const summarize = Effect.fn("LocalConnectors.summarize")(function* (
    record: Pick<ConnectorRecord, "connectorId">,
    local: LocalLaunchRecord,
    names: ReadonlyMap<VaultSecretRef, string>,
  ): Effect.fn.Return<Omit<LocalConnectorSummary, "running">> {
    // Undoing a brand-new connector's creation would delete it for good; Remove keeps a copy.
    const latest = yield* Effect.promise(() => latestHistory(historyRoot, record.connectorId));
    const canUndo =
      latest !== undefined && !(latest.kind === "created" && latest.meta === undefined);
    const base = {
      kind: local.kind,
      directory: local.directory,
      owned: local.owned,
      canUndo,
      ...(local.changedBy === undefined ? {} : { changedBy: local.changedBy }),
      ...(local.forkedFrom === undefined ? {} : { forkedFrom: local.forkedFrom }),
    };
    const read = yield* manifestOf(local.directory).pipe(Effect.result);
    if (read._tag === "Failure") {
      return { ...base, setup: [], missing: [], problem: read.failure.message };
    }
    const manifest = read.success;
    const signIn = yield* signInOf(manifest, local);
    if (signIn !== undefined && "problem" in signIn) {
      return { ...base, setup: [], missing: [], problem: signIn.problem };
    }
    const fields = bundleFields(manifest, yield* directories);
    const setup: LocalConnectorSetupItem[] = fields.map((field) => {
      if (field.sensitive) {
        const ref = local.keys[field.key];
        const account = ref === undefined ? undefined : names.get(ref);
        return account === undefined ? { field } : { field, account };
      }
      const value = local.settings[field.key] ?? field.default;
      return value === undefined ? { field } : { field, value };
    });
    const missing = setup.flatMap(({ field, account, value }) =>
      field.required && (field.sensitive ? account === undefined : !isAnswered(value))
        ? [field.title]
        : [],
    );
    if (signIn?.state === "missing") missing.push(`Sign-in to ${hostOf(signIn.site)}`);
    const author = manifest.author?.name?.trim();
    return {
      ...base,
      commandLine: commandLineOf(
        programOf(manifest, local.directory, yield* directories, yield* HostProcess.Platform),
      ),
      version: manifest.version.trim(),
      ...(author ? { author } : {}),
      setup,
      missing,
      ...(signIn === undefined ? {} : { signIn }),
    };
  });

  /**
   * The sign-in to link for a manifest that asks for one: the one given, the one already linked,
   * or the only Accounts sign-in for that site.
   */
  const chooseSignIn = Effect.fn("LocalConnectors.chooseSignIn")(function* (
    manifest: BundleManifest,
    current: string | undefined,
    chosen: string | undefined,
  ) {
    const asked = manifestSignIn(manifest);
    if (asked === undefined || "problem" in asked || Option.isNone(options.sessions))
      return current;
    const fitting = yield* options.sessions.value.accountsFor(asked.site);
    if (chosen !== undefined) {
      if (!fitting.some((account) => account.accountId === chosen)) {
        return yield* invalid(`That sign-in is not one for ${hostOf(asked.site)}.`);
      }
      return `${ACCOUNT_PREFIX}${chosen}`;
    }
    if (fitting.some((account) => `${ACCOUNT_PREFIX}${account.accountId}` === current))
      return current;
    return fitting.length === 1 ? `${ACCOUNT_PREFIX}${fitting[0]!.accountId}` : undefined;
  });

  /** A matching Accounts key for a field nobody answered, linked without asking. */
  const matchingKey = (accounts: ReadonlyArray<AccountSummary>, field: LocalBundleField) =>
    field.envName === undefined
      ? undefined
      : accounts.find(
          (account) =>
            account.details.kind === "api-key" &&
            account.details.envName === field.envName &&
            account.controls.access !== "off",
        );

  /**
   * Keys become linked Accounts API-key accounts: a chosen account as it is, a typed value as a
   * new account (or as the new value of the account this key already uses).
   */
  const linkKeys = Effect.fn("LocalConnectors.linkKeys")(function* (input: {
    readonly name: string;
    readonly fields: ReadonlyArray<LocalBundleField>;
    readonly current: Readonly<Record<string, VaultSecretRef>>;
    readonly keys: LocalKeysInput;
    readonly created: Array<AccountSummary["accountId"]>;
  }) {
    const accounts = Option.getOrUndefined(options.accounts);
    const known = yield* apiKeys;
    const linked: Record<string, VaultSecretRef> = { ...input.current };
    for (const [key, given] of Object.entries(input.keys)) {
      const field = input.fields.find((item) => item.key === key && item.sensitive);
      if (field === undefined) return yield* invalid(`This connector has no key named ${key}.`);
      if (accounts === undefined) {
        return yield* unsupported("Accounts is unavailable, so keys cannot be saved right now.");
      }
      if (given.type === "account") {
        if (!known.some((account) => accountTokenRef(account.accountId) === given.ref)) {
          return yield* invalid(`The key chosen for ${field.title} is not an API-key account.`);
        }
        linked[key] = given.ref;
        continue;
      }
      const existing = known.find(
        (account) => accountTokenRef(account.accountId) === input.current[key],
      );
      const secrets = { token: { type: "scient" as const, value: given.value } };
      const saved = yield* (
        existing !== undefined &&
        existing.details.kind === "api-key" &&
        (existing.secrets.token?.source === undefined ||
          existing.secrets.token.source.type === "scient")
          ? accounts.save({
              accountId: existing.accountId,
              name: existing.name,
              details: existing.details,
              secrets,
            })
          : accounts.save({
              name: field.title.toLowerCase().includes(input.name.toLowerCase())
                ? field.title
                : `${input.name} ${field.title}`,
              details: {
                kind: "api-key",
                sites: [],
                auth: { type: "bearer" },
                ...(field.envName !== undefined && /^[A-Z_][A-Z0-9_]*$/.test(field.envName)
                  ? { envName: field.envName }
                  : {}),
              },
              secrets,
            })
      ).pipe(
        Effect.mapError(() => unsupported(`Scient could not save the key for ${field.title}.`)),
      );
      if (existing === undefined || saved.accountId !== existing.accountId) {
        input.created.push(saved.accountId);
      }
      linked[key] = accountTokenRef(saved.accountId);
    }
    for (const field of input.fields) {
      if (!field.sensitive || linked[field.key] !== undefined) continue;
      const match = matchingKey(known, field);
      if (match !== undefined) linked[field.key] = accountTokenRef(match.accountId);
    }
    return linked;
  });

  /**
   * Why a server another app runs cannot run in Scient: its program is missing here, or it needs
   * values only that app hands it (Codex `env_vars` that are not in the user's environment and
   * are not keys Scient could ask for).
   */
  const importProblem = Effect.fn("LocalConnectors.importProblem")(function* (
    server: ImportedServer,
  ) {
    const env = yield* HostProcess.Environment;
    const appOnly = server.passEnv.filter(
      (name) => env[name] === undefined && server.env[name] === undefined && !looksLikeKey(name),
    );
    if (appOnly.length > 0) {
      return `${server.name} only runs inside ${server.sourceLabel}: it needs ${appOnly.join(", ")}, which ${server.sourceLabel} gives it.`;
    }
    return yield* withFiles(programUnavailable({ runtime: "system", command: server.command }));
  });

  const inspect = Effect.fn("LocalConnectors.inspect")(function* (input: {
    readonly path: string;
  }) {
    const isFolder = yield* fileSystem.stat(input.path).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.orElseSucceed(() => false),
    );
    if (
      isFolder &&
      (yield* fileSystem
        .exists(path.join(input.path, SCIENT_PLUGIN_MANIFEST_FILE))
        .pipe(Effect.orElseSucceed(() => false)))
    ) {
      const displayName = yield* fileSystem
        .readFile(path.join(input.path, SCIENT_PLUGIN_MANIFEST_FILE))
        .pipe(
          Effect.flatMap(parseScientPluginManifest),
          Effect.map((manifest) => manifest.displayName),
          Effect.orElseSucceed(() => path.basename(input.path)),
        );
      return { kind: "plugin", displayName } satisfies LocalInspection;
    }
    if (
      isFolder &&
      !(yield* fileSystem
        .exists(path.join(input.path, "manifest.json"))
        .pipe(Effect.orElseSucceed(() => false)))
    ) {
      const servers = yield* folderServers(input.path);
      if (servers.length === 0) {
        return yield* invalid(
          "Scient could not tell how to run this folder: it has no manifest.json or .mcp.json. Use Advanced → Run a command.",
        );
      }
      const problems = yield* Effect.forEach(servers, importProblem);
      const usable = servers.filter((_, index) => problems[index] === undefined);
      const firstProblem = problems.find((problem) => problem !== undefined);
      if (usable.length === 0 && firstProblem !== undefined)
        return yield* unsupported(firstProblem);
      return { kind: "servers", servers: usable.map(importableSummary) } satisfies LocalInspection;
    }
    const { manifest } = yield* readBundleManifest(input.path);
    const program = programOf(
      manifest,
      input.path,
      yield* directories,
      yield* HostProcess.Platform,
    );
    const unavailable =
      platformUnavailable(manifest, yield* HostProcess.Platform) ??
      (program.command.includes("${") || path.isAbsolute(program.command)
        ? undefined
        : yield* withFiles(programUnavailable(program)));
    return inspectionOf(manifest, yield* directories, unavailable) satisfies LocalInspection;
  });

  const importable = Effect.gen(function* () {
    const projects = yield* options.projects.list().pipe(Effect.orElseSucceed(() => []));
    const env = yield* HostProcess.Environment;
    return yield* readImportableServers({
      home: yield* HostProcess.HomeDirectory,
      platform: yield* HostProcess.Platform,
      appData: env.APPDATA,
      projectFolders: projects.map((project) => project.workspaceRoot),
    });
  });

  const importables = Effect.fn("LocalConnectors.importables")(function* (
    records: ReadonlyArray<ConnectorRecord>,
  ) {
    const found = yield* importable;
    // Only what would start here is offered; a server another app runs from inside itself is not.
    const servers = yield* Effect.filter(found, (server) =>
      records.some(
        (record) =>
          record.local?.imported !== undefined &&
          record.local.imported.name === server.name &&
          sameSource(record.local.imported.source, server.source),
      )
        ? Effect.succeed(true)
        : importProblem(server).pipe(Effect.map((problem) => problem === undefined)),
    );
    return servers.map((server): LocalImportableServer => {
      const installed = records.find(
        (record) =>
          record.local?.imported !== undefined &&
          record.local.imported.name === server.name &&
          sameSource(record.local.imported.source, server.source),
      );
      return {
        ...importableSummary(server),
        ...(installed === undefined ? {} : { installedConnectorId: installed.connectorId }),
      };
    });
  });

  /**
   * Makes the connector's folder and links its keys. Returns the record part and a cleanup that
   * removes what this made, for a commit that fails afterwards.
   */
  const prepare = Effect.fn("LocalConnectors.prepare")(function* (
    connectorId: ConnectorId,
    target: LocalTarget,
    requestedName: string | undefined,
  ) {
    const platform = yield* HostProcess.Platform;
    const folderFor = (name: string) =>
      path.join(root, `${slug(name)}-${connectorId.slice(4, 10).toLowerCase()}`);
    const created: Array<AccountSummary["accountId"]> = [];
    let owned: string | undefined;
    const cleanup = Effect.gen(function* () {
      if (owned !== undefined)
        yield* fileSystem.remove(owned, { recursive: true }).pipe(Effect.ignore);
      const accounts = Option.getOrUndefined(options.accounts);
      if (accounts !== undefined) {
        for (const accountId of created) yield* accounts.remove(accountId).pipe(Effect.ignore);
      }
    });
    const prepared = yield* Effect.gen(function* () {
      let directory: string;
      let settings: LocalBundleSettingsInput = {};
      let keys: LocalKeysInput = {};
      let kind: LocalLaunchRecord["kind"];
      let imported: LocalLaunchRecord["imported"];
      let registry: { readonly name: string; readonly version: string } | undefined;
      switch (target.type) {
        case "registry-bundle": {
          const download = path.join(root, `.download-${connectorId}.mcpb`);
          yield* withFiles(
            fileSystem
              .makeDirectory(root, { recursive: true })
              .pipe(
                Effect.mapError(() =>
                  unsupported("Scient could not create its connectors folder."),
                ),
              ),
          );
          directory = yield* Effect.gen(function* () {
            yield* downloadBundle(target.bundle, download, options.bundleFetch);
            const read = yield* readBundleManifest(download);
            const reason = platformUnavailable(read.manifest, platform);
            if (reason !== undefined) return yield* unsupported(reason);
            const unpacked = folderFor(read.manifest.display_name ?? read.manifest.name);
            yield* unpackBundle(download, unpacked);
            return unpacked;
          }).pipe(
            Effect.ensuring(fileSystem.remove(download, { force: true }).pipe(Effect.ignore)),
          );
          owned = directory;
          kind = "bundle";
          registry = { name: target.name, version: target.version };
          break;
        }
        case "local-bundle": {
          const read = yield* readBundleManifest(target.path);
          const reason = platformUnavailable(read.manifest, platform);
          if (reason !== undefined) return yield* unsupported(reason);
          if (read.kind === "folder") directory = target.path;
          else {
            directory = folderFor(read.manifest.display_name ?? read.manifest.name);
            yield* withFiles(
              fileSystem
                .makeDirectory(root, { recursive: true })
                .pipe(
                  Effect.mapError(() =>
                    unsupported("Scient could not create its connectors folder."),
                  ),
                ),
            );
            yield* unpackBundle(target.path, directory);
            owned = directory;
          }
          settings = target.settings;
          keys = target.keys;
          kind = "bundle";
          break;
        }
        case "local-command":
        case "local-package":
        case "local-import": {
          let manifest: BundleManifest;
          if (target.type === "local-import") {
            const servers: ReadonlyArray<ImportedServer> =
              target.source.type === "file"
                ? yield* folderServers(target.source.path)
                : yield* importable;
            const server = servers.find(
              (item) => item.name === target.name && sameSource(item.source, target.source),
            );
            if (server === undefined) {
              return yield* invalid(`${target.name} is no longer set up there.`);
            }
            const flag = keyArgument(server.args);
            if (flag !== undefined) {
              return yield* unsupported(
                `${server.name} passes a key on its command line (${flag}), where other programs can read it. In ${server.sourceLabel}, give it the key in an environment variable instead, then add it again.`,
              );
            }
            const problem = yield* importProblem(server);
            if (problem !== undefined) return yield* unsupported(problem);
            const env = yield* HostProcess.Environment;
            const entries = [
              ...Object.entries(server.env).map(([name, value]) => ({
                name,
                value,
                secret: looksLikeKey(name),
              })),
              // A key the app takes from its environment and this one lacks is asked for later.
              ...server.passEnv
                .filter((name) => env[name] === undefined && server.env[name] === undefined)
                .map((name) => ({ name, value: "", secret: true })),
            ];
            const variables = variablesOf(entries);
            manifest = generatedManifest({
              name: slug(server.name),
              displayName: requestedName ?? server.name,
              description: `Imported from ${server.sourceLabel}.`,
              command: server.command,
              args: server.args,
              fixed: variables.fixed,
              variables: variables.variables,
              workingDirectory: server.cwd,
            });
            keys = variables.keys;
            kind = "import";
            imported = { source: target.source, name: target.name };
          } else if (target.type === "local-command") {
            const flag = keyArgument(target.args);
            if (flag !== undefined) {
              return yield* invalid(
                `The command passes a key on its command line (${flag}), where other programs can read it. Put the key in a variable marked Key instead.`,
              );
            }
            const variables = variablesOf(target.environment);
            const name =
              requestedName ?? path.basename(target.command).replace(/\.(exe|cmd|bat)$/i, "");
            manifest = generatedManifest({
              name: slug(name),
              displayName: name,
              command: target.command,
              args: target.args,
              fixed: variables.fixed,
              variables: variables.variables,
            });
            keys = variables.keys;
            kind = "command";
          } else {
            const pkg = target.package;
            const given = new Map(target.environment.map((entry) => [entry.name, entry]));
            const declared = new Set(pkg.environment.map((variable) => variable.name));
            const extra = variablesOf(
              target.environment.filter((entry) => !declared.has(entry.name)),
            );
            manifest = generatedManifest({
              name: slug(target.name),
              displayName: requestedName ?? target.name.split("/").pop() ?? target.name,
              version: pkg.version,
              command: pkg.runner,
              args:
                pkg.runner === "npx"
                  ? ["-y", `${pkg.identifier}@${pkg.version}`, ...pkg.args]
                  : [`${pkg.identifier}==${pkg.version}`, ...pkg.args],
              fixed: extra.fixed,
              variables: [
                ...pkg.environment.map((variable) => ({
                  name: variable.name,
                  secret: variable.secret,
                  required: variable.required,
                  description: variable.description,
                  default: variable.default,
                })),
                ...extra.variables,
              ],
            });
            const plain: Record<string, string> = {};
            const secret: Record<string, LocalKeyInput> = { ...extra.keys };
            for (const variable of pkg.environment) {
              const entry = given.get(variable.name);
              if (entry === undefined) continue;
              if (variable.secret) {
                if (entry.account !== undefined)
                  secret[variable.name] = { type: "account", ref: entry.account };
                else if (entry.value.trim() !== "")
                  secret[variable.name] = { type: "value", value: entry.value.trim() };
              } else if (entry.value !== "") plain[variable.name] = entry.value;
            }
            settings = plain;
            keys = secret;
            kind = "package";
            registry = { name: target.name, version: target.version };
          }
          directory = folderFor(manifest.display_name ?? manifest.name);
          yield* writeFolderManifest(directory, manifest);
          owned = directory;
          break;
        }
      }
      const manifest = yield* readFolderManifest(directory);
      const found = yield* directories;
      const program = programOf(manifest, directory, found, platform);
      const unavailable = yield* withFiles(programUnavailable(program));
      if (unavailable !== undefined) return yield* unsupported(unavailable);
      const fields = bundleFields(manifest, found);
      // Refused now rather than at first use: a key on the command line is never passed.
      yield* bundleLaunch({
        manifest,
        bundleDir: directory,
        platform,
        directories: found,
        fields,
        answers: {},
      });
      const name = requestedName ?? manifest.display_name?.trim() ?? manifest.name.trim();
      const signIn = yield* chooseSignIn(manifest, undefined, undefined);
      const local: LocalLaunchRecord = {
        kind,
        directory,
        owned: owned !== undefined,
        settings: yield* resolveSettings(fields, settings),
        keys: yield* linkKeys({ name, fields, current: {}, keys, created }),
        ...(imported === undefined ? {} : { imported }),
        changedBy: "you",
        ...(signIn === undefined ? {} : { signIn }),
      };
      const description = manifest.description?.trim().slice(0, 1_000);
      return {
        local,
        displayName: name,
        ...(description ? { description } : {}),
        ...(registry === undefined ? {} : { registry }),
      };
    }).pipe(Effect.tapError(() => cleanup));
    return { ...prepared, cleanup };
  });

  /** New settings and keys for an existing connector; answers it leaves out are kept. */
  const setup = Effect.fn("LocalConnectors.setup")(function* (
    record: ConnectorRecord,
    input: {
      readonly settings: LocalBundleSettingsInput;
      readonly keys: LocalKeysInput;
      readonly signIn?: string | undefined;
    },
  ) {
    const local = record.local!;
    const manifest = yield* manifestOf(local.directory);
    const fields = bundleFields(manifest, yield* directories);
    const settings = yield* resolveSettings(fields, input.settings);
    const keys = yield* linkKeys({
      name: record.displayName,
      fields,
      current: local.keys,
      keys: input.keys,
      created: [],
    });
    const signIn = yield* chooseSignIn(manifest, local.signIn, input.signIn);
    const { signIn: _signIn, signInNeedsUser: _needsUser, ...rest } = local;
    return {
      ...rest,
      settings: { ...local.settings, ...settings },
      keys,
      ...(signIn === undefined ? {} : { signIn }),
      // A sign-in chosen again is a fresh start; the next session finds out whether it works.
      ...(local.signInNeedsUser && input.signIn === undefined ? { signInNeedsUser: true } : {}),
    } satisfies LocalLaunchRecord;
  });

  /** A manifest's sign-in linked again after its folder changed (it may name another site). */
  const relink = Effect.fn("LocalConnectors.relink")(function* (local: LocalLaunchRecord) {
    const manifest = yield* manifestOf(local.directory);
    const signIn = yield* chooseSignIn(manifest, local.signIn, undefined).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    const { signIn: _signIn, ...rest } = local;
    return { ...rest, ...(signIn === undefined ? {} : { signIn }) } satisfies LocalLaunchRecord;
  });

  /**
   * How an agent session starts the connector: its manifest with settings and Accounts keys, or,
   * while something required is missing, Scient's setup answerer.
   */
  /** Bumped by each new sign-in, so a session that started before it knows to start again. */
  const signInGenerations = new Map<string, number>();
  const signInLocks = new Map<string, Semaphore.Semaphore>();

  /**
   * How an agent session starts the connector: its manifest with settings, Accounts keys and the
   * site's session, or, while something required is missing, Scient's setup answerer. A check
   * (`checking`) starts the program anyway and says what it ran without.
   */
  const start = Effect.fn("LocalConnectors.start")(
    function* (
      record: ConnectorRecord,
      serverName: string,
      location: { readonly projectId: ProjectId; readonly worktreePath: string | null } | undefined,
      mode: { readonly checking?: boolean } = {},
    ): Effect.fn.Return<CheckedStart, LocalLaunchError, FileSystem.FileSystem | Path.Path> {
      const local = record.local!;
      const manifest = yield* manifestOf(local.directory).pipe(
        Effect.mapError(
          (error) => new LocalLaunchError({ message: `${record.displayName}: ${error.message}` }),
        ),
      );
      const found = yield* directories;
      const platform = yield* HostProcess.Platform;
      const fields = bundleFields(manifest, found);
      const answers: Record<string, SettingValue> = {};
      const missing: string[] = [];
      for (const field of fields) {
        if (!field.sensitive) {
          const value = local.settings[field.key] ?? field.default;
          if (isAnswered(value)) answers[field.key] = value!;
          else if (field.required) missing.push(field.title);
          continue;
        }
        const ref = local.keys[field.key];
        if (ref === undefined || Option.isNone(options.accounts)) {
          if (field.required) missing.push(field.title);
          continue;
        }
        const value = yield* options.accounts.value
          .resolveBound(ref, {
            kind: "local-connector",
            connectorId: record.connectorId,
            connector: record.displayName,
            key: field.key,
            ...(location === undefined ? {} : { projectId: location.projectId }),
          })
          .pipe(Effect.result);
        if (value._tag === "Success") answers[field.key] = Redacted.value(value.success);
        else missing.push(`${field.title} (its key in Accounts is unavailable)`);
      }
      const asked = manifestSignIn(manifest);
      if (asked !== undefined && "problem" in asked) {
        return yield* new LocalLaunchError({ message: `${record.displayName}: ${asked.problem}` });
      }
      let session: { readonly environment: Record<string, string>; readonly hide: string[] } = {
        environment: {},
        hide: [],
      };
      let signInProblem: string | undefined;
      const generation = signInGenerations.get(record.connectorId) ?? 0;
      if (asked !== undefined) {
        const accountId = signInAccountOf(local);
        if (accountId === undefined || Option.isNone(options.sessions)) {
          missing.push(`Sign-in to ${hostOf(asked.site)}`);
        } else {
          const prepared = yield* options.sessions.value
            .prepare({
              connectorId: record.connectorId,
              accountId,
              site: asked.site,
              projectId: location?.projectId,
            })
            .pipe(Effect.result);
          if (prepared._tag === "Success") {
            session = {
              environment: { ...prepared.success.environment },
              hide: [...prepared.success.hide],
            };
          } else {
            signInProblem =
              prepared.failure.reason === "needs-user"
                ? `${needsYouMessage(asked.site)} (${prepared.failure.message})`
                : prepared.failure.message;
          }
        }
      }
      if (mode.checking !== true && signInProblem !== undefined && missing.length === 0) {
        const message = `${record.displayName} cannot reach its site: ${signInProblem} Tell the user; do not retry until they have.`;
        const launch = yield* resolveLocalLaunch(
          {
            runtime: "scient-node",
            command: "node",
            args: [stubPath],
            environment: {
              SCIENT_CONNECTOR_SETUP: encodeSetup({
                name: serverName,
                message,
                tools: (manifest.tools ?? []).map((tool) => ({
                  name: tool.name,
                  ...(tool.description === undefined ? {} : { description: tool.description }),
                })),
              }),
            },
          },
          {},
          local.directory,
        );
        return {
          launch,
          credentials: NO_CREDENTIALS,
          missing: [signInProblem],
        } satisfies CheckedStart;
      }
      if (mode.checking !== true && missing.length > 0) {
        const message = `${record.displayName} is not set up yet: it needs ${missing.join(", ")}. Next step: call mcp__scient__scient_connector_setup with {"connector":"${serverName}"} (load it with your tool search if needed). It asks the user for keys in a private card; never ask for keys in chat. Then call this tool again.`;
        const launch = yield* resolveLocalLaunch(
          {
            runtime: "scient-node",
            command: "node",
            args: [stubPath],
            environment: {
              SCIENT_CONNECTOR_SETUP: encodeSetup({
                name: serverName,
                message,
                tools: (manifest.tools ?? []).map((tool) => ({
                  name: tool.name,
                  ...(tool.description === undefined ? {} : { description: tool.description }),
                })),
              }),
            },
          },
          {},
          local.directory,
        );
        return { launch, credentials: NO_CREDENTIALS, missing } satisfies CheckedStart;
      }
      if (signInProblem !== undefined) missing.push(signInProblem);
      const built = yield* bundleLaunch({
        manifest,
        bundleDir: local.directory,
        platform,
        directories: found,
        fields,
        answers,
      }).pipe(Effect.mapError((error) => new LocalLaunchError({ message: error.message })));
      const where = manifestWorkingDirectory(manifest);
      let cwd = local.directory;
      if (where === "project" && location !== undefined) {
        const project = yield* options.projects
          .get(location.projectId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        cwd =
          location.worktreePath ??
          (Option.isSome(project) ? project.value.workspaceRoot : local.directory);
      } else if (where !== undefined && path.isAbsolute(where)) cwd = where;
      const launch = yield* resolveLocalLaunch(
        {
          ...built.launch,
          environment: { ...built.launch.environment, ...session.environment },
        },
        built.secrets,
        cwd,
      );
      const values = Object.values(built.secrets);
      const known = started.get(record.connectorId) ?? new Set<string>();
      for (const value of values) known.add(value);
      started.set(record.connectorId, known);
      // Earlier cookies stay: a program may echo a session it held before.
      const cookies = startedCookies.get(record.connectorId) ?? new Set<string>();
      for (const value of session.hide) cookies.add(value);
      startedCookies.set(record.connectorId, cookies);
      const entry = authorizationKey(record.connectorId, location?.projectId);
      const joined = values.join("\u0000");
      const before = authorized.get(entry);
      authorized.set(entry, {
        revision: yield* revisionOf,
        values: joined,
        mixed: before !== undefined && (before.mixed || before.values !== joined),
      });
      return {
        launch,
        credentials: programCredentials(Object.values(built.secrets), session.hide),
        missing,
        ...(asked === undefined ? {} : { signInGeneration: generation }),
      } satisfies CheckedStart;
    },
    (effect) => withFiles(effect),
  );

  /**
   * The site ended a connector's session: Scient signs in again, once for every session that saw
   * it end. `seen` is the sign-in the caller's process started with.
   */
  const signInAgain = Effect.fn("LocalConnectors.signInAgain")(function* (
    record: ConnectorRecord,
    seen: number | undefined,
  ) {
    const lock =
      signInLocks.get(record.connectorId) ??
      (() => {
        const created = Semaphore.makeUnsafe(1);
        signInLocks.set(record.connectorId, created);
        return created;
      })();
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const current = signInGenerations.get(record.connectorId) ?? 0;
        if (seen !== undefined && seen < current) return { type: "signed-in" as const };
        const local = record.local!;
        const manifest = yield* manifestOf(local.directory).pipe(
          Effect.orElseSucceed(() => undefined),
        );
        const asked = manifest === undefined ? undefined : manifestSignIn(manifest);
        const accountId = signInAccountOf(local);
        if (
          asked === undefined ||
          "problem" in asked ||
          accountId === undefined ||
          Option.isNone(options.sessions)
        )
          return {
            type: "error" as const,
            message: `${record.displayName} has no sign-in to renew.`,
          };
        const renewed = yield* options.sessions.value
          .signInAgain({ connectorId: record.connectorId, accountId, site: asked.site })
          .pipe(Effect.result);
        if (renewed._tag === "Success") {
          signInGenerations.set(record.connectorId, current + 1);
          return { type: "signed-in" as const };
        }
        return renewed.failure.reason === "needs-user"
          ? {
              type: "needs-user" as const,
              message: `${needsYouMessage(asked.site)} (${renewed.failure.message})`,
            }
          : { type: "error" as const, message: renewed.failure.message };
      }),
    );
  });

  /**
   * Whether running copies may keep their keys: checked again whenever Accounts changed since
   * they started. A key turned off, removed, out of the project's scope or changed returns false.
   */
  const stillAuthorized = Effect.fn("LocalConnectors.stillAuthorized")(function* (
    record: ConnectorRecord,
    location: { readonly projectId: ProjectId } | undefined,
  ) {
    const local = record.local;
    const signInAccount = local === undefined ? undefined : signInAccountOf(local);
    const checksKeys = local !== undefined && Object.keys(local.keys).length > 0;
    if (
      local === undefined ||
      ((!checksKeys || Option.isNone(options.accounts)) && signInAccount === undefined)
    ) {
      return true;
    }
    const key = authorizationKey(record.connectorId, location?.projectId);
    const previous = authorized.get(key);
    if (previous === undefined) return true;
    // Older copies may hold a key the newest start replaced: restart them all.
    if (previous.mixed) {
      authorized.delete(key);
      return false;
    }
    const revision = yield* revisionOf;
    if (revision !== undefined && previous.revision === revision) return true;
    // The linked sign-in is held to Accounts' Off switches, scope and existence, like a key.
    if (signInAccount !== undefined && Option.isSome(options.sessions)) {
      const site = yield* signInSiteOf(local);
      const allowed =
        site !== undefined &&
        (yield* options.sessions.value.allowed({
          connectorId: record.connectorId,
          accountId: signInAccount,
          site,
          projectId: location?.projectId,
        }));
      if (!allowed) return false;
    }
    if (!checksKeys || Option.isNone(options.accounts)) {
      authorized.set(key, { revision, values: previous.values, mixed: false });
      return true;
    }
    const values: string[] = [];
    for (const [name, ref] of Object.entries(local.keys)) {
      const value = yield* options.accounts.value
        .resolveBound(
          ref,
          {
            kind: "local-connector",
            connectorId: record.connectorId,
            connector: record.displayName,
            key: name,
            ...(location === undefined ? {} : { projectId: location.projectId }),
          },
          { auditAllowed: false },
        )
        .pipe(Effect.result);
      if (value._tag === "Failure") return false;
      values.push(Redacted.value(value.success));
    }
    if (values.join("\u0000") !== previous.values) return false;
    authorized.set(key, { revision, values: previous.values, mixed: false });
    return true;
  });

  const discard = (local: LocalLaunchRecord) =>
    local.owned
      ? fileSystem.remove(local.directory, { recursive: true }).pipe(Effect.ignore)
      : Effect.void;

  /**
   * A local connector record for a folder an agent saved: its settings and keys kept from the
   * connector it replaces, or defaults, matching Accounts keys and sign-in linked.
   */
  const adopt = Effect.fn("LocalConnectors.adopt")(function* (
    directory: string,
    keep: LocalLaunchRecord | undefined,
  ) {
    const manifest = yield* readFolderManifest(directory);
    const fields = bundleFields(manifest, yield* directories);
    const name = manifest.display_name?.trim() || manifest.name.trim();
    const keys = yield* linkKeys({
      name,
      fields,
      current: keep?.keys ?? {},
      keys: {},
      created: [],
    });
    const signIn = yield* chooseSignIn(manifest, keep?.signIn, undefined).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    const settings = keep?.settings ?? (yield* resolveSettings(fields, {}));
    const description = manifest.description?.trim().slice(0, 1_000);
    return {
      name,
      ...(description ? { description } : {}),
      local: {
        kind: keep?.kind ?? "bundle",
        directory,
        owned: true,
        settings,
        keys,
        ...(keep?.imported === undefined ? {} : { imported: keep.imported }),
        ...(signIn === undefined ? {} : { signIn }),
      } satisfies LocalLaunchRecord,
    };
  });

  /** The site a manifest signs in to, for messages. */
  const signInSiteOf = (local: LocalLaunchRecord) =>
    manifestOf(local.directory).pipe(
      Effect.map((manifest) => {
        const asked = manifestSignIn(manifest);
        return asked !== undefined && "site" in asked ? asked.site : undefined;
      }),
      Effect.orElseSucceed(() => undefined),
    );

  return {
    root,
    historyRoot,
    inspect,
    importables,
    prepare,
    setup,
    relink,
    adopt,
    start,
    signInAgain,
    signInSiteOf,
    manifestOf,
    summarize,
    keyNames,
    discard,
    /** Key values the last start used, so the proxy redacts them if the program echoes one. */
    secretsFor: (connectorId: string) => [...(started.get(connectorId) ?? [])],
    /** Every key and session cookie its starts handed the program, read live for each answer. */
    credentialsFor: (connectorId: string) =>
      programCredentials(started.get(connectorId) ?? [], startedCookies.get(connectorId) ?? []),
    stillAuthorized,
  };
});

export type LocalConnectors = Effect.Success<ReturnType<typeof makeLocalConnectors>>;
