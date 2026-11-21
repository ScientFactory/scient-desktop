// @effect-diagnostics nodeBuiltinImport:off -- the archive is hashed as it streams in.
/**
 * Stages one catalog plugin for `agy plugin install <dir>`: the archive the catalog names is
 * downloaded from gstatic, checked against the catalog's SHA-256 before it is opened, unpacked
 * without links, special files or paths outside the folder, and its manifest must name the plugin.
 */
import * as NodeCrypto from "node:crypto";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient } from "effect/http";
import type * as Yauzl from "yauzl";
import { openZipArchive } from "../../zipArchive.ts";
import { getGstatic, isAntigravityGstaticUrl } from "./AntigravityPluginCatalog.ts";

export const sha256Hex = (bytes: Uint8Array) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");

export const ARCHIVE_LIMITS = {
  archiveBytes: 64 * 1024 * 1024,
  unpackedBytes: 256 * 1024 * 1024,
  entries: 20_000,
  manifestBytes: 256 * 1024,
  depth: 32,
};

export class AntigravityPluginArchiveError extends Schema.TaggedError<AntigravityPluginArchiveError>()(
  "AntigravityPluginArchiveError",
  {
    reason: Schema.Literals(["download", "checksum", "unsafe-archive", "manifest"]),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}
export const isAntigravityPluginArchiveError = Schema.is(AntigravityPluginArchiveError);
const archiveError =
  (reason: AntigravityPluginArchiveError["reason"], detail: string) => (cause?: unknown) =>
    new AntigravityPluginArchiveError({ reason, detail, cause });
const unsafe = (detail: string) => archiveError("unsafe-archive", detail)();

const Manifest = Schema.Struct({
  name: Schema.String,
  version: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest));

/** Downloads and checks the archive in memory; nothing reaches disk unless the digest matches. */
const downloadAntigravityArchive = Effect.fn("AntigravityPluginArchive.download")(
  function* (archive: { readonly url: string; readonly sha256: string }) {
    if (!isAntigravityGstaticUrl(archive.url))
      return yield* archiveError("download", "This plugin's download is not on Google's host.")();
    const http = yield* HttpClient.HttpClient;
    const failed = archiveError("download", "Scient could not download this plugin.");
    const response = yield* getGstatic(http, archive.url, "application/zip").pipe(
      Effect.mapError(failed),
    );
    if (response.status !== 200) return yield* failed();
    const declared = Number(response.headers["content-length"]);
    if (Number.isFinite(declared) && declared > ARCHIVE_LIMITS.archiveBytes)
      return yield* archiveError("download", "This plugin's download is larger than 64 MB.")();
    const hash = NodeCrypto.createHash("sha256");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    yield* response.stream.pipe(
      Stream.mapError(failed),
      Stream.runForEach((chunk) => {
        bytes += chunk.length;
        if (bytes > ARCHIVE_LIMITS.archiveBytes)
          return archiveError("download", "This plugin's download is larger than 64 MB.")();
        hash.update(chunk);
        chunks.push(chunk);
        return Effect.void;
      }),
    );
    if (hash.digest("hex") !== archive.sha256.toLowerCase())
      return yield* archiveError(
        "checksum",
        "The downloaded plugin doesn't match the checksum its catalog lists, so Scient didn't add it.",
      )();
    return Buffer.concat(chunks);
  },
  (effect) =>
    Effect.timeoutOrElse(effect, {
      duration: "3 minutes",
      orElse: () =>
        Effect.fail(
          new AntigravityPluginArchiveError({
            reason: "download",
            detail: "The plugin took too long to download.",
          }),
        ),
    }),
);

const UNIX_FILE_TYPE = 0o170000;
const UNIX_REGULAR = 0o100000;
const UNIX_DIRECTORY = 0o040000;

/** Relative, forward-slash names only; every segment a plain name on every platform. */
function memberSegments(fileName: string): ReadonlyArray<string> | undefined {
  const directory = fileName.endsWith("/");
  const segments = (directory ? fileName.slice(0, -1) : fileName).split("/");
  if (
    fileName.length > 1024 ||
    segments.length > ARCHIVE_LIMITS.depth ||
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        segment.length > 255 ||
        /[\u0000-\u001f\\:*?"<>|]/.test(segment) ||
        /[. ]$/.test(segment) ||
        // Windows device names, with or without an extension, never name a file there.
        /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(\.|$)/i.test(segment),
    )
  )
    return undefined;
  return segments;
}

/**
 * Unpacks `archivePath` into the empty folder `target`. Executable bits are kept; anything that
 * is not a plain file or folder, or that would land outside `target` or on another member, fails.
 */
export const extractAntigravityArchive = Effect.fn("AntigravityPluginArchive.extract")(function* (
  archivePath: string,
  target: string,
  limits: Partial<typeof ARCHIVE_LIMITS> = {},
) {
  const { entries, unpackedBytes } = { ...ARCHIVE_LIMITS, ...limits };
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(target);
  yield* Effect.scoped(
    Effect.gen(function* () {
      const archive = yield* openZipArchive(archivePath, (detail, cause) =>
        archiveError("unsafe-archive", `The plugin archive could not be read: ${detail}`)(cause),
      );
      if (archive.entryCount > entries)
        return yield* unsafe("The plugin archive has too many files.");
      const claimed = new Set<string>();
      let total = 0;
      for (;;) {
        const entry: Yauzl.Entry | null = yield* archive.next;
        if (entry === null) break;
        const segments = memberSegments(entry.fileName);
        if (!segments) return yield* unsafe("The plugin archive has a file outside its folder.");
        if (entry.isEncrypted()) return yield* unsafe("The plugin archive is encrypted.");
        const madeOnUnix = entry.versionMadeBy >> 8 === 3;
        const mode = madeOnUnix ? entry.externalFileAttributes >>> 16 : 0;
        const type = mode & UNIX_FILE_TYPE;
        const isDirectory = entry.fileName.endsWith("/");
        if (
          (type !== 0 && type !== UNIX_REGULAR && type !== UNIX_DIRECTORY) ||
          (type === UNIX_DIRECTORY && !isDirectory) ||
          (type === UNIX_REGULAR && isDirectory)
        )
          return yield* unsafe("The plugin archive has links or special files.");
        // Case- and form-insensitive, as macOS and Windows folders compare names.
        const key = segments.join("/").normalize("NFC").toLowerCase();
        const destination = path.join(root, ...segments);
        if (!destination.startsWith(`${root}${path.sep}`))
          return yield* unsafe("The plugin archive has a file outside its folder.");
        if (isDirectory) {
          if (claimed.has(`file:${key}`))
            return yield* unsafe("The plugin archive has two members with one name.");
          claimed.add(`dir:${key}`);
          yield* fs.makeDirectory(destination, { recursive: true });
          continue;
        }
        if (claimed.has(`file:${key}`) || claimed.has(`dir:${key}`))
          return yield* unsafe("The plugin archive has two members with one name.");
        claimed.add(`file:${key}`);
        total += entry.uncompressedSize;
        if (total > unpackedBytes)
          return yield* unsafe("The plugin is larger than 256 MB unpacked.");
        const readable = yield* archive.streamEntry(entry);
        const contents = yield* Effect.tryPromise({
          try: async () => {
            const parts: Buffer[] = [];
            let size = 0;
            for await (const chunk of readable) {
              size += (chunk as Buffer).length;
              if (size > entry.uncompressedSize) throw new Error("member larger than declared");
              parts.push(chunk as Buffer);
            }
            return Buffer.concat(parts);
          },
          catch: archiveError("unsafe-archive", "A file in the plugin archive could not be read."),
        });
        yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
        yield* fs.writeFile(destination, contents, {
          flag: "wx",
          mode: (mode & 0o111) !== 0 ? 0o755 : 0o644,
        });
      }
    }),
  ).pipe(
    Effect.mapError((cause) =>
      isAntigravityPluginArchiveError(cause)
        ? cause
        : archiveError("unsafe-archive", "The plugin archive could not be unpacked.")(cause),
    ),
  );
});

/** The unpacked plugin's own manifest must be the catalog's plugin, at the catalog's version. */
export const checkStagedManifest = Effect.fn("AntigravityPluginArchive.checkManifest")(function* (
  directory: string,
  expected: { readonly name: string; readonly version?: string | undefined },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(directory, "plugin.json");
  const missing = archiveError("manifest", "The plugin archive has no readable plugin.json.");
  const info = yield* fs.stat(file).pipe(Effect.mapError(missing));
  if (info.type !== "File" || Number(info.size) > ARCHIVE_LIMITS.manifestBytes)
    return yield* missing();
  const manifest = yield* fs
    .readFileString(file)
    .pipe(Effect.flatMap(decodeManifest), Effect.mapError(missing));
  if (manifest.name !== expected.name)
    return yield* archiveError(
      "manifest",
      "The downloaded plugin names a different plugin than its catalog entry.",
    )();
  if (
    expected.version !== undefined &&
    typeof manifest.version === "string" &&
    manifest.version.trim() !== expected.version
  )
    return yield* archiveError(
      "manifest",
      "The downloaded plugin is a different version than its catalog lists. Refresh and try again.",
    )();
});

/**
 * A checked, unpacked copy of the plugin in a private folder under `stagingRoot`, removed when the
 * scope closes whatever happened.
 */
export const stageAntigravityPlugin = Effect.fn("AntigravityPluginArchive.stage")(
  function* (input: {
    readonly name: string;
    readonly version?: string | undefined;
    readonly archive: { readonly url: string; readonly sha256: string };
    readonly stagingRoot: string;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const bytes = yield* downloadAntigravityArchive(input.archive);
    yield* fs.makeDirectory(input.stagingRoot, { recursive: true, mode: 0o700 });
    const staging = yield* Effect.acquireRelease(
      fs.makeTempDirectory({ directory: input.stagingRoot, prefix: "add-" }),
      (directory) =>
        fs
          .remove(directory, { recursive: true, force: true })
          .pipe(
            Effect.catch(() =>
              Effect.logWarning("Could not remove an Antigravity plugin staging folder."),
            ),
          ),
    );
    const archivePath = path.join(staging, "plugin.zip");
    const pluginDirectory = path.join(staging, input.name);
    yield* fs.writeFile(archivePath, bytes, { flag: "wx", mode: 0o600 });
    yield* fs.makeDirectory(pluginDirectory);
    yield* extractAntigravityArchive(archivePath, pluginDirectory);
    yield* checkStagedManifest(pluginDirectory, input);
    return pluginDirectory;
  },
);
