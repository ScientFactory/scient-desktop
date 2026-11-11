// @effect-diagnostics nodeBuiltinImport:off -- Connector folders are plain folders on this computer.
/**
 * Agents make and fix local connectors: a copy of a connector (or the template) in the chat's
 * folder, Scient's check of a folder (start it, list its tools, call some), and saving it as the
 * user's own with history, so the last change, a removal included, can be undone.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  type ConnectorId,
  type ConnectorSummary,
  ExtensionsError,
  type ProjectId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as yazl from "yazl";

import type { ConnectorSessionsShape } from "../../accounts/connectorSessions.ts";
import {
  latestHistory,
  removeFolder,
  restoreFolder,
  writeFolder,
} from "../../storage/FolderHistory.ts";
import { agentStatusOf } from "./agentStatus.ts";
import type { ConnectorLogs } from "./ConnectorLogs.ts";
import { credentialSet, redactJsonValue, redactText } from "./ConnectorRedaction.ts";
import { ConnectorRecord } from "./ConnectorStateStore.ts";
import { connectorTemplate } from "./connectorTemplate.ts";
import {
  type BundleManifest,
  manifestScientProblem,
  readFolderManifest,
} from "./LocalConnectorBundle.ts";
import type { LocalLaunchError } from "./LocalConnectorLaunch.ts";
import { bringInPackage, packageOf, type RunTool } from "./PackageSource.ts";
import type { LocalConnectorHost } from "./LocalConnectorProcesses.ts";
import type { CheckedStart, LocalConnectors } from "./LocalConnectors.ts";

/** Left out of copies, saves and exports: system clutter, version control, Scient's marker. */
const JUNK = new Set([
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
  ".git",
  "__MACOSX",
  // uv makes these again when it starts; a moved .venv no longer runs.
  ".venv",
  "__pycache__",
]);
/** Programs a command runs that may be its code rather than a runtime. */
const SCRIPT_FILE = /\.(?:py|js|mjs|cjs|ts|rb|sh|jar|r|jl|pl|php)$/iu;
/** Written into an agent's copy, so a later copy of the same connector may replace it. */
const COPY_MARKER = ".scient-connector.json";
const SKIPPED = new Set([...JUNK, COPY_MARKER]);
const MAX_FOLDER_BYTES = 200 * 1024 * 1024;
const MAX_FOLDER_FILES = 20_000;
const MAX_EXPORT_BYTES = 50 * 1024 * 1024;
const START_TIMEOUT_MS = 45_000;
const CALL_TIMEOUT_MS = 60_000;
const MAX_CALLS = 10;
const MAX_RESULT_CHARS = 4_000;
const MAX_LOG_CHARS = 8_000;
/** Folder names tried for a copy before giving up: `name`, `name-2`, … */
const MAX_COPY_NAMES = 20;

const NO_CREDENTIALS = credentialSet([]);

const decodeRecord = Schema.decodeUnknownExit(Schema.fromJsonString(ConnectorRecord));
const encodeRecord = Schema.encodeSync(Schema.fromJsonString(ConnectorRecord));
const CopyMarker = Schema.fromJsonString(Schema.Struct({ connectorId: Schema.String }));
const decodeMarker = Schema.decodeUnknownExit(CopyMarker);
const toJsonText = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));
const encodeMarker = Schema.encodeSync(CopyMarker);

const invalid = (message: string) => new ExtensionsError({ reason: "invalid-input", message });
const notFound = (message: string) => new ExtensionsError({ reason: "not-found", message });
const unsupported = (message: string) => new ExtensionsError({ reason: "unsupported", message });

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "connector";

const historyStamp = Effect.map(DateTime.now, (now) =>
  DateTime.formatIso(now).replace(/[:.]/gu, "-"),
);

const exists = (path: string) =>
  NodeFSP.lstat(path).then(
    () => true,
    () => false,
  );

const clip = (text: string, limit: number) =>
  text.length <= limit ? text : `${text.slice(0, limit)}… (${text.length - limit} more characters)`;

/** Files and bytes in a folder, links and clutter left out, within the limits. */
async function measure(folder: string): Promise<{ files: number; bytes: number }> {
  let files = 0;
  let bytes = 0;
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
      if (SKIPPED.has(entry.name)) continue;
      const path = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        files += 1;
        bytes += (await NodeFSP.lstat(path)).size;
      }
      if (files > MAX_FOLDER_FILES || bytes > MAX_FOLDER_BYTES) return;
    }
  };
  await walk(folder);
  return { files, bytes };
}

const zipFolder = (folder: string) =>
  new Promise<Buffer>((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const chunks: Buffer[] = [];
    let total = 0;
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on("error", reject);
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    const walk = async (directory: string, prefix: string): Promise<void> => {
      const entries = await NodeFSP.readdir(directory, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (SKIPPED.has(entry.name)) continue;
        const path = NodePath.join(directory, entry.name);
        const name = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(path, name);
        else if (entry.isFile()) {
          const bytes = await NodeFSP.readFile(path);
          total += bytes.length;
          if (total > MAX_EXPORT_BYTES) throw new Error("too-large");
          zip.addBuffer(bytes, name, { mode: 0o100644 });
        }
      }
    };
    walk(folder, "").then(
      () => zip.end(),
      (error: unknown) => reject(error),
    );
  });

export interface CheckInput {
  readonly folder: string;
  /** Use this connector's settings, keys and sign-in. */
  readonly connector?: string | undefined;
  /** An Accounts sign-in (name or id) for the manifest's site, for a folder never saved. */
  readonly signIn?: string | undefined;
  readonly calls?: ReadonlyArray<{ readonly tool: string; readonly arguments?: unknown }>;
}

export interface CheckResult {
  readonly ok: boolean;
  readonly tools: ReadonlyArray<{
    readonly name: string;
    readonly description?: string;
    readonly parameters?: unknown;
  }>;
  readonly calls: ReadonlyArray<{
    readonly tool: string;
    readonly isError: boolean;
    readonly text: string;
  }>;
  /** Required settings, keys or sign-in it ran without. */
  readonly missing: ReadonlyArray<string>;
  readonly error?: string;
  readonly log?: string;
}

export interface AuthoringDeps {
  readonly local: LocalConnectors;
  readonly host: LocalConnectorHost;
  readonly logs: ConnectorLogs;
  readonly sessions: Option.Option<ConnectorSessionsShape>;
  readonly records: Effect.Effect<ReadonlyArray<ConnectorRecord>>;
  readonly summaryOf: (record: ConnectorRecord) => Effect.Effect<ConnectorSummary>;
  readonly newConnectorId: Effect.Effect<ConnectorId>;
  /** Adds a record (a new connector, or one brought back) and publishes it. */
  readonly add: (record: ConnectorRecord) => Effect.Effect<ConnectorRecord, ExtensionsError>;
  readonly update: (
    connectorId: string,
    change: (record: ConnectorRecord, updatedAt: string) => ConnectorRecord,
  ) => Effect.Effect<void, ExtensionsError>;
  /** Removes a record without history (undoing its creation). */
  readonly drop: (record: ConnectorRecord) => Effect.Effect<void, ExtensionsError>;
  /** Lets a removed connector's id be used again. */
  readonly revive: (connectorId: string) => void;
  readonly isoNow: Effect.Effect<string>;
  /** Runs npm and uv to bring a package connector's code into a copy. */
  readonly runTool: RunTool;
}

/** Script files a copied command runs from outside its folder, for the agent to bring in. */
const outsidePrograms = async (manifest: BundleManifest, folder: string) => {
  const config = manifest.server.mcp_config;
  const candidates = [config?.command ?? "", ...(config?.args ?? [])].filter(
    (part) => NodePath.isAbsolute(part) && SCRIPT_FILE.test(part),
  );
  const found: string[] = [];
  for (const path of candidates) {
    const inside = path === folder || path.startsWith(folder + NodePath.sep);
    if (!inside && (await NodeFSP.stat(path).catch(() => undefined))?.isFile()) found.push(path);
  }
  return found;
};

export const makeLocalConnectorAuthoring = (deps: AuthoringDeps) => {
  const { local, host, logs } = deps;

  const findConnector = Effect.fn("LocalConnectorAuthoring.find")(function* (name: string) {
    const wanted = name.trim().toLowerCase();
    const named = (yield* deps.records).filter(
      (item) =>
        item.serverName === name.trim() ||
        item.connectorId === name.trim() ||
        item.displayName.toLowerCase() === wanted,
    );
    const record = named.find((item) => item.local !== undefined);
    if (record !== undefined) return record;
    const hosted = named[0];
    return yield* hosted === undefined
      ? notFound(`No local connector is named ${name}. scient_connector_list shows them.`)
      : invalid(
          `${hosted.displayName} runs online, so it has no code here. scient_connector_check {"connector":"${hosted.serverName}"} tests it; scient_connector_control signs in again.`,
        );
  });

  const requireFolder = Effect.fn("LocalConnectorAuthoring.requireFolder")(function* (
    folder: string,
  ) {
    if (!NodePath.isAbsolute(folder)) return yield* invalid("Give the folder's full path.");
    const info = yield* Effect.promise(() => NodeFSP.stat(folder).catch(() => undefined));
    if (info === undefined || !info.isDirectory())
      return yield* invalid(`${folder} is not a folder.`);
    if (!(yield* Effect.promise(() => exists(NodePath.join(folder, "manifest.json")))))
      return yield* invalid(`${folder} has no manifest.json.`);
    const size = yield* Effect.promise(() => measure(folder));
    if (size.files > MAX_FOLDER_FILES || size.bytes > MAX_FOLDER_BYTES)
      return yield* invalid(
        "The folder is too large for a connector (over 200 MB or 20,000 files).",
      );
    return NodePath.resolve(folder);
  });

  /** A copy of a connector, or the template, in the chat's folder, for the agent to change. */
  const copy = Effect.fn("LocalConnectorAuthoring.copy")(function* (input: {
    readonly workingFolder: string;
    readonly connector?: string | undefined;
    readonly name?: string | undefined;
  }) {
    if (input.connector === undefined && input.name === undefined)
      return yield* invalid("Give connector (to fix one) or name (to make one).");
    const record =
      input.connector === undefined ? undefined : yield* findConnector(input.connector);
    const displayName = (record?.displayName ?? input.name ?? "").trim() || "Connector";
    // Never over someone's files: an earlier copy of this connector is replaced, else the
    // first free name (`name`, `name-2`, …) is used.
    const base = NodePath.join(input.workingFolder, "connectors", slug(displayName));
    // Only inside the chat's own folder: never through a link to somewhere else.
    const linked = yield* Effect.promise(async () => {
      const connectors = NodePath.dirname(base);
      const info = await NodeFSP.lstat(connectors).catch(() => undefined);
      return info?.isSymbolicLink() === true;
    });
    if (linked)
      return yield* invalid(
        `${NodePath.dirname(base)} is a link to another folder. Scient writes copies only inside this chat's folder.`,
      );
    const target = yield* Effect.promise(async () => {
      for (let turn = 1; turn <= MAX_COPY_NAMES; turn++) {
        const candidate = turn === 1 ? base : `${base}-${turn}`;
        if ((await NodeFSP.lstat(candidate).catch(() => undefined))?.isSymbolicLink()) continue;
        const entries = await NodeFSP.readdir(candidate).catch(() => [] as string[]);
        if (entries.length === 0) return candidate;
        const marker = await NodeFSP.readFile(NodePath.join(candidate, COPY_MARKER), "utf8").catch(
          () => "",
        );
        const decoded = decodeMarker(marker);
        if (decoded._tag === "Success" && decoded.value.connectorId === record?.connectorId)
          return candidate;
      }
      return undefined;
    });
    if (target === undefined)
      return yield* invalid(
        `${base} and the next ${MAX_COPY_NAMES - 1} names all hold other files. Tidy the connectors folder first.`,
      );
    yield* Effect.tryPromise({
      try: async () => {
        await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
        const home = await NodeFSP.realpath(input.workingFolder);
        const parent = await NodeFSP.realpath(NodePath.dirname(target));
        if (parent !== home && !parent.startsWith(home + NodePath.sep))
          throw new Error("outside the chat folder");
        await NodeFSP.rm(target, { recursive: true, force: true });
        if (record?.local !== undefined) {
          await NodeFSP.cp(record.local.directory, target, {
            recursive: true,
            verbatimSymlinks: true,
            filter: (from) => !SKIPPED.has(NodePath.basename(from)),
          });
          await NodeFSP.writeFile(
            NodePath.join(target, COPY_MARKER),
            encodeMarker({ connectorId: record.connectorId }),
          );
          return;
        }
        const files = connectorTemplate({ name: slug(displayName), displayName });
        for (const [path, text] of Object.entries(files)) {
          const destination = NodePath.join(target, ...path.split("/"));
          await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
          await NodeFSP.writeFile(destination, text);
        }
      },
      catch: () => unsupported(`Scient could not write ${target}.`),
    });
    if (record === undefined) return { folder: target, variant: "new" as const };
    const summary = yield* deps.summaryOf(record);
    const log = clip(yield* logs.tail(record.connectorId), MAX_LOG_CHARS).trim();
    const copied = yield* readFolderManifest(target).pipe(Effect.option);
    const pkg = Option.isNone(copied) ? undefined : packageOf(copied.value);
    let source: string | undefined;
    if (pkg !== undefined && Option.isSome(copied))
      source = yield* bringInPackage(target, copied.value, pkg, deps.runTool).pipe(
        Effect.catch((error) =>
          Effect.succeed(
            `Its code is not here: ${error.message} Fix what the manifest runs, or bring the code in yourself.`,
          ),
        ),
      );
    else if (Option.isSome(copied)) {
      const outside = yield* Effect.promise(() => outsidePrograms(copied.value, target));
      if (outside.length > 0)
        source = `It runs ${outside.join(", ")}, outside this folder. To change that code, copy it in here and point manifest.json at it (\${__dirname}/<file>).`;
    }
    const manifest = yield* readFolderManifest(target).pipe(Effect.option);
    return {
      folder: target,
      variant: record.local!.owned ? ("fix" as const) : ("fork" as const),
      connector: record.serverName,
      status: agentStatusOf(summary),
      ...(summary.lastError === undefined ? {} : { lastError: summary.lastError }),
      ...(summary.local?.problem === undefined ? {} : { problem: summary.local.problem }),
      ...(log.length === 0 ? {} : { log }),
      ...(source === undefined ? {} : { source }),
      ...(summary.local === undefined || summary.local.missing.length === 0
        ? {}
        : { missing: summary.local.missing }),
      ...(Option.isNone(manifest)
        ? {}
        : {
            manifest: {
              name: manifest.value.name,
              version: manifest.value.version,
              runtime: manifest.value.server.type,
              entryPoint: manifest.value.server.entry_point,
              settings: Object.keys(manifest.value.user_config ?? {}),
              ...(summary.local?.signIn === undefined
                ? {}
                : { signInSite: summary.local.signIn.site }),
            },
          }),
    };
  });

  /** The sign-in a check uses: the connector's, or one named for the manifest's site. */
  const checkSignIn = Effect.fn("LocalConnectorAuthoring.checkSignIn")(function* (
    folder: string,
    given: string | undefined,
  ) {
    if (given === undefined) return undefined;
    const site = yield* local.signInSiteOf({
      kind: "bundle",
      directory: folder,
      owned: false,
      settings: {},
      keys: {},
    });
    if (site === undefined)
      return yield* invalid("This manifest has no signIn site to sign in to.");
    if (Option.isNone(deps.sessions)) return yield* unsupported("Accounts is unavailable here.");
    const wanted = given.trim().toLowerCase();
    const fitting = yield* deps.sessions.value.accountsFor(site);
    const account = fitting.find(
      (item) => item.accountId === given.trim() || item.name.toLowerCase() === wanted,
    );
    if (account === undefined)
      return yield* invalid(
        `No Accounts sign-in named ${given} covers ${site}. scient_accounts_list shows the user's sign-ins.`,
      );
    return `account:${account.accountId}`;
  });

  /** Starts the folder like an installed connector, outside any record, then stops it. */
  const runCheck = Effect.fn("LocalConnectorAuthoring.runCheck")(function* (
    input: CheckInput,
    location: { readonly projectId: ProjectId; readonly worktreePath: string | null } | undefined,
    listOnly: boolean,
  ) {
    const folder = yield* requireFolder(input.folder);
    const base = input.connector === undefined ? undefined : yield* findConnector(input.connector);
    const signIn = yield* checkSignIn(folder, input.signIn);
    const manifest = yield* readFolderManifest(folder).pipe(Effect.result);
    const failed = (error: string, log?: string): CheckResult => ({
      ok: false,
      tools: [],
      calls: [],
      missing: [],
      error,
      ...(log === undefined || log.trim() === "" ? {} : { log: clip(log, MAX_LOG_CHARS) }),
    });
    if (manifest._tag === "Failure") return failed(manifest.failure.message);
    const problem = manifestScientProblem(manifest.success);
    if (problem !== undefined) return failed(problem);
    const checkId = `check_${(yield* deps.newConnectorId).slice(4)}`;
    const displayName =
      base?.displayName ?? (manifest.success.display_name?.trim() || manifest.success.name);
    const keep = base?.local;
    const record: ConnectorRecord = {
      ...(base ?? {
        connectorId: checkId as ConnectorId,
        serverName: slug(displayName),
        displayName,
        url: `scient-local:${checkId}`,
        source: { type: "local" },
        auth: { type: "none" },
        status: "connected",
        enabled: true,
        authRevision: 0,
        availability: { type: "all-projects" },
        createdAt: yield* deps.isoNow,
        updatedAt: yield* deps.isoNow,
      }),
      local: {
        kind: "bundle",
        directory: folder,
        owned: false,
        settings: keep?.settings ?? {},
        keys: keep?.keys ?? {},
        ...((signIn ?? keep?.signIn) === undefined ? {} : { signIn: (signIn ?? keep?.signIn)! }),
      },
    };
    let started: CheckedStart | undefined;
    const start = local
      .start(record, record.serverName, location, { checking: true })
      .pipe(Effect.tap((value) => Effect.sync(() => (started = value)))) as Effect.Effect<
      CheckedStart,
      LocalLaunchError
    >;
    const identity = { connectorId: checkId, displayName };
    const run = Effect.runPromiseWith(yield* Effect.context<never>());
    const fetch = async (_url: string | URL, init?: RequestInit): Promise<Response> => {
      const headers = new Headers(init?.headers);
      const method = init?.method ?? "GET";
      const body = init?.body;
      return run(
        host.exchange(
          identity,
          {
            method: method === "POST" || method === "DELETE" ? method : "GET",
            sessionId: headers.get("mcp-session-id") ?? undefined,
            body: typeof body === "string" ? new TextEncoder().encode(body) : undefined,
            signal: init?.signal ?? new AbortController().signal,
          },
          start,
        ),
      );
    };
    const credentials = () => started?.credentials ?? NO_CREDENTIALS;
    const shown = (text: string, limit: number) =>
      clip(redactText(text, credentials(), limit), limit);
    const outcome = yield* Effect.tryPromise({
      try: async () => {
        const transport = new StreamableHTTPClientTransport(new URL("http://scient.local/check"), {
          fetch,
        });
        const client = new Client({ name: "Scient check", version: "1" });
        try {
          await client.connect(transport as unknown as Transport, { timeout: START_TIMEOUT_MS });
          const listed = await client.listTools(undefined, { timeout: START_TIMEOUT_MS });
          const calls: Array<CheckResult["calls"][number]> = [];
          for (const call of listOnly ? [] : (input.calls ?? []).slice(0, MAX_CALLS)) {
            try {
              const result = await client.callTool(
                {
                  name: call.tool,
                  arguments: (call.arguments ?? {}) as Record<string, unknown>,
                },
                undefined,
                { timeout: CALL_TIMEOUT_MS },
              );
              const content = Array.isArray(result.content) ? result.content : [];
              const text = content
                .map((item) =>
                  item.type === "text"
                    ? item.text
                    : item.type === "image"
                      ? `[image ${item.mimeType}]`
                      : `[${item.type}]`,
                )
                .join("\n");
              // Structured results usually repeat the text; shown only when there is no text.
              const encoded =
                result.structuredContent === undefined || text.trim() !== ""
                  ? undefined
                  : toJsonText(result.structuredContent);
              const structured =
                encoded === undefined || encoded._tag === "Failure" ? "" : `\n${encoded.value}`;
              calls.push({
                tool: call.tool,
                isError: result.isError === true,
                text: shown(text + structured, MAX_RESULT_CHARS),
              });
            } catch (error) {
              calls.push({
                tool: call.tool,
                isError: true,
                text: shown(
                  error instanceof Error ? error.message : String(error),
                  MAX_RESULT_CHARS,
                ),
              });
            }
          }
          return { tools: listed.tools, calls };
        } finally {
          await transport.terminateSession().catch(() => undefined);
          await client.close().catch(() => undefined);
        }
      },
      catch: (cause) =>
        cause instanceof Error ? cause.message.replace(/^MCP error -?\d+: /u, "") : String(cause),
    }).pipe(Effect.result);
    yield* host.stop(checkId, "The check is done.");
    const log = shown(yield* logs.tail(checkId), MAX_LOG_CHARS).trim();
    yield* logs.remove(checkId);
    if (base === undefined && Option.isSome(deps.sessions))
      yield* deps.sessions.value.remove(checkId);
    if (outcome._tag === "Failure") return failed(shown(outcome.failure, MAX_RESULT_CHARS), log);
    return {
      ok: true,
      tools: outcome.success.tools.map((tool) => {
        const parameters = redactJsonValue(tool.inputSchema, credentials());
        return {
          name: shown(tool.name, MAX_RESULT_CHARS),
          ...(tool.description === undefined
            ? {}
            : { description: shown(tool.description, MAX_RESULT_CHARS) }),
          ...(parameters === undefined ? {} : { parameters }),
        };
      }),
      calls: outcome.success.calls,
      missing: started?.missing ?? [],
      ...(log.length === 0 ? {} : { log }),
    } satisfies CheckResult;
  });

  const check = (
    input: CheckInput,
    location: { readonly projectId: ProjectId; readonly worktreePath: string | null } | undefined,
  ) => runCheck(input, location, false);

  /** Saves a checked folder as the user's own connector: new, a fix, or a copy of a bundle. */
  const save = Effect.fn("LocalConnectorAuthoring.save")(function* (
    input: { readonly folder: string; readonly connector?: string | undefined },
    location: { readonly projectId: ProjectId; readonly worktreePath: string | null } | undefined,
  ) {
    const existing =
      input.connector === undefined ? undefined : yield* findConnector(input.connector);
    const checked = yield* runCheck(
      { folder: input.folder, connector: input.connector },
      location,
      true,
    );
    if (!checked.ok) {
      return yield* invalid(
        `Not saved: the check failed. ${checked.error ?? ""}${checked.log ? `\nIts error output:\n${checked.log}` : ""}`.trim(),
      );
    }
    const folder = NodePath.resolve(input.folder);
    const stamp = yield* historyStamp;
    const source = { copyFrom: folder, skip: SKIPPED };
    if (existing !== undefined) {
      const current = existing.local!;
      const inRoot = current.owned && NodePath.dirname(current.directory) === local.root;
      const name = inRoot
        ? NodePath.basename(current.directory)
        : `${slug(existing.displayName)}-${existing.connectorId.slice(4, 10).toLowerCase()}`;
      const directory = NodePath.join(local.root, name);
      yield* Effect.tryPromise({
        try: () =>
          writeFolder({
            root: local.root,
            historyRoot: local.historyRoot,
            name,
            key: existing.connectorId,
            source,
            stamp,
            meta: new TextEncoder().encode(encodeRecord(existing)),
          }),
        catch: () => unsupported("Scient could not save the connector's folder."),
      });
      const adopted = yield* local.adopt(directory, current);
      const forkedFrom = inRoot ? current.forkedFrom : (current.forkedFrom ?? existing.displayName);
      yield* deps.update(existing.connectorId, (record, updatedAt) => ({
        ...record,
        local: {
          ...adopted.local,
          changedBy: "agent",
          ...(forkedFrom === undefined ? {} : { forkedFrom }),
        },
        lastError: undefined,
        updatedAt,
      }));
      yield* host.stop(existing.connectorId, `${existing.displayName} was updated. Restarting.`);
      const saved = (yield* deps.records).find(
        (record) => record.connectorId === existing.connectorId,
      );
      return {
        summary: yield* deps.summaryOf(saved ?? existing),
        tools: checked.tools.map((tool) => tool.name),
        variant: inRoot ? ("fix" as const) : ("fork" as const),
      };
    }
    const connectorId = yield* deps.newConnectorId;
    const manifest = yield* readFolderManifest(folder);
    const displayName = manifest.display_name?.trim() || manifest.name.trim();
    const name = `${slug(displayName)}-${connectorId.slice(4, 10).toLowerCase()}`;
    const directory = NodePath.join(local.root, name);
    yield* Effect.tryPromise({
      try: () =>
        writeFolder({
          root: local.root,
          historyRoot: local.historyRoot,
          name,
          key: connectorId,
          source,
          stamp,
        }),
      catch: () => unsupported("Scient could not save the connector's folder."),
    });
    const discard = Effect.promise(async () => {
      await NodeFSP.rm(directory, { recursive: true, force: true });
      await NodeFSP.rm(NodePath.join(local.historyRoot, connectorId), {
        recursive: true,
        force: true,
      });
    });
    const adopted = yield* local.adopt(directory, undefined).pipe(Effect.tapError(() => discard));
    const createdAt = yield* deps.isoNow;
    const added = yield* deps
      .add({
        connectorId,
        serverName: adopted.name,
        displayName: adopted.name,
        ...(adopted.description === undefined ? {} : { description: adopted.description }),
        url: `scient-local:${connectorId}`,
        source: { type: "local" },
        auth: { type: "none" },
        status: "connected",
        enabled: true,
        authRevision: 0,
        availability: { type: "all-projects" },
        createdAt,
        updatedAt: createdAt,
        local: { ...adopted.local, changedBy: "agent" },
      })
      .pipe(Effect.tapError(() => discard));
    return {
      summary: yield* deps.summaryOf(added),
      tools: checked.tools.map((tool) => tool.name),
      variant: "new" as const,
    };
  });

  /** Removal keeps the folder (when Scient owns it) and the record, so Undo can bring it back. */
  const keepRemoved = Effect.fn("LocalConnectorAuthoring.keepRemoved")(function* (
    record: ConnectorRecord,
  ) {
    const current = record.local!;
    const inRoot = current.owned && NodePath.dirname(current.directory) === local.root;
    const stamp = yield* historyStamp;
    yield* Effect.tryPromise({
      try: () =>
        removeFolder({
          root: inRoot ? local.root : NodePath.dirname(current.directory),
          historyRoot: local.historyRoot,
          name: NodePath.basename(current.directory),
          key: record.connectorId,
          stamp,
          meta: new TextEncoder().encode(encodeRecord(record)),
          ...(inRoot ? {} : { keepInPlace: true }),
        }),
      catch: () => unsupported("Scient could not keep a copy of the connector."),
    }).pipe(
      // Removal still goes ahead; without a copy it cannot be undone.
      Effect.catch(() => (current.owned ? local.discard(current) : Effect.void)),
    );
    yield* logs.remove(record.connectorId);
    if (Option.isSome(deps.sessions)) yield* deps.sessions.value.remove(record.connectorId);
  });

  /**
   * Undoes the last change to a connector's folder: a new connector goes, a replaced folder comes
   * back (settings and keys stay as they are now), and a removed connector returns.
   */
  const undo = Effect.fn("LocalConnectorAuthoring.undo")(function* (connectorId: string) {
    const latest = yield* Effect.promise(() => latestHistory(local.historyRoot, connectorId));
    if (latest === undefined) return yield* notFound("There is no earlier version to go back to.");
    const before =
      latest.meta === undefined ? undefined : decodeRecord(new TextDecoder().decode(latest.meta));
    const previous = before?._tag === "Success" ? before.value : undefined;
    const current = (yield* deps.records).find((record) => record.connectorId === connectorId);
    const restore = (folderOf: string) =>
      Effect.tryPromise({
        try: () =>
          restoreFolder({
            root: NodePath.dirname(folderOf),
            historyRoot: local.historyRoot,
            name: NodePath.basename(folderOf),
            key: connectorId,
          }),
        catch: () => unsupported("Scient could not bring the earlier version back."),
      });
    if (latest.kind === "removed") {
      if (current !== undefined || previous?.local === undefined)
        return yield* invalid("That connector is already here.");
      yield* restore(previous.local.directory);
      deps.revive(connectorId);
      yield* deps.add({ ...previous, updatedAt: yield* deps.isoNow });
      return { kind: latest.kind };
    }
    if (current?.local === undefined) return yield* notFound("That connector no longer exists.");
    yield* restore(current.local.directory);
    yield* host.stop(connectorId, `${current.displayName} went back to its earlier version.`);
    if (latest.kind === "created" && previous === undefined) {
      yield* deps.drop(current);
      return { kind: latest.kind };
    }
    const earlier = previous?.local ?? current.local;
    yield* deps.update(connectorId, (record, updatedAt) => {
      const now = record.local!;
      const { changedBy: _changedBy, forkedFrom: _forkedFrom, ...rest } = now;
      return {
        ...record,
        local: {
          ...rest,
          kind: earlier.kind,
          directory: earlier.directory,
          owned: earlier.owned,
          changedBy: "you",
          ...(earlier.forkedFrom === undefined ? {} : { forkedFrom: earlier.forkedFrom }),
        },
        lastError: undefined,
        updatedAt,
      };
    });
    return { kind: latest.kind };
  });

  const exportBundle = Effect.fn("LocalConnectorAuthoring.export")(function* (connectorId: string) {
    const record = (yield* deps.records).find((item) => item.connectorId === connectorId);
    if (record?.local === undefined) return yield* notFound("That connector no longer exists.");
    const bytes = yield* Effect.tryPromise({
      try: () => zipFolder(record.local!.directory),
      catch: (error) =>
        error instanceof Error && error.message === "too-large"
          ? invalid("This connector is larger than the 50 MB a shared file can be.")
          : unsupported("Scient could not read the connector's folder."),
    });
    return { fileName: `${slug(record.displayName)}.mcpb`, base64: bytes.toString("base64") };
  });

  return { copy, check, save, undo, keepRemoved, exportBundle };
};

export type LocalConnectorAuthoring = ReturnType<typeof makeLocalConnectorAuthoring>;
