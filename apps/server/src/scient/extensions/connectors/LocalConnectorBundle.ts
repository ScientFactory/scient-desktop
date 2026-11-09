// @effect-diagnostics nodeBuiltinImport:off -- Unpacks bundle archives into Scient's state folder.
/**
 * MCP Bundles (`.mcpb`, formerly `.dxt`): a zip with `manifest.json` and the server. A folder is
 * used where it is, so a connector someone is building runs their latest files; a file is
 * unpacked into Scient's state folder and removed with its connector.
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStreamPromises from "node:stream/promises";

import {
  ExtensionsError,
  type LocalBundleField,
  type LocalBundleInspection,
  type LocalBundleSettingsInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { openZipArchive } from "../../../zipArchive.ts";
import type { LocalLaunchTemplate } from "./LocalConnectorLaunch.ts";

const MANIFEST_FILE = "manifest.json";
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_ENTRIES = 100_000;
const MAX_UNPACKED_BYTES = 2 * 1024 * 1024 * 1024;

const SettingValue = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Boolean,
  Schema.Array(Schema.String),
]);

const UserConfigField = Schema.Struct({
  type: Schema.Literals(["string", "number", "boolean", "directory", "file"]),
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  required: Schema.optional(Schema.Boolean),
  default: Schema.optional(SettingValue),
  multiple: Schema.optional(Schema.Boolean),
  sensitive: Schema.optional(Schema.Boolean),
  min: Schema.optional(Schema.Number),
  max: Schema.optional(Schema.Number),
});

const LaunchOverride = Schema.Struct({
  command: Schema.optional(Schema.String),
  args: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

const Manifest = Schema.Struct({
  name: Schema.String,
  display_name: Schema.optional(Schema.String),
  version: Schema.String,
  description: Schema.optional(Schema.String),
  author: Schema.optional(Schema.Struct({ name: Schema.optional(Schema.String) })),
  server: Schema.Struct({
    type: Schema.Literals(["node", "python", "binary", "uv"]),
    entry_point: Schema.String,
    mcp_config: Schema.optional(
      Schema.Struct({
        command: Schema.String,
        args: Schema.optional(Schema.Array(Schema.String)),
        env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
        platform_overrides: Schema.optional(Schema.Record(Schema.String, LaunchOverride)),
      }),
    ),
  }),
  user_config: Schema.optional(Schema.Record(Schema.String, UserConfigField)),
  tools: Schema.optional(
    Schema.Array(
      Schema.Struct({ name: Schema.String, description: Schema.optional(Schema.String) }),
    ),
  ),
  compatibility: Schema.optional(
    Schema.Struct({ platforms: Schema.optional(Schema.Array(Schema.String)) }),
  ),
  _meta: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
export type BundleManifest = typeof Manifest.Type;
const ManifestJson = Schema.fromJsonString(Manifest);
const decodeManifest = Schema.decodeUnknownExit(ManifestJson);
const encodeManifest = Schema.encodeSync(Manifest);
/** Indented, since people and agents read and edit these files. */
const manifestText = (manifest: BundleManifest) =>
  `${JSON.stringify(encodeManifest(manifest), null, 2)}\n`;

/** Scient's own manifest key (`_meta` takes reverse-DNS keys). */
const SCIENT_MANIFEST_META = "com.scientfactory.scient";
const ScientMeta = Schema.Struct({
  /** `project`: the chat's project folder; an absolute path: that folder. Default: the bundle's. */
  workingDirectory: Schema.optional(Schema.String),
});
const decodeScientMeta = Schema.decodeUnknownExit(ScientMeta);

/** Where the program runs, from the manifest's Scient settings. */
export const manifestWorkingDirectory = (manifest: BundleManifest): string | undefined => {
  const meta = decodeScientMeta(manifest._meta?.[SCIENT_MANIFEST_META] ?? {});
  return Exit.isSuccess(meta) ? nonBlank(meta.value.workingDirectory) : undefined;
};

const PLATFORM_NAMES: Readonly<Record<string, string>> = {
  darwin: "macOS",
  win32: "Windows",
  linux: "Linux",
};

const invalid = (message: string) => new ExtensionsError({ reason: "invalid-input", message });

const nonBlank = (value: string | undefined) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const parseBundleManifest = (text: string) => {
  const decoded = decodeManifest(text);
  if (Exit.isFailure(decoded)) {
    return Effect.fail(invalid("This bundle's manifest.json is not a valid MCP Bundle manifest."));
  }
  const manifest = decoded.value;
  if (!nonBlank(manifest.name) || !nonBlank(manifest.version)) {
    return Effect.fail(invalid("This bundle's manifest has no name or version."));
  }
  return Effect.succeed(manifest);
};

/** Directory variables the manifest may use, resolved for this computer. */
export interface BundleDirectories {
  readonly home: string;
  readonly separator: string;
}

const directoryVariables = (directories: BundleDirectories, bundleDir?: string) => {
  const join = (name: string) => `${directories.home}${directories.separator}${name}`;
  return {
    ...(bundleDir === undefined ? {} : { __dirname: bundleDir }),
    HOME: directories.home,
    DESKTOP: join("Desktop"),
    DOCUMENTS: join("Documents"),
    DOWNLOADS: join("Downloads"),
    "/": directories.separator,
    pathSeparator: directories.separator,
  } as Readonly<Record<string, string>>;
};

const fillDirectories = (text: string, variables: Readonly<Record<string, string>>) =>
  text.replace(/\$\{([^}]+)\}/g, (match, name: string) => variables[name] ?? match);

const fieldDefault = (
  value: typeof SettingValue.Type | undefined,
  variables: Readonly<Record<string, string>>,
) =>
  typeof value === "string"
    ? fillDirectories(value, variables)
    : Array.isArray(value)
      ? value.map((item) => fillDirectories(item, variables))
      : value;

export const bundleFields = (
  manifest: BundleManifest,
  directories: BundleDirectories,
): ReadonlyArray<LocalBundleField> => {
  const variables = directoryVariables(directories);
  const env = manifest.server.mcp_config?.env ?? {};
  const envNameOf = (key: string) =>
    Object.entries(env).find(([, value]) => value === `\${user_config.${key}}`)?.[0];
  return Object.entries(manifest.user_config ?? {}).flatMap(([key, field]) => {
    const name = nonBlank(key);
    if (name === undefined) return [];
    const defaultValue = fieldDefault(field.default, variables);
    const description = nonBlank(field.description);
    return [
      {
        key: name,
        type: field.type,
        title: nonBlank(field.title) ?? name,
        ...(description === undefined ? {} : { description }),
        required: field.required === true,
        sensitive: field.type === "string" && field.sensitive === true,
        multiple: field.multiple === true,
        ...(defaultValue === undefined ? {} : { default: defaultValue }),
        ...(field.min === undefined ? {} : { min: field.min }),
        ...(field.max === undefined ? {} : { max: field.max }),
        ...(envNameOf(name) === undefined ? {} : { envName: envNameOf(name)! }),
      } satisfies LocalBundleField,
    ];
  });
};

/** Why this computer cannot run the bundle at all, before any runtime lookup. */
export const platformUnavailable = (
  manifest: BundleManifest,
  platform: NodeJS.Platform,
): string | undefined => {
  const platforms = manifest.compatibility?.platforms;
  if (platforms === undefined || platforms.length === 0 || platforms.includes(platform)) {
    return undefined;
  }
  const names = platforms.map((name) => PLATFORM_NAMES[name] ?? name);
  return `This connector is made for ${names.join(" and ")} only.`;
};

/**
 * Checks plain answers against the manifest's questions. Keys are never settings, and a missing
 * required answer is allowed: the connector then shows Needs setup.
 */
export const resolveSettings = Effect.fn("LocalConnectorBundle.resolveSettings")(function* (
  fields: ReadonlyArray<LocalBundleField>,
  settings: LocalBundleSettingsInput,
) {
  const plain = fields.filter((field) => !field.sensitive);
  const known = new Set(plain.map((field) => field.key));
  for (const key of Object.keys(settings)) {
    if (!known.has(key)) return yield* invalid(`This connector has no setting named ${key}.`);
  }
  const resolved: Record<string, string | number | boolean | ReadonlyArray<string>> = {};
  for (const field of plain) {
    const value = settings[field.key];
    if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) {
      continue;
    }
    const ok =
      field.type === "number"
        ? typeof value === "number" && Number.isFinite(value)
        : field.type === "boolean"
          ? typeof value === "boolean"
          : field.multiple
            ? Array.isArray(value) || typeof value === "string"
            : typeof value === "string";
    if (!ok) return yield* invalid(`${field.title} has the wrong kind of value.`);
    if (typeof value === "number") {
      if (field.min !== undefined && value < field.min)
        return yield* invalid(`${field.title} must be at least ${field.min}.`);
      if (field.max !== undefined && value > field.max)
        return yield* invalid(`${field.title} must be at most ${field.max}.`);
    }
    resolved[field.key] = field.multiple && typeof value === "string" ? [value] : value;
  }
  return resolved;
});

const SECRET_MARKER = (key: string) => `\${secret:${key}}`;

/**
 * The bundle's launch with directory variables and plain answers filled in. Sensitive answers
 * stay as `${secret:<key>}` in environment values and are returned separately for the vault;
 * a sensitive answer on the command line is refused, since other programs can read it there.
 */
export const bundleLaunch = Effect.fn("LocalConnectorBundle.launch")(function* (input: {
  readonly manifest: BundleManifest;
  readonly bundleDir: string;
  readonly platform: NodeJS.Platform;
  readonly directories: BundleDirectories;
  readonly fields: ReadonlyArray<LocalBundleField>;
  readonly answers: Readonly<Record<string, string | number | boolean | ReadonlyArray<string>>>;
}) {
  const { manifest, bundleDir, platform } = input;
  const variables = directoryVariables(input.directories, bundleDir);
  const sensitive = new Set(input.fields.filter((field) => field.sensitive).map((f) => f.key));
  const base = manifest.server.mcp_config;
  const override = base?.platform_overrides?.[platform];
  const entry = `${bundleDir}${input.directories.separator}${manifest.server.entry_point}`;
  const command =
    override?.command ??
    base?.command ??
    (manifest.server.type === "uv" ? "uv" : manifest.server.type === "node" ? "node" : entry);
  const args =
    override?.args ??
    base?.args ??
    (manifest.server.type === "uv"
      ? ["run", "--project", "${__dirname}", entry]
      : manifest.server.type === "binary"
        ? []
        : [entry]);
  const env = { ...base?.env, ...override?.env };

  const text = (value: string | number | boolean | ReadonlyArray<string>) =>
    Array.isArray(value) ? value.join(",") : String(value);
  const fill = Effect.fn("LocalConnectorBundle.fill")(function* (
    template: string,
    where: "args" | "env",
  ) {
    let usesSecret = false;
    const filled = template.replace(/\$\{([^}]+)\}/g, (match, name: string) => {
      if (!name.startsWith("user_config.")) return variables[name] ?? match;
      const key = name.slice("user_config.".length);
      if (sensitive.has(key)) {
        usesSecret = true;
        return input.answers[key] === undefined ? "" : SECRET_MARKER(key);
      }
      const value = input.answers[key];
      return value === undefined ? "" : text(value);
    });
    if (usesSecret && where === "args") {
      return yield* invalid(
        "This connector passes its key on the command line, which Scient doesn't allow.",
      );
    }
    return filled;
  });

  const filledArgs: string[] = [];
  for (const arg of args) {
    const whole = /^\$\{user_config\.([^}]+)\}$/.exec(arg)?.[1];
    const value = whole === undefined ? undefined : input.answers[whole];
    if (whole !== undefined && !sensitive.has(whole)) {
      // A whole-argument answer with several values becomes one argument per value; an
      // unanswered optional one is left out rather than passed as an empty argument.
      if (Array.isArray(value)) filledArgs.push(...value);
      else if (value !== undefined) filledArgs.push(String(value));
      continue;
    }
    filledArgs.push(yield* fill(arg, "args"));
  }
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) environment[name] = yield* fill(value, "env");

  const resolvedCommand = yield* fill(command, "args");
  // Bundled binaries are named without `.exe`; a command on PATH is found by PATHEXT instead.
  const binary =
    manifest.server.type === "binary" &&
    platform === "win32" &&
    resolvedCommand.startsWith(bundleDir) &&
    NodePath.win32.extname(resolvedCommand) === ""
      ? `${resolvedCommand}.exe`
      : resolvedCommand;
  const secrets: Record<string, string> = {};
  for (const key of sensitive) {
    const value = input.answers[key];
    if (typeof value === "string" && value.length > 0) secrets[key] = value;
  }
  return {
    launch: {
      command: manifest.server.type === "node" && binary === "node" ? "node" : binary,
      runtime: manifest.server.type === "node" && binary === "node" ? "scient-node" : "system",
      args: filledArgs,
      environment,
    },
    secrets,
  } satisfies {
    readonly launch: LocalLaunchTemplate;
    readonly secrets: Readonly<Record<string, string>>;
  };
});

/** The manifest in a connector's folder; Scient reads it each time it starts the program. */
export const readFolderManifest = Effect.fn("LocalConnectorBundle.readFolderManifest")(function* (
  directory: string,
) {
  const text = yield* Effect.tryPromise({
    try: async () => {
      const file = NodePath.join(directory, MANIFEST_FILE);
      if ((await NodeFSP.stat(file)).size > MAX_MANIFEST_BYTES) throw new Error("too large");
      return NodeFSP.readFile(file, "utf8");
    },
    catch: () => invalid(`${directory} has no readable manifest.json.`),
  });
  return yield* parseBundleManifest(text);
});

/** Writes a manifest Scient generated for a command, package or imported server. */
export const writeFolderManifest = Effect.fn("LocalConnectorBundle.writeFolderManifest")(function* (
  directory: string,
  manifest: BundleManifest,
) {
  yield* Effect.tryPromise({
    try: async () => {
      await NodeFSP.mkdir(directory, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(directory, MANIFEST_FILE), manifestText(manifest), {
        flag: "wx",
      });
    },
    catch: () => invalid("Scient could not write the connector's folder."),
  });
});

/** Reads `manifest.json` from a `.mcpb` file or an unpacked bundle folder. */
export const readBundleManifest = Effect.fn("LocalConnectorBundle.readManifest")(function* (
  path: string,
) {
  if (!NodePath.isAbsolute(path)) {
    return yield* invalid("Give the full path to the .mcpb file or bundle folder.");
  }
  const stat = yield* Effect.tryPromise({
    try: () => NodeFSP.stat(path),
    catch: () => invalid("Scient could not find that file or folder."),
  });
  if (stat.isDirectory()) {
    return { kind: "folder" as const, manifest: yield* readFolderManifest(path) };
  }
  if (!stat.isFile()) return yield* invalid("That path is not a file or folder.");
  const text = yield* Effect.scoped(
    Effect.gen(function* () {
      const archive = yield* openZipArchive(path, () =>
        invalid("That file is not an MCP Bundle (.mcpb) archive."),
      );
      for (let index = 0; index < Math.min(archive.entryCount, MAX_ENTRIES); index++) {
        const entry = yield* archive.next;
        if (entry === null) break;
        if (entry.fileName !== MANIFEST_FILE) continue;
        if (entry.uncompressedSize > MAX_MANIFEST_BYTES) break;
        const readable = yield* archive.streamEntry(entry);
        return yield* Effect.tryPromise({
          try: async () => {
            const chunks: Buffer[] = [];
            for await (const chunk of readable) chunks.push(chunk as Buffer);
            return Buffer.concat(chunks).toString("utf8");
          },
          catch: () => invalid("The bundle's manifest.json could not be read."),
        });
      }
      return yield* invalid("That bundle has no manifest.json at its top level.");
    }),
  );
  return { kind: "file" as const, manifest: yield* parseBundleManifest(text) };
});

/**
 * Unpacks a `.mcpb` into `target` (which must not exist), keeping executable bits. Links and
 * entries outside the folder are refused; the archive reader rejects absolute and `..` names.
 */
export const unpackBundle = Effect.fn("LocalConnectorBundle.unpack")(function* (
  archivePath: string,
  target: string,
) {
  const staging = `${target}.unpacking`;
  yield* Effect.promise(() => NodeFSP.rm(staging, { recursive: true, force: true }));
  const unpacked = yield* Effect.scoped(
    Effect.gen(function* () {
      const archive = yield* openZipArchive(archivePath, () =>
        invalid("That file is not an MCP Bundle (.mcpb) archive."),
      );
      if (archive.entryCount > MAX_ENTRIES) {
        return yield* invalid("That bundle has too many files.");
      }
      let total = 0;
      yield* Effect.promise(() => NodeFSP.mkdir(staging, { recursive: true }));
      for (;;) {
        const entry = yield* archive.next;
        if (entry === null) break;
        const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (mode === 0o120000) return yield* invalid("Bundles with links are not supported.");
        const destination = NodePath.join(staging, entry.fileName);
        if (!destination.startsWith(staging + NodePath.sep)) {
          return yield* invalid("That bundle has a file outside its folder.");
        }
        if (entry.fileName.endsWith("/")) {
          yield* Effect.promise(() => NodeFSP.mkdir(destination, { recursive: true }));
          continue;
        }
        total += entry.uncompressedSize;
        if (total > MAX_UNPACKED_BYTES) return yield* invalid("That bundle is larger than 2 GB.");
        const executable = ((entry.externalFileAttributes >>> 16) & 0o111) !== 0;
        const readable = yield* archive.streamEntry(entry);
        yield* Effect.tryPromise({
          try: async () => {
            await NodeFSP.mkdir(NodePath.dirname(destination), { recursive: true });
            await NodeStreamPromises.pipeline(
              readable,
              NodeFS.createWriteStream(destination, {
                flags: "wx",
                mode: executable ? 0o755 : 0o644,
              }),
            );
          },
          catch: () => invalid("The bundle could not be unpacked."),
        });
      }
    }),
  ).pipe(Effect.exit);
  if (Exit.isFailure(unpacked)) {
    yield* Effect.promise(() => NodeFSP.rm(staging, { recursive: true, force: true }));
    return yield* unpacked;
  }
  yield* Effect.tryPromise({
    try: () => NodeFSP.rename(staging, target),
    catch: () => invalid("The bundle could not be unpacked."),
  });
});

export const inspectionOf = (
  manifest: BundleManifest,
  directories: BundleDirectories,
  unavailableReason: string | undefined,
): LocalBundleInspection => {
  const displayName = nonBlank(manifest.display_name) ?? manifest.name.trim();
  const description = nonBlank(manifest.description);
  const author = nonBlank(manifest.author?.name);
  return {
    kind: "bundle",
    name: manifest.name.trim(),
    displayName,
    version: manifest.version.trim(),
    ...(description === undefined ? {} : { description }),
    ...(author === undefined ? {} : { author }),
    runtime: manifest.server.type,
    fields: bundleFields(manifest, directories),
    tools: (manifest.tools ?? []).flatMap((tool) => {
      const name = nonBlank(tool.name);
      const toolDescription = nonBlank(tool.description);
      return name === undefined
        ? []
        : [{ name, ...(toolDescription === undefined ? {} : { description: toolDescription }) }];
    }),
    ...(unavailableReason === undefined ? {} : { unavailableReason }),
  };
};

/** A key or setting of a generated manifest: one variable of the program. */
export interface GeneratedVariable {
  readonly name: string;
  readonly secret: boolean;
  readonly required: boolean;
  readonly description?: string | undefined;
  readonly default?: string | undefined;
}

/**
 * The manifest Scient writes for a typed command, a registry package or a server imported from
 * another app, so every local connector is a folder its setup, Restart and later fixes can read.
 * Plain values given now are written as they are; declared variables become questions.
 */
export const generatedManifest = (input: {
  readonly name: string;
  readonly displayName: string;
  readonly description?: string | undefined;
  readonly version?: string | undefined;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly fixed: Readonly<Record<string, string>>;
  readonly variables: ReadonlyArray<GeneratedVariable>;
  readonly workingDirectory?: string | undefined;
}): BundleManifest => ({
  name: input.name,
  display_name: input.displayName,
  version: input.version ?? "1.0.0",
  ...(input.description === undefined ? {} : { description: input.description }),
  author: { name: "Added in Scient" },
  server: {
    type: "binary",
    entry_point: input.command,
    mcp_config: {
      command: input.command,
      args: [...input.args],
      env: {
        ...input.fixed,
        ...Object.fromEntries(
          input.variables.map((variable) => [variable.name, `\${user_config.${variable.name}}`]),
        ),
      },
    },
  },
  ...(input.variables.length === 0
    ? {}
    : {
        user_config: Object.fromEntries(
          input.variables.map((variable) => [
            variable.name,
            {
              type: "string" as const,
              title: variable.name,
              ...(variable.description === undefined ? {} : { description: variable.description }),
              required: variable.required,
              ...(variable.secret ? { sensitive: true } : {}),
              ...(variable.default === undefined ? {} : { default: variable.default }),
            },
          ]),
        ),
      }),
  ...(input.workingDirectory === undefined
    ? {}
    : { _meta: { [SCIENT_MANIFEST_META]: { workingDirectory: input.workingDirectory } } }),
});
